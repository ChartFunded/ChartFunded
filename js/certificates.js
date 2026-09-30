(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const W = 1600, H = 1131;
  const cv = $("certCanvas");
  const ctx = cv.getContext("2d");
  const imgs = {};
  let current = null;   // abhi preview me jo issued certificate hai
  let list = [];
  let ready = false;

  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const today = () => new Date().toISOString().slice(0, 10);
  const money = (n) => "$" + Number(n).toLocaleString("en-US", {
    minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const niceDate = (d) => {
    const [y, m, dd] = String(d).split("-").map(Number);
    return String(dd).padStart(2, "0") + " " + MONTHS[m - 1] + " " + y;
  };
  const err = (m) => { $("certErr").textContent = m || ""; };

  const loadImg = (src) => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
  });

  async function prepare() {
    if (!imgs.logo) {
      [imgs.logo, imgs.sig] = await Promise.all([loadImg("assets/logo.png"), loadImg("assets/signature.png")]);
    }
    try {
      await Promise.all([
        document.fonts.load('800 80px "Saira"'),
        document.fonts.load('600 30px "Saira"'),
        document.fonts.load('400 120px "Kaushan Script"'),
      ]);
    } catch (_) {}
  }

  // ---------- drawing helpers ----------
  function setFont(spec) {
    ctx.font = spec;
    if ("fontStretch" in ctx) ctx.fontStretch = /Saira/.test(spec) && /\b(700|800)\b/.test(spec) ? "expanded" : "normal";
  }
  function spaced(text, x, y, gap) {
    const chars = [...text];
    const ws = chars.map((c) => ctx.measureText(c).width);
    const total = ws.reduce((a, b) => a + b, 0) + gap * (chars.length - 1);
    let cx = x - total / 2;
    const prev = ctx.textAlign; ctx.textAlign = "left";
    chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += ws[i] + gap; });
    ctx.textAlign = prev;
    return total;
  }
  function fit(text, spec, max, maxW) {
    let s = max;
    for (; s > 20; s -= 2) { setFont(spec.replace("{s}", s)); if (ctx.measureText(text).width <= maxW) break; }
    return s;
  }
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function seeded(n) { let s = n; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
  function silver(y0, y1) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, "#FFFFFF"); g.addColorStop(.45, "#C9D3DF"); g.addColorStop(.6, "#8C9AAE"); g.addColorStop(1, "#E4EAF1");
    return g;
  }
  function blueGrad(y0, y1) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, "#6FDCFA"); g.addColorStop(.55, "#2FA6F7"); g.addColorStop(1, "#1C74E0");
    return g;
  }
  function sideLines(y, half, len) {
    [[-1], [1]].forEach(([d]) => {
      const x0 = W / 2 + d * (half + 28), x1 = W / 2 + d * (half + 28 + len);
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, "rgba(56,205,244,.9)"); g.addColorStop(1, "rgba(56,205,244,0)");
      ctx.strokeStyle = g; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    });
  }

  function background() {
    ctx.fillStyle = "#020A1F"; ctx.fillRect(0, 0, W, H);
    let g = ctx.createRadialGradient(W / 2, H * .45, 40, W / 2, H * .45, 950);
    g.addColorStop(0, "rgba(14,58,132,.6)"); g.addColorStop(1, "rgba(2,10,31,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // candles: left falling, right rising
    const candles = (x0, y0, up, seed) => {
      const r = seeded(seed); let y = y0;
      for (let i = 0; i < 15; i++) {
        const x = x0 + i * 24;
        y += (up ? -1 : 1) * (8 + r() * 16) + (r() - .5) * 18;
        const body = 22 + r() * 40;
        ctx.fillStyle = i % 3 ? "rgba(28,142,242,.22)" : "rgba(56,205,244,.12)";
        ctx.fillRect(x - 1, y - body / 2 - 16, 2, body + 32);
        ctx.fillRect(x - 7, y - body / 2, 14, body);
      }
    };
    candles(80, 300, false, 11);
    candles(W - 440, 640, true, 29);

    // corner light streaks
    ctx.save();
    ctx.shadowColor = "rgba(56,205,244,.9)";
    for (let i = 0; i < 5; i++) {
      const off = 60 + i * 34, a = .75 - i * .13;
      ctx.lineWidth = i === 0 ? 5 : 2;
      ctx.shadowBlur = i === 0 ? 22 : 8;
      [[0, 0, 1], [W, H, -1]].forEach(([cx, cy, d]) => {
        const g2 = ctx.createLinearGradient(cx, cy + d * off * 3.2, cx + d * off * 3.2, cy);
        g2.addColorStop(0, "rgba(56,205,244,0)"); g2.addColorStop(.5, `rgba(120,215,255,${a})`); g2.addColorStop(1, "rgba(56,205,244,0)");
        ctx.strokeStyle = g2;
        ctx.beginPath(); ctx.moveTo(cx, cy + d * off * 3.2); ctx.lineTo(cx + d * off * 3.2, cy); ctx.stroke();
      });
    }
    ctx.restore();
  }

  function frame() {
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#38CDF4"); g.addColorStop(.5, "#1C8EF2"); g.addColorStop(1, "#38CDF4");
    ctx.strokeStyle = g; ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(56,205,244,.8)"; ctx.shadowBlur = 18;
    rr(34, 34, W - 68, H - 68, 26); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = "rgba(120,170,255,.18)"; ctx.lineWidth = 1;
    rr(50, 50, W - 100, H - 100, 20); ctx.stroke();
  }

  function header() {
    setFont('800 62px "Saira", sans-serif');
    const tw = Math.max(ctx.measureText("CHART").width, ctx.measureText("FUNDED").width);
    const logo = 112, gap = 22, total = logo + gap + tw;
    const x = W / 2 - total / 2, y = 88;
    ctx.save(); rr(x, y, logo, logo, 22); ctx.clip(); ctx.drawImage(imgs.logo, x, y, logo, logo); ctx.restore();
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = silver(y, y + 56); ctx.fillText("CHART", x + logo + gap, y + 52);
    ctx.fillStyle = blueGrad(y + 58, y + 112); ctx.fillText("FUNDED", x + logo + gap, y + 110);
    ctx.textAlign = "center";
    setFont('600 21px "Saira", sans-serif'); ctx.fillStyle = "#C9D3DF";
    spaced("TRADE  |  GROW  |  GET FUNDED", W / 2, 244, 7);
  }

  function laurel(cx, cy, dir) {
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(dir, 1);
    const g = ctx.createLinearGradient(0, -70, 0, 70);
    g.addColorStop(0, "#6FDCFA"); g.addColorStop(1, "#1C74E0");
    ctx.fillStyle = g; ctx.strokeStyle = g; ctx.lineWidth = 3;
    ctx.beginPath();
    for (let t = 0; t <= 1.001; t += .05) {
      const px = -22 * Math.sin(t * Math.PI), py = 62 - 124 * t;
      t === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
    for (let i = 0; i < 7; i++) {
      const t = .08 + i * .13, px = -22 * Math.sin(t * Math.PI), py = 62 - 124 * t;
      [-1, 1].forEach((s) => {
        ctx.save(); ctx.translate(px, py); ctx.rotate(s * .75 - .2);
        ctx.beginPath(); ctx.ellipse(s * 13, -4, 14, 5.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
    }
    ctx.restore();
  }

  function qr(url, x, y, size) {
    ctx.save();
    ctx.shadowColor = "rgba(56,205,244,.6)"; ctx.shadowBlur = 16;
    ctx.fillStyle = "#FFFFFF"; rr(x, y, size, size, 14); ctx.fill();
    ctx.restore();
    if (!url) {
      setFont('700 18px "Saira", sans-serif'); ctx.fillStyle = "#00153A"; ctx.textAlign = "center";
      ctx.fillText("QR AFTER", x + size / 2, y + size / 2 - 4);
      ctx.fillText("GENERATE", x + size / 2, y + size / 2 + 20);
      return;
    }
    const q = window.qrcode(0, "M"); q.addData(url); q.make();
    const n = q.getModuleCount(), pad = 10;
    const cell = Math.floor((size - pad * 2) / n);
    const off = Math.round((size - cell * n) / 2);
    ctx.fillStyle = "#00153A";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) ctx.fillRect(x + off + c * cell, y + off + r * cell, cell, cell);
    }
  }

  // ---------- main render ----------
  function render(d) {
    const funded = d.cert_type === "funded";
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "center";
    background(); frame(); header();

    // Title
    const title = funded ? "FUNDED TRADER CERTIFICATE" : "PAYOUT CERTIFICATE";
    fit(title, '800 {s}px "Saira", sans-serif', 96, 1260);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
    ctx.fillStyle = silver(270, 350); ctx.fillText(title, W / 2, 350); ctx.restore();

    setFont('600 24px "Saira", sans-serif'); ctx.fillStyle = "#D5DDE7";
    const pw = spaced("PROUDLY PRESENTED TO", W / 2, 415, 9);
    sideLines(407, pw / 2, 190);

    // Name
    const name = d.trader_name || "Trader Name";
    fit(name, '400 {s}px "Kaushan Script", cursive', 128, 1000);
    ctx.save(); ctx.shadowColor = "rgba(56,205,244,.7)"; ctx.shadowBlur = 20;
    ctx.fillStyle = blueGrad(440, 540); ctx.fillText(name, W / 2, 530); ctx.restore();
    const ug = ctx.createLinearGradient(W / 2 - 430, 0, W / 2 + 430, 0);
    ug.addColorStop(0, "rgba(56,205,244,0)"); ug.addColorStop(.5, "rgba(56,205,244,1)"); ug.addColorStop(1, "rgba(56,205,244,0)");
    ctx.save(); ctx.strokeStyle = ug; ctx.lineWidth = 3; ctx.shadowColor = "#38CDF4"; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.moveTo(W / 2 - 430, 566); ctx.lineTo(W / 2 + 430, 566); ctx.stroke(); ctx.restore();

    // Body
    setFont('500 28px "Saira", sans-serif'); ctx.fillStyle = "#E4EAF1";
    if (funded) {
      ctx.fillText("For meeting the Chart Funded trading standards", W / 2, 620);
      ctx.fillText("and earning a funded trading account.", W / 2, 658);
    } else {
      ctx.fillText("In recognition of your outstanding trading performance", W / 2, 620);
      ctx.fillText("and successful achievement of your payout.", W / 2, 658);
    }

    // Amount box
    const bw = 660, top = 695, bh = 160, cx = W / 2, mid = top + bh / 2, cut = 52;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - bw / 2 + cut, top); ctx.lineTo(cx + bw / 2 - cut, top); ctx.lineTo(cx + bw / 2, mid);
    ctx.lineTo(cx + bw / 2 - cut, top + bh); ctx.lineTo(cx - bw / 2 + cut, top + bh); ctx.lineTo(cx - bw / 2, mid);
    ctx.closePath();
    ctx.fillStyle = "rgba(3,18,48,.92)"; ctx.fill();
    ctx.strokeStyle = "#2FA6F7"; ctx.lineWidth = 2.5; ctx.shadowColor = "#38CDF4"; ctx.shadowBlur = 18; ctx.stroke();
    ctx.restore();
    laurel(cx - 245, mid + 8, 1); laurel(cx + 245, mid + 8, -1);
    setFont('700 21px "Saira", sans-serif'); ctx.fillStyle = "#E4EAF1";
    spaced(funded ? "FUNDED ACCOUNT SIZE" : "PAYOUT AMOUNT", cx, top + 42, 6);
    const amt = money(d.amount || 0);
    fit(amt, '800 {s}px "Saira", sans-serif', 84, 400);
    ctx.save(); ctx.shadowColor = "rgba(56,205,244,.55)"; ctx.shadowBlur = 16;
    ctx.fillStyle = blueGrad(top + 60, top + 140); ctx.fillText(amt, cx, top + 132); ctx.restore();

    // Tagline / program
    setFont('600 19px "Saira", sans-serif'); ctx.fillStyle = "#C9D3DF";
    const tag = funded ? "PROGRAM: " + String(d.program || "").toUpperCase() : "YOUR SKILLS. OUR SUPPORT. REAL OPPORTUNITY.";
    const tw = spaced(tag, W / 2, 900, 5);
    sideLines(893, tw / 2, 110);

    // Date (left)
    const lx = 330;
    setFont('600 32px "Saira", sans-serif'); ctx.fillStyle = "#FFFFFF"; ctx.textAlign = "center";
    ctx.fillText(niceDate(d.issued_on || today()), lx, 1000);
    ctx.strokeStyle = "rgba(56,205,244,.8)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx - 140, 1018); ctx.lineTo(lx + 140, 1018); ctx.stroke();
    setFont('600 17px "Saira", sans-serif'); ctx.fillStyle = "#C9D3DF"; spaced("DATE", lx, 1050, 6);

    // Signature (right)
    const rx = W - 330, sw = 215, sh = sw * imgs.sig.height / imgs.sig.width;
    ctx.drawImage(imgs.sig, rx - sw / 2, 1012 - sh, sw, sh);
    ctx.strokeStyle = "rgba(56,205,244,.8)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rx - 140, 1018); ctx.lineTo(rx + 140, 1018); ctx.stroke();
    setFont('600 17px "Saira", sans-serif'); ctx.fillStyle = "#C9D3DF"; spaced("CEO · CHART FUNDED", rx, 1050, 5);

    // QR (center)
    const url = d.code ? location.origin + "/verify?c=" + encodeURIComponent(d.code) : "";
    qr(url, W / 2 - 68, 925, 136);
    setFont('600 14px "Saira", sans-serif'); ctx.fillStyle = "#93A6C4";
    spaced(d.code ? "SCAN TO VERIFY · ID " + d.code : "PREVIEW", W / 2, 1082, 3);
  }

  // ---------- form ----------
  function formData() {
    return {
      cert_type: $("cType").value,
      trader_name: $("cName").value.trim().replace(/\s+/g, " "),
      amount: Number(String($("cAmount").value).replace(/[, $]/g, "")),
      program: $("cProgram").value,
      issued_on: $("cDate").value || today(),
    };
  }
  function syncType() {
    const funded = $("cType").value === "funded";
    $("cAmountLbl").textContent = funded ? "Account size ($)" : "Payout amount ($)";
    $("cAmount").placeholder = funded ? "10000" : "300";
    $("cProgWrap").hidden = !funded;
  }
  let t = null;
  function livePreview() {
    current = null;
    $("cDownload").disabled = true;
    $("cCode").textContent = "";
    clearTimeout(t);
    t = setTimeout(() => { if (ready && !current) render(formData()); }, 120);
  }
  ["cType", "cName", "cAmount", "cProgram", "cDate"].forEach((id) => {
    $(id).addEventListener("input", () => { if (id === "cType") syncType(); livePreview(); });
    $(id).addEventListener("change", () => { if (id === "cType") syncType(); livePreview(); });
  });

  $("certForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    err();
    const d = formData();
    if (d.trader_name.length < 2 || d.trader_name.length > 60 || /[<>{}]/.test(d.trader_name)) {
      err("Trader name 2–60 characters ka hona chahiye."); return;
    }
    if (!Number.isFinite(d.amount) || d.amount <= 0 || d.amount > 10000000) {
      err("Amount sahi daalo (sirf number)."); return;
    }
    const label = d.cert_type === "funded" ? "Funded pass" : "Payout";
    if (!window.confirm(`${label} certificate issue karein?\n\n${d.trader_name} — ${money(d.amount)}\n\nIssue hone ke baad ye QR se verify hoga.`)) return;

    $("cGenBtn").disabled = true;
    const { data, error } = await window.CF_SB.rpc("cf_issue_certificate", {
      p_type: d.cert_type, p_name: d.trader_name, p_amount: d.amount,
      p_program: d.cert_type === "funded" ? d.program : null, p_date: d.issued_on,
    });
    $("cGenBtn").disabled = false;
    if (error || !data) { err("Certificate nahi bana. Login check karo ya SQL run hua hai ya nahi."); return; }
    await show(data);
    loadList();
  });

  async function show(rec) {
    await init();
    clearTimeout(t);
    current = rec;
    render(rec);
    $("cDownload").disabled = false;
    $("cCode").textContent = "ID " + rec.code + (rec.revoked ? " · REVOKED" : "");
  }

  $("cDownload").addEventListener("click", () => {
    if (!current) return;
    const slug = String(current.trader_name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "trader";
    cv.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `chartfunded-${current.cert_type}-${slug}-${current.code}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    }, "image/png");
  });

  // ---------- issued list ----------
  function cell(tag, text, cls) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  async function loadList() {
    const { data, error } = await window.CF_SB
      .from("cf_certificates")
      .select("id,code,cert_type,trader_name,amount,program,issued_on,revoked")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) { err("List load nahi hui."); return; }
    list = data || [];
    const frag = document.createDocumentFragment();
    list.forEach((r) => {
      const tr = document.createElement("tr");
      tr.append(cell("td", r.code), cell("td", r.cert_type === "funded" ? "Funded" : "Payout"),
        cell("td", r.trader_name), cell("td", money(r.amount)), cell("td", niceDate(r.issued_on)));
      const st = cell("td"); st.append(cell("span", r.revoked ? "revoked" : "valid", "tag " + (r.revoked ? "rejected" : "approved"))); tr.append(st);
      const act = cell("td");
      const open = cell("button", "Open", "btn mini"); open.type = "button"; open.dataset.act = "open"; open.dataset.id = r.id;
      const rev = cell("button", r.revoked ? "Restore" : "Revoke", "btn mini" + (r.revoked ? "" : " no"));
      rev.type = "button"; rev.dataset.act = "rev"; rev.dataset.id = r.id;
      act.append(open, " ", rev); tr.append(act);
      frag.append(tr);
    });
    $("certRows").replaceChildren(frag);
  }
  $("certRows").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const r = list.find((x) => x.id === Number(b.dataset.id)); if (!r) return;
    if (b.dataset.act === "open") { show(r); cv.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if (!r.revoked && !window.confirm(`${r.trader_name} ka certificate revoke karein? QR scan pe "Revoked" dikhega.`)) return;
    b.disabled = true;
    const { error } = await window.CF_SB.rpc("cf_set_certificate_revoked", { p_id: r.id, p_revoked: !r.revoked });
    if (error) { err("Update nahi hua."); b.disabled = false; return; }
    loadList();
  });

  // ---------- start ----------
  let initP = null;
  function init() {
    if (!initP) {
      initP = (async () => {
        $("cDate").value = today();
        syncType();
        await prepare();
        ready = true;
        render(formData());
      })();
    }
    return initP;
  }
  async function start() { await init(); loadList(); }
  document.addEventListener("cf-admin-ready", start);
  // admin.js ne event pehle hi bhej diya ho to bhi chalu ho
  if (!$("panelView").hidden) start();
  document.addEventListener("cf-admin-logout", () => { current = null; list = []; $("certRows").replaceChildren(); });
})();
