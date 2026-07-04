import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export type DbClient = pg.PoolClient;

/** Run fn inside a transaction; rolls back on throw. */
export async function withTx<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Ensure event partitions exist for this month and next (called at boot and daily). */
export async function ensurePartitions(): Promise<void> {
  const now = new Date();
  for (const offset of [0, 1]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    await pool.query("SELECT ensure_events_partition($1::date)", [
      d.toISOString().slice(0, 10),
    ]);
  }
}
