// ═══════════════════════════════════════════════════════════════════════════
//  tv-webhook v2 — TradingView alerts (OANDA chart) → trades + MT5 commands
//  Strategies: MAHI (M3) · M5 · FAST (M15) · TALHA (H1) · SHARP (H4)
//  One setup = one group (gid) with 1–3 legs (entries). Each leg = its own order.
//
//  Body: one JSON object per line. Common fields:
//   {"v":2,"key":"<TV_WEBHOOK_SECRET>","strat":"MAHI","tf":"M3","ev":"create","gid":"MAHI-S-1727000000000",
//    "side":"SELL","sym":"XAUUSD","ts":1727000000000, ...}
//   create : "legs":[{"n":1,"e":4048.8,"sl":4054.8,"tp":4044.8},{"n":2,"e":4049.3,"sl":4054.8,"tp":4037.3}]
//   cancel : "reason":"expired|invalid|missed|gap"
//   modify : "tp":4040.0 (and optional "sl")
//   result : "res":"tp|sl|be|tp1", "legs":[{"n":1,"f":1,"x":4044.8},{"n":2,"f":0,"x":0}]
//   pause / resume : pending orders taken off / put back (session window)
//   trigger / tp1  : info only
//
//  Security: shared secret (constant time), optional TradingView IP allow-list, 8 KB cap,
//  strict validation, idempotent, the key is never stored.
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const SECRET = Deno.env.get("TV_WEBHOOK_SECRET") ?? "";
const STRATS = new Set(["MAHI", "M5", "FAST", "TALHA", "SHARP"]);
const EVENTS = new Set(["create", "trigger", "cancel", "modify", "result", "tp1", "pause", "resume"]);
const REASONS = new Set(["", "expired", "invalid", "missed", "gap", "flip"]);
const RESULTS = new Set(["tp", "sl", "be", "tp1"]);
const GID_RX = /^[A-Z0-9\-]{8,48}$/;
const SYM_RX = /^[A-Z0-9.]{3,20}$/;
const TF_RX = /^[A-Z0-9]{1,8}$/;
const PIP = 0.10;     // gold

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const now = () => new Date().toISOString();
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e7;
const r2 = (x: number) => Math.round(x * 100) / 100;

function safeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let d = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) d |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return d === 0;
}
function ipAllowed(req: Request) {
  const list = (Deno.env.get("TV_ALLOWED_IPS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  return list.includes((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim());
}

type Leg = { n: number; e?: number; sl?: number; tp?: number; f?: number; x?: number };
type Msg = { v: number; key: string; strat: string; tf?: string; ev: string; gid: string; side: string; sym?: string;
  legs?: Leg[]; reason?: string; res?: string; tp?: number; sl?: number; ts?: number };

function validate(m: Msg): string | null {
  if (m.v !== 2) return "version";
  if (!STRATS.has(m.strat)) return "strat";
  if (!EVENTS.has(m.ev)) return "ev";
  if (typeof m.gid !== "string" || !GID_RX.test(m.gid)) return "gid";
  if (m.side !== "BUY" && m.side !== "SELL") return "side";
  if (m.sym !== undefined && (typeof m.sym !== "string" || !SYM_RX.test(m.sym))) return "sym";
  if (m.tf !== undefined && (typeof m.tf !== "string" || !TF_RX.test(m.tf))) return "tf";
  if (m.reason !== undefined && !REASONS.has(m.reason)) return "reason";
  if (m.ev === "create") {
    if (!Array.isArray(m.legs) || m.legs.length < 1 || m.legs.length > 3) return "legs";
    for (const l of m.legs) {
      if (![1, 2, 3].includes(l.n) || !isNum(l.e) || !isNum(l.sl) || !isNum(l.tp)) return "leg_values";
      const ok = m.side === "SELL" ? (l.sl! > l.e! && l.tp! < l.e!) : (l.sl! < l.e! && l.tp! > l.e!);
      if (!ok) return "leg_sides";
    }
  }
  if (m.ev === "modify" && !isNum(m.tp)) return "modify_tp";
  if (m.ev === "modify" && m.sl !== undefined && !isNum(m.sl)) return "modify_sl";
  if (m.ev === "result") {
    if (!RESULTS.has(m.res ?? "")) return "res";
    if (!Array.isArray(m.legs) || m.legs.length < 1 || m.legs.length > 3) return "legs";
    for (const l of m.legs) if (![1, 2, 3].includes(l.n) || typeof l.f !== "number" || typeof l.x !== "number") return "leg_result";
  }
  return null;
}

// broker levels = indicator levels ± buffer (entry & TP easier to hit, SL a bit wider)
function buf(side: string, e: number, sl: number, tp: number, pips: number) {
  const b = pips * PIP;
  return side === "SELL" ? { e: r2(e - b), sl: r2(sl + b), tp: r2(tp + b) } : { e: r2(e + b), sl: r2(sl - b), tp: r2(tp - b) };
}
const q = (trade_id: number, action: string, params: Record<string, unknown>) =>
  db.from("algo_commands").insert({ trade_id, action, params });

async function settings() {
  const { data, error } = await db.from("algo_settings").select("*").eq("id", 1).single();
  if (error) throw new Error("settings");
  return data;
}

async function handle(m: Msg) {
  const s = await settings();
  const { data: legs } = await db.from("algo_trades").select("*").eq("group_id", m.gid).order("leg");
  const rows = legs ?? [];

  // ── CREATE: one limit order per leg ─────────────────────────────────────────
  if (m.ev === "create") {
    if (rows.length) return "duplicate";
    const lots = Number((s.lots ?? {})[m.strat] ?? 0.01);
    const stratOn = (s.enabled ?? {})[m.strat] !== false;
    let paper = !s.trading_enabled || !stratOn;
    let status = "pending", note: string | null = null;
    if (!paper) {
      const { count } = await db.from("algo_trades").select("id", { count: "exact", head: true })
        .eq("paper", false).in("status", ["pending", "open"]);
      if ((count ?? 0) + m.legs!.length > s.max_open) { status = "rejected"; note = "max open trades reached"; paper = true; }
    }
    for (const l of m.legs!) {
      const o = buf(m.side, l.e!, l.sl!, l.tp!, Number(s.buffer_pips));
      const { data: t, error } = await db.from("algo_trades").insert({
        setup_id: `${m.gid}-${l.n}`, group_id: m.gid, leg: l.n, strategy: m.strat, tf: m.tf ?? null,
        symbol: m.sym ?? "XAUUSD", side: m.side, status, note, paper,
        sig_entry: l.e, sig_sl: l.sl, sig_tp: l.tp, sig_time: m.ts ? new Date(m.ts).toISOString() : now(),
        ord_entry: o.e, ord_sl: o.sl, ord_tp: o.tp, buffer_pips: s.buffer_pips, lots,
      }).select("id").single();
      if (error) throw new Error("insert");
      if (!paper)
        await q(t.id, "place", { setup_id: `${m.gid}-${l.n}`, symbol: m.sym ?? "XAUUSD",
          type: m.side === "SELL" ? "SELL_LIMIT" : "BUY_LIMIT", price: o.e, sl: o.sl, tp: o.tp, lots });
    }
    return "created";
  }
  if (!rows.length) return "unknown_setup";

  // ── info events ─────────────────────────────────────────────────────────────
  if (m.ev === "trigger" || m.ev === "tp1") return "noted";

  // ── CANCEL: expired / invalid / missed / gap (OANDA is the boss) ───────────
  if (m.ev === "cancel") {
    const reason = m.reason || "cancelled";
    const st = ["expired", "invalid", "missed"].includes(reason) ? reason : "cancelled";
    for (const t of rows) {
      if (t.status === "pending") {
        await db.from("algo_trades").update({ status: st, close_reason: reason, updated_at: now() }).eq("id", t.id);
        if (!t.paper) {
          await db.from("algo_commands").update({ status: "skipped" }).eq("trade_id", t.id).eq("status", "queued").eq("action", "place");
          await q(t.id, "cancel", { setup_id: t.setup_id, ticket: t.broker_ticket });
        }
      } else if (t.status === "open" && !t.paper) {
        await db.from("algo_trades").update({ close_reason: "sync:" + reason, updated_at: now() }).eq("id", t.id);
        await q(t.id, "close", { setup_id: t.setup_id, ticket: t.broker_ticket });
      }
    }
    return "cancelled";
  }

  // ── MODIFY: movable TP (Sharp) ──────────────────────────────────────────────
  if (m.ev === "modify") {
    for (const t of rows) {
      if (t.status !== "pending" && t.status !== "open") continue;
      const o = buf(t.side, Number(t.sig_entry), m.sl ?? Number(t.sig_sl), m.tp!, Number(t.buffer_pips));
      await db.from("algo_trades").update({ sig_tp: m.tp, sig_sl: m.sl ?? t.sig_sl, ord_tp: o.tp, ord_sl: o.sl, updated_at: now() }).eq("id", t.id);
      if (!t.paper) await q(t.id, "modify", { setup_id: t.setup_id, ticket: t.broker_ticket, sl: o.sl, tp: o.tp });
    }
    return "modified";
  }

  // ── PAUSE / RESUME: take pending orders off before the close, put them back after ──
  if (m.ev === "pause" || m.ev === "resume") {
    for (const t of rows) {
      if (t.paper || t.status !== "pending") continue;
      if (m.ev === "pause" && !t.paused) {
        await db.from("algo_trades").update({ paused: true, updated_at: now() }).eq("id", t.id);
        await q(t.id, "cancel", { setup_id: t.setup_id, ticket: t.broker_ticket });
      } else if (m.ev === "resume" && t.paused) {
        await db.from("algo_trades").update({ paused: false, updated_at: now() }).eq("id", t.id);
        await q(t.id, "place", { setup_id: t.setup_id, symbol: t.symbol, type: t.side === "SELL" ? "SELL_LIMIT" : "BUY_LIMIT",
          price: Number(t.ord_entry), sl: Number(t.ord_sl), tp: Number(t.ord_tp), lots: Number(t.lots) });
      }
    }
    return m.ev;
  }

  // ── RESULT: the setup finished on OANDA ─────────────────────────────────────
  if (m.ev === "result") {
    for (const t of rows) {
      const l = m.legs!.find((x) => x.n === t.leg);
      if (t.paper) {
        if (t.status !== "pending" && t.status !== "open") continue;
        if (!l || !l.f) {
          await db.from("algo_trades").update({ status: "cancelled", close_reason: "not filled", updated_at: now() }).eq("id", t.id);
          continue;
        }
        const e = Number(t.sig_entry), x = Number(l.x);
        const pips = (t.side === "SELL" ? e - x : x - e) / PIP;
        const st = Math.abs(pips) < 0.5 ? "be" : pips > 0 ? "tp" : "sl";
        await db.from("algo_trades").update({
          status: st, closed_at: now(), close_price: x, close_reason: "oanda_" + m.res,
          pips: Math.round(pips * 10) / 10, pnl: r2(pips * Number(t.lots) * 10), updated_at: now(),
        }).eq("id", t.id);
      } else if (t.status === "open") {
        await q(t.id, "close", { setup_id: t.setup_id, ticket: t.broker_ticket });          // stay in sync with OANDA
      } else if (t.status === "pending") {
        await db.from("algo_trades").update({ status: "cancelled", close_reason: "not filled", updated_at: now() }).eq("id", t.id);
        await q(t.id, "cancel", { setup_id: t.setup_id, ticket: t.broker_ticket });
      }
    }
    return "result";
  }
  return "ignored";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  if (!SECRET || SECRET.length < 24) return json({ ok: false, err: "server_not_configured" }, 500);
  if (!ipAllowed(req)) return json({ ok: false }, 403);
  if (Number(req.headers.get("content-length") ?? "0") > 8192) return json({ ok: false }, 413);
  const body = await req.text();
  if (body.length > 8192) return json({ ok: false }, 413);

  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 12);
  if (!lines.length) return json({ ok: false, err: "empty" }, 400);

  const out: string[] = [];
  for (const line of lines) {
    let m: Msg;
    try { m = JSON.parse(line); } catch { out.push("bad_json"); continue; }
    if (typeof m?.key !== "string" || !safeEqual(m.key, SECRET)) return json({ ok: false }, 401);
    const { key: _k, ...clean } = m;                       // never store the secret
    const bad = validate(m);
    if (bad) {
      await db.from("algo_events").insert({ source: "tv", event: "rejected", ok: false, error: bad, payload: clean });
      out.push("invalid:" + bad);
      continue;
    }
    const { data: ev, error } = await db.from("algo_events")
      .insert({ source: "tv", event: m.ev, setup_id: m.gid, payload: clean }).select("id").single();
    if (error) { out.push(error.code === "23505" ? "duplicate" : "log_error"); continue; }
    try { out.push(await handle(m)); }
    catch (e) {
      await db.from("algo_events").update({ ok: false, error: String((e as Error).message).slice(0, 200) }).eq("id", ev.id);
      out.push("error");
    }
  }
  return json({ ok: true, results: out });
});
