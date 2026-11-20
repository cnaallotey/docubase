---
title: Managed hosting
description: Run the Docubase host server to build and serve many docs sites from git.
order: 9
---

`docubase-host` is the server behind a managed tier. You give it a git repository, and it builds the docs, serves them at `<name>.your-domain.com` or at a custom domain, rebuilds on every push, and answers Ask AI questions with a key the site owner supplies. You can run it yourself, and it is the same code a hosted plan would run.

It has two front doors: an admin API for the operator, and a web dashboard where people sign up, add their own sites and pay for a plan through Paystack. Billing is optional, so a team can run it for itself with no plans at all.

## Start it

```bash
docker build -f docker/Dockerfile --target host -t docubase-host .
docker run -d --name docubase-host -p 8080:8080 -v docubase-data:/data \
  -e DOCUBASE_ADMIN_TOKEN="$(openssl rand -base64 32)" \
  -e DOCUBASE_MASTER_KEY="$(openssl rand -hex 32)" \
  -e DOCUBASE_BASE_DOMAIN=docs.example.com \
  docubase-host
```

Keep the token and the master key somewhere safe. Losing the master key means the stored secrets can no longer be read.

For a real deployment, `docker/compose.host.yml` runs the host behind Caddy, which gets HTTPS certificates on demand for site names and custom domains:

```bash
cp docker/.env.example docker/.env     # fill in the three values
docker compose -f docker/compose.host.yml --env-file docker/.env up -d --build
```

Point `*.docs.example.com`, `admin.docs.example.com` and `app.docs.example.com` at the server.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `DOCUBASE_ADMIN_TOKEN` | required | Bearer token for the admin API, at least 24 characters |
| `DOCUBASE_MASTER_KEY` | required | 32 bytes as 64 hex characters, used to encrypt stored secrets |
| `DOCUBASE_BASE_DOMAIN` | required | Sites are served at `<name>.<this domain>` |
| `DOCUBASE_ADMIN_HOST` | none | When set, the admin API answers only on this hostname |
| `DOCUBASE_DATA_DIR` | `./data` | Site database and built sites |
| `DOCUBASE_PUBLIC_URL` | none | Public address of the admin host, used in webhook URLs |
| `DOCUBASE_TRUST_PROXY` | off | Read reader addresses from `X-Forwarded-For`. Turn on only behind your own proxy |
| `DOCUBASE_DASHBOARD_HOST` | `app.<base domain>` | Hostname of the dashboard. `off` turns it off |
| `DOCUBASE_SIGNUP` | `closed` | `open` lets anyone create an account. `closed` means the admin creates them |
| `DOCUBASE_USER_MAX_SITES` | `3` | Sites per account when billing is off |
| `DOCUBASE_FREE_SITES` | `1` | Sites on the free plan when billing is on |
| `DOCUBASE_PRO_SITES` | `10` | Sites on the paid plan |
| `PAYSTACK_SECRET_KEY` | none | Turns billing on with Paystack, together with the next one |
| `PAYSTACK_PLAN_CODE` | none | The Paystack plan for the paid plan (`PLN_...`) |
| `DOCUBASE_BILLING` | `paystack` when its keys are set | `paystack`, `stripe` or `off`. Stripe is used only when this says so |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | none | Stripe keys, read only when `DOCUBASE_BILLING=stripe` |
| `DOCUBASE_MAX_SITES` | `50` | Most sites this server will hold |
| `DOCUBASE_BUILD_CONCURRENCY` | `2` | Builds that run at the same time |
| `DOCUBASE_BUILD_TIMEOUT_SECONDS` | `120` | A build that takes longer is stopped |
| `DOCUBASE_MAX_DOCS_MB` | `50` | Largest repository checkout accepted |
| `DOCUBASE_MAX_FILES` | `5000` | Most files in a checkout |
| `PORT`, `HOST` | `8080`, `127.0.0.1` | Where to listen. The Docker image listens on all addresses |

## Add a site

Every admin call sends `Authorization: Bearer <token>`.

