(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.CF_CONFIG;
  const MONTHS = [ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ];
  const money = n => '$' + Number(n).toLocaleString('en-US', {
    maximumFractionDigits: 2
  });
  const niceDate = d => {
    const [y, m, dd] = String(d).split('-').map(Number);
    return dd + ' ' + MONTHS[m - 1] + ' ' + y;
  };
  function status(text, kind) {
    const s = $('vStatus');
    s.textContent = text;
    s.className = 'v-status' + (kind ? ' ' + kind : '');
  }
  let sb = null;
  try {
    sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false
      }
    });
  } catch (_) {}
  async function check(raw) {
    const code = String(raw || '').trim().toUpperCase();
    $('vBody').hidden = true;
    if (!/^[0-9A-F]{16}$/.test(code)) {
      status('Enter a valid 16-character certificate ID.', 'bad');
      return;
    }
    if (!sb) {
      status('Verification is unavailable right now. Try again later.', 'bad');
      return;
    }
    status('Checking certificate…');
    const {data: data, error: error} = await sb.rpc('cf_verify_certificate', {
      p_code: code
    });
    if (error || !data) {
      status('Couldn\'t check right now. Try again.', 'bad');
      return;
    }
    if (!data.found) {
      status('✕ No certificate with this ID. It may be fake.', 'bad');
      return;
    }
    const funded = data.cert_type === 'funded';
    const TYPES = {
      '2-Step Phase 1': 'Phase 1 pass certificate · 2-Step Evaluation',
      '2-Step Phase 2': 'Phase 2 pass certificate · 2-Step Evaluation',
      '2-Step Evaluation': 'Funded trader certificate · 2-Step Evaluation',
      'Step 1 Evaluation': 'Funded trader certificate · 1-Step Evaluation',
      'Instant Funding': 'Funded trader certificate · Instant Funding'
    };
    $('vType').textContent = funded ? TYPES[data.program] || 'Evaluation certificate' : 'Payout certificate';
    $('vName').textContent = data.trader_name;
    $('vAmtLbl').textContent = 'Payout amount';
    $('vAmt').textContent = data.amount == null ? '' : money(data.amount);
    $('vAmt').parentElement.hidden = funded || data.amount == null;
    $('vProgRow').hidden = true;
    $('vProg').textContent = data.program || '';
    $('vDate').textContent = niceDate(data.issued_on);
    $('vCode').textContent = code;
    $('vBody').hidden = false;
    if (data.valid) status('✓ Genuine certificate issued by Chart Funded', 'good'); else status('✕ This certificate has been revoked', 'bad');
  }
  $('vForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('vInput').value;
    history.replaceState(null, '', '?c=' + encodeURIComponent(v.trim().toUpperCase()));
    check(v);
  });
  const initial = new URLSearchParams(location.search).get('c');
  if (initial) {
    $('vInput').value = initial.toUpperCase().slice(0, 16);
    check(initial);
  } else status('Enter a certificate ID to check it.');
})();