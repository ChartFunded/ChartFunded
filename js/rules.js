(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const wheel = $('wheel');
  const items = [ ...wheel.querySelectorAll('.w-item') ];
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const usd = n => '$' + Math.round(n).toLocaleString('en-US');
  let index = 0;
  function values(size) {
    return {
      vSize: usd(size),
      vMax: usd(size * .04),
      vDaily: usd(size * .015),
      vRisk: usd(size * .005),
      vBuffer: usd(size * .03),
      lStart: usd(size),
      lPlus: usd(size * 1.02),
      lFloor2: usd(size * .98)
    };
  }
  function flip(el, text, delay) {
    if (el.textContent === text) return;
    if (reduce || !el.animate) {
      el.textContent = text;
      return;
    }
    if (el._anim) el._anim.cancel();
    if (el._out) el._out.cancel();
    const out = el.animate([ {
      transform: 'rotateX(0deg)',
      opacity: 1
    }, {
      transform: 'rotateX(90deg)',
      opacity: .2
    } ], {
      duration: 150,
      delay: delay,
      easing: 'ease-in',
      fill: 'forwards'
    });
    el._out = out;
    out.onfinish = () => {
      el.textContent = text;
      el._anim = el.animate([ {
        transform: 'rotateX(-90deg)',
        opacity: .2
      }, {
        transform: 'rotateX(0deg)',
        opacity: 1
      } ], {
        duration: 260,
        easing: 'cubic-bezier(.2,.8,.2,1)'
      });
      out.cancel();
    };
  }
  function apply(i) {
    const size = Number(items[i].dataset.size);
    const v = values(size);
    Object.keys(v).forEach((id, n) => flip($(id), v[id], n * 35));
    $('vFloor').textContent = usd(size * .96);
    $('lFloor1').textContent = usd(size * .96);
    items.forEach((it, n) => it.setAttribute('aria-selected', String(n === i)));
    const url = new URL(location.href);
    url.searchParams.set('size', String(size / 1e3) + 'k');
    history.replaceState(null, '', url);
  }
  function itemH() {
    return items[0].offsetHeight;
  }
  function paint() {
    const h = itemH();
    const center = wheel.scrollTop + wheel.clientHeight / 2;
    let nearest = 0, best = Infinity;
    items.forEach((it, n) => {
      const mid = it.offsetTop + h / 2;
      const d = (mid - center) / h;
      const ad = Math.abs(d);
      if (ad < best) {
        best = ad;
        nearest = n;
      }
      it.style.transform = `rotateX(${Math.max(-70, Math.min(70, -d * 22))}deg) scale(${1 - Math.min(ad, 3) * .08})`;
      it.style.opacity = String(Math.max(.15, 1 - ad * .32));
      it.classList.toggle('on', ad < .5);
    });
    if (nearest !== index) {
      index = nearest;
      apply(index);
    }
  }
  let raf = 0;
  wheel.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  }, {
    passive: true
  });
  function go(i, smooth = true) {
    i = Math.max(0, Math.min(items.length - 1, i));
    const h = itemH();
    const top = items[i].offsetTop + h / 2 - wheel.clientHeight / 2;
    wheel.scrollTo({
      top: top,
      behavior: smooth && !reduce ? 'smooth' : 'auto'
    });
  }
  items.forEach((it, n) => it.addEventListener('click', () => go(n)));
  $('wUp').addEventListener('click', () => go(index - 1));
  $('wDown').addEventListener('click', () => go(index + 1));
  wheel.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(index - 1);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(index + 1);
    }
  });
  const want = String(new URLSearchParams(location.search).get('size') || '').toLowerCase();
  const start = Math.max(0, items.findIndex(it => String(Number(it.dataset.size) / 1e3) + 'k' === want));
  index = -1;
  requestAnimationFrame(() => {
    go(start, false);
    paint();
  });
})();