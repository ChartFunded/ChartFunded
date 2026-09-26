(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const C = window.CF_CONFIG;

  // Setup check — kuch missing ho to page pe saaf error dikhe
  const setupErr = (msg) => {
    const p = $("errX");
    if (p) p.textContent = "Setup error: " + msg;
    if ($("saveX")) $("saveX").disabled = true;
  };
  if (!C || typeof C !== "object") {
    setupErr("js/config.js didn't load. Check the file path and syntax.");
    return;
  }
  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "X_HANDLE", "TELEGRAM_URL", "DISCORD_URL"]
    .filter((k) => typeof C[k] !== "string" || !C[k].trim() || C[k].includes("YOUR"));
  if (missing.length) {
    setupErr("fill " + missing.join(", ") + " in js/config.js.");
    return;
  }
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    setupErr("Supabase library didn't load. Refresh the page.");
    return;
  }

  // Official links — sirf https allow
  const safe = (u) => (typeof u === "string" && u.startsWith("https://") ? u : "#");
  const handle = C.X_HANDLE.trim().replace(/^@/, "");
  const xProfile = "https://x.com/" + encodeURIComponent(handle);
  const xFollow = "https://x.com/intent/follow?screen_name=" + encodeURIComponent(handle);
  ["topX", "footX"].forEach((id) => ($(id).href = xProfile));
  $("linkX").href = xFollow;
  $("linkTg").href = $("footTg").href = safe(C.TELEGRAM_URL);
  $("linkDc").href = $("footDc").href = safe(C.DISCORD_URL);

  let sb = null;
  try {
    sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (_) { /* submit pe error dikhega */ }

  const RX = {
    x: /^[A-Za-z0-9_]{1,15}$/,
    tg: /^[A-Za-z0-9_]{5,32}$/,
    dc: /^[a-z0-9_.]{2,32}$/,
    wallet: /^0x[0-9a-fA-F]{40}$/,
  };

  const state = { x: null, tg: null, dc: null, done: 0 };

  function setErr(id, msg) { $(id).textContent = msg || ""; }

  function progress() {
    $("passCount").textContent = state.done + "/5";
    $("meterFill").style.width = (state.done / 5) * 100 + "%";
  }

  function complete(n) {
    const li = $("s" + n);
    if (!li.classList.contains("is-done")) {
      li.classList.add("is-done");
      state.done++;
    }
    li.classList.remove("is-active");
    const next = $("s" + (n + 1));
    if (next && !next.classList.contains("is-done")) {
      next.classList.add("is-active");
      $("f" + (n + 1)).disabled = false;
    }
    progress();
  }

  // Step 1 — X handle
  const xInput = $("xHandle");
  $("saveX").addEventListener("click", () => {
    if (state.x && xInput.readOnly) { // Edit mode
      xInput.readOnly = false;
      xInput.focus();
      $("saveX").textContent = "Save";
      return;
    }
    const v = xInput.value.trim().replace(/^@/, "");
    if (!RX.x.test(v)) {
      setErr("errX", "Use letters, numbers and _ only, up to 15 characters.");
      return;
    }
    setErr("errX");
    state.x = v;
    xInput.value = v;
    xInput.readOnly = true;
    $("saveX").textContent = "Edit";
    $("passHolder").textContent = "@" + v;
    complete(1);
  });
  xInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("saveX").click(); }
  });

  // Step 2 — X follow (link khulne ke baad hi button chalu)
  $("linkX").addEventListener("click", () => { $("doneX").disabled = false; });
  $("doneX").addEventListener("click", () => {
    $("doneX").textContent = "Followed";
    $("doneX").disabled = true;
    complete(2);
  });

  // Step 3 & 4 — Telegram / Discord
  function socialStep({ link, input, btn, err, rx, clean, key, n, msg }) {
    let opened = false;
    const sync = () => { $(btn).disabled = !(opened && $(input).value.trim().length > 1); };
    $(link).addEventListener("click", () => { opened = true; sync(); });
    $(input).addEventListener("input", sync);
    $(btn).addEventListener("click", () => {
      const v = clean($(input).value);
      if (!rx.test(v)) { setErr(err, msg); return; }
      setErr(err);
      state[key] = v;
      $(input).value = v;
      complete(n);
    });
  }
  socialStep({
    link: "linkTg", input: "tgUser", btn: "doneTg", err: "errTg", key: "tg", n: 3,
    rx: RX.tg, clean: (s) => s.trim().replace(/^@/, ""),
    msg: "Telegram username is 5–32 letters, numbers or _. Set one in Telegram settings if you don't have it.",
  });
  socialStep({
    link: "linkDc", input: "dcUser", btn: "doneDc", err: "errDc", key: "dc", n: 4,
    rx: RX.dc, clean: (s) => s.trim().toLowerCase(),
    msg: "Discord username is 2–32 lowercase letters, numbers, _ or dots.",
  });

  // Step 5 — Wallet
  const syncSubmit = () => {
    $("submitBtn").disabled = !($("ownWallet").checked && $("wallet").value.trim().length === 42);
  };
  $("wallet").addEventListener("input", syncSubmit);
  $("ownWallet").addEventListener("change", syncSubmit);

  const MSG = {
    bad_x: "Your X handle doesn't look right. Edit it in step 1.",
    bad_tg: "Your Telegram username doesn't look right.",
    bad_dc: "Your Discord username doesn't look right.",
    bad_wallet: "That isn't a valid 0x wallet address.",
    duplicate: "This X handle or wallet is already on the whitelist.",
    busy: "Lots of sign-ups right now. Try again in a minute.",
  };

  let sending = false;
  $("wlForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    if (state.done < 4 || !state.x || !state.tg || !state.dc) {
      setErr("errW", "Finish steps 1 to 4 first.");
      return;
    }
    if ($("company").value) return; // bot honeypot

    const w = $("wallet").value.trim();
    if (!RX.wallet.test(w) || /^0x0{40}$/i.test(w)) { setErr("errW", MSG.bad_wallet); return; }
    if (!sb) { setErr("errW", "The whitelist isn't connected yet. Try again later."); return; }

    sending = true;
    $("submitBtn").disabled = true;
    $("submitBtn").textContent = "Joining…";
    setErr("errW");

    try {
      const { data, error } = await sb.rpc("whitelist_submit", {
        p_x: state.x, p_tg: state.tg, p_dc: state.dc, p_wallet: w,
      });
      if (error) throw error;
      if (data === "ok") {
        complete(5);
        $("steps").hidden = true;
        $("doneState").hidden = false;
        $("doneState").focus();
        return;
      }
      setErr("errW", MSG[data] || "Something didn't match. Check your details and try again.");
    } catch (_) {
      setErr("errW", "Couldn't reach the server. Check your connection and try again.");
    } finally {
      sending = false;
      $("submitBtn").textContent = "Join whitelist";
      syncSubmit();
    }
  });

  progress();
})();
