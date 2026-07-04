# Waggle server — multi-stage build.
# Note: the repo's exFAT dev workaround (scripts/sync-workspace.mjs) is not
# needed here; the Linux image supports symlinks, but we keep the copy-based
# workspace layout so the same lockfile builds everywhere.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-alpine AS run
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
# Copy the built workspace (dist + node_modules synced by the build).
COPY --from=build /app /app
WORKDIR /app/packages/server
EXPOSE 8080
ENV HOST=0.0.0.0 PORT=8080
# migrate() runs at boot inside server.ts; start serves after it completes.
CMD ["node", "dist/server.js"]
