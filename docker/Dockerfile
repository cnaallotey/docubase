# syntax=docker/dockerfile:1
#
# Two images from one file.
#   docs  serves a folder of Markdown (build, then start). Mount your docs at /docs.
#   host  runs the managed hosting server (many sites, built from git).
#
#   docker build -f docker/Dockerfile --target docs -t docubase .
#   docker build -f docker/Dockerfile --target host -t docubase-host .

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/docubase/package.json packages/docubase/
COPY packages/host/package.json packages/host/
COPY packages/nuxt/package.json packages/nuxt/
# The Nuxt example is a workspace in the lock file, so its manifest has to exist, but it is never installed.
COPY examples/nuxt/package.json examples/nuxt/
RUN npm ci --omit=dev --no-audit --no-fund --workspace docubase --workspace @docubase/host

FROM node:22-alpine AS base
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core ./packages/core
COPY packages/docubase ./packages/docubase
COPY packages/host ./packages/host
COPY LICENSE ./

# ---- docs: serve one docs folder -------------------------------------------------------------
FROM base AS docs
ENV PORT=3000 DOCS_DIR=/docs OUT_DIR=/site
COPY docker/docs-entrypoint.sh /usr/local/bin/docs-entrypoint
RUN chmod 755 /usr/local/bin/docs-entrypoint && mkdir -p /docs /site && chown node:node /docs /site
USER node
EXPOSE 3000
# Any answer below 500 means the server is up. A site with a base path answers 404 at "/", which is fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "docs-entrypoint"]

# ---- host: the managed hosting server --------------------------------------------------------
FROM base AS host
# git fetches customer repositories. The server calls it directly, with hooks and submodules off.
RUN apk add --no-cache git && mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8080 DOCUBASE_DATA_DIR=/data
VOLUME ["/data"]
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/__host/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/packages/host/bin/docubase-host.js"]
