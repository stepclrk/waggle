/**
 * Trade timeout sweeper (spec §8.3): 1-minute tick materialising time-based
 * transitions. Idempotent — safe to run any number of times, including once
 * after a rebuild-views replay (defection penalties are guarded by a unique
 * ledger index).
 *
 *   PROPOSED  past deadline → EXPIRED
 *   ACCEPTED  past deadline → EXPIRED               (commit window lapsed)
 *   COMMITTED past deadline, one revealed → CANCELLED
 *       revealer's blob destroyed unexposed; non-revealer flagged DEFECTED
 *       (spec §8.4.3: a defector gains nothing; honest party loses only time)
 *   COMMITTED past deadline, none revealed → EXPIRED (no penalty)
 *   REVEALED  past deadline → CLOSED                 (rating window ends)
 *   CLOSED + retention days → escrow blobs deleted   (spec §8.6)
 */

import { ulid } from "ulid";
import { withTx, pool, type DbClient } from "../db.js";
import { config } from "../config.js";
import { blobStore } from "../lib/blobstore.js";
import { notify } from "../lib/notify.js";
import { suspendAgent } from "../lib/moderation.js";
import { sweeperTransitions } from "../lib/metrics.js";

async function systemStep(client: DbClient, trade: string, type: string): Promise<void> {
  await client.query(
    `INSERT INTO trade_events (id, trade, agent, type, ts) VALUES ($1, $2, 'system', $3, now())`,
    [`sys_${ulid()}`, trade, type],
  );
}

async function deleteBlobs(client: DbClient, trade: string, onlyAgent?: string): Promise<void> {
  const params: unknown[] = [trade];
  let where = "trade = $1";
  if (onlyAgent) {
    params.push(onlyAgent);
    where += " AND agent = $2";
  }
  const { rows } = await client.query(
    `DELETE FROM escrow_blobs WHERE ${where} RETURNING storage_ref`,
    params,
  );
  for (const r of rows) await blobStore.delete(r.storage_ref);
}

export interface SweepResult {
  expired: number;
  cancelled: number;
  closed: number;
  defectors: string[];
  purgedBlobs: number;
}

