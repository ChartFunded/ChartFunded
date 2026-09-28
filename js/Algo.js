// Chart Funded · Algo Desk (admin only)
// Reads trades / events through Supabase RLS (admins = read-only).
// The only writes are 2 server-validated RPCs: kill switch + settings.
(() => {
  "use strict";
  const C = window.CF_CONFIG;
  const $ = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);

  let trades = [], events = [], settings = null, bridge = null, timer = null;

  // ---------- helpers (XSS safe: textContent only) ----------
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const td = (text, cls) => el("td", text, cls);
  const money = (v) => (v == null ? "—" : (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2));
  const num = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
  const dt = (s) => (s ? new Date(s).toLocaleString() : "—");
  const err = (id, m) => { $(id).textContent = m || ""; };
  const show = (v) => { $("loginView").hidden = v !== "login"; $("deskView").hidden = v !== "desk"; $("admNav").hidden = v !== "desk"; };

  // ---------- auth ----------
  $("loginView").addEventListener("submit", async (e) => {
    e.preventDefault(); err("loginErr"); $("loginBtn").disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    $("password").value = ""; $("loginBtn").disabled = false;
    if (error) { err("loginErr", "Email or password is wrong."); return; }
    await enter();
  });
  $("logoutBtn").addEventListener("click", async () => {
    clearInterval(timer); await sb.auth.signOut(); trades = []; events = []; show("login");
  });

  async function enter() {
    const { data: ok, error } = await sb.rpc("wl_is_admin");
    if (error || ok !== true) { await sb.auth.signOut(); show("login"); err("loginErr", "This account doesn't have admin access."); return; }
    show("desk"); await load();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) load(); }, 30000);
  }

  // ---------- data ----------
  async function load() {
    err("deskErr");
    const range = Number($("fRange").value);
    let q = sb.from("algo_trades").select("*").order("created_at", { ascending: true }).limit(5000);
    if (range > 0) q = q.gte("created_at", new Date(Date.now() - range * 864e5).toISOString());
    const [t, s, b, ev] = await Promise.all([
      q,
      sb.from("algo_settings").select("*").eq("id", 1).single(),
      sb.from("algo_bridge").select("*").eq("id", "main").single(),
      sb.from("algo_events").select("received_at,source,event,setup_id,ok,error").order("received_at", { ascending: false }).limit(50),
    ]);
    if (t.error || s.error) { err("deskErr", "Couldn't load data. Log in again."); return; }
    trades = t.data; settings = s.data; bridge = b.data; events = ev.data || [];
    render();
  }

  const CLOSED = new Set(["tp", "sl", "be"]);
  function filtered() {
    const st = $("fStrat").value, md = $("fMode").value;
    return trades.filter((r) => (st === "all" || r.strategy === st) && (md === "all" || (md === "paper" ? r.paper : !r.paper)));
  }

  function stats(list) {
    const done = list.filter((r) => CLOSED.has(r.status));
    const tp = done.filter((r) => r.status === "tp").length;
    const sl = done.filter((r) => r.status === "sl").length;
    const be = done.filter((r) => r.status === "be").length;
    const pnls = done.map((r) => Number(r.pnl || 0));
    const gp = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const gl = pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0);
    let eq = 0, peak = 0, dd = 0;
    const curve = done.slice().sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at)).map((r) => {
      eq += Number(r.pnl || 0); peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); return eq;
    });
    const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p < 0);
    return {
      setups: list.length, trades: done.length, tp, sl, be,
      wr: tp + sl ? (tp * 100) / (tp + sl) : null,
      net: gp + gl, pf: gl < 0 ? gp / -gl : gp > 0 ? Infinity : null, dd, curve,
      avgW: wins.length ? gp / wins.length : null, avgL: losses.length ? gl / losses.length : null,
      open: list.filter((r) => r.status === "open").length, pending: list.filter((r) => r.status === "pending").length,
      skipped: list.filter((r) => ["expired", "invalid", "missed", "cancelled", "rejected", "error"].includes(r.status)).length,
    };
  }

  // ---------- render ----------
  function render() {
    // controls
    const on = !!settings.trading_enabled;
    $("tradeBtn").textContent = on ? "Trading: ON" : "Trading: OFF (paper)";
    $("tradeBtn").className = "btn " + (on ? "on" : "off");
    const age = bridge && bridge.last_seen ? (Date.now() - new Date(bridge.last_seen)) / 1000 : Infinity;
    const live = age < 90;
    $("bridgePill").textContent = "Bridge · " + (live ? "online" : "offline");
    $("bridgePill").className = "pill " + (live ? "on" : "off");
    $("bridgeInfo").textContent = bridge && bridge.last_seen
      ? `${bridge.broker || "broker"} · ${bridge.account || ""} · balance ${num(bridge.balance)} · equity ${num(bridge.equity)} · last seen ${dt(bridge.last_seen)}`
      : "MT5 bridge has not connected yet.";

    const list = filtered(), s = stats(list);

    // KPIs
    const k = [
      ["Setups", s.setups], ["Trades", s.trades], ["Win rate", s.wr == null ? "—" : s.wr.toFixed(1) + "%", s.wr == null ? "" : s.wr >= 50 ? "pos" : "neg"],
      ["TP", s.tp, "pos"], ["SL", s.sl, "neg"], ["BE", s.be],
      ["Net P&L", money(s.net), s.net >= 0 ? "pos" : "neg"],
      ["Profit factor", s.pf == null ? "—" : s.pf === Infinity ? "∞" : s.pf.toFixed(2)],
      ["Max drawdown", "$" + s.dd.toFixed(2), s.dd > 0 ? "neg" : ""],
      ["Avg win", money(s.avgW)], ["Avg loss", money(s.avgL)],
      ["Open · Pending", s.open + " · " + s.pending], ["Skipped", s.skipped],
    ];
    const kf = document.createDocumentFragment();
    k.forEach(([t, v, c]) => { const d = el("dl", null, "kpi"); d.append(el("dt", t), el("dd", String(v), c || "")); kf.append(d); });
    $("kpis").replaceChildren(kf);

    drawCurve(s.curve);

    // per strategy
    const sf = document.createDocumentFragment();
    [["FAST", "Fast Track (M30)"], ["TALHA", "Talha Sniper (H1)"]].forEach(([code, name]) => {
      const md = $("fMode").value;
      const x = stats(trades.filter((r) => r.strategy === code && (md === "all" || (md === "paper" ? r.paper : !r.paper))));
      const tr = el("tr");
      tr.append(td(name), td(String(x.trades)), td(String(x.tp)), td(String(x.sl)), td(String(x.be)),
        td(x.wr == null ? "—" : x.wr.toFixed(1) + "%"), td(money(x.net), x.net >= 0 ? "pos" : "neg"),
        td(x.pf == null ? "—" : x.pf === Infinity ? "∞" : x.pf.toFixed(2)));
      sf.append(tr);
    });
    $("stratRows").replaceChildren(sf);

    // open & pending
    const of = document.createDocumentFragment();
    list.filter((r) => r.status === "open" || r.status === "pending").reverse().forEach((r) => {
      const tr = el("tr");
      tr.append(td(r.setup_id), td(r.strategy), td(r.side), td(r.status), td(num(r.ord_entry)), td(num(r.ord_sl)), td(num(r.ord_tp)),
        td(num(r.lots)), td(r.broker_ticket ? String(r.broker_ticket) : "—"), td(dt(r.created_at)));
      of.append(tr);
    });
    $("openRows").replaceChildren(of);

    // history (closed + skipped), newest first
    const hist = list.filter((r) => r.status !== "open" && r.status !== "pending")
      .sort((a, b) => new Date(b.closed_at || b.updated_at) - new Date(a.closed_at || a.updated_at)).slice(0, 200);
    $("histNote").textContent = hist.length + " shown";
    const hf = document.createDocumentFragment();
    hist.forEach((r) => {
      const tr = el("tr");
      const res = el("td"); res.append(el("span", r.status.toUpperCase(), "res " + (CLOSED.has(r.status) ? r.status : "other")));
      tr.append(td(dt(r.closed_at || r.updated_at)), td(r.strategy), td(r.side), res,
        td(num(r.fill_price ?? r.sig_entry)), td(num(r.close_price)), td(r.pips == null ? "—" : num(r.pips, 1)),
        td(money(r.pnl), r.pnl > 0 ? "pos" : r.pnl < 0 ? "neg" : ""), td(r.paper ? "paper" : "live"), td(r.close_reason || r.note || "—"));
      hf.append(tr);
    });
    $("histRows").replaceChildren(hf);

    // events
    const ef = document.createDocumentFragment();
    events.forEach((e) => {
      const tr = el("tr");
      tr.append(td(dt(e.received_at)), td(e.source), td(e.event), td(e.setup_id || "—"), td(e.ok ? "✓" : "✗", e.ok ? "pos" : "neg"), td(e.error || ""));
      ef.append(tr);
    });
    $("evRows").replaceChildren(ef);
  }

  // simple SVG equity curve (no external libraries → CSP stays strict)
  function drawCurve(curve) {
    const svg = $("eqSvg"), NS = "http://www.w3.org/2000/svg";
    svg.replaceChildren();
    const pts = [0, ...curve];
    $("eqNote").textContent = curve.length ? curve.length + " closed trades" : "no closed trades yet";
    if (pts.length < 2) return;
    const W = 800, H = 220, P = 10;
    const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
    const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
    const y = (v) => H - P - ((v - lo) * (H - 2 * P)) / span;
    const zero = document.createElementNS(NS, "line");
    zero.setAttribute("x1", P); zero.setAttribute("x2", W - P); zero.setAttribute("y1", y(0)); zero.setAttribute("y2", y(0));
    zero.setAttribute("stroke", "#1B3A73"); zero.setAttribute("stroke-dasharray", "4 4");
    const path = document.createElementNS(NS, "polyline");
    path.setAttribute("points", pts.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" "));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", pts[pts.length - 1] >= 0 ? "#43D9A0" : "#FF7A88");
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(zero, path);
  }

  // ---------- controls ----------
  $("tradeBtn").addEventListener("click", async () => {
    const turnOn = !settings.trading_enabled;
    const msg = turnOn
      ? "Turn LIVE trading ON? New levels will place real orders on the broker."
      : "Turn trading OFF? New levels will only be logged (paper). Open trades keep their SL/TP.";
    if (!window.confirm(msg)) return;
    $("tradeBtn").disabled = true;
    const { error } = await sb.rpc("algo_set_trading", { p_enabled: turnOn });
    $("tradeBtn").disabled = false;
    if (error) { err("deskErr", "Couldn't change trading. Your session may have expired."); return; }
    await load();
  });

  $("setBtn").addEventListener("click", () => {
    $("sBuf").value = settings.buffer_pips; $("sLf").value = settings.lots_fast; $("sLt").value = settings.lots_talha;
    $("sMo").value = settings.max_open; $("sDl").value = settings.max_daily_loss;
    $("setBox").hidden = !$("setBox").hidden;
  });
  $("setCancel").addEventListener("click", () => { $("setBox").hidden = true; });
  $("setBox").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = { p_buffer: +$("sBuf").value, p_lots_fast: +$("sLf").value, p_lots_talha: +$("sLt").value, p_max_open: Math.round(+$("sMo").value), p_max_daily_loss: +$("sDl").value };
    if (Object.values(v).some((n) => !Number.isFinite(n) || n < 0)) { err("deskErr", "Settings must be positive numbers."); return; }
    $("setSave").disabled = true;
    const { error } = await sb.rpc("algo_update_settings", v);
    $("setSave").disabled = false;
    if (error) { err("deskErr", "Settings rejected (out of range or session expired)."); return; }
    $("setBox").hidden = true; await load();
  });

  ["fStrat", "fMode"].forEach((id) => $(id).addEventListener("change", render));
  $("fRange").addEventListener("change", load);
  $("reloadBtn").addEventListener("click", load);

  // CSV (formula-injection safe)
  $("csvBtn").addEventListener("click", () => {
    const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const head = ["setup_id", "strategy", "side", "status", "paper", "sig_entry", "sig_sl", "sig_tp", "ord_entry", "ord_sl", "ord_tp", "lots",
      "broker_ticket", "fill_price", "filled_at", "close_price", "closed_at", "pips", "pnl", "close_reason", "created_at"];
    const lines = [head.join(",")].concat(filtered().map((r) => head.map((h) => cell(r[h])).join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "chartfunded-algo-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------- start ----------
  (async () => {
    const { data } = await sb.auth.getSession();
    if (data && data.session) await enter(); else show("login");
  })();
})();
