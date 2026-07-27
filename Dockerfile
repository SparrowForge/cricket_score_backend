# CricLive API — container image (Back4App Containers / any Docker host).
#
# Two stages so the runtime image carries no devDependencies or TypeScript
# sources: `build` compiles src/ -> dist/, `runtime` installs prod deps only.
#
# The app reads PORT (default 3001) and serves:
#   /health                    liveness + DB probe (no prefix)
#   /api/v1/*                  REST
#   /live (Socket.IO)          realtime fan-out via Redis pub/sub
#   /api/docs                  Swagger UI

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Kept so `npm run db:migrate` can be run inside the container (Back4App web shell).
COPY migrations ./migrations
COPY scripts ./scripts

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "dist/main.js"]
