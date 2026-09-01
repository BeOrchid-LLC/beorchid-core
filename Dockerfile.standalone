# syntax=docker/dockerfile:1

# ═══════════════════════════════════════════════════════════════════════════
# beorchid-core — Core API
#
# Build context is the repository root, which is now this directory.
#   docker build -t beorchid/core-api .
#
# In Coolify: Base Directory "/", Dockerfile Location "/Dockerfile".
# ═══════════════════════════════════════════════════════════════════════════

FROM node:22-alpine AS base
# dumb-init gives PID 1 correct signal handling, so SIGTERM from Coolify reaches
# the process and the graceful shutdown in src/index.ts actually runs.
RUN apk add --no-cache dumb-init
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# --omit=dev drops typescript, drizzle-kit and the type packages. tsx stays: it
# is a runtime dependency here, because the start script runs the TypeScript
# directly rather than compiling ahead of time.
RUN npm ci --omit=dev --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000

# Never run as root.
RUN addgroup -g 1001 -S nodejs && adduser -S coreapi -u 1001 -G nodejs

COPY --from=deps --chown=coreapi:nodejs /app/node_modules ./node_modules
COPY --chown=coreapi:nodejs . .

USER coreapi
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]
