/* Docubase default theme script. Plain JavaScript, no dependencies, loaded with defer. */
(function () {
  'use strict';

  var root = document.documentElement;
  var base = root.getAttribute('data-base') || '/';
  var version = root.getAttribute('data-v') || '';

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === 'text') node.textContent = props[key];
        else if (key === 'class') node.className = props[key];
        else node.setAttribute(key, props[key]);
      });
    }
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  // ---- Colour theme and mobile navigation ----------------------------------------
  // Delegated, so they keep working when a framework theme re-renders the page frame.
  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function setNavOpen(open) {
    document.body.classList.toggle('nav-open', open);
    var toggle = document.querySelector('.nav-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    return toggle;
  }
  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    if (target.closest('.theme-toggle')) {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('docubase-theme', next); } catch (e) { /* storage can be blocked */ }
    } else if (target.closest('.nav-toggle')) {
      setNavOpen(!document.body.classList.contains('nav-open'));
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && document.body.classList.contains('nav-open')) {
      var toggle = setNavOpen(false);
      if (toggle) toggle.focus();
    }
  });

  // ---- Page content -------------------------------------------------------------
  // Everything here runs again after a client side navigation, so each step skips work it already did.
  var tabGroups = 0;
  var tocObserver = null;

  function enhanceContent() {
  // ---- Copy buttons on code blocks ------------------------------------------
  document.querySelectorAll('.prose pre > code').forEach(function (code) {
    var pre = code.parentNode;
    if (pre.querySelector(':scope > .copy')) return;
    var button = el('button', { type: 'button', class: 'copy', 'aria-label': 'Copy code', text: 'Copy' });
    button.addEventListener('click', function () {
      var done = function (label) {
        button.textContent = label;
        setTimeout(function () { button.textContent = 'Copy'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code.textContent).then(function () { done('Copied'); }, function () { done('Failed'); });
      } else {
        done('Failed');
      }
    });
    pre.appendChild(button);
  });

  // ---- Tabs -------------------------------------------------------------------
  document.querySelectorAll('.tabs').forEach(function (tabs) {
    if (tabs.classList.contains('is-enhanced')) return;
    var groupIndex = tabGroups++;
    var panels = Array.prototype.filter.call(tabs.children, function (c) { return c.classList.contains('tab-panel'); });
    if (panels.length === 0) return;
    var list = el('div', { class: 'tab-list', role: 'tablist' });
    var buttons = panels.map(function (panel, i) {
      var id = 'tab-' + groupIndex + '-' + i;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', id);
      var button = el('button', { type: 'button', role: 'tab', id: id, text: panel.getAttribute('data-label') || 'Tab' });
      list.appendChild(button);
      return button;
    });
    function select(index, focus) {
      buttons.forEach(function (button, i) {
        var active = i === index;
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        button.tabIndex = active ? 0 : -1;
        panels[i].hidden = !active;
      });
      if (focus) buttons[index].focus();
    }
    buttons.forEach(function (button, i) {
      button.addEventListener('click', function () { select(i, false); });
      button.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowRight') { event.preventDefault(); select((i + 1) % buttons.length, true); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); select((i - 1 + buttons.length) % buttons.length, true); }
      });
    });
    tabs.insertBefore(list, tabs.firstChild);
    tabs.classList.add('is-enhanced');
    select(0, false);
  });

  // ---- Table of contents highlight ---------------------------------------------
  if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (link) { byId[decodeURIComponent(link.getAttribute('href').slice(1))] = link; });
    var observer = tocObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        tocLinks.forEach(function (link) { link.classList.remove('is-active'); });
        var link = byId[entry.target.id];
        if (link) link.classList.add('is-active');
      });
    }, { rootMargin: '-70px 0px -70% 0px' });
    Object.keys(byId).forEach(function (id) {
      var heading = document.getElementById(id);
      if (heading) observer.observe(heading);
    });
  }

  // API playground: replace each <div class="try-it-slot"> with a small request form.
  var apiData = document.getElementById('docubase-api');
  var operations = [];
  if (apiData) {
    // The default theme embeds a script tag. Framework themes may use a data-operations attribute,
    // which changes together with the page content during client side navigation.
    try { operations = JSON.parse(apiData.getAttribute('data-operations') || apiData.textContent); } catch (e) { operations = []; }
  }
  document.querySelectorAll('.try-it-slot').forEach(function (slot) {
    if (slot.hasAttribute('data-enhanced')) return;
    var op = operations[Number(slot.getAttribute('data-operation'))];
    if (!op) return;
    slot.setAttribute('data-enhanced', '');
    slot.appendChild(buildPlayground(op));
  });
  }

  // ---- API playground ------------------------------------------------------------
  // Credentials stay in memory for the life of the form and are only sent to the server address shown in it.

  function field(labelText, input, hint) {
    var label = el('label', { class: 'tryit-field' }, [el('span', { text: labelText }), input]);
    if (hint) label.appendChild(el('small', { text: hint }));
    return label;
  }

  function prettyBody(text, type) {
    if (/json/i.test(type || '')) {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* show as received */ }
    }
    return text;
  }

  function buildPlayground(op) {
    var form = el('form', { class: 'tryit', novalidate: 'novalidate' });
    var details = el('details', { class: 'tryit-box' });
    details.appendChild(el('summary', { text: 'Try it' }));
    details.appendChild(form);

    var server = el('input', { type: 'url', placeholder: 'https://api.example.com', autocomplete: 'off', spellcheck: 'false' });
    server.value = op.servers[0] || '';
    if (op.servers.length > 1) {
      var list = el('datalist', { id: 'servers-' + Math.random().toString(36).slice(2) });
      op.servers.forEach(function (url) { list.appendChild(el('option', { value: url })); });
      server.setAttribute('list', list.id);
      form.appendChild(list);
    }
    form.appendChild(field('Server', server, op.servers.length ? '' : 'The spec has no server address. Enter one.'));

    var inputs = [];
    op.parameters.forEach(function (p) {
      var input = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
      input.value = p.example || '';
      inputs.push({ p: p, input: input });
      form.appendChild(field(p.name + ' (' + p.in + (p.required ? ', required' : '') + ')', input));
    });

    var auth = op.security || { kind: 'none' };
    var authA = null;
    var authB = null;
    if (auth.kind === 'bearer') {
      authA = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Token' });
      form.appendChild(field('Bearer token', authA, 'Not saved. Sent only to the server above.'));
    } else if (auth.kind === 'basic') {
      authA = el('input', { type: 'text', autocomplete: 'off', placeholder: 'Username' });
      authB = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Password' });
      form.appendChild(field('Username', authA));
      form.appendChild(field('Password', authB, 'Not saved. Sent only to the server above.'));
    } else if (auth.kind === 'apiKey') {
      authA = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Key' });
      form.appendChild(field('API key (' + auth.in + ' ' + auth.name + ')', authA, 'Not saved. Sent only to the server above.'));
    }

    var body = null;
    if (op.body && op.body.supported) {
      body = el('textarea', { rows: '7', spellcheck: 'false' });
      body.value = op.body.text || '';
      form.appendChild(field('Body (' + op.body.contentType + ')', body));
    }

    var send = el('button', { type: 'submit', class: 'tryit-send', text: 'Send request' });
    var out = el('div', { class: 'tryit-out', 'aria-live': 'polite' });
    form.appendChild(send);
    form.appendChild(out);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      out.textContent = '';
      var origin = server.value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(origin)) { out.appendChild(el('p', { class: 'tryit-error', text: 'Enter a server address that starts with http:// or https://' })); return; }
      var route = op.path;
      var query = new URLSearchParams();
      var headers = {};
      var missing = null;
      inputs.forEach(function (item) {
        var value = item.input.value.trim();
        if (!value) { if (item.p.required && !missing) missing = item.p.name; return; }
        if (item.p.in === 'path') route = route.split('{' + item.p.name + '}').join(encodeURIComponent(value));
        else if (item.p.in === 'query') query.append(item.p.name, value);
        else if (item.p.in === 'header') headers[item.p.name] = value;
      });
      if (missing) { out.appendChild(el('p', { class: 'tryit-error', text: 'Fill in "' + missing + '" first.' })); return; }
      if (authA && authA.value) {
        if (auth.kind === 'bearer') headers.Authorization = 'Bearer ' + authA.value;
        else if (auth.kind === 'basic') headers.Authorization = 'Basic ' + btoa(unescape(encodeURIComponent(authA.value + ':' + (authB ? authB.value : ''))));
        else if (auth.kind === 'apiKey' && auth.in === 'header') headers[auth.name] = authA.value;
        else if (auth.kind === 'apiKey' && auth.in === 'query') query.append(auth.name, authA.value);
      }
      var url = origin + route;
      var qs = query.toString();
      if (qs) url += (url.indexOf('?') === -1 ? '?' : '&') + qs;
      var init = { method: op.method, headers: headers, credentials: 'omit', cache: 'no-store' };
      if (body && body.value.trim() && op.method !== 'GET' && op.method !== 'HEAD') {
        init.body = body.value;
        headers['Content-Type'] = op.body.contentType;
      }

      send.disabled = true;
      send.textContent = 'Sending';
      var started = performance.now();
      fetch(url, init).then(function (response) {
        return response.text().then(function (text) {
          var ms = Math.round(performance.now() - started);
          var ok = response.status < 400;
          out.appendChild(el('p', { class: ok ? 'tryit-status ok' : 'tryit-status bad', text: response.status + ' ' + response.statusText + ' in ' + ms + ' ms' }));
          var shown = prettyBody(text, response.headers.get('content-type'));
          if (shown.length > 20000) shown = shown.slice(0, 20000) + '\n[cut after 20000 characters]';
          out.appendChild(el('pre', { class: 'tryit-body', text: shown || '(empty body)' }));
        });
      }).catch(function () {
        out.appendChild(el('p', { class: 'tryit-error', text: 'The request did not complete. The server may be down, or it may not allow requests from this page (CORS). The request was ' + op.method + ' ' + url }));
      }).then(function () {
        send.disabled = false;
        send.textContent = 'Send request';
      });
    });
    return details;
  }

  // ---- Ask the docs ---------------------------------------------------------------
  function setupAsk() {
  var askUrl = root.getAttribute('data-ask');
  var askDialog = document.getElementById('ask-dialog');
  var askButton = document.querySelector('.ask-btn');
  if (askDialog && askDialog.hasAttribute('data-enhanced')) return;
  if (askUrl && askDialog && askButton && typeof askDialog.showModal === 'function') {
    askDialog.setAttribute('data-enhanced', '');
    var askForm = askDialog.querySelector('form');
    var askInput = askDialog.querySelector('textarea');
    var askAnswer = askDialog.querySelector('.ask-answer');
    var askSources = askDialog.querySelector('.ask-sources');
    var askSend = askDialog.querySelector('.ask-send');

    // Safe rendering: the answer is shown as text, with code fences and inline code only.
    function renderAnswer(text) {
      askAnswer.textContent = '';
      String(text).split(/```[a-zA-Z0-9]*\n?/).forEach(function (part, i) {
        if (i % 2 === 1) { askAnswer.appendChild(el('pre', null, [el('code', { text: part.replace(/\n$/, '') })])); return; }
        part.split(/\n{2,}/).forEach(function (para) {
          if (!para.trim()) return;
          var p = el('p');
          para.split(/`([^`\n]+)`/).forEach(function (bit, n) {
            p.appendChild(n % 2 === 1 ? el('code', { text: bit }) : document.createTextNode(bit));
          });
          askAnswer.appendChild(p);
        });
      });
    }

    askButton.addEventListener('click', function () {
      if (!askDialog.open) askDialog.showModal();
      askInput.focus();
    });
    askDialog.addEventListener('click', function (event) { if (event.target === askDialog) askDialog.close(); });
    askInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askForm.requestSubmit(); }
    });
    function showSources(sources) {
      askSources.textContent = '';
      (sources || []).forEach(function (s) {
        var label = s.heading ? s.title + ' › ' + s.heading : s.title;
        askSources.appendChild(el('li', null, [el('a', { href: s.url, text: label })]));
      });
    }

    // Read a Server-Sent Events stream and call onMessage(event, data) for each message.
    function readEvents(body, onMessage) {
      var reader = body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function flush(block) {
        var event = 'message';
        var data = [];
        block.split(/\r?\n/).forEach(function (line) {
          if (line.indexOf('event:') === 0) event = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''));
        });
        if (data.length) onMessage(event, JSON.parse(data.join('\n')));
      }
      function pump() {
        return reader.read().then(function (step) {
          if (step.done) { if (buffer.trim()) flush(buffer); return; }
          buffer += decoder.decode(step.value, { stream: true });
          var parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop();
          parts.forEach(flush);
          return pump();
        });
      }
      return pump();
    }

    var inFlight = null;
    askDialog.addEventListener('close', function () { if (inFlight) inFlight.abort(); });

    askForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var question = askInput.value.trim();
      if (!question) return;
      if (inFlight) inFlight.abort();
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      inFlight = controller;
      askSources.textContent = '';
      askAnswer.textContent = 'Looking through the docs';
      askAnswer.setAttribute('aria-busy', 'true');
      askSend.disabled = true;

      var text = '';
      var frame = 0;
      function paint() { frame = 0; renderAnswer(text); }
      function schedule() { if (!frame) frame = (window.requestAnimationFrame || setTimeout)(paint); }

      fetch(askUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
        body: JSON.stringify({ question: question }),
        credentials: 'omit',
        signal: controller ? controller.signal : undefined,
      })
        .then(function (response) {
          var type = response.headers.get('content-type') || '';
          if (response.ok && type.indexOf('text/event-stream') !== -1 && response.body && typeof TextDecoder === 'function') {
            return readEvents(response.body, function (name, data) {
              if (name === 'sources') showSources(data);
              else if (name === 'delta') { text += data.text || ''; schedule(); }
              else if (name === 'error') throw new Error(data.error || 'The assistant stopped before it finished.');
            }).then(function () {
              if (!text) throw new Error('No answer was returned.');
              paint();
            });
          }
          // An older server, or a proxy that dropped the stream: a single JSON answer.
          return response.json().catch(function () { return {}; }).then(function (data) {
            if (!response.ok) throw new Error(data.error || 'The assistant is not available right now.');
            renderAnswer(data.answer || 'No answer was returned.');
            showSources(data.sources);
          });
        })
        .catch(function (error) {
          if (error && error.name === 'AbortError') return;
          if (text) {
            paint();
            askAnswer.appendChild(el('p', { class: 'ask-error', text: error.message || 'The answer was cut off.' }));
          } else {
            askAnswer.textContent = error && error.message ? error.message : 'The assistant could not be reached.';
          }
        })
        .then(function () {
          if (inFlight !== controller) return; // a newer question owns the dialog now
          inFlight = null;
          askAnswer.removeAttribute('aria-busy');
          askSend.disabled = false;
        });
    });
  } else if (askButton) {
    askButton.hidden = true;
  }
  }

  // ---- Search -------------------------------------------------------------------
  // The index is loaded once. The dialog is bound again whenever a framework theme renders a new one.
  var index = null;
  var loading = null;
  var openSearch = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(script);
    });
  }

  function loadIndex() {
    if (!loading) {
      loading = loadScript(base + 'assets/minisearch.js?v=' + version)
        .then(function () { return fetch(base + 'search-index.json'); })
        .then(function (response) {
          if (!response.ok) throw new Error('Search index not found');
          return response.json();
        })
        .then(function (data) { index = window.MiniSearch.loadJS(data.index, data.options); })
        .catch(function (error) { loading = null; throw error; });
    }
    return loading;
  }

  function setupSearch() {
  var dialog = document.getElementById('search-dialog');
  var openButton = document.querySelector('.search-btn');
  if (!dialog || typeof dialog.showModal !== 'function') {
    if (openButton) openButton.hidden = true;
    return;
  }
  if (dialog.hasAttribute('data-enhanced')) return;
  dialog.setAttribute('data-enhanced', '');
  var input = dialog.querySelector('input');
  var results = dialog.querySelector('.search-results');
  var status = dialog.querySelector('.search-status');
  var selected = -1;
  var links = [];

  function setStatus(text) {
    status.textContent = text;
    status.hidden = !text;
  }

  function select(i) {
    if (links.length === 0) { selected = -1; return; }
    selected = (i + links.length) % links.length;
    links.forEach(function (link, n) { link.setAttribute('aria-selected', n === selected ? 'true' : 'false'); });
    links[selected].scrollIntoView({ block: 'nearest' });
  }

  function render(hits) {
    results.textContent = '';
    links = [];
    hits.slice(0, 8).forEach(function (hit) {
      var title = el('span', { class: 'r-title', text: hit.heading ? hit.title + ' › ' + hit.heading : hit.title });
      var line = [title];
      if (hit.group) line.push(el('span', { class: 'r-group', text: hit.group }));
      var a = el('a', { href: hit.url }, line);
      if (hit.excerpt) a.appendChild(el('span', { class: 'r-text', text: hit.excerpt }));
      results.appendChild(el('li', null, [a]));
      links.push(a);
    });
    select(links.length ? 0 : -1);
    setStatus(hits.length ? '' : 'No results for "' + input.value.trim() + '"');
  }

  function run() {
    var query = input.value.trim();
    if (!query) { results.textContent = ''; links = []; setStatus('Type to search the docs.'); return; }
    loadIndex().then(function () { render(index.search(query)); }, function () {
      setStatus('Search could not load. If you opened the files directly, serve the folder over http instead.');
    });
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    input.focus();
    input.select();
    setStatus('Type to search the docs.');
    loadIndex().catch(function () { /* reported when the user types */ });
  }

  if (openButton) openButton.addEventListener('click', open);
  input.addEventListener('input', run);
  input.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); select(selected + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); select(selected - 1); }
    else if (event.key === 'Enter' && links[selected]) { event.preventDefault(); dialog.close(); api.navigate(links[selected].href); }
  });
  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });
  results.addEventListener('click', function () { dialog.close(); });
  openSearch = open;
  }

  document.addEventListener('keydown', function (event) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (openSearch && ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing))) {
      event.preventDefault();
      openSearch();
    }
  });

  // ---- Entry point ----------------------------------------------------------------
  // Framework themes call Docubase.enhance() after they render a new page, and may replace
  // Docubase.navigate so search results move without a full page load.
  var api = window.Docubase = window.Docubase || {};
  api.navigate = api.navigate || function (url) { window.location.href = url; };
  api.enhance = function (options) {
    if (options && options.navigated) setNavOpen(false);
    enhanceContent();
    setupAsk();
    setupSearch();
  };
  api.enhance();
})();
