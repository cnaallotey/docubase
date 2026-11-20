/* Docubase dashboard. Plain JavaScript, no build step. Every page is built with DOM calls, never innerHTML. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var nav = document.getElementById('nav');
  var toastBox = document.getElementById('toast');
  var session = null; // { user, limits, sites, billing }
  var pollTimer = null;
  var oneTime = {}; // webhook secrets shown once, right after a site is created

  // ---- helpers ---------------------------------------------------------------------
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    });
    [].concat(children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function show() {
    app.textContent = '';
    Array.prototype.forEach.call(arguments, function (node) { if (node) app.appendChild(node); });
    var heading = app.querySelector('h1');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
  }

  function toast(message) {
    toastBox.textContent = message;
    toastBox.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { toastBox.hidden = true; }, 3500);
  }

  function api(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (method !== 'GET') init.headers['x-docubase'] = '1';
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch('/api/' + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && path !== 'session') { session = null; route(); }
        if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ')');
        return data;
      });
    });
  }

  /** Run an action from a form: disable the button, show errors under it, re-enable. */
  function submitting(form, run) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = form.querySelector('button[type=submit]');
      var error = form.querySelector('.error') || form.appendChild(h('p', { class: 'error', role: 'alert' }));
      error.textContent = '';
      if (button) button.disabled = true;
      Promise.resolve().then(run).catch(function (e) { error.textContent = e.message; }).then(function () { if (button) button.disabled = false; });
    });
    return form;
  }

  function field(label, input, hint) {
    return h('label', null, [label, input, hint ? h('small', { text: hint }) : null]);
  }

  function badge(state) {
    var labels = { ready: 'Live', building: 'Building', queued: 'Queued', failed: 'Failed' };
    return h('span', { class: 'badge ' + state, text: labels[state] || state });
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function copyButton(text) {
    return h('button', { type: 'button', class: 'btn', onclick: function () {
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, function () { toast('Copy failed'); });
    }, text: 'Copy' });
  }

  function setNav(name) {
    nav.hidden = !session;
    document.getElementById('nav-billing').hidden = !(session && session.billing.enabled);
    Array.prototype.forEach.call(nav.querySelectorAll('a'), function (a) {
      if (a.getAttribute('href') === '#/' + name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  // ---- sign in and sign up ------------------------------------------------------------
  function authPage(signupOpen, mode) {
    var isSignup = mode === 'signup' && signupOpen;
    var email = h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: '254', placeholder: 'you@company.com' });
    var password = h('input', { type: 'password', autocomplete: isSignup ? 'new-password' : 'current-password', required: true, minlength: isSignup ? '10' : null, maxlength: '200', placeholder: isSignup ? 'At least 10 characters' : 'Your password' });
    var form = submitting(h('form', null, [
      field('Email', email),
      field('Password', password),
      h('button', { type: 'submit', class: 'btn primary block', text: isSignup ? 'Create your account' : 'Sign in' }),
    ]), function () {
      return api('POST', isSignup ? 'signup' : 'session', { email: email.value, password: password.value }).then(function (data) {
        session = data;
        if (location.hash === '#/' || location.hash === '') route();
        else location.hash = '#/'; // the hashchange listener draws the page
      });
    });
    var switcher = signupOpen
      ? h('p', { class: 'switch' }, [isSignup ? 'Have an account? ' : 'New here? ', h('a', { href: isSignup ? '#/signin' : '#/signup', text: isSignup ? 'Sign in' : 'Create an account' })])
      : h('p', { class: 'switch', text: 'Accounts on this server are made by its administrator.' });
    show(h('section', { class: 'hero' }, [
      h('h1', { text: isSignup ? 'Docs that read like a letter' : 'Welcome back' }),
      h('p', { class: 'lede', text: 'Host your docs straight from git, with search, an assistant on your own key, and a domain of your own.' }),
      form,
      switcher,
    ]));
    email.focus();
  }

  // ---- sites ----------------------------------------------------------------------------
  function sitesPage() {
    api('GET', 'sites').then(function (data) {
      var limits = session.limits;
      var full = data.sites.length >= limits.maxSites;
      var list = data.sites.length
        ? h('ul', { class: 'sites' }, data.sites.map(function (site) {
          return h('li', null, h('a', { class: 'site', href: '#/sites/' + site.slug }, [
            h('div', null, [h('div', { class: 'site-name', text: site.slug }), h('div', { class: 'site-meta', text: site.repo.replace(/^https:\/\//, '') + ' · ' + site.branch })]),
            badge(site.status.state),
          ]));
        }))
        : h('div', { class: 'panel empty' }, [
          h('h2', { text: 'Nothing published yet' }),
          h('p', { class: 'muted', text: 'Point Docubase at a git repository with a docs folder. It builds in about a minute and rebuilds on every push.' }),
          full ? null : h('a', { class: 'btn primary', href: '#/new', text: 'Add your first site' }),
        ]);
      show(
        h('div', { class: 'head' }, [
          h('div', null, [h('p', { class: 'eyebrow', text: data.sites.length + ' of ' + limits.maxSites + ' sites' + (limits.plan !== 'none' ? ', ' + limits.plan + ' plan' : '') }), h('h1', { text: 'Your sites' })]),
          full || !data.sites.length ? null : h('a', { class: 'btn primary', href: '#/new', text: 'Add a site' }),
        ]),
        full && session.billing.enabled && limits.plan === 'free' ? h('div', { class: 'notice' }, ['You have used every site on the free plan. ', h('a', { href: '#/billing', text: 'Upgrade' }), ' for more.']) : null,
        list
      );
    }).catch(function (e) { show(h('p', { class: 'error', text: e.message })); });
  }

  function newSitePage() {
    var slug = h('input', { required: true, pattern: '[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?', maxlength: '40', autocomplete: 'off', spellcheck: 'false', placeholder: 'acme' });
    var repo = h('input', { type: 'url', required: true, placeholder: 'https://github.com/acme/app', autocomplete: 'off', spellcheck: 'false' });
    var branch = h('input', { value: 'main', autocomplete: 'off', spellcheck: 'false' });
    var dir = h('input', { placeholder: 'docs', autocomplete: 'off', spellcheck: 'false' });
    var token = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Only for private repositories' });
    var preview = h('code', { text: '<name>.' + location.hostname.replace(/^[^.]+\./, '') });
    slug.addEventListener('input', function () { preview.textContent = (slug.value || '<name>') + '.' + location.hostname.replace(/^[^.]+\./, ''); });
    show(
      h('div', { class: 'head' }, h('div', null, [h('p', { class: 'crumbs' }, [h('a', { href: '#/', text: 'Your sites' }), ' / new']), h('h1', { text: 'Add a site' })])),
      submitting(h('form', { class: 'panel' }, [
        field('Name', slug, null),
        h('p', { class: 'muted small' }, ['The site will be at ', preview, '. Lowercase letters, numbers and dashes.']),
        field('Repository', repo, 'Public https address of a GitHub, GitLab or other git repository.'),
        h('div', { class: 'grid' }, [field('Branch', branch), field('Docs folder', dir, 'Leave empty if the docs are at the root.')]),
        field('Access token', token, 'Optional. Stored encrypted and never shown again.'),
        h('button', { type: 'submit', class: 'btn primary', text: 'Create site' }),
      ]), function () {
        var body = { slug: slug.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main', dir: dir.value.trim() };
        if (token.value) body.repoToken = token.value;
        return api('POST', 'sites', body).then(function (data) {
          oneTime[data.site.slug] = data.webhook;
          session.sites += 1;
          location.hash = '#/sites/' + data.site.slug;
        });
      })
    );
  }

  function sitePage(slug, tab) {
    clearTimeout(pollTimer);
    api('GET', 'sites/' + encodeURIComponent(slug)).then(function (data) {
      var site = data.site;
      var limits = session.limits;
      var busy = site.status.state === 'building' || site.status.state === 'queued';
      var currentTab = tab || 'overview';
      if (busy) pollTimer = setTimeout(function () { if (location.hash.indexOf('#/sites/' + slug) === 0) sitePage(slug, currentTab); }, 3000);

      var hook = oneTime[slug];
      var hookUrl = hook ? (hook.url.indexOf('http') === 0 ? hook.url : location.origin + hook.url) : '';
      var webhookNotice = hook ? h('div', { class: 'notice warn' }, [
        h('h2', { text: 'Rebuild on every push' }),
        h('p', { text: 'Add a webhook in your repository settings with this address and secret, for push events. The secret is shown only now.' }),
        h('p', { class: 'secret' }, [h('code', { text: hookUrl }), copyButton(hookUrl)]),
        h('p', { class: 'secret' }, [h('code', { text: hook.secret }), copyButton(hook.secret)]),
        h('button', { type: 'button', class: 'link-btn', onclick: function () { delete oneTime[slug]; sitePage(slug, currentTab); }, text: 'I have saved it' }),
      ]) : null;

      var tabs = ['overview', 'settings', 'domains', 'assistant', 'danger'];
      var labels = { overview: 'Overview', settings: 'Repository', domains: 'Domains', assistant: 'Assistant', danger: 'Delete' };
      var tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(function (name) {
        return h('button', { type: 'button', role: 'tab', 'aria-selected': name === currentTab ? 'true' : 'false', onclick: function () { sitePage(slug, name); }, text: labels[name] });
      }));

      var body;
      if (currentTab === 'overview') {
        body = h('div', null, [
          h('div', { class: 'panel' }, [
            h('dl', { class: 'facts' }, [
              h('dt', { text: 'Address' }), h('dd', null, h('a', { href: site.url, target: '_blank', rel: 'noopener noreferrer', text: site.url })),
              site.domains.length ? h('dt', { text: 'Domains' }) : null, site.domains.length ? h('dd', { text: site.domains.join(', ') }) : null,
              h('dt', { text: 'Repository' }), h('dd', { class: 'mono', text: site.repo + ' @ ' + site.branch + (site.dir ? ' / ' + site.dir : '') }),
              h('dt', { text: 'Deployed' }), h('dd', { text: site.deploy ? site.deploy.commit.slice(0, 7) + ', ' + site.deploy.pages + ' pages, ' + when(site.deploy.builtAt) : 'Not yet' }),
            ]),
          ]),
          h('div', { class: 'panel' }, [
            h('div', { class: 'head' }, [h('h2', { text: 'Build log' }), h('button', { type: 'button', class: 'btn', disabled: busy, onclick: function (e) {
              e.target.disabled = true;
              api('POST', 'sites/' + slug + '/deploy').then(function () { toast('Build queued'); sitePage(slug, 'overview'); }, function (err) { toast(err.message); e.target.disabled = false; });
            }, text: busy ? 'Building' : 'Rebuild now' })]),
            site.status.error ? h('p', { class: 'error', text: site.status.error }) : null,
            h('ul', { class: 'log' }, (site.status.log || []).slice().reverse().map(function (line) {
              return h('li', null, [h('time', { datetime: line.at, text: when(line.at) }), h('span', { text: line.message })]);
            })),
          ]),
        ]);
      } else if (currentTab === 'settings') {
        var repo = h('input', { type: 'url', value: site.repo, required: true, spellcheck: 'false' });
        var branch = h('input', { value: site.branch, required: true, spellcheck: 'false' });
        var dir = h('input', { value: site.dir || '', spellcheck: 'false' });
        var token = h('input', { type: 'password', autocomplete: 'off', placeholder: site.hasRepoToken ? 'A token is saved. Type to replace it.' : 'Only for private repositories' });
        body = submitting(h('form', { class: 'panel' }, [
          field('Repository', repo), h('div', { class: 'grid' }, [field('Branch', branch), field('Docs folder', dir)]),
          field('Access token', token, 'Stored encrypted and never shown again.'),
          h('div', { class: 'row' }, [
            h('button', { type: 'submit', class: 'btn primary', text: 'Save and rebuild' }),
            site.hasRepoToken ? h('button', { type: 'button', class: 'btn', onclick: function () { api('PATCH', 'sites/' + slug, { repoToken: null }).then(function () { toast('Token removed'); sitePage(slug, 'settings'); }, function (e) { toast(e.message); }); }, text: 'Remove token' }) : null,
          ]),
        ]), function () {
          var patch = { repo: repo.value.trim(), branch: branch.value.trim(), dir: dir.value.trim() };
          if (token.value) patch.repoToken = token.value;
          return api('PATCH', 'sites/' + slug, patch).then(function () { toast('Saved. Rebuilding.'); sitePage(slug, 'overview'); });
        });
      } else if (currentTab === 'domains') {
        if (!limits.customDomains) {
          body = h('div', { class: 'panel' }, [h('h2', { text: 'Use your own domain' }), h('p', { class: 'muted', text: 'Custom domains are part of the paid plan.' }), h('a', { class: 'btn primary', href: '#/billing', text: 'See plans' })]);
        } else {
          var list = h('textarea', { rows: '4', spellcheck: 'false', placeholder: 'docs.example.com' });
          list.value = site.domains.concat(site.pendingDomains.map(function (p) { return p.domain; })).join('\n');
          var pending = site.pendingDomains.length ? h('div', { class: 'panel' }, [
            h('h2', { text: 'Prove you own ' + (site.pendingDomains.length === 1 ? 'this domain' : 'these domains') }),
            h('p', { class: 'muted', text: 'Add a TXT record for each name below at your DNS provider, then check. The domain starts serving once the record is found.' }),
            h('dl', { class: 'facts' }, site.pendingDomains.reduce(function (out, p) {
              return out.concat([
                h('dt', { text: 'Name' }), h('dd', { class: 'secret' }, [h('code', { text: p.record }), copyButton(p.record)]),
                h('dt', { text: 'Value' }), h('dd', { class: 'secret' }, [h('code', { text: p.value }), copyButton(p.value)]),
              ]);
            }, [])),
            h('p', null, h('button', { type: 'button', class: 'btn primary', onclick: function (e) {
              e.target.disabled = true;
              api('POST', 'sites/' + slug + '/verify-domains').then(function (data) {
                var ok = data.results.filter(function (r) { return r.verified; }).length;
                var failed = data.results.filter(function (r) { return r.error; });
                toast(failed.length ? failed[0].domain + ': ' + failed[0].error : ok ? ok + ' domain' + (ok === 1 ? '' : 's') + ' verified' : 'No record found yet. DNS changes can take a few minutes.');
                sitePage(slug, 'domains');
              }, function (err) { toast(err.message); e.target.disabled = false; });
            }, text: 'Check DNS' })),
          ]) : null;
          body = h('div', null, [
            site.domains.length ? h('div', { class: 'panel' }, [h('h2', { text: 'Live domains' }), h('ul', null, site.domains.map(function (d) { return h('li', null, h('a', { href: 'https://' + d, target: '_blank', rel: 'noopener noreferrer', text: d })); }))]) : null,
            pending,
            submitting(h('form', { class: 'panel' }, [
              field('Domains', list, 'One per line, up to 10. Point each one at this server with a CNAME record to ' + site.url.replace(/^https?:\/\//, '').replace(/:\d+$/, '') + '. Certificates are issued when the first request arrives.'),
              h('button', { type: 'submit', class: 'btn primary', text: 'Save domains' }),
            ]), function () {
              var domains = list.value.split(/[\s,]+/).map(function (d) { return d.trim(); }).filter(Boolean);
              return api('PUT', 'sites/' + slug + '/domains', { domains: domains }).then(function () { toast('Domains saved'); sitePage(slug, 'domains'); });
            }),
          ]);
        }
      } else if (currentTab === 'assistant') {
        if (!limits.assistant) {
          body = h('div', { class: 'panel' }, [h('h2', { text: 'Ask AI for your readers' }), h('p', { class: 'muted', text: 'The assistant is part of the paid plan. It answers from your docs with your own model key.' }), h('a', { class: 'btn primary', href: '#/billing', text: 'See plans' })]);
        } else {
          var key = h('input', { type: 'password', autocomplete: 'off', required: true, placeholder: site.hasAssistantKey ? 'A key is saved. Paste a new one to replace it.' : 'Your Anthropic or OpenAI compatible API key' });
          body = submitting(h('form', { class: 'panel' }, [
            h('p', { class: 'muted' }, ['Turn the assistant on in ', h('code', { text: 'docubase.config.json' }), ' in your repository, then save your model key here. It is encrypted on this server and cannot be read back.']),
            field('API key', key),
            h('div', { class: 'row' }, [
              h('button', { type: 'submit', class: 'btn primary', text: site.hasAssistantKey ? 'Replace key' : 'Save key' }),
              site.hasAssistantKey ? h('button', { type: 'button', class: 'btn', onclick: function () { api('DELETE', 'sites/' + slug + '/assistant-key').then(function () { toast('Key removed'); sitePage(slug, 'assistant'); }, function (e) { toast(e.message); }); }, text: 'Remove key' }) : null,
            ]),
          ]), function () {
            return api('PUT', 'sites/' + slug + '/assistant-key', { key: key.value.trim() }).then(function () { toast('Key saved'); sitePage(slug, 'assistant'); });
          });
        }
      } else {
        var confirmName = h('input', { autocomplete: 'off', spellcheck: 'false', placeholder: slug });
        body = submitting(h('form', { class: 'panel danger' }, [
          h('h2', { text: 'Delete this site' }),
          h('p', { class: 'muted', text: 'The site goes offline at once and its builds, domains and saved keys are removed. Your repository is not touched.' }),
          field('Type the site name to confirm', confirmName),
          h('button', { type: 'submit', class: 'btn danger', text: 'Delete site' }),
        ]), function () {
          if (confirmName.value.trim() !== slug) throw new Error('The name does not match');
          return api('DELETE', 'sites/' + slug).then(function () { session.sites -= 1; toast('Site deleted'); location.hash = '#/'; });
        });
      }

      show(
        h('div', { class: 'head' }, [
          h('div', null, [h('p', { class: 'crumbs' }, [h('a', { href: '#/', text: 'Your sites' }), ' / ' + site.slug]), h('h1', { text: site.slug })]),
          badge(site.status.state),
        ]),
        webhookNotice,
        tabBar,
        body
      );
    }).catch(function (e) { show(h('h1', { text: 'Site not found' }), h('p', { class: 'error', text: e.message }), h('a', { href: '#/', text: 'Back to sites' })); });
  }

  // ---- billing and account ----------------------------------------------------------------
  function billingPage() {
    var limits = session.limits;
    var user = session.user;
    if (!session.billing.enabled) {
      show(h('div', { class: 'head' }, h('div', null, [h('p', { class: 'eyebrow', text: 'Plan and payment' }), h('h1', { text: 'Billing' })])), h('div', { class: 'panel' }, h('p', { class: 'muted', text: 'Billing is not set up on this server, so there are no plans. You can add up to ' + limits.maxSites + ' sites.' })));
      return;
    }
    var pro = limits.plan === 'pro';
    var go = function (action) {
      return function (event) {
        event.target.disabled = true;
        api('POST', 'billing/' + action).then(function (data) { location.href = data.url; }, function (e) { toast(e.message); event.target.disabled = false; });
      };
    };
    var done = /[?&]done=1/.test(location.hash);
    show(
      h('div', { class: 'head' }, h('div', null, [h('p', { class: 'eyebrow', text: 'Plan and payment' }), h('h1', { text: 'Billing' })])),
      done && !pro ? h('div', { class: 'notice', text: 'Thanks. Your payment is being confirmed. This page updates in a few seconds.' }) : null,
      h('div', { class: 'grid' }, [
        h('div', { class: 'panel' }, [
          h('p', { class: 'eyebrow', text: 'Current plan' }),
          h('p', { class: 'plan', text: limits.plan }),
          user.subscription ? h('p', { class: 'muted small', text: 'Subscription: ' + user.subscription.replace(/_/g, ' ') }) : null,
          h('p', { text: limits.maxSites + ' site' + (limits.maxSites === 1 ? '' : 's') + (limits.customDomains ? ', custom domains' : '') + (limits.assistant ? ', Ask AI' : '') }),
          user.subscription
            ? h('button', { type: 'button', class: 'btn', onclick: go('portal'), text: 'Manage payment or cancel' })
            : null,
        ]),
        pro ? null : h('div', { class: 'panel' }, [
          h('p', { class: 'eyebrow', text: 'Upgrade' }),
          h('p', { class: 'plan', text: 'Pro' }),
          h('p', { text: 'More sites, your own domains, and Ask AI on every site.' }),
          h('button', { type: 'button', class: 'btn primary', onclick: go('checkout'), text: 'Upgrade with Stripe' }),
          h('p', { class: 'muted small', text: 'Payment happens on Stripe. Card details never reach this server.' }),
        ]),
      ])
    );
    if (done && !pro) {
      setTimeout(function () {
        api('GET', 'session').then(function (data) { if (data.user) { session = data; if (location.hash.indexOf('#/billing') === 0) billingPage(); } });
      }, 3000);
    }
  }

  function accountPage() {
    var current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    var next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
    var confirmPw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    show(
      h('div', { class: 'head' }, h('div', null, [h('p', { class: 'eyebrow', text: 'Signed in as ' + session.user.email }), h('h1', { text: 'Account' })])),
      h('div', { class: 'panel' }, h('button', { type: 'button', class: 'btn', onclick: function () {
        api('DELETE', 'session').then(function () { session = null; location.hash = '#/signin'; });
      }, text: 'Sign out' })),
      submitting(h('form', { class: 'panel' }, [
        h('h2', { text: 'Change password' }),
        field('Current password', current), field('New password', next, 'At least 10 characters. Other devices are signed out.'),
        h('button', { type: 'submit', class: 'btn primary', text: 'Change password' }),
      ]), function () {
        return api('POST', 'account/password', { current: current.value, next: next.value }).then(function () { current.value = ''; next.value = ''; toast('Password changed'); });
      }),
      submitting(h('form', { class: 'panel danger' }, [
        h('h2', { text: 'Delete account' }),
        h('p', { class: 'muted', text: 'Deletes your account and every site you own. Cancel any subscription first.' }),
        field('Password', confirmPw),
        h('button', { type: 'submit', class: 'btn danger', text: 'Delete my account' }),
      ]), function () {
        return api('DELETE', 'account', { password: confirmPw.value }).then(function () { session = null; location.hash = '#/signin'; toast('Account deleted'); });
      })
    );
  }

  // ---- routing -------------------------------------------------------------------------------
  var signupOpen = false;
  function route() {
    clearTimeout(pollTimer);
    var hash = location.hash.replace(/^#/, '').split('?')[0] || '/';
    if (!session) {
      setNav(null);
      authPage(signupOpen, hash === '/signup' ? 'signup' : 'signin');
      return;
    }
    var parts = hash.split('/').filter(Boolean);
    setNav(parts[0] === 'billing' || parts[0] === 'account' ? parts[0] : '');
    if (parts[0] === 'new') newSitePage();
    else if (parts[0] === 'sites' && parts[1]) sitePage(decodeURIComponent(parts[1]));
    else if (parts[0] === 'billing') billingPage();
    else if (parts[0] === 'account') accountPage();
    else sitesPage();
  }

  window.addEventListener('hashchange', route);
  api('GET', 'session').then(function (data) {
    signupOpen = data.signup === 'open';
    session = data.user ? data : null;
    route();
  }, function () {
    show(h('p', { class: 'error', text: 'The dashboard could not reach the server.' }));
  });
})();
