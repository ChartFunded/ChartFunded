// ═══════════════════════════════════════════════════════════════════════════
//  tv-webhook — receives TradingView alerts from the Fast Track / Talha Sniper
//  indicators (OANDA chart) and turns them into trades + MT5 commands.
//
//  Body: one JSON object per line (TradingView may batch several events):
//  {"v":1,"key":"<TV_WEBHOOK_SECRET>","strat":"FAST","ev":"create","id":"FAST-S-1727000000000",
//   "side":"SELL","sym":"XAUUSD","entry":4049.0,"sl":4056.0,"tp":4040.5,"reason":"","ts":1727000000000}
//  ev: create | trigger | cancel | modify | tp | sl | be
//
//  Security: shared secret (constant-time), optional TradingView IP allow-list,
//  8 KB body cap, strict validation, idempotent (same event processed once),
//  the key is stripped before anything is logged.
// ═══════════════════════════════════════════════════════════════════════════

// ───────── shared helpers (inlined so the file can be pasted in the Supabase dashboard editor) ─────────
// Shared helpers for the Chart Funded algo Edge Functions.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,          // server-side only, never shipped to a browser
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// constant-time string compare (no early exit → no timing leak)
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// optional IP allow-list (comma separated env var). Empty = allow all.
function ipAllowed(req: Request, envName: string): boolean {
  const list = (Deno.env.get(envName) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return list.includes(ip);
}

// read body with a hard size cap
async function readBody(req: Request, max = 8192): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > max) return null;
  const text = await req.text();
  return text.length > max ? null : text;
}

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e7;

async function settings() {
  const { data, error } = await db.from("algo_settings").select("*").eq("id", 1).single();
  if (error) throw new Error("settings");
  return data;
}

// realised (non-paper) P&L since 00:00 UTC — for the daily loss guard
async function todayLoss(): Promise<number> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const { data } = await db.from("algo_trades").select("pnl")
    .eq("paper", false).gte("closed_at", start.toISOString()).not("pnl", "is", null);
  return (data ?? []).reduce((s, r) => s + Number(r.pnl), 0);
}

async function guardDailyLoss(maxLoss: number) {
  if (maxLoss <= 0) return;
  const pnl = await todayLoss();
  if (pnl <= -maxLoss) {
    await db.from("algo_settings").update({ trading_enabled: false, updated_at: new Date().toISOString() }).eq("id", 1);
    await db.from("algo_events").insert({ source: "bridge", event: "daily_loss_stop", payload: { pnl } });
  }
}

// ───────── function ─────────
const SECRET = Deno.env.get("TV_WEBHOOK_SECRET") ?? "";
const STRATS = new Set(["FAST", "TALHA"]);
const EVENTS = new Set(["create", "trigger", "cancel", "modify", "tp", "sl", "be"]);
const REASONS = new Set(["", "expired", "invalid", "missed", "gap", "news", "flip"]);
const ID_RX = /^[A-Z0-9\-]{6,64}$/;
const SYM_RX = /^[A-Z0-9.]{3,20}$/;

type Msg = {
  v: number; key: string; strat: string; ev: string; id: string; side: string; sym?: string;
  entry?: number; sl?: number; tp?: number; reason?: string; ts?: number;
};

function validate(m: Msg): string | null {
  if (m.v !== 1) return "version";
  if (!STRATS.has(m.strat)) return "strat";
  if (!EVENTS.has(m.ev)) return "ev";
  if (typeof m.id !== "string" || !ID_RX.test(m.id)) return "id";
  if (m.side !== "BUY" && m.side !== "SELL") return "side";
  if (m.sym !== undefined && (typeof m.sym !== "string" || !SYM_RX.test(m.sym))) return "sym";
  if (m.reason !== undefined && !REASONS.has(m.reason)) return "reason";
  if (m.ev === "create" || m.ev === "modify") {
    if (!isNum(m.entry) || !isNum(m.sl) || !isNum(m.tp)) return "levels";
    // SL must be on the loss side, TP on the profit side
    const ok = m.side === "SELL" ? (m.sl! > m.entry! && m.tp! < m.entry!) : (m.sl! < m.entry! && m.tp! > m.entry!);
    if (!ok) return "level_sides";
  }
  return null;
}

