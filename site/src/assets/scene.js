/* Docubase: dot-matrix wave fields in raw WebGL, no library.
   Every <canvas data-dots="variant"> gets its own field: a grid of square dots on a plane seen in
   perspective, lifted by travelling waves. A ribbon of brighter dots runs diagonally through it and the
   crests turn the accent colour. The pointer lights the dots under it.
   Performance: one draw call per field, all motion in the vertex shader, render scale drops when frames
   run long, and a field only draws while it is on screen and the tab is visible. Reduced motion draws a
   single still frame. */
(function () {
  'use strict';

  var canvases = document.querySelectorAll('canvas[data-dots]');
  if (!canvases.length) return;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var small = window.matchMedia('(max-width: 760px)').matches;

  // Ribbon path and camera per variant. ribbon: [slope, offset, width]; cam: [height, pitch, fov].
  var VARIANTS = {
    hero: { ribbon: [-1.15, -2.9, 1.15], cam: [1.9, 0.4, 62], speed: 1, base: 0.12 },
    page: { ribbon: [-1.05, -3.8, 1.1], cam: [1.9, 0.4, 62], speed: 0.8, base: 0.11 },
    cta: { ribbon: [1.15, -2.9, 1.15], cam: [1.9, 0.42, 60], speed: 0.9, base: 0.1 },
    edge: { ribbon: [-1.3, -3.0, 0.9], cam: [2.6, 0.72, 54], speed: 0.7, base: 0.14 },
  };

  var VERT = [
    'attribute vec3 aGrid;', // x: 0..1 across, y: 0..1 into the distance, z: random
    'uniform float uTime, uAspect, uFov, uCamH, uPitch, uDpr, uSpeed, uBase;',
    'uniform vec3 uRibbon;',
    'uniform vec2 uPointer;', // clip space, or far away when absent
    'uniform float uPointerOn;',
    'varying float vA; varying float vHot;',
    'const float W = 22.0; const float D = 18.0;',
    'void main() {',
    '  float t = uTime * uSpeed;',
    '  vec3 p = vec3((aGrid.x - 0.5) * W, 0.0, -aGrid.y * D - 0.6);',
    '  float h = 0.34 * sin(p.x * 0.55 + p.z * 0.38 - t * 0.7)',
    '          + 0.18 * sin(p.x * -1.1 + p.z * 0.8 + t * 0.55)',
    '          + 0.07 * sin(p.x * 2.3 - p.z * 1.7 + t * 1.3);',
    '  float zc = uRibbon.y + p.x * uRibbon.x + 1.2 * sin(p.x * 0.32 + t * 0.18);',
    '  float dz = (p.z - zc) / uRibbon.z;',
    '  float band = exp(-dz * dz);',
    '  p.y = h * (0.5 + band * 1.2) - 0.3;',
    '  vec3 q = p - vec3(0.0, uCamH, 0.0);',
    '  float ca = cos(uPitch), sa = sin(uPitch);',
    '  vec3 r = vec3(q.x, q.y * ca - q.z * sa, q.y * sa + q.z * ca);',
    '  float f = 1.0 / tan(radians(uFov) * 0.5);',
    '  vec4 clip = vec4(r.x * f / uAspect, r.y * f, 0.0, -r.z);',
    '  gl_Position = clip;',
    '  vec2 ndc = clip.xy / clip.w;',
    '  vec2 dp = (ndc - uPointer) * vec2(uAspect, 1.0);',
    '  float glow = uPointerOn * exp(-dot(dp, dp) * 14.0);',
    '  float crest = smoothstep(0.05, 0.45, h);',
    '  float fog = smoothstep(D + 0.6, D * 0.45, -p.z) * smoothstep(W * 0.5, W * 0.36, abs(p.x));',
    '  float tw = 0.72 + 0.28 * sin(uTime * 2.4 + aGrid.z * 60.0);',
    '  vHot = clamp(crest * band * 1.15 + glow, 0.0, 1.0);',
    '  vA = (uBase + band * (0.42 + crest * 1.1) + glow * 1.1) * fog * tw;',
    '  gl_PointSize = clamp((1.0 + band * 0.7 + glow * 1.2) * uDpr * 7.0 / -r.z, 1.2 * uDpr, 7.0 * uDpr);',
    '}',
  ].join('\n');

  var FRAG = [
    'precision mediump float;',
    'uniform vec3 uAccent;',
    'varying float vA; varying float vHot;',
    'void main() {',
    '  vec2 c = abs(gl_PointCoord - 0.5);',
    '  float e = max(c.x, c.y);',
    '  float a = vA * smoothstep(0.5, 0.36, e);',
    '  vec3 col = mix(vec3(0.86, 0.87, 0.84), uAccent, vHot);',
    '  gl_FragColor = vec4(col * a, a);',
    '}',
  ].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function Field(canvas) {
    var v = VARIANTS[canvas.getAttribute('data-dots')] || VARIANTS.hero;
    var gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) return null;
    var prog = gl.createProgram();
    try {
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    } catch (err) { return null; }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    var cols = small ? 170 : 320;
    var rows = small ? 110 : 180;
    if (canvas.getAttribute('data-dots') === 'edge') { cols = small ? 130 : 200; rows = small ? 90 : 140; }
    var n = cols * rows;
    var data = new Float32Array(n * 3);
    for (var j = 0, k = 0; j < rows; j++) {
      // Rows get closer together with distance so the far field reads as fine texture.
      var y = Math.pow(j / (rows - 1), 1.35);
      for (var i = 0; i < cols; i++, k += 3) {
        data[k] = i / (cols - 1);
        data[k + 1] = y;
        data[k + 2] = Math.random();
      }
    }
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    var aGrid = gl.getAttribLocation(prog, 'aGrid');
    gl.enableVertexAttribArray(aGrid);
    gl.vertexAttribPointer(aGrid, 3, gl.FLOAT, false, 0, 0);

    var U = {};
    ['uTime', 'uAspect', 'uFov', 'uCamH', 'uPitch', 'uDpr', 'uSpeed', 'uBase', 'uRibbon', 'uPointer', 'uPointerOn', 'uAccent'].forEach(function (name) { U[name] = gl.getUniformLocation(prog, name); });
    gl.uniform1f(U.uFov, v.cam[2]);
    gl.uniform1f(U.uCamH, v.cam[0]);
    gl.uniform1f(U.uSpeed, v.speed);
    gl.uniform1f(U.uBase, v.base);
    gl.uniform3f(U.uRibbon, v.ribbon[0], v.ribbon[1], v.ribbon[2]);
    gl.uniform3f(U.uAccent, 0.984, 1.0, 0.33);
    gl.uniform2f(U.uPointer, 9, 9);
    gl.uniform1f(U.uPointerOn, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);

    var self = { canvas: canvas, visible: false, scale: 1, w: 0, h: 0 };
    var pointer = { x: 9, y: 9, tx: 9, ty: 9, on: 0, ton: 0 };
    var host = canvas.parentElement;

    self.resize = function () {
      var r = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 1.75) * self.scale;
      var w = Math.max(1, Math.round(r.width * dpr));
      var h = Math.max(1, Math.round(r.height * dpr));
      if (w !== self.w || h !== self.h) {
        self.w = canvas.width = w;
        self.h = canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform1f(U.uAspect, r.width / Math.max(1, r.height));
      gl.uniform1f(U.uDpr, dpr);
    };

    var scrollLift = 0;
    self.draw = function (time) {
      pointer.x += (pointer.tx - pointer.x) * 0.12;
      pointer.y += (pointer.ty - pointer.y) * 0.12;
      pointer.on += (pointer.ton - pointer.on) * 0.08;
      // The camera tips forward a little as its card scrolls away, so the field seems to roll past.
      var r = host.getBoundingClientRect();
      scrollLift = Math.max(-1, Math.min(1, -r.top / Math.max(1, r.height)));
      gl.uniform1f(U.uPitch, v.cam[1] + scrollLift * 0.12);
      gl.uniform1f(U.uTime, time);
      gl.uniform2f(U.uPointer, pointer.x, pointer.y);
      gl.uniform1f(U.uPointerOn, pointer.on);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, n);
    };

    if (!reduced && window.matchMedia('(hover: hover)').matches) {
      host.addEventListener('pointermove', function (e) {
        var r = canvas.getBoundingClientRect();
        pointer.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
        pointer.ty = 1 - ((e.clientY - r.top) / r.height) * 2;
        pointer.ton = 1;
        if (pointer.x > 5) { pointer.x = pointer.tx; pointer.y = pointer.ty; }
      });
      host.addEventListener('pointerleave', function () { pointer.ton = 0; });
    }
    return self;
  }

  var fields = [];
  canvases.forEach(function (c) { var f = Field(c); if (f) { f.resize(); fields.push(f); } });
  if (!fields.length) return;

  var start = performance.now();
  if (reduced) {
    // One still frame per field, redrawn only when the layout changes.
    var still = function () { fields.forEach(function (f) { f.resize(); f.draw(6.0); }); };
    still();
    window.addEventListener('resize', still);
    return;
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { fields.forEach(function (f) { if (f.canvas === e.target) f.visible = e.isIntersecting; }); });
      kick();
    }, { rootMargin: '80px' });
    fields.forEach(function (f) { io.observe(f.canvas); });
  } else fields.forEach(function (f) { f.visible = true; });

  var running = false, last = 0, slow = 0, fast = 0;
  function frame(now) {
    var any = false;
    var dt = last ? now - last : 16;
    last = now;
    // Adapt the render scale: long frames lower it, a run of quick ones raises it back.
    if (dt > 24) { slow++; fast = 0; } else if (dt < 15) { fast++; slow = 0; }
    var t = (now - start) / 1000;
    fields.forEach(function (f) {
      if (!f.visible) return;
      any = true;
      if (slow > 20 && f.scale > 0.55) { f.scale = Math.max(0.55, f.scale - 0.15); f.resize(); }
      else if (fast > 180 && f.scale < 1) { f.scale = Math.min(1, f.scale + 0.1); f.resize(); }
      f.draw(t);
    });
    if (slow > 20) slow = 0;
    if (fast > 180) fast = 0;
    if (any && !document.hidden) requestAnimationFrame(frame);
    else { running = false; last = 0; }
  }
  function kick() {
    if (running || document.hidden) return;
    if (!fields.some(function (f) { return f.visible; })) return;
    running = true;
    requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', kick);
  var rt = 0;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { fields.forEach(function (f) { f.resize(); }); }, 120); });
  kick();
})();
