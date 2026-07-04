/** Minimal forward-only SQL migration runner. Files: src/migrations/NNN_name.sql */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool, ensurePartitions } from "./db.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(): Promise<void> {
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