```bash
curl -X POST https://admin.docs.example.com/__host/api/sites \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"slug":"acme","repo":"https://github.com/acme/docs","branch":"main","dir":"docs"}'
```

The reply contains a webhook address and a secret. **The secret is shown once.** In GitHub, add a webhook for push events with content type `application/json`, that address and that secret. GitLab works too, using the secret as the webhook token. A push to the site's branch triggers a rebuild, and other branches are ignored.

For a private repository, add `"repoToken": "<read only token>"`. It is encrypted at rest and sent to git in the environment, never in the address or the process list.

## Admin API

| Call | What it does |
| --- | --- |
| `GET /__host/api/sites` | List sites with their status |
| `POST /__host/api/sites` | Create a site: `slug`, `repo`, optional `branch`, `dir`, `repoToken` |
| `GET /__host/api/sites/<slug>` | Status, last deploy and the last 20 log lines |
| `PATCH /__host/api/sites/<slug>` | Change `repo`, `branch`, `dir` or `repoToken`, then rebuild |
| `POST /__host/api/sites/<slug>/deploy` | Rebuild now |
| `PUT /__host/api/sites/<slug>/domains` | Replace the custom domains: `{"domains":["docs.acme.com"]}` |
| `PUT /__host/api/sites/<slug>/assistant-key` | Set the model provider key: `{"key":"..."}` |
| `DELETE /__host/api/sites/<slug>/assistant-key` | Remove the key, which switches the assistant off |
| `DELETE /__host/api/sites/<slug>` | Delete the site and its builds |

| `GET /__host/api/users` | List dashboard accounts with their plan and sites |
| `POST /__host/api/users` | Create an account: `{"email":"...","password":"..."}`. Use this when sign up is closed |
| `PATCH /__host/api/users/<id>` | Set a plan by hand: `{"plan":"pro"}`, or `null` to follow billing again |
| `DELETE /__host/api/users/<id>` | Delete an account and every site it owns |

Keys can be replaced or removed but never read back. Sites created with the admin API have no owner and no plan limits.

## Dashboard

The dashboard answers at `app.docs.example.com`. People sign in with an email and password, then:

* add a site from a git repository, and see the webhook address and secret once
* watch the build status and log, and rebuild by hand
* change the repository, branch, folder or access token
* add custom domains, which go live after a DNS check
* save or remove the assistant key, which is encrypted and never shown again
* delete a site, change their password, or delete their account

Each person sees only their own sites. Someone else's site answers exactly like one that does not exist.

### Custom domains need proof

A domain added from the dashboard stays pending until its owner adds a TXT record that the dashboard shows, such as `_docubase-challenge.docs.acme.com` with the value `docubase-verify=<token>`, and presses **Check DNS**. Only then does the server route the name and let your proxy request a certificate for it. Each claim has its own token, and a name already live on one site cannot be verified for another. Domains set through the admin API skip the check, because only the operator can use it.

### Accounts and sessions

* Passwords are hashed with scrypt. Sign in and sign up are rate limited per address and per email, and an unknown email takes as long to refuse as a wrong password.
* The session is a random token in an `HttpOnly`, `SameSite=Lax` cookie, marked `Secure` unless `DOCUBASE_PUBLIC_URL` is plain `http`. Only a SHA-256 of it is stored. Sessions last 30 days.
* Every request that changes something must carry the header `x-docubase: 1`. A page on another site cannot add it without a preflight this server never approves.
* The page loads only its own script and stylesheet, under a strict content security policy, and cannot be framed.
* Changing the password signs out every other device.

## Billing

