# @docubase/host

The hosting server for [Docubase](https://www.npmjs.com/package/docubase) sites. Point it at a git repository and it builds the docs, serves them at `<name>.your-domain.com` or at a verified custom domain, rebuilds on every push, and answers Ask AI questions with a key the site owner supplies.

It has an admin API for the operator and a web dashboard where people sign up, add sites and, optionally, pay for a plan through Paystack.

```bash
npm install -g @docubase/host
DOCUBASE_ADMIN_TOKEN=... DOCUBASE_MASTER_KEY=... DOCUBASE_BASE_DOMAIN=docs.example.com docubase-host
```

For a real deployment, use the Docker setup in the repository, which puts Caddy in front for HTTPS. Settings, security notes and billing setup are in the guide: https://docubase.clientra.tech/docs/guides/managed-hosting/

## License

MIT
