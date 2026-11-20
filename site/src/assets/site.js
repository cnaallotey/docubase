/* Docubase marketing site: the page side. The WebGL dot fields live in scene.js. No dependencies. */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var raf = window.requestAnimationFrame.bind(window);
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  function watch(el, cb, margin) {
    if (!('IntersectionObserver' in window)) { cb(true); return; }
    new IntersectionObserver(function (es) { es.forEach(function (e) { cb(e.isIntersecting); }); }, { rootMargin: margin || '0px' }).observe(el);
  }

  // ---- Navigation: clear over the first stage, solid after it, hidden while scrolling down -----------
  var nav = document.querySelector('[data-nav]');
  var firstStage = document.querySelector('.stage');
  var lastY = window.scrollY;
  function navState() {
    var y = window.scrollY;
    if (nav && !document.body.classList.contains('menu-open')) {
      var past = firstStage ? firstStage.getBoundingClientRect().bottom < 90 : y > 40;
      nav.classList.toggle('is-solid', past);
      if (past && y > lastY + 6) nav.classList.add('is-hidden');
      else if (y < lastY - 6 || !past) nav.classList.remove('is-hidden');
    }
    lastY = y;
  }
  window.addEventListener('scroll', navState, { passive: true });
  navState();
  var toggle = document.querySelector('[data-nav-toggle]');
  var sheet = document.getElementById('nav-sheet');
  if (toggle && sheet) {
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      sheet.hidden = !open;
      document.body.classList.toggle('menu-open', open);
      if (nav) { nav.classList.remove('is-hidden'); nav.classList.add('is-solid'); if (!open) navState(); }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !sheet.hidden) { toggle.click(); toggle.focus(); } });
  }
  document.querySelectorAll('.nav-links a, .nav-sheet a').forEach(function (a) {
    var href = a.getAttribute('href');
    if (href === '/' ? location.pathname === '/' : location.pathname.indexOf(href) === 0) a.setAttribute('aria-current', 'page');
  });

  // ---- Copy and magnetic buttons ------------------------------------------------------------------
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    var label = b.querySelector('[data-copy-label]') || (b.parentElement && b.parentElement.querySelector('[data-copy-label]'));
    var original = label ? label.textContent : '';
    b.addEventListener('click', function () {
      var done = function (t) {
        b.classList.add('is-copied');
        if (label) label.textContent = t;
        setTimeout(function () { b.classList.remove('is-copied'); if (label) label.textContent = original; }, 2200);
      };
      var text = b.getAttribute('data-copy');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { done('Copied. Now paste it in a terminal.'); }, function () { done('Select the command and press ⌘C.'); });
      else done('Select the command and press ⌘C.');
    });
  });
  if (fine && !reduced) {
    document.querySelectorAll('[data-magnetic]').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', ((e.clientX - r.left - r.width / 2) * 0.2).toFixed(1) + 'px');
        el.style.setProperty('--my', ((e.clientY - r.top - r.height / 2) * 0.3).toFixed(1) + 'px');
      });
      el.addEventListener('pointerleave', function () { el.style.setProperty('--mx', '0px'); el.style.setProperty('--my', '0px'); });
    });
  }

  // ---- Feature rail: arrow buttons page through the cards -----------------------------------------
  var rail = document.querySelector('[data-rail]');
  if (rail) {
    var prev = document.querySelector('[data-rail-prev]');
    var next = document.querySelector('[data-rail-next]');
    var railState = function () {
      if (prev) prev.disabled = rail.scrollLeft < 4;
      if (next) next.disabled = rail.scrollLeft + rail.clientWidth > rail.scrollWidth - 4;
    };
    var page = function (dir) {
      var card = rail.querySelector('article');
      var stepW = card ? card.getBoundingClientRect().width + 16 : rail.clientWidth * 0.8;
      rail.scrollBy({ left: dir * stepW, behavior: reduced ? 'auto' : 'smooth' });
    };
    if (prev) prev.addEventListener('click', function () { page(-1); });
    if (next) next.addEventListener('click', function () { page(1); });
    rail.addEventListener('scroll', function () { raf(railState); }, { passive: true });
    window.addEventListener('resize', railState);
    railState();
  }

  // ---- Tabs: arrow keys move between them, panels animate in --------------------------------------
  var tablist = document.querySelector('[data-tabs]');
  if (tablist) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    var select = function (tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (!panel) return;
        panel.hidden = !on;
        panel.classList.remove('is-in');
        if (on) { void panel.offsetWidth; panel.classList.add('is-in'); }
      });
      if (focus) tab.focus();
      window.dispatchEvent(new CustomEvent('docubase:tab', { detail: { id: tab.id } }));
    };
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); });
      t.addEventListener('keydown', function (e) {
        var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (j === null) return;
        e.preventDefault();
        select(tabs[(j + tabs.length) % tabs.length], true);
      });
    });
  }

  // ---- Build log: lines appear one by one while it is on screen ------------------------------------
  var log = document.querySelector('[data-buildlog]');
  if (log) {
    var lines = log.querySelectorAll('p');
    if (reduced) lines.forEach(function (l) { l.classList.add('is-on'); });
    else {
      var li = 0, ltimer = null, lOn = false;
      var lstep = function () {
        if (!lOn) return;
        if (li >= lines.length) {
          ltimer = setTimeout(function () { lines.forEach(function (l) { l.classList.remove('is-on'); }); li = 0; ltimer = setTimeout(lstep, 600); }, 3600);
          return;
        }
        lines[li].classList.add('is-on');
        var slow = lines[li].querySelector('.p');
        li++;
        ltimer = setTimeout(lstep, slow ? 900 : 380);
      };
      watch(log, function (v) { if (v && !lOn) { lOn = true; lstep(); } if (!v) { lOn = false; clearTimeout(ltimer); } });
    }
  }

  // ---- Scramble and count up ----------------------------------------------------------------------
  var GLYPHS = '#%&*+/<>=?0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function scramble(el) {
    var target = el.textContent;
    var start = performance.now();
    (function step(now) {
      var t = clamp((now - start) / 650, 0, 1);
      var shown = Math.floor(t * target.length);
      var out = target.slice(0, shown);
      for (var i = shown; i < target.length; i++) out += target[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      el.textContent = out;
      if (t < 1) raf(step); else el.textContent = target;
    })(start);
  }
  function countUp(el) {
    var end = Number(el.getAttribute('data-count'));
    var start = performance.now();
    (function step(now) {
      var t = clamp((now - start) / 1500, 0, 1);
      el.textContent = String(Math.round(end * (1 - Math.pow(1 - t, 4))));
      if (t < 1) raf(step);
    })(start);
  }
  if (!reduced && 'IntersectionObserver' in window) {
    root.classList.add('reveal-ready');
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        io.unobserve(el);
        if (el.hasAttribute('data-reveal')) el.classList.add('is-in');
        if (el.hasAttribute('data-scramble')) scramble(el);
        if (el.hasAttribute('data-count')) countUp(el);
      });
    }, { rootMargin: '0px 0px -12% 0px' });
    document.querySelectorAll('[data-reveal], [data-scramble], [data-count]').forEach(function (el) { io.observe(el); });
  }

  // ---- Search demo: types queries and lists the matching sections ----------------------------------
  var search = document.querySelector('[data-search]');
  if (search) {
    var QUERIES = [
      { q: 'deploy under /docs', cluster: 0, results: [['Deploying', 'Hosting under a sub path', 'Guides'], ['Configuration', 'base', 'Reference'], ['Nuxt theme', 'Base URL', 'Guides'], ['Self hosting', 'Behind a proxy', 'Guides']] },
      { q: 'ask ai streaming', cluster: 1, results: [['AI and agents', 'Ask AI, with your own key', 'Guides'], ['AI and agents', 'Static hosting', 'Guides'], ['Configuration', 'Assistant options', 'Reference']] },
      { q: 'webhook secret', cluster: 2, results: [['Managed hosting', 'Add a site', 'Guides'], ['Managed hosting', 'Admin API', 'Guides'], ['Managed hosting', 'What protects the server', 'Guides'], ['Self hosting', 'Docker', 'Guides']] },
      { q: 'drift check ci', cluster: 3, results: [['Docs drift detection', 'Run it in CI', 'Guides'], ['Docs drift detection', 'What it checks', 'Guides'], ['Command line', 'docubase check', 'Reference']] },
    ];
    var qEl = search.querySelector('[data-q]');
    var list = search.querySelector('[data-results]');
    var count = search.querySelector('[data-count-results]');
    var qi = 0, ci = 0, phase = 'type', timer = null, running = false;
    var esc = function (s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    function show(item) {
      list.innerHTML = item.results.map(function (r) { return '<li><span class="h">#</span><div><b>' + esc(r[0]) + ' › ' + esc(r[1]) + '</b><small>Section match</small></div><i>' + esc(r[2]) + '</i></li>'; }).join('');
      count.textContent = item.results.length + ' results in ' + (2 + (qi % 3)) + ' ms';
    }
    function clear() { list.innerHTML = ''; count.textContent = '0 results'; }
    function step() {
      if (!running) return;
      var item = QUERIES[qi];
      var wait = 90;
      if (phase === 'type') {
        ci++; qEl.textContent = item.q.slice(0, ci);
        if (ci === 4) show(item);
        if (ci >= item.q.length) { phase = 'hold'; wait = 2600; } else wait = 70 + Math.random() * 70;
      } else if (phase === 'hold') { phase = 'erase'; wait = 30; }
      else { ci--; qEl.textContent = item.q.slice(0, ci); if (ci === 3) clear(); if (ci <= 0) { phase = 'type'; qi = (qi + 1) % QUERIES.length; wait = 450; } else wait = 26; }
      timer = setTimeout(step, wait);
    }
    if (reduced) { qEl.textContent = QUERIES[0].q; show(QUERIES[0]); }
    else watch(search, function (v) { if (v && !running) { running = true; step(); } if (!v) { running = false; clearTimeout(timer); } });
  }

  // ---- Agent terminal: an MCP exchange typed out line by line -------------------------------------
  var term = document.querySelector('[data-term-body]');
  if (term) {
    var LINES = [
      ['c', '# an agent connects to /__docubase/mcp'],
      ['k', '→ initialize'],
      ['o', '← docubase · tools: search_docs, get_page, list_pages'],
      ['k', '→ search_docs { "query": "custom domains" }'],
      ['o', '← 1. Managed hosting › Custom domains need proof'],
      ['o', '     path: guides/managed-hosting'],
      ['k', '→ get_page { "path": "guides/managed-hosting" }'],
      ['o', '← # Managed hosting'],
      ['o', '  A domain added from the dashboard stays pending'],
      ['o', '  until its owner adds a TXT record…'],
      ['c', '# answered from your docs, not the open web'],
    ];
    var render = function (n, partial) {
      term.innerHTML = LINES.slice(0, n).map(function (l) { return '<span class="' + l[0] + '">' + l[1].replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) + '</span>'; }).join('\n') + (partial || '');
    };
    if (reduced) render(LINES.length);
    else {
      var line = 0, ch = 0, ttimer = null, tOn = false;
      var tstep = function () {
        if (!tOn) return;
        if (line >= LINES.length) { ttimer = setTimeout(function () { line = 0; ch = 0; tstep(); }, 3200); return; }
        var text = LINES[line][1];
        ch += LINES[line][0] === 'o' ? text.length : 2;
        if (ch >= text.length) { line++; ch = 0; render(line); ttimer = setTimeout(tstep, LINES[line - 1][0] === 'k' ? 420 : 160); return; }
        render(line, (line ? '\n' : '') + '<span class="' + LINES[line][0] + '">' + text.slice(0, ch) + '</span>');
        ttimer = setTimeout(tstep, 24);
      };
      watch(term, function (v) { if (v && !tOn) { tOn = true; tstep(); } if (!v) { tOn = false; clearTimeout(ttimer); } });
    }
  }
})();
