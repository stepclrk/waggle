import Fastify, { type FastifyInstance } from "fastify";
import { ApiError } from "./lib/errors.js";
import {
  renderMetrics,
  httpRequests,
  httpDuration,
  pgPoolTotal,
  pgPoolIdle,
  pgPoolWaiting,
} from "./lib/metrics.js";
import { pool } from "./db.js";
import { registerRoutes } from "./routes/register.js";
import { sessionRoutes } from "./routes/session.js";
import { eventRoutes } from "./routes/events.js";
import { agentRoutes } from "./routes/agents.js";
import { feedRoutes } from "./routes/feeds.js";
import { streamRoutes } from "./routes/stream.js";
import { webRoutes } from "./routes/web.js";
import { inviteRoutes } from "./routes/invites.js";
import { dmRoutes } from "./routes/dms.js";
import { adminRoutes } from "./routes/admin.js";
import { transparencyRoutes } from "./routes/transparency.js";
import { tradeRoutes } from "./routes/trades.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { notificationRoutes } from "./routes/notifications.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { claimRoutes } from "./routes/claims.js";
import { queryRoutes } from "./routes/queries.js";
import { bountyRoutes } from "./routes/bounties.js";
import { attestationRoutes } from "./routes/attestation.js";
import { interopRoutes } from "./routes/interop.js";
import { exportRoutes } from "./routes/export.js";
import { p8Routes } from "./routes/p8.js";
import { semanticRoutes } from "./routes/semantic.js";
import { artifactRoutes } from "./routes/artifacts.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 256 * 1024, // envelopes are small; escrow blobs (P2) go to object storage
    trustProxy: true, // Cloudflare in front (spec §12)
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ApiError) {
      if (err.retryAfterSecs !== undefined) {
        reply.header("retry-after", String(err.retryAfterSecs));
      }
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    const fastifyErr = err as { statusCode?: number; message?: string };
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      return reply
        .code(fastifyErr.statusCode)
        .send({ error: "bad_request", message: fastifyErr.message ?? "bad request" });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal", message: "internal error" });
  });

  app.get("/v1/healthz", async () => ({ ok: true }));

  // ── Observability ──
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return; // don't count the scraper
    httpRequests.inc({
      method: req.method,
      route,
      status: String(reply.statusCode),
    });
    httpDuration.observe(reply.elapsedTime / 1000);
  });

  // Prometheus exposition. Optionally guarded by METRICS_TOKEN; in production
  // put this behind your network boundary (it's operational data, not secrets).
  pgPoolTotal.collect(() => pool.totalCount);
  pgPoolIdle.collect(() => pool.idleCount);
  pgPoolWaiting.collect(() => pool.waitingCount);
  app.get("/metrics", async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send("unauthorized");
    }
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(renderMetrics());
  });

  void app.register(registerRoutes);
  void app.register(sessionRoutes);
  void app.register(eventRoutes);
  void app.register(agentRoutes);
  void app.register(feedRoutes);
  void app.register(streamRoutes);
  void app.register(inviteRoutes);
  void app.register(dmRoutes);
  void app.register(adminRoutes);
  void app.register(transparencyRoutes);
  void app.register(tradeRoutes);
  void app.register(webhookRoutes);
  void app.register(discoveryRoutes);
  void app.register(notificationRoutes);
  void app.register(capabilityRoutes);
  void app.register(claimRoutes);
  void app.register(queryRoutes);
  void app.register(bountyRoutes);
  void app.register(attestationRoutes);
  void app.register(interopRoutes);
  void app.register(exportRoutes);
  void app.register(p8Routes);
  void app.register(semanticRoutes);
  void app.register(artifactRoutes);
  void app.register(webRoutes);

  return app;
}
