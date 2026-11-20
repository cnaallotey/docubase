/* Docubase marketing site. No dependencies. Every loop runs only while its element is on screen. */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  var raf = window.requestAnimationFrame.bind(window);

  function onScreen(el, cb, margin) {
    if (!('IntersectionObserver' in window)) { cb(true); return; }
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { cb(e.isIntersecting); });
    }, { rootMargin: margin || '0px' }).observe(el);
  }

  // ---- Navigation: solid after the hero, hides while reading down, returns on the way up ---------
  var nav = document.querySelector('[data-nav]');
  var lastY = window.scrollY;
  function onNavScroll() {
    var y = window.scrollY;
    if (nav) {
      nav.classList.toggle('is-solid', y > 40);
      nav.classList.toggle('is-hidden', y > 600 && y > lastY + 4 && !document.body.classList.contains('menu-open'));
      if (y < lastY - 4) nav.classList.remove('is-hidden');
    }
    lastY = y;
  }
  window.addEventListener('scroll', onNavScroll, { passive: true });
  onNavScroll();

  var toggle = document.querySelector('[data-nav-toggle]');
  var sheet = document.getElementById('nav-sheet');
  if (toggle && sheet) {
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      sheet.hidden = !open;
      document.body.classList.toggle('menu-open', open);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !sheet.hidden) { toggle.click(); toggle.focus(); }
    });
  }
  var here = location.pathname.replace(/index\.html$/, '');
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    if (a.getAttribute('href') !== '/' && here.indexOf(a.getAttribute('href')) === 0) a.setAttribute('aria-current', 'page');
  });

  // ---- Copy the command ----------------------------------------------------------------------------
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var label = button.querySelector('[data-copy-label]');
      var done = function (text) {
        button.classList.add('is-copied');
        if (label) label.textContent = text;
        setTimeout(function () { button.classList.remove('is-copied'); if (label) label.textContent = 'Copy'; }, 1800);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(button.getAttribute('data-copy')).then(function () { done('Copied'); }, function () { done('Press ⌘C'); });
    });
  });

  // ---- Magnetic buttons: a small pull toward the pointer, only with a mouse ------------------------
  if (finePointer.matches && !reduced.matches) {
    document.querySelectorAll('[data-magnetic]').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', ((e.clientX - r.left - r.width / 2) * 0.22).toFixed(1) + 'px');
        el.style.setProperty('--my', ((e.clientY - r.top - r.height / 2) * 0.3).toFixed(1) + 'px');
      });
      el.addEventListener('pointerleave', function () { el.style.setProperty('--mx', '0px'); el.style.setProperty('--my', '0px'); });
    });
  }

  // ---- Statement: wrap each word so it can light up in turn ----------------------------------------
  document.querySelectorAll('[data-words]').forEach(function (el) {
    var words = el.textContent.trim().split(/\s+/);
    el.textContent = '';
    words.forEach(function (word, i) {
      var span = document.createElement('span');
      span.className = 'w' + (/thank/i.test(word) || /^readers$/i.test(word) ? ' em' : '');
      span.style.setProperty('--i', i);
      span.textContent = word;
      el.appendChild(span);
      if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
    });
    el.style.setProperty('--n', words.length);
  });

  // ---- Scroll progress: one rAF loop sets --p on each tracked section while it is visible ----------
  // "pin": 0 when the section top meets the viewport top, 1 when its bottom meets the viewport bottom.
  // "through": 0 as it enters at the bottom, 1 as it leaves at the top. "exit": 0 at rest, 1 once scrolled past.
  var tracked = [];
  var hero = document.querySelector('.hero');
  if (hero) tracked.push({ el: hero, mode: 'exit', visible: true, last: -1 });
  document.querySelectorAll('[data-progress]').forEach(function (el) {
    tracked.push({ el: el, mode: el.classList.contains('typeset') ? 'pin' : 'through', visible: false, last: -1 });
  });
  var stagesEl = document.querySelector('[data-stages]');
  var stages = stagesEl ? Array.prototype.slice.call(stagesEl.children) : [];
  var ticking = false;

  function progressOf(t) {
    var r = t.el.getBoundingClientRect();
    var vh = window.innerHeight;
    var p;
    if (t.mode === 'pin') p = -r.top / Math.max(1, r.height - vh);
    else if (t.mode === 'exit') p = -r.top / Math.max(1, r.height);
    else p = (vh - r.top) / (r.height + vh);
    return Math.min(1, Math.max(0, p));
  }

  function update() {
    ticking = false;
    for (var i = 0; i < tracked.length; i++) {
      var t = tracked[i];
      if (!t.visible) continue;
      var p = Math.round(progressOf(t) * 1000) / 1000;
      if (p === t.last) continue;
      t.last = p;
      t.el.style.setProperty('--p', p);
      if (t.mode === 'pin' && stages.length) {
        var on = p < 0.44 ? 0 : p < 0.68 ? 1 : 2;
        stages.forEach(function (s, n) { s.classList.toggle('is-on', n === on); });
      }
    }
  }
  function requestUpdate() { if (!ticking) { ticking = true; raf(update); } }

  if (!reduced.matches) {
    tracked.forEach(function (t) {
      onScreen(t.el, function (visible) { t.visible = visible; if (visible) requestUpdate(); }, '200px 0px');
    });
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);
  } else if (stages.length) {
    stages.forEach(function (s) { s.classList.add('is-on'); });
  }

  // The dark mode finale: a copy of the finished page, revealed by a growing circle.
  var page = document.querySelector('[data-page]');
  if (page && !reduced.matches) {
    var copy = page.cloneNode(true);
    copy.classList.add('dark');
    copy.removeAttribute('data-page');
    page.parentNode.appendChild(copy);
  }

  // ---- Reveals ------------------------------------------------------------------------------------
  var reveals = document.querySelectorAll('[data-reveal]');
  if (reveals.length && 'IntersectionObserver' in window && !reduced.matches) {
    root.classList.add('reveal-ready');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -12% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  // ---- Feature demos: each loops only while its card is visible ------------------------------------
  function loop(el, step) {
    var timer = null;
    var running = false;
    function run() { if (!running) return; var wait = step(); timer = setTimeout(run, wait); }
    onScreen(el, function (visible) {
      if (visible && !running) { running = true; run(); }
      if (!visible) { running = false; clearTimeout(timer); }
    });
  }

  var demos = {
    search: function (card) {
      var box = card.querySelector('.demo-search');
      var q = card.querySelector('[data-q]');
      var word = 'deploy';
      var i = 0;
      var phase = 'type';
      return function () {
        if (phase === 'type') {
          i += 1;
          q.textContent = word.slice(0, i);
          if (i >= 3) box.classList.add('has-results');
          if (i === word.length) { phase = 'hold'; return 2600; }
          return 120;
        }
        if (phase === 'hold') { phase = 'erase'; return 60; }
        i -= 1;
        q.textContent = word.slice(0, i);
        if (i < 3) box.classList.remove('has-results');
        if (i === 0) { phase = 'type'; return 900; }
        return 45;
      };
    },
    ask: function (card) {
      var box = card.querySelector('.demo-ask');
      var out = card.querySelector('[data-a]');
      var text = 'Set "base" to "/docs/" in docubase.config.json, then build. Every link, script and the search index follow it.';
      var words = text.split(' ');
      var i = 0;
      return function () {
        if (i === 0) { out.textContent = ''; box.classList.remove('has-src'); box.classList.add('has-src'); }
        if (i < words.length) { out.textContent += (i ? ' ' : '') + words[i]; i += 1; return 70 + Math.random() * 70; }
        i = 0;
        return 3200;
      };
    },
    drift: function (card) {
      var box = card.querySelector('.demo-term');
      var on = false;
      return function () { on = !on; box.classList.toggle('is-run', on); return on ? 4200 : 700; };
    },
    agents: function (card) {
      var box = card.querySelector('.demo-mcp');
      var on = false;
      return function () { on = !on; box.classList.toggle('is-run', on); return on ? 4600 : 600; };
    },
    api: function (card) {
      var box = card.querySelector('.demo-api');
      var status = card.querySelector('[data-status]');
      var body = card.querySelector('[data-body]');
      var stage = 0;
      return function () {
        stage = (stage + 1) % 3;
        if (stage === 1) { box.classList.remove('is-ok'); status.textContent = 'Sending'; return 700; }
        if (stage === 2) {
          box.classList.add('is-ok');
          status.textContent = '200 OK in 23 ms';
          body.textContent = '[\n  { "title": "Write the docs", "done": true },\n  { "title": "Run docubase check", "done": false }\n]';
          return 3400;
        }
        box.classList.remove('is-ok');
        status.textContent = 'Send request';
        return 900;
      };
    },
    host: function (card) {
      var box = card.querySelector('.demo-host');
      return function () { box.classList.add('is-run'); return 60000; };
    },
  };

  document.querySelectorAll('[data-demo]').forEach(function (card) {
    var make = demos[card.getAttribute('data-demo')];
    if (!make) return;
    if (reduced.matches) {
      card.querySelectorAll('.demo-search, .demo-ask, .demo-term, .demo-mcp, .demo-api').forEach(function (box) { box.classList.add('has-results', 'has-src', 'is-run', 'is-ok'); });
      var q = card.querySelector('[data-q]'); if (q) q.textContent = 'deploy';
      var a = card.querySelector('[data-a]'); if (a) a.textContent = 'Set "base" to "/docs/" in docubase.config.json, then build.';
      var st = card.querySelector('[data-status]'); if (st) st.textContent = '200 OK in 23 ms';
      return;
    }
    loop(card, make(card));
  });

  // ---- The painted sky: a small WebGL shader of drifting clouds over distant hills -----------------
  var skyBox = document.querySelector('[data-sky]');
  var canvas = skyBox && skyBox.querySelector('canvas');
  if (canvas) startSky(skyBox, canvas);

  function startSky(box, canvas) {
    var gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' });
    if (!gl) return; // the CSS gradient underneath stays

    var vs = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
    var fs = [
      'precision mediump float;',
      'uniform vec2 R;uniform float T;uniform vec2 M;uniform float D;',
      'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
      'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
      ' return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}',
      'float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<5;i++){v+=a*n(p);p=m*p;a*=.5;}return v;}',
      'void main(){',
      ' vec2 uv=gl_FragCoord.xy/R;float asp=R.x/R.y;vec2 p=vec2(uv.x*asp,uv.y);',
      ' vec2 par=(M-.5)*.035;',
      // sky: blue at the top left, peach at the top right, pale mint near the horizon
      ' vec3 blue=mix(vec3(.84,.906,.945),vec3(.1,.17,.22),D);',
      ' vec3 peach=mix(vec3(.969,.89,.84),vec3(.18,.137,.106),D);',
      ' vec3 mint=mix(vec3(.875,.925,.84),vec3(.106,.172,.125),D);',
      ' vec3 base=mix(vec3(.953,.965,.949),vec3(.083,.125,.102),D);',
      ' vec3 col=mix(base,blue,smoothstep(.2,1.,uv.y)*(1.-uv.x*.7));',
      ' col=mix(col,peach,smoothstep(.35,1.,uv.y)*smoothstep(.35,1.,uv.x)*.85);',
      // clouds: domain warped noise, drifting slowly to the right
      ' vec2 q=p*vec2(1.25,2.6)+par*4.+vec2(T*.012,0.);',
      ' vec2 w=vec2(fbm(q+vec2(0.,T*.01)),fbm(q+vec2(5.2,1.3)));',
      ' float c=fbm(q+1.6*w);',
      ' float band=smoothstep(.25,.75,uv.y);',
      ' float cloud=smoothstep(.48,.78,c)*band;',
      ' float shade=smoothstep(.55,.95,fbm(q*1.7+w+vec2(2.,0.)));',
      ' vec3 white=mix(vec3(1.),vec3(.78,.84,.86),D*.85);',
      ' vec3 shadow=mix(vec3(.88,.91,.93),vec3(.16,.22,.25),D);',
      ' col=mix(col,mix(white,shadow,shade*.55),cloud*.92);',
      // two ranges of hills, the far one hazy, the near one sage
      ' float x=p.x+par.x*2.;',
      ' float far=.27+.07*fbm(vec2(x*1.4+3.,1.))+.02*sin(x*2.3);',
      ' float near=.15+.08*fbm(vec2(x*2.2+11.,4.));',
      ' vec3 farc=mix(mix(vec3(.80,.87,.85),vec3(.13,.2,.18),D),col,.45);',
      ' vec3 nearc=mix(vec3(.69,.8,.72),vec3(.11,.19,.15),D);',
      ' col=mix(col,farc,smoothstep(far+.004,far-.004,uv.y));',
      ' col=mix(col,nearc,smoothstep(near+.004,near-.004,uv.y));',
      ' col=mix(col,base,smoothstep(.12,0.,uv.y)*.65);',
      // a soft clearing behind the headline keeps the text readable
      ' float clear=smoothstep(.75,.0,length((uv-vec2(.32,.3))*vec2(1.,1.4)));',
      ' col=mix(col,base,clear*.35);',
      ' gl_FragColor=vec4(col,1.);',
      '}',
    ].join('\n');

    function shader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    }
    var v = shader(gl.VERTEX_SHADER, vs);
    var f = shader(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return;
    var prog = gl.createProgram();
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var uR = gl.getUniformLocation(prog, 'R');
    var uT = gl.getUniformLocation(prog, 'T');
    var uM = gl.getUniformLocation(prog, 'M');
    var uD = gl.getUniformLocation(prog, 'D');

    // Clouds are soft, so the shader draws at a fraction of the screen's pixels and the browser scales it up.
    var scale = 0.5;
    var visible = true;
    var running = false;
    var start = performance.now() - Math.random() * 60000;
    var mouse = [0.5, 0.5];
    var target = [0.5, 0.5];
    var slowFrames = 0;
    var lastFrame = 0;

    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr * scale));
      var h = Math.max(1, Math.round(canvas.clientHeight * dpr * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    }

    function draw(now) {
      size();
      mouse[0] += (target[0] - mouse[0]) * 0.04;
      mouse[1] += (target[1] - mouse[1]) * 0.04;
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.uniform1f(uT, (now - start) / 1000);
      gl.uniform2f(uM, mouse[0], mouse[1]);
      gl.uniform1f(uD, dark.matches ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame(now) {
      if (!running) return;
      // If the device struggles, draw fewer pixels rather than drop frames.
      if (lastFrame && now - lastFrame > 28 && scale > 0.3) { if (++slowFrames > 20) { scale -= 0.1; slowFrames = 0; } } else slowFrames = 0;
      lastFrame = now;
      draw(now);
      raf(frame);
    }

    function play() { if (!running && visible && !document.hidden && !reduced.matches) { running = true; lastFrame = 0; raf(frame); } }
    function pause() { running = false; }

    draw(performance.now());
    box.classList.add('is-live');
    if (reduced.matches) return; // one still frame

    onScreen(box, function (v) { visible = v; if (v) play(); else pause(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); else play(); });
    dark.addEventListener && dark.addEventListener('change', function () { draw(performance.now()); });
    window.addEventListener('resize', function () { draw(performance.now()); });
    if (finePointer.matches) {
      window.addEventListener('pointermove', function (e) { target[0] = e.clientX / window.innerWidth; target[1] = 1 - e.clientY / window.innerHeight; }, { passive: true });
    }
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); pause(); box.classList.remove('is-live'); });
    play();
  }
})();
