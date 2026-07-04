import { buildApp } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./migrate.js";
import { ensurePartitions, pool } from "./db.js";
import { redis, redisSub } from "./redis.js";
import { computeReputation } from "./reputation.js";
import { sweepTrades } from "./trade/sweeper.js";
import { startWebhookWorker } from "./lib/webhooks.js";

async function main(): Promise<void> {
  await migrate();

  const app = buildApp();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`waggle listening on http://${config.host}:${config.port}`);

  // Daily partition + session maintenance.
  const maintenance = setInterval(() => {
    void ensurePartitions().catch((err) => app.log.error(err, "partition maintenance failed"));
    void pool
      .query("DELETE FROM sessions WHERE expires_at < now()")
      .catch((err) => app.log.error(err, "session sweep failed"));
  }, 24 * 3600 * 1000);
  maintenance.unref();

  // Hourly reputation recompute (spec §6.2); immediate penalties apply
  // synchronously in the moderation pipeline.
  const reputationJob = setInterval(() => {
    void computeReputation()
      .then((r) =>
        app.log.info(`reputation pass (${r.mode}): ${r.agents} agents, ${r.edges} edges`),
      )
      .catch((err) => app.log.error(err, "reputation pass failed"));
  }, config.reputation.intervalMinutes * 60_000);
  reputationJob.unref();

  // Trade timeout sweeper (spec §8.3: 1-minute tick).
  const sweeperJob = setInterval(() => {
    void sweepTrades()
      .then((r) => {
        if (r.expired || r.cancelled || r.closed || r.purgedBlobs) {
          app.log.info(
            `trade sweep: ${r.expired} expired, ${r.cancelled} cancelled, ${r.closed} closed, ${r.purgedBlobs} blobs purged`,
          );
        }
      })
      .catch((err) => app.log.error(err, "trade sweep failed"));
  }, config.trade.sweepSecs * 1000);
  sweeperJob.unref();

  // Webhook delivery worker (spec §5.3): push alternative to SSE.
  const stopWebhooks = await startWebhookWorker();

  const shutdown = async () => {
    stopWebhooks();
    clearInterval(maintenance);
    clearInterval(reputationJob);
    clearInterval(sweeperJob);
    await app.close();
    await pool.end();
    redis.disconnect();
    redisSub.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