export async function sweepTrades(): Promise<SweepResult> {
  const result: SweepResult = { expired: 0, cancelled: 0, closed: 0, defectors: [], purgedBlobs: 0 };

  await withTx(async (client) => {
    const { rows: due } = await client.query(
      `SELECT id, state, initiator, counterparty, initiator_revealed, counterparty_revealed
       FROM trades
       WHERE deadline < now() AND state IN ('PROPOSED','ACCEPTED','COMMITTED','REVEALED')
       FOR UPDATE SKIP LOCKED`,
    );

    for (const t of due) {
      if (t.state === "PROPOSED" || t.state === "ACCEPTED") {
        await client.query(
          "UPDATE trades SET state = 'EXPIRED', deadline = NULL, updated_at = now() WHERE id = $1",
          [t.id],
        );
        await deleteBlobs(client, t.id);
        await systemStep(client, t.id, "trade.expire");
        result.expired++;
        continue;
      }

      if (t.state === "COMMITTED") {
        const iRev = t.initiator_revealed as boolean;
        const cRev = t.counterparty_revealed as boolean;
        if (iRev !== cRev) {
          // One revealed, the other timed out: CANCELLED + DEFECTED.
          const defector = iRev ? (t.counterparty as string) : (t.initiator as string);
          const honest = iRev ? (t.initiator as string) : (t.counterparty as string);
          await client.query(
            `UPDATE trades SET state = 'CANCELLED', deadline = NULL, defector = $1,
             updated_at = now() WHERE id = $2`,
            [defector, t.id],
          );
          // Destroy ALL blobs unexposed — the honest party's payload is never
          // released, the defector uploaded nothing worth keeping.
          await deleteBlobs(client, t.id);
          await systemStep(client, t.id, "trade.cancel");

          // Severe reputation hit, immediately and in the ledger (unique per
          // trade — rebuild-time sweeps cannot double-apply).
          const { rowCount } = await client.query(
            `INSERT INTO reputation_adjustments (did, kind, factor, reason)
             VALUES ($1, 'penalty_mult', $2, $3)
             ON CONFLICT DO NOTHING`,
            [defector, config.trade.defectionFactor, `defection:${t.id}`],
          );
          if (rowCount && rowCount > 0) {
            await client.query(
              "UPDATE agents SET reputation = reputation * $1, updated_at = now() WHERE did = $2",
              [config.trade.defectionFactor, defector],
            );
          }
          result.cancelled++;
          result.defectors.push(defector);
          void honest;
        } else {
          // Neither revealed → EXPIRED, no penalty (spec §8.3).
          await client.query(
            "UPDATE trades SET state = 'EXPIRED', deadline = NULL, updated_at = now() WHERE id = $1",
            [t.id],
          );
          await deleteBlobs(client, t.id);
          await systemStep(client, t.id, "trade.expire");
          result.expired++;
        }
        continue;
      }

      if (t.state === "REVEALED") {
        await client.query(
          `UPDATE trades SET state = 'CLOSED', deadline = NULL, closed_at = now(),
           updated_at = now() WHERE id = $1`,
          [t.id],
        );
        await systemStep(client, t.id, "trade.close");
        result.closed++;
      }
    }

    // Retention: blobs of trades CLOSED more than N days ago are purged (§8.6).
    const { rows: stale } = await client.query(
      `DELETE FROM escrow_blobs eb USING trades t
       WHERE eb.trade = t.id AND t.state = 'CLOSED'
         AND t.closed_at < now() - make_interval(days => $1)
       RETURNING eb.storage_ref`,
      [config.trade.retentionDays],
    );
    for (const r of stale) await blobStore.delete(r.storage_ref);
    result.purgedBlobs = stale.length;
  });

  // Bounty lifecycle (P5/P6). All reputation effects are idempotent via unique
  // ledger-reason indexes, so rebuild-time sweeps never double-apply.
  await withTx(async (client) => {
    const refund = async (did: string, reward: number, bountyId: string) => {
      const { rowCount } = await client.query(
        `INSERT INTO reputation_adjustments (did, kind, amount, reason)
         VALUES ($1, 'grant', $2, $3) ON CONFLICT DO NOTHING`,
        [did, reward, `bounty_refund:${bountyId}`],
      );
      if (rowCount && rowCount > 0) {
        await client.query(
          "UPDATE agents SET reputation = reputation + $1, updated_at = now() WHERE did = $2",
          [reward, did],
        );
      }
    };

    // OPEN/CLAIMED past deadline → EXPIRED, stake refunds.
    const { rows: due } = await client.query(
      `SELECT id, poster, reward FROM bounties
       WHERE deadline < now() AND state IN ('OPEN','CLAIMED') FOR UPDATE SKIP LOCKED`,
    );
    for (const b of due) {
      await client.query(
        "UPDATE bounties SET state = 'EXPIRED', updated_at = now() WHERE id = $1",
        [b.id],
      );
      await refund(b.poster, Number(b.reward), b.id);
    }

    // REJECTED, dispute window lapsed, never disputed → refund the poster now
    // (P6: rejection no longer refunds instantly; the stake is held so the
    // worker has recourse).
    const { rows: undisputed } = await client.query(
      `SELECT id, poster, reward FROM bounties
       WHERE state = 'REJECTED' AND resolution IS NULL AND dispute_deadline < now()
       FOR UPDATE SKIP LOCKED`,
    );
    for (const b of undisputed) {
      await client.query(
        "UPDATE bounties SET resolution = 'undisputed', updated_at = now() WHERE id = $1",
        [b.id],
      );
      await refund(b.poster, Number(b.reward), b.id);
    }

    // DISPUTED past arbitration deadline → resolve by plain vote majority.
    // Deliberately unweighted: a count over signed events is deterministic
    // under rebuild (reputation-weighted tallies would drift). Tie or no
    // votes → poster (status quo — nobody judged the work bad enough).
    const { rows: disputed } = await client.query(
      `SELECT id, poster, worker, reward FROM bounties
       WHERE state = 'DISPUTED' AND arbitration_deadline < now()
       FOR UPDATE SKIP LOCKED`,
    );
    for (const b of disputed) {
      const { rows: tally } = await client.query(
        `SELECT count(*) FILTER (WHERE verdict = 1) AS worker_votes,
                count(*) FILTER (WHERE verdict = -1) AS poster_votes
         FROM bounty_arbitrations WHERE bounty = $1`,
        [b.id],
      );
      const workerVotes = Number(tally[0].worker_votes);
      const posterVotes = Number(tally[0].poster_votes);
      const reward = Number(b.reward);

      if (workerVotes > posterVotes && b.worker) {
        // Jury sided with the worker: pay them; penalise the poster for
        // trying to keep work unpaid.
        await client.query(
          "UPDATE bounties SET state = 'PAID', resolution = 'worker', updated_at = now() WHERE id = $1",
          [b.id],
        );
        const { rowCount } = await client.query(
          `INSERT INTO reputation_adjustments (did, kind, amount, reason)
           VALUES ($1, 'grant', $2, $3) ON CONFLICT DO NOTHING`,
          [b.worker, reward, `bounty_reward:${b.id}`],
        );
        if (rowCount && rowCount > 0) {
          await client.query(
            "UPDATE agents SET reputation = reputation + $1, updated_at = now() WHERE did = $2",
            [reward, b.worker],
          );
        }
        const { rowCount: pen } = await client.query(
          `INSERT INTO reputation_adjustments (did, kind, factor, reason)
           VALUES ($1, 'penalty_mult', $2, $3) ON CONFLICT DO NOTHING`,
          [b.poster, config.bounty.posterArbLossFactor, `arb_loss:${b.id}`],
        );
        if (pen && pen > 0) {
          await client.query(
            "UPDATE agents SET reputation = reputation * $1, updated_at = now() WHERE did = $2",
            [config.bounty.posterArbLossFactor, b.poster],
          );
        }
      } else {
        // Poster prevails: refund the stake. Mild frivolous-dispute penalty
        // only when jurors actually voted against the worker.
        await client.query(
          "UPDATE bounties SET state = 'REJECTED', resolution = 'poster', updated_at = now() WHERE id = $1",
          [b.id],
        );
        await refund(b.poster, reward, b.id);
        if (posterVotes > 0 && b.worker) {
          const { rowCount } = await client.query(
            `INSERT INTO reputation_adjustments (did, kind, factor, reason)
             VALUES ($1, 'penalty_mult', $2, $3) ON CONFLICT DO NOTHING`,
            [b.worker, config.bounty.workerFrivolousFactor, `arb_frivolous:${b.id}`],
          );
          if (rowCount && rowCount > 0) {
            await client.query(
              "UPDATE agents SET reputation = reputation * $1, updated_at = now() WHERE did = $2",
              [config.bounty.workerFrivolousFactor, b.worker],
            );
          }
        }
      }
    }
  });

  // ── Effort deadlines (P10) ── OPEN past deadline → ABANDONED, refund the
  // coordinator's staked pool (nothing pays out before finalize). Idempotent.
  await withTx(async (client) => {
    const { rows: due } = await client.query(
      `SELECT id, coordinator, reward, title FROM efforts
       WHERE state = 'OPEN' AND deadline < now() FOR UPDATE SKIP LOCKED`,
    );
    for (const e of due) {
      await client.query("UPDATE efforts SET state = 'ABANDONED' WHERE id = $1", [e.id]);
      await notify(
        client, e.coordinator, "effort", e.coordinator, e.id,
        `effort "${String(e.title).slice(0, 80)}" hit its deadline — abandoned, stake refunded`,
        new Date().toISOString(),
      );
      if (Number(e.reward) > 0) {
        const { rowCount } = await client.query(
          `INSERT INTO reputation_adjustments (did, kind, amount, reason)
           VALUES ($1, 'grant', $2, $3) ON CONFLICT DO NOTHING`,
          [e.coordinator, Number(e.reward), `effort_refund:${e.id}`],
        );
        if (rowCount && rowCount > 0) {
          await client.query(
            "UPDATE agents SET reputation = reputation + $1, updated_at = now() WHERE did = $2",
            [Number(e.reward), e.coordinator],
          );
        }
      }
    }
  });

  // ── Forecast resolution (P8, appendix I) ──
  // After resolves_by + resolution window: outcome = plain majority of juror
  // votes (deterministic from the log; tie or none → VOID, no scoring). Each
  // predictor scores delta = (0.25 − (p − outcome)²) × weight — better than a
  // coin flip earns, confidently wrong pays. Ledger-guarded per (agent,
  // forecast) so rebuild-time sweeps never double-score.
  await withTx(async (client) => {
    const { rows: due } = await client.query(
      `SELECT id FROM forecasts
       WHERE resolution IS NULL
         AND resolves_by + make_interval(secs => $1) < now()
       FOR UPDATE SKIP LOCKED`,
      [config.forecast.resolutionWindowSecs],
    );
    for (const f of due) {
      const { rows: tally } = await client.query(
        `SELECT count(*) FILTER (WHERE outcome) AS yes,
                count(*) FILTER (WHERE NOT outcome) AS no
         FROM forecast_resolutions WHERE forecast = $1`,
        [f.id],
      );
      const yes = Number(tally[0].yes);
      const no = Number(tally[0].no);

      // VOID unless a real quorum agrees: at least MIN_JURORS distinct voters
      // and a strict majority. A single (or tied) juror can never move
      // reputation — this blocks solo-grief and forces genuine consensus.
      // Attestor stake settlement (appendix N): majority-side attestors are
      // refunded; minority-side forfeit — lying at settlement costs. On VOID,
      // everyone is refunded (no outcome to be right about). Ledger-guarded
      // per (attestor, forecast) so rebuild-time sweeps never double-credit.
      const refundAttestors = async (onlyOutcome: boolean | null) => {
        const stake = config.forecast.resolverStake;
        if (stake <= 0) return;
        const { rows: attestors } = await client.query(
          onlyOutcome === null
            ? "SELECT voter FROM forecast_resolutions WHERE forecast = $1"
            : "SELECT voter FROM forecast_resolutions WHERE forecast = $1 AND outcome = $2",
          onlyOutcome === null ? [f.id] : [f.id, onlyOutcome],
        );
        for (const a of attestors) {
          const { rowCount } = await client.query(
            `INSERT INTO reputation_adjustments (did, kind, amount, reason)
             VALUES ($1, 'grant', $2, $3) ON CONFLICT DO NOTHING`,
            [a.voter, stake, `forecast_attest_refund:${f.id}`],
          );
          if (rowCount && rowCount > 0) {
            await client.query(
              "UPDATE agents SET reputation = reputation + $1, updated_at = now() WHERE did = $2",
              [stake, a.voter],
            );
          }
        }
      };

      if (yes + no < config.forecast.minJurors || yes === no) {
        await client.query(
          "UPDATE forecasts SET resolution = 'void', resolved_at = now() WHERE id = $1",
          [f.id],
        );
        await refundAttestors(null); // VOID: all stakes back
        sweeperTransitions.inc({ kind: "forecast_void" });
        continue;
      }
      const outcome = yes > no;
      await client.query(
        "UPDATE forecasts SET resolution = 'resolved', outcome = $1, resolved_at = now() WHERE id = $2",
        [outcome, f.id],
      );
      await refundAttestors(outcome); // majority refunded; minority forfeits

      const { rows: predictions } = await client.query(
        "SELECT agent, p FROM forecast_predictions WHERE forecast = $1",
        [f.id],
      );
      for (const pred of predictions) {
        const p = Number(pred.p);
        const target = outcome ? 1 : 0;
        const delta = (0.25 - (p - target) ** 2) * config.forecast.weight;
        if (Math.abs(delta) < 1e-9) continue;
        const kind = delta >= 0 ? "grant" : "spend";
        const { rowCount } = await client.query(
          `INSERT INTO reputation_adjustments (did, kind, amount, reason)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [pred.agent, kind, Math.abs(delta), `forecast:${f.id}`],
        );
        if (rowCount && rowCount > 0) {
          await client.query(
            `UPDATE agents SET reputation = GREATEST(0, reputation + $1), updated_at = now()
             WHERE did = $2`,
            [delta, pred.agent],
          );
        }
      }
      sweeperTransitions.inc({ kind: "forecast_resolved" });
    }
  });

  // Repeat defection within 90d → suspension (spec §8.7). Outside the sweep tx
  // so a suspension failure can't roll back state transitions.
  for (const defector of result.defectors) {
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM trades
       WHERE defector = $1 AND updated_at > now() - interval '90 days'`,
      [defector],
    );
    if (Number(rows[0].n) >= config.trade.defectionSuspendCount) {
      await suspendAgent(defector, "defection", "repeat trade defection (automatic)").catch(
        () => {}, // already suspended is fine
      );
    }
  }

  if (result.expired) sweeperTransitions.inc({ kind: "trade_expired" }, result.expired);
  if (result.cancelled) sweeperTransitions.inc({ kind: "trade_cancelled" }, result.cancelled);
  if (result.closed) sweeperTransitions.inc({ kind: "trade_closed" }, result.closed);
  if (result.purgedBlobs) sweeperTransitions.inc({ kind: "blobs_purged" }, result.purgedBlobs);

  return result;
}
