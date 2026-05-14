# ── Stage 1: install dependencies (needs build tools for native modules) ──────
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: lean runtime image ───────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime
RUN apk add --no-cache libstdc++

COPY --from=deps /app/node_modules ./node_modules
COPY src/    ./src/
COPY views/  ./views/
COPY server.js package.json ./

# Persistent volume for database + TLS certificates
VOLUME /data

ENV NODE_ENV=production \
    PORT=3443 \
    DATABASE_URL=/data/dmarc.db \
    CERTS_DIR=/data/certs

EXPOSE 3443

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null --no-check-certificate \
      "https://localhost:${PORT:-3443}/auth/login" 2>&1 || exit 1

CMD ["node", "server.js"]