// broker levels = indicator levels + buffer (entry & TP easier to hit, SL a bit wider)
function withBuffer(side: string, entry: number, sl: number, tp: number, bufPips: number, pip: number) {
  const b = bufPips * pip;
  const r = (x: number) => Math.round(x * 100) / 100;
  return side === "SELL"
    ? { entry: r(entry - b), sl: r(sl + b), tp: r(tp + b) }
    : { entry: r(entry + b), sl: r(sl - b), tp: r(tp - b) };
}

async function queue(trade_id: number, action: string, params: Record<string, unknown>) {
  await db.from("algo_commands").insert({ trade_id, action, params });
}

async function handle(m: Msg) {
  const s = await settings();
  const { data: t } = await db.from("algo_trades").select("*").eq("setup_id", m.id).maybeSingle();

  // ── CREATE: new level → limit order ───────────────────────────────────────
  if (m.ev === "create") {
    if (t) return "duplicate";
    const lots = m.strat === "FAST" ? Number(s.lots_fast) : Number(s.lots_talha);
    const o = withBuffer(m.side, m.entry!, m.sl!, m.tp!, Number(s.buffer_pips), Number(s.pip_size));

    let status = "pending", note: string | null = null;
    let paper = !s.trading_enabled;
    if (!paper) {
      const { count } = await db.from("algo_trades").select("id", { count: "exact", head: true })
        .eq("paper", false).in("status", ["pending", "open"]);
      if ((count ?? 0) >= s.max_open) { status = "rejected"; note = "max open trades reached"; paper = true; }
    }

    const { data: nt, error } = await db.from("algo_trades").insert({
      setup_id: m.id, strategy: m.strat, symbol: m.sym ?? "XAUUSD", side: m.side, status, note, paper,
      sig_entry: m.entry, sig_sl: m.sl, sig_tp: m.tp,
      sig_time: m.ts ? new Date(m.ts).toISOString() : new Date().toISOString(),
      ord_entry: o.entry, ord_sl: o.sl, ord_tp: o.tp, buffer_pips: s.buffer_pips, lots,
    }).select("id").single();
    if (error) throw new Error("insert trade");
    if (!paper) {
      await queue(nt.id, "place", {
        setup_id: m.id, symbol: m.sym ?? "XAUUSD",
        type: m.side === "SELL" ? "SELL_LIMIT" : "BUY_LIMIT",
        price: o.entry, sl: o.sl, tp: o.tp, lots,
      });
    }
    return "created";
  }

  if (!t) return "unknown_setup";

  // ── TRIGGER: OANDA filled E1 (info only — the broker limit order does the job) ─
  if (m.ev === "trigger") {
    await db.from("algo_trades").update({ note: "oanda_trigger", updated_at: new Date().toISOString() }).eq("id", t.id);
    return "noted";
  }

  // ── MODIFY: movable TP / SL → BE (Talha) ──────────────────────────────────
  if (m.ev === "modify") {
    const o = withBuffer(t.side, Number(t.sig_entry), m.sl!, m.tp!, Number(t.buffer_pips), Number(s.pip_size));
    await db.from("algo_trades").update({ sig_sl: m.sl, sig_tp: m.tp, ord_sl: o.sl, ord_tp: o.tp, updated_at: new Date().toISOString() }).eq("id", t.id);
    if (!t.paper && (t.status === "pending" || t.status === "open"))
      await queue(t.id, "modify", { setup_id: t.setup_id, ticket: t.broker_ticket, sl: o.sl, tp: o.tp });
    return "modified";
  }

  // ── CANCEL: expired / invalid / missed / gap … (OANDA is the boss) ─────────
  if (m.ev === "cancel") {
    const reason = m.reason || "cancelled";
    const newStatus = ["expired", "invalid", "missed"].includes(reason) ? reason : "cancelled";
    if (t.status === "pending") {
      await db.from("algo_trades").update({ status: newStatus, close_reason: reason, updated_at: new Date().toISOString() }).eq("id", t.id);
      if (!t.paper) {
        // place not picked up yet → just skip it; otherwise cancel the live order
        await db.from("algo_commands").update({ status: "skipped" }).eq("trade_id", t.id).eq("status", "queued").eq("action", "place");
        await queue(t.id, "cancel", { setup_id: t.setup_id, ticket: t.broker_ticket });
      }
    } else if (t.status === "open" && !t.paper) {
      // filled on the broker but OANDA says the setup is dead → close it
      await db.from("algo_trades").update({ close_reason: "sync:" + reason, updated_at: new Date().toISOString() }).eq("id", t.id);
      await queue(t.id, "close", { setup_id: t.setup_id, ticket: t.broker_ticket });
    }
    return "cancelled";
  }

  // ── TP / SL / BE seen on OANDA ────────────────────────────────────────────
  if (m.ev === "tp" || m.ev === "sl" || m.ev === "be") {
    if (t.paper) {
      // paper trade: book the result from the indicator levels
      const pip = Number(s.pip_size);
      const entry = Number(t.sig_entry);
      const exit = m.ev === "tp" ? Number(t.sig_tp) : m.ev === "sl" ? Number(t.sig_sl) : entry;
      const pips = ((t.side === "SELL" ? entry - exit : exit - entry) / pip);
      await db.from("algo_trades").update({
        status: m.ev, closed_at: new Date().toISOString(), close_price: exit, close_reason: "oanda_" + m.ev,
        pips: Math.round(pips * 10) / 10, pnl: Math.round(pips * Number(t.lots) * 10 * 100) / 100,
        updated_at: new Date().toISOString(),
      }).eq("id", t.id);
    } else if (t.status === "open") {
      // broker still open after OANDA closed (buffer / feed gap) → close to stay in sync
      await queue(t.id, "close", { setup_id: t.setup_id, ticket: t.broker_ticket });
    } else if (t.status === "pending") {
      // OANDA filled & closed but the broker never filled → drop the order
      await db.from("algo_trades").update({ status: "missed", close_reason: "broker_not_filled", updated_at: new Date().toISOString() }).eq("id", t.id);
      await queue(t.id, "cancel", { setup_id: t.setup_id, ticket: t.broker_ticket });
    }
    await guardDailyLoss(Number(s.max_daily_loss));
    return "synced";
  }
  return "ignored";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  if (!SECRET || SECRET.length < 24) return json({ ok: false, err: "server_not_configured" }, 500);
  if (!ipAllowed(req, "TV_ALLOWED_IPS")) return json({ ok: false }, 403);

  const body = await readBody(req);
  if (body === null) return json({ ok: false, err: "too_large" }, 413);

  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 10);
  if (!lines.length) return json({ ok: false, err: "empty" }, 400);

  const results: string[] = [];
  for (const line of lines) {
    let m: Msg;
    try { m = JSON.parse(line); } catch { results.push("bad_json"); continue; }
    if (typeof m?.key !== "string" || !safeEqual(m.key, SECRET)) return json({ ok: false }, 401);

    const { key: _drop, ...clean } = m;                    // never store the secret
    const bad = validate(m);
    if (bad) {
      await db.from("algo_events").insert({ source: "tv", event: "rejected", setup_id: null, ok: false, error: bad, payload: clean });
      results.push("invalid:" + bad);
      continue;
    }

    // idempotency lock: the same (setup, event) is only processed once
    const { data: evRow, error: evErr } = await db.from("algo_events")
      .insert({ source: "tv", event: m.ev, setup_id: m.id, payload: clean }).select("id").single();
    if (evErr) { results.push(evErr.code === "23505" ? "duplicate" : "log_error"); continue; }

    try {
      results.push(await handle(m));
    } catch (e) {
      await db.from("algo_events").update({ ok: false, error: String((e as Error).message).slice(0, 200) }).eq("id", evRow.id);
      results.push("error");
    }
  }
  return json({ ok: true, results });
});