Billing runs through [Paystack](https://paystack.com). Set `PAYSTACK_SECRET_KEY` and `PAYSTACK_PLAN_CODE` to turn it on. Without a payment provider there are no plans: every account gets custom domains, the assistant and `DOCUBASE_USER_MAX_SITES` sites.

With billing on there are two plans:

| Plan | Sites | Custom domains | Ask AI |
| --- | --- | --- | --- |
| Free | `DOCUBASE_FREE_SITES` | no | no |
| Pro | `DOCUBASE_PRO_SITES` | yes | yes |

To set it up:

1. In Paystack, create a plan with a monthly interval and the price you charge, and copy its plan code (`PLN_...`).
2. Under Settings, then API Keys and Webhooks, set the webhook URL to `https://app.docs.example.com/__host/billing/webhook` and copy the secret key (`sk_live_...`, or `sk_test_...` while testing).
3. Set the two variables and restart.

**Upgrade to Pro** sends the person to Paystack's checkout, and **Manage payment or cancel** opens Paystack's page for changing the card or cancelling. Card details never reach this server. The plan changes only when a webhook signed with your secret key arrives, and only for your plan code:

| Paystack event | Result |
| --- | --- |
| `charge.success` | Pro |
| `subscription.create` | Pro, and the subscription is saved so it can be managed |
| `subscription.not_renew` | Still Pro until the paid period ends |
| `invoice.payment_failed` | Still Pro while Paystack retries |
| `subscription.disable` | Back to Free |

### Stripe

Stripe is supported too and kept off until you choose it. Set `DOCUBASE_BILLING=stripe` with `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET`, create a recurring price, turn on the customer portal, and add a webhook at the same `/__host/billing/webhook` address for `checkout.session.completed` and `customer.subscription.*` events. Stripe signatures older than five minutes are refused. The keys can sit in the environment beside Paystack's until then.

When a subscription ends, the account drops to the free plan. Its sites stay online at their `<name>.docs.example.com` address, but custom domains stop answering and saved assistant keys are ignored until the person pays again. Nothing is deleted.

### Try it on your laptop

`npm run playground:host` starts the hosting server with an open dashboard at http://app.localhost:8090. It keeps its data in `examples/playground/.host-data` and accepts local `file://` repositories, so it is for trying things only.

## How a site behaves

* The docs live in the repository, including `docubase.config.json`. The server builds the site for the root of its own hostname, so any `base` in the config is ignored.
* A failed build changes nothing. The previous version keeps serving, and the error appears in the site's status.
* A site with no successful build yet answers 503 while it builds and 502 if the first build failed.
* Ask AI uses the provider and model from the repository config, and the key from the admin API. The key never goes in the repository.
* Custom domains need a DNS record pointing at the server. Certificates come from your proxy. The server answers `/__host/tls-check?domain=` so a proxy can ask whether a name is one of yours before it requests a certificate.

## What protects the server

Customer repositories are untrusted input. Docubase only reads Markdown and an optional OpenAPI file and never runs code from them, and the server adds these limits:

* Only public `https` repository addresses are accepted, with no credentials in the address. Private network, loopback and cloud metadata addresses are refused.
* Git runs with hooks off, submodules off, symbolic links not created, a timeout and a size check while it downloads.
* Each build runs in its own process with a memory cap, an empty environment and a time limit.
* The docs folder must resolve inside the checkout.
* An assistant `baseUrl` in a customer config must be a public `https` address, and assistant requests to providers are checked again before they are sent.
* Rate limits for the assistant follow this server's proxy setting. A customer cannot change them from a config file.
* Secrets are encrypted with AES-256-GCM, bound to their site and purpose. Webhook signatures are checked in constant time, and a bad signature and an unknown site look the same.
* Failed admin logins are rate limited per address.

## Limits you should know about

* One server, one JSON database file. There is no clustering, and a restart pauses serving for a moment.
* Isolation between customers is by process, not by container or virtual machine. Run the host in a network that cannot reach your internal services. The address check just before each request cannot stop a hostile DNS server that changes its answer between the check and the connection.
* There is no email: no address confirmation and no password reset by mail. An admin can delete an account, or create a new one, through the admin API.
* Billing has one paid plan with one price, from one provider at a time. Trials, coupons and taxes are whatever you set up with the provider. Switching providers does not move existing subscriptions.
* There are no per site quotas for bandwidth or storage beyond the build limits above.
