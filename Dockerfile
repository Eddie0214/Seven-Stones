# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/app/data/league.sqlite

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@11.25.0 \
 && pnpm install --frozen-lockfile --prod

COPY server.cjs game.cjs invitations.cjs google-auth.cjs ai-worker.cjs ./
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.cjs"]
