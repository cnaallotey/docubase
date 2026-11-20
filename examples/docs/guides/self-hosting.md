---
title: Self hosting with Docker
description: Run a docs folder, with the assistant if you want it, from one container.
order: 8
---

The Docker image builds your docs when the container starts and then serves them. It runs as an unprivileged user and works with a read only file system. The only outbound traffic is the assistant calling your model provider, if you turn it on.

## Run it

```bash
docker build -f docker/Dockerfile --target docs -t docubase .
docker run --rm -p 3000:3000 -v "$(pwd)/docs:/docs:ro" docubase
```

Open `http://localhost:3000`. Mount your own docs folder at `/docs`. If the folder is empty or missing, the container stops with a message that says so.

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port inside the container |
| `DOCS_DIR` | `/docs` | Where the docs are mounted |
| `OUT_DIR` | `/site` | Where the built site is written |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | none | Needed only when the assistant is on, see [AI and agents](./ai-and-agents.md) |

The site is served under the `base` in your config. A site with `"base": "/docs/"` answers at `/docs/` and returns 404 at `/`, which the health check accepts.

## Compose

`docker/compose.yml` does the same with a read only root file system and `no-new-privileges`:

```bash
docker compose -f docker/compose.yml up --build
```

## Bake the docs into an image

To ship one image per site, build the docs in an earlier stage and copy the output:

```dockerfile
FROM docubase AS build
COPY docs /docs
RUN node /app/packages/docubase/bin/docubase.js build /docs --out /site

FROM node:22-alpine
COPY --from=build /app /app
COPY --from=build /docs /docs
COPY --from=build /site /site
USER node
CMD ["node", "/app/packages/docubase/bin/docubase.js", "start", "/docs", "--out", "/site", "--host", "0.0.0.0"]
```

Or skip the server and copy `/site` to any static host, see [Deploying](./deploying.md).

## HTTPS

The server speaks plain HTTP. Put it behind a reverse proxy that terminates HTTPS, and set `trustProxy` in the assistant options so rate limits see each reader's address.
