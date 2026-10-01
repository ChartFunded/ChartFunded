// Chart Funded · Algo Desk v2 (admin only) — all strategies, results per setup
// Reads through Supabase RLS (admins = read-only). Only writes: 2 server-validated RPCs.
(() => {
  "use strict";
  const C = window.CF_CONFIG;
  const $ = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const STRATS = [["MAHI", "Mahi M3 (3m)"], ["M5", "M5 Money Bhai (5m)"], ["FAST", "Fast Track (15m)"], ["TALHA", "Talha Sniper (1H)"], ["SHARP", "Sharp Zone (4H)"]];

  let legs = [], events = [], settings = null, bridge = null, timer = null;

  // ---------- helpers (XSS safe: textContent only) ----------
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const td = (text, cls) => el("td", text, cls);
  const money = (v) => (v == null ? "—" : (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2));
  const num = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
  const dt = (s) => (s ? new Date(s).toLocaleString() : "—");
  const err = (id, m) => { $(id).textContent = m || ""; };
  const show = (v) => { $("loginView").hidden = v !== "login"; $("deskView").hidden = v !== "desk"; $("admNav").hidden = v !== "desk"; };
  const DONE = new Set(["tp", "sl", "be"]);
  const SKIP = new Set(["expired", "invalid", "missed", "cancelled", "rejected", "error"]);

  // ---------- auth ----------
  $("loginView").addEventListener("submit", async (e) => {
    e.preventDefault(); err("loginErr"); $("loginBtn").disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    $("password").value = ""; $("loginBtn").disabled = false;
    if (error) { err("loginErr", "Email or password is wrong."); return; }
    await enter();
  });
  $("logoutBtn").addEventListener("click", async () => { clearInterval(timer); await sb.auth.signOut(); legs = []; events = []; show("login"); });

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
    let q = sb.from("algo_trades").select("*").order("created_at", { ascending: true }).limit(10000);
    if (range > 0) q = q.gte("created_at", new Date(Date.now() - range * 864e5).toISOString());
    const [t, s, b, ev] = await Promise.all([
      q,
      sb.from("algo_settings").select("*").eq("id", 1).single(),
      sb.from("algo_bridge").select("*").eq("id", "main").single(),
      sb.from("algo_events").select("received_at,source,event,setup_id,ok,error").order("received_at", { ascending: false }).limit(50),
    ]);
    if (t.error || s.error) { err("deskErr", "Couldn't load data. Log in again."); return; }
    legs = t.data; settings = s.data; bridge = b.data; events = ev.data || [];
    render();
  }

  // legs → setups (one row per setup / group)
  function groups(list) {
    const map = new Map();
    for (const r of list) {
      const g = r.group_id || r.setup_id;
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(r);
    }
    const out = [];
    for (const [gid, ls] of map) {
      ls.sort((a, b) => (a.leg || 1) - (b.leg || 1));
      const l1 = ls[0];
      const filled = ls.filter((r) => DONE.has(r.status));
      const live = ls.some((r) => r.status === "open" || r.status === "pending");
      // setup result follows entry 1: TP = win, SL = loss (entry 2 at BE still counts as a win)
      // "be" = entry 1 hit TP1 and entry 2 closed at break-even (still a win)
      let res = live ? (ls.some((r) => r.status === "open") ? "open" : "pending") : l1.status;
      if (!live && l1.status === "tp" && ls.some((r) => r.status === "be")) res = "be";
      out.push({
        gid, strategy: l1.strategy, side: l1.side, paper: l1.paper, res, legs: ls,
        nFilled: filled.length,
        pips: filled.reduce((a, r) => a + Number(r.pips || 0), 0),
        pnl: filled.reduce((a, r) => a + Number(r.pnl || 0), 0),
        closed: ls.map((r) => r.closed_at || r.updated_at).sort().pop(),
        created: l1.created_at, note: ls.map((r) => r.close_reason || r.note).filter(Boolean)[0] || "",
      });
    }
    return out;
  }

  function filtered() {
    const st = $("fStrat").value, md = $("fMode").value;
    return legs.filter((r) => (st === "all" || r.strategy === st) && (md === "all" || (md === "paper" ? r.paper : !r.paper)));
  }

  function stats(gs) {
    const done = gs.filter((g) => DONE.has(g.res) && g.nFilled > 0);
    const win = done.filter((g) => g.res === "tp" || g.res === "be").length;
    const sl = done.filter((g) => g.res === "sl").length;
    const gp = done.filter((g) => g.pnl > 0).reduce((a, g) => a + g.pnl, 0);
    const gl = done.filter((g) => g.pnl < 0).reduce((a, g) => a + g.pnl, 0);
    let eq = 0, peak = 0, dd = 0;
    const curve = done.slice().sort((a, b) => new Date(a.closed) - new Date(b.closed)).map((g) => {
      eq += g.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); return eq;
    });
    const wins = done.filter((g) => g.pnl > 0), losses = done.filter((g) => g.pnl < 0);
    return {
      setups: gs.length, traded: done.length, win, sl,
      tp: done.filter((g) => g.res === "tp").length, be: done.filter((g) => g.res === "be").length,
      wr: win + sl ? (win * 100) / (win + sl) : null,
      net: gp + gl, pf: gl < 0 ? gp / -gl : gp > 0 ? Infinity : null, dd, curve,
      avgW: wins.length ? gp / wins.length : null, avgL: losses.length ? gl / losses.length : null,
      open: gs.filter((g) => g.res === "open").length, pending: gs.filter((g) => g.res === "pending").length,
      skipped: gs.filter((g) => SKIP.has(g.res)).length,
    };
  }

  // ---------- render ----------
  function render() {
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

    const gs = groups(filtered()), s = stats(gs);

    const k = [
      ["Setups", s.setups], ["Traded", s.traded], ["Win rate", s.wr == null ? "—" : s.wr.toFixed(1) + "%", s.wr == null ? "" : s.wr >= 50 ? "pos" : "neg"],
      ["Wins (TP)", s.tp, "pos"], ["Wins (TP1 + BE)", s.be], ["SL", s.sl, "neg"],
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
    const md = $("fMode").value;
    const sf = document.createDocumentFragment();
    STRATS.forEach(([code, name]) => {
      const x = stats(groups(legs.filter((r) => r.strategy === code && (md === "all" || (md === "paper" ? r.paper : !r.paper)))));
      const onS = (settings.enabled || {})[code] !== false;
      const tr = el("tr");
      tr.append(td(name), td(String(x.traded)), td(String(x.win)), td(String(x.sl)),
        td(x.wr == null ? "—" : x.wr.toFixed(1) + "%"), td(money(x.net), x.net >= 0 ? "pos" : "neg"),
        td(x.pf == null ? "—" : x.pf === Infinity ? "∞" : x.pf.toFixed(2)), td(onS ? "ON" : "OFF (paper)", onS ? "tag-on" : "tag-off"));
      sf.append(tr);
    });
    $("stratRows").replaceChildren(sf);

    // open & pending (per entry)
    const of = document.createDocumentFragment();
    filtered().filter((r) => r.status === "open" || r.status === "pending").reverse().forEach((r) => {
      const tr = el("tr");
      tr.append(td(r.group_id || r.setup_id), td(r.strategy), td("E" + (r.leg || 1)), td(r.side), td(r.status + (r.paused ? " (paused)" : "")),
        td(num(r.ord_entry)), td(num(r.ord_sl)), td(num(r.ord_tp)), td(num(r.lots)),
        td(r.broker_ticket ? String(r.broker_ticket) : "—"), td(dt(r.created_at)));
      of.append(tr);
    });
    $("openRows").replaceChildren(of);

    // history per setup
    const hist = gs.filter((g) => g.res !== "open" && g.res !== "pending")
      .sort((a, b) => new Date(b.closed) - new Date(a.closed)).slice(0, 200);
    $("histNote").textContent = hist.length + " shown";
    const hf = document.createDocumentFragment();
    hist.forEach((g) => {
      const tr = el("tr");
      const label = g.res === "be" ? "TP1 + BE" : g.res.toUpperCase();
      const res = el("td"); res.append(el("span", label, "res " + (DONE.has(g.res) ? g.res : "other")));
      tr.append(td(dt(g.closed)), td(g.strategy), td(g.side), res, td(g.nFilled + " / " + g.legs.length),
        td(g.nFilled ? num(g.pips, 1) : "—"), td(g.nFilled ? money(g.pnl) : "—", g.pnl > 0 ? "pos" : g.pnl < 0 ? "neg" : ""),
        td(g.paper ? "paper" : "live"), td(g.note || "—"));
      hf.append(tr);
    });
    $("histRows").replaceChildren(hf);

    const ef = document.createDocumentFragment();
    events.forEach((e) => {
      const tr = el("tr");
      tr.append(td(dt(e.received_at)), td(e.source), td(e.event), td(e.setup_id || "—"), td(e.ok ? "✓" : "✗", e.ok ? "pos" : "neg"), td(e.error || ""));
      ef.append(tr);
    });
    $("evRows").replaceChildren(ef);
  }

  function drawCurve(curve) {
    const svg = $("eqSvg"), NS = "http://www.w3.org/2000/svg";
    svg.replaceChildren();
    const pts = [0, ...curve];
    $("eqNote").textContent = curve.length ? curve.length + " finished setups" : "no finished setups yet";
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
    const msg = turnOn ? "Turn LIVE trading ON? New levels will place real orders on the broker."
                       : "Turn trading OFF? New levels will only be logged (paper). Open trades keep their SL/TP.";
    if (!window.confirm(msg)) return;
    $("tradeBtn").disabled = true;
    const { error } = await sb.rpc("algo_set_trading", { p_enabled: turnOn });
    $("tradeBtn").disabled = false;
    if (error) { err("deskErr", "Couldn't change trading. Your session may have expired."); return; }
    await load();
  });

  function buildStratSettings() {
    const box = document.createDocumentFragment();
    STRATS.forEach(([code, name]) => {
      const wrap = el("div", null, "strat-set");
      wrap.append(el("b", name));
      const r1 = el("label", null, "row");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.id = "on_" + code;
      cb.checked = (settings.enabled || {})[code] !== false;
      r1.append(cb, document.createTextNode("Live trading"));
      const r2 = el("label", null, "row");
      const lot = document.createElement("input"); lot.type = "number"; lot.min = "0"; lot.max = "1"; lot.step = "0.01"; lot.id = "lot_" + code;
      lot.value = String((settings.lots || {})[code] ?? 0.01);
      r2.append(document.createTextNode("Lot per entry"), lot);
      wrap.append(r1, r2);
      box.append(wrap);
    });
    $("stratSet").replaceChildren(box);
  }

  $("setBtn").addEventListener("click", () => {
    $("sBuf").value = settings.buffer_pips; $("sMo").value = settings.max_open; $("sDl").value = settings.max_daily_loss;
    buildStratSettings();
    $("setBox").hidden = !$("setBox").hidden;
  });
  $("setCancel").addEventListener("click", () => { $("setBox").hidden = true; });
  $("setBox").addEventListener("submit", async (e) => {
    e.preventDefault();
    const lots = {}, enabled = {};
    for (const [code] of STRATS) {
      const v = +$("lot_" + code).value;
      if (!Number.isFinite(v) || v < 0 || v > 1) { err("deskErr", "Lot must be between 0 and 1."); return; }
      lots[code] = Math.round(v * 100) / 100;
      enabled[code] = $("on_" + code).checked;
    }
    const p = { p_buffer: +$("sBuf").value, p_lots: lots, p_enabled: enabled, p_max_open: Math.round(+$("sMo").value), p_max_daily_loss: +$("sDl").value };
    if (![p.p_buffer, p.p_max_open, p.p_max_daily_loss].every((n) => Number.isFinite(n) && n >= 0)) { err("deskErr", "Settings must be positive numbers."); return; }
    $("setSave").disabled = true;
    const { error } = await sb.rpc("algo_update_settings_v2", p);
    $("setSave").disabled = false;
    if (error) { err("deskErr", "Settings rejected (out of range or session expired)."); return; }
    $("setBox").hidden = true; await load();
  });

  ["fStrat", "fMode"].forEach((id) => $(id).addEventListener("change", render));
  $("fRange").addEventListener("change", load);
  $("reloadBtn").addEventListener("click", load);

  // CSV per entry (formula-injection safe)
  $("csvBtn").addEventListener("click", () => {
    const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const head = ["group_id", "leg", "strategy", "tf", "side", "status", "paper", "sig_entry", "sig_sl", "sig_tp", "ord_entry", "ord_sl", "ord_tp",
      "lots", "broker_ticket", "fill_price", "filled_at", "close_price", "closed_at", "pips", "pnl", "close_reason", "created_at"];
    const lines = [head.join(",")].concat(filtered().map((r) => head.map((h) => cell(r[h])).join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "chartfunded-algo-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  (async () => {
    const { data } = await sb.auth.getSession();
    if (data && data.session) await enter(); else show("login");
  })();
})();
