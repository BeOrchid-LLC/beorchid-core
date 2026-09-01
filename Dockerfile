# syntax=docker/dockerfile:1

# ═══════════════════════════════════════════════════════════════════════════
# core-api
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory, because npm
# resolves this workspace through the root lockfile. In Coolify set Base
# Directory to "/" and Dockerfile Location to "/core-api/Dockerfile".
#
#   docker build -f core-api/Dockerfile -t beorchid/core-api .
#
# core-api does not depend on core-sdk. Nothing here copies or installs it.
# ═══════════════════════════════════════════════════════════════════════════

FROM node:22-alpine AS base
# dumb-init gives PID 1 correct signal handling, so SIGTERM from Coolify reaches
# the process and the graceful shutdown in src/index.ts actually runs.
RUN apk add --no-cache dumb-init
WORKDIR /repo

# ── Dependencies ───────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY core-api/package.json ./core-api/

# Install ONLY this workspace, and only its production dependencies.
#
# A bare `npm ci` at the root installs every workspace, so core-api's image
# would carry core-web's Next.js and image tooling: over 400 MB this service
# never loads. --workspace scopes the install to what this service actually
# needs.
#
# --omit=dev drops typescript, drizzle-kit and the type packages. tsx stays
# because it is a runtime dependency here: the start script runs the
# TypeScript directly rather than compiling ahead of time.
#
# --ignore-scripts stops any dependency's postinstall running during the build.
RUN npm ci --workspace @beorchid/core-api --include-workspace-root \
      --omit=dev --ignore-scripts

# ── Runtime ────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000

# Never run as root. A compromised container should not also be privileged
# inside itself.
RUN addgroup -g 1001 -S nodejs && adduser -S coreapi -u 1001 -G nodejs

COPY --from=deps --chown=coreapi:nodejs /repo/node_modules ./node_modules
COPY --from=deps --chown=coreapi:nodejs /repo/package.json ./package.json
COPY --chown=coreapi:nodejs core-api ./core-api

WORKDIR /repo/core-api
USER coreapi
EXPOSE 3000

# Distinct from Coolify's health check: this one tells Docker itself the
# container is unhealthy, which is what restart policies act on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]
