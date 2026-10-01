// ═══════════════════════════════════════════════════════════════════════════
//  mt5-bridge v2 — the ONLY door for the MT5 EA running on the VPS.
//  The EA polls this endpoint (outbound HTTPS only — MT5 is never exposed).
//
//  Auth: header  Authorization: Bearer <BRIDGE_SECRET>  (constant-time check)
//        + optional BRIDGE_ALLOWED_IPS (put your VPS IP here — strongly advised)
//
//  POST ?op=pull       → { trading, commands:[{id, action, params}] }
//  POST ?op=ack        { id, ok, ticket?, price?, error? }
//  POST ?op=fill       { setup_id, ticket, price, time }
//  POST ?op=close      { setup_id, ticket, price, time, profit, commission, swap, reason }
//  POST ?op=heartbeat  { broker, account, balance, equity, version }
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
const SECRET = Deno.env.get("BRIDGE_SECRET") ?? "";
const ID_RX = /^[A-Z0-9\-]{6,64}$/;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const now = () => new Date().toISOString();
const iso = (t: unknown) => (typeof t === "number" && t > 1e12 && t < 1e14 ? new Date(t).toISOString() : now());

async function log(event: string, setup_id: string | null, payload: unknown, ok = true, error: string | null = null) {
  await db.from("algo_events").insert({ source: "bridge", event, setup_id, payload, ok, error });
}

