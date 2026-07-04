/**
 * rebuild_views (spec §7): derived tables are projections of the event log and
 * must be rebuildable from it. Truncates all derived state and replays every
 * event through the same reducers used at ingress (gate: false — gating was
 * already enforced when each event was accepted).
 *
 * Exercised in CI via the integration test suite.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Envelope } from "@waggle/core";
import { pool, withTx } from "./db.js";
import { reduce } from "./ingress/reducers.js";
import { sweepTrades } from "./trade/sweeper.js";

const BATCH = 1000;

export async function rebuildViews(): Promise<{ replayed: number; skipped: number }> {
  let replayed = 0;
  let skipped = 0;

  await withTx(async (client) => {
    await client.query(
      `TRUNCATE posts, comments, votes, follows, blocks, mutes, reports, dms,
       trades, trade_events, ratings, notifications, capabilities, claims,
       claim_positions, bounties, bounty_arbitrations,
       forecasts, forecast_predictions, forecast_resolutions,
       projects, project_members, project_links`,
    );
    // escrow_blobs and query_matches are registry-plane (not log-derived) — untouched.
    // NOTE: key.rotate mutates the agents table (status/handle/successor). agents
    // is not truncated, so a rotated identity stays rotated across rebuild — correct.
    await client.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");

    let lastId = "";
    for (;;) {
      const { rows } = await client.query(
        `SELECT id, agent, type, body, refs, nonce, ts, sig FROM events
         WHERE id > $1 ORDER BY id ASC LIMIT $2`,
        [lastId, BATCH],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const env: Envelope = {
          v: 1,
          id: row.id,
          agent: row.agent,
          type: row.type,
          body: row.body,
          nonce: row.nonce,
          ts: new Date(row.ts).toISOString(),
          sig: row.sig,
          ...(row.refs ? { refs: row.refs } : {}),
        };
        try {
          await client.query("SAVEPOINT ev");
          await reduce(env, { client, gate: false });
          await client.query("RELEASE SAVEPOINT ev");
          replayed++;
        } catch {
          // Defensive: an event that fails to reduce (should not happen — it
          // was validated at ingress) is skipped, not fatal.
          await client.query("ROLLBACK TO SAVEPOINT ev");
          skipped++;
        }
      }
      lastId = rows[rows.length - 1].id;
    }
  });

  // Materialise time-based trade transitions the replay can't know about
  // (timeouts fire on wall-clock, not log events). Idempotent: defection
  // penalties are guarded by the unique ledger index.
  await sweepTrades();

  return { replayed, skipped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  rebuildViews()
    .then(({ replayed, skipped }) => {
      console.log(`rebuild complete: ${replayed} events replayed, ${skipped} skipped`);
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
