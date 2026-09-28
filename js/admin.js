(() => {
  "use strict";
  const C = window.CF_CONFIG;
  const $ = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);

  let rows = [];

  const show = (view) => {
    $("loginView").hidden = view !== "login";
    $("panelView").hidden = view !== "panel";
    $("logoutBtn").hidden = view !== "panel";
    $("algoLink").hidden = view !== "panel";
  };
  const err = (id, msg) => { $(id).textContent = msg || ""; };

  // ---------- Auth ----------
  $("loginView").addEventListener("submit", async (e) => {
    e.preventDefault();
    err("loginErr");
    $("loginBtn").disabled = true;
    const { error } = await sb.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value,
    });
    $("password").value = "";
    $("loginBtn").disabled = false;
    if (error) { err("loginErr", "Email or password is wrong."); return; }
    await enter();
  });

  $("logoutBtn").addEventListener("click", async () => {
    await sb.auth.signOut();
    rows = [];
    $("rows").replaceChildren();
    show("login");
  });

  async function enter() {
    const { data: ok, error } = await sb.rpc("wl_is_admin");
    if (error || ok !== true) {
      await sb.auth.signOut();
      show("login");
      err("loginErr", "This account doesn't have admin access.");
      return;
    }
    show("panel");
    await load();
  }

  // ---------- Data ----------
  async function load() {
    err("panelErr");
    rows = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await sb
        .from("whitelist")
        .select("id,x_handle,telegram,discord,wallet,status,created_at")
        .order("created_at", { ascending: false })
        .range(from, from + size - 1);
      if (error) { err("panelErr", "Couldn't load the list. Log in again."); break; }
      rows.push(...data);
      if (data.length < size) break;
    }
    render();
  }

  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text; // textContent = XSS safe
    if (cls) n.className = cls;
    return n;
  }
  function link(href, text) {
    const a = el("a", text);
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    return a;
  }

  function render() {
    const q = $("search").value.trim().toLowerCase();
    const f = $("filter").value;
    const list = rows.filter((r) =>
      (f === "all" || r.status === f) &&
      (!q || [r.x_handle, r.telegram, r.discord, r.wallet].some((v) => (v || "").toLowerCase().includes(q))));

    const frag = document.createDocumentFragment();
    list.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.append(el("td", String(i + 1)));

      const tx = el("td"); tx.append(link("https://x.com/" + encodeURIComponent(r.x_handle), "@" + r.x_handle)); tr.append(tx);
      const tt = el("td"); tt.append(link("https://t.me/" + encodeURIComponent(r.telegram), "@" + r.telegram)); tr.append(tt);
      tr.append(el("td", r.discord));

      const tw = el("td");
      const short = el("span", r.wallet.slice(0, 6) + "…" + r.wallet.slice(-4));
      short.title = r.wallet;
      const cp = el("button", "Copy", "copy");
      cp.type = "button"; cp.dataset.act = "copy"; cp.dataset.id = r.id;
      tw.append(short, cp); tr.append(tw);

      tr.append(el("td", new Date(r.created_at).toLocaleString()));
      const ts = el("td"); ts.append(el("span", r.status, "tag " + r.status)); tr.append(ts);

      const ta = el("td");
      if (r.status !== "approved") {
        const b = el("button", "Approve", "btn mini"); b.type = "button";
        b.dataset.act = "approved"; b.dataset.id = r.id; ta.append(b);
      }
      if (r.status !== "rejected") {
        const b = el("button", "Reject", "btn mini no"); b.type = "button";
        b.dataset.act = "rejected"; b.dataset.id = r.id; ta.append(" ", b);
      }
      tr.append(ta);
      frag.append(tr);
    });
    $("rows").replaceChildren(frag);

    const count = (s) => rows.filter((r) => r.status === s).length;
    $("stTotal").textContent = rows.length;
    $("stPending").textContent = count("pending");
    $("stApproved").textContent = count("approved");
    $("stRejected").textContent = count("rejected");
  }

  $("rows").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = Number(b.dataset.id);
    const row = rows.find((r) => r.id === id);
    if (!row) return;

    if (b.dataset.act === "copy") {
      try { await navigator.clipboard.writeText(row.wallet); b.textContent = "Copied"; } catch (_) {}
      return;
    }
    b.disabled = true;
    const { error } = await sb.rpc("whitelist_set_status", { p_id: id, p_status: b.dataset.act });
    if (error) { err("panelErr", "Couldn't update. Your session may have expired."); b.disabled = false; return; }
    row.status = b.dataset.act;
    render();
  });

  $("search").addEventListener("input", render);
  $("filter").addEventListener("change", render);
  $("reloadBtn").addEventListener("click", load);

  // ---------- CSV (formula injection safe) ----------
  $("csvBtn").addEventListener("click", () => {
    const cell = (v) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const head = ["x_handle", "telegram", "discord", "wallet", "status", "created_at"];
    const lines = [head.join(",")].concat(rows.map((r) => head.map((h) => cell(r[h])).join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "chartfunded-whitelist-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------- Start ----------
  (async () => {
    const { data } = await sb.auth.getSession();
    if (data && data.session) await enter(); else show("login");
  })();
})();