async function tradeBySetup(setup_id: unknown) {
  if (typeof setup_id !== "string" || !ID_RX.test(setup_id)) return null;
  const { data } = await db.from("algo_trades").select("*").eq("setup_id", setup_id).maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  if (!SECRET || SECRET.length < 24) return json({ ok: false, err: "server_not_configured" }, 500);
  if (!ipAllowed(req, "BRIDGE_ALLOWED_IPS")) return json({ ok: false }, 403);
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), SECRET)) return json({ ok: false }, 401);

  const op = new URL(req.url).searchParams.get("op") ?? "";
  const raw = await readBody(req, 16384);
  if (raw === null) return json({ ok: false, err: "too_large" }, 413);
  let b: Record<string, unknown> = {};
  if (raw.trim()) { try { b = JSON.parse(raw); } catch { return json({ ok: false, err: "bad_json" }, 400); } }

  try {
    // ── PULL: hand out queued commands (and re-send ones never acknowledged) ──
    if (op === "pull") {
      const s = await settings();
      const retryBefore = new Date(Date.now() - 60_000).toISOString();
      const { data: cmds } = await db.from("algo_commands")
        .select("id, action, params, status, attempts, sent_at")
        .or(`status.eq.queued,and(status.eq.sent,sent_at.lt.${retryBefore},attempts.lt.5)`)
        .order("created_at", { ascending: true }).limit(20);
      const list = cmds ?? [];
      // kill switch: with trading OFF only cancels / closes are handed out
      const out = list.filter((c) => s.trading_enabled || c.action === "cancel" || c.action === "close");
      for (const c of out)
        await db.from("algo_commands").update({ status: "sent", sent_at: now(), attempts: c.attempts + 1 }).eq("id", c.id);
      return json({ ok: true, trading: s.trading_enabled, commands: out.map((c) => ({ id: c.id, action: c.action, params: c.params })) });
    }

    // ── ACK: result of a command ──────────────────────────────────────────────
    if (op === "ack") {
      const id = num(b.id);
      if (!id) return json({ ok: false, err: "id" }, 400);
      const { data: c } = await db.from("algo_commands").select("id, trade_id, action").eq("id", id).maybeSingle();
      if (!c) return json({ ok: false, err: "unknown" }, 404);
      const ok = b.ok === true;
      await db.from("algo_commands").update({
        status: ok ? "done" : "failed", done_at: now(),
        result: { ticket: num(b.ticket), price: num(b.price), error: typeof b.error === "string" ? b.error.slice(0, 200) : null },
      }).eq("id", id);
      if (c.action === "place") {
        if (ok && num(b.ticket)) await db.from("algo_trades").update({ broker_ticket: num(b.ticket), updated_at: now() }).eq("id", c.trade_id);
        if (!ok) {
          const errTxt = String(b.error ?? "").slice(0, 120);
          // price already went past the entry before the order arrived → skipped (counts as missed, not an error)
          const missed = errTxt.startsWith("price passed");
          await db.from("algo_trades").update({ status: missed ? "missed" : "error", note: (missed ? "" : "place failed: ") + errTxt, updated_at: now() }).eq("id", c.trade_id);
        }
      }
      await log("ack_" + c.action, null, { id, ok, ticket: num(b.ticket) }, ok, ok ? null : String(b.error ?? "").slice(0, 200));
      return json({ ok: true });
    }

    // ── FILL: limit order filled on the broker ────────────────────────────────
    if (op === "fill") {
      const t = await tradeBySetup(b.setup_id);
      if (!t) return json({ ok: false, err: "unknown_setup" }, 404);
      await db.from("algo_trades").update({
        status: t.status === "pending" ? "open" : t.status,
        broker_ticket: num(b.ticket) ?? t.broker_ticket, fill_price: num(b.price), filled_at: iso(b.time), updated_at: now(),
      }).eq("id", t.id);
      // filled after OANDA already cancelled the setup → close right away
      if (t.status !== "pending" && t.status !== "open")
        await db.from("algo_commands").insert({ trade_id: t.id, action: "close", params: { setup_id: t.setup_id, ticket: num(b.ticket) } });
      await log("fill", t.setup_id, { ticket: num(b.ticket), price: num(b.price) });
      return json({ ok: true });
    }

    // ── CLOSE: position closed on the broker (TP / SL / sync / manual) ────────
    if (op === "close") {
      const t = await tradeBySetup(b.setup_id);
      if (!t) return json({ ok: false, err: "unknown_setup" }, 404);
      const s = await settings();
      const price = num(b.price);
      const pnl = (num(b.profit) ?? 0) + (num(b.commission) ?? 0) + (num(b.swap) ?? 0);
      const fill = Number(t.fill_price ?? t.ord_entry);
      const pips = price !== null ? (t.side === "SELL" ? fill - price : price - fill) / Number(s.pip_size) : null;
      const reason = typeof b.reason === "string" ? b.reason.slice(0, 20) : "unknown";
      // keep an OANDA-driven status (invalid/expired…) — otherwise classify by result
      const keep = ["expired", "invalid", "missed", "cancelled"].includes(t.status);
      const status = keep ? t.status : reason === "tp" ? "tp" : Math.abs(pnl) < 0.5 ? "be" : pnl > 0 ? "tp" : "sl";
      await db.from("algo_trades").update({
        status, closed_at: iso(b.time), close_price: price,
        pips: pips === null ? null : Math.round(pips * 10) / 10, pnl: Math.round(pnl * 100) / 100,
        close_reason: t.close_reason ?? reason, updated_at: now(),
      }).eq("id", t.id);
      await log("close", t.setup_id, { ticket: num(b.ticket), price, pnl, reason });
      await guardDailyLoss(Number(s.max_daily_loss));
      return json({ ok: true });
    }

    // ── HEARTBEAT: bridge alive + account snapshot ────────────────────────────
    if (op === "heartbeat") {
      const acc = typeof b.account === "string" ? "••••" + b.account.slice(-4) : null;   // never store the full login
      await db.from("algo_bridge").update({
        last_seen: now(), broker: typeof b.broker === "string" ? b.broker.slice(0, 60) : null, account: acc,
        balance: num(b.balance), equity: num(b.equity), version: typeof b.version === "string" ? b.version.slice(0, 20) : null,
      }).eq("id", "main");
      return json({ ok: true });
    }

    return json({ ok: false, err: "op" }, 400);
  } catch (e) {
    await log("error", null, { op }, false, String((e as Error).message).slice(0, 200));
    return json({ ok: false, err: "server" }, 500);
  }
});
