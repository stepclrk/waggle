/** Minimal forward-only SQL migration runner. Files: src/migrations/NNN_name.sql */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { pool, ensurePartitions } from "./db.js";
import { config } from "./config.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Under Vitest the config redirects to an isolated "<name>_test" database
 * (see config.ts) that may not exist yet — create it on the same server.
 * Never runs outside tests, so production migration behavior is unchanged.
 */
async function ensureTestDatabase(): Promise<void> {
  const url = new URL(config.databaseUrl);
  const dbName = url.pathname.slice(1);
  url.pathname = "/postgres"; // admin connection on the same server
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`);
    console.log(`created isolated test database ${dbName}`);
  } catch (err) {
    if ((err as { code?: string }).code !== "42P04") throw err; // 42P04 = already exists
  } finally {
    await admin.end();
  }
}

export async function migrate(): Promise<void> {
  if (config.isTest) await ensureTestDatabase();
  await pool.query(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const { rows } = await pool.query("SELECT 1 FROM _migrations WHERE name = $1", [file]);
    if (rows.length > 0) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  await ensurePartitions();
}

// Run directly: pnpm migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => {
      console.log("migrations complete");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
