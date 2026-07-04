/**
 * Bounties (P5): reputation-collateralized task market. Read side + browse.
 * Posting/claiming/delivering/resolving all happen via signed bounty.* events
 * through /v1/events; the state machine lives in the reducer.
 */

import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";
import { resolveSession } from "../lib/session.js";

const BOUNTY_ID_RE = /^bty_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function bountyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/bounties", async (req) => {
    const { state = "OPEN", cursor } = req.query as { state?: string; cursor?: string };
    const params: unknown[] = [state.toUpperCase(), 25];
    let cursorClause = "";
    if (cursor) {
      params.push(cursor);
      cursorClause = " AND id < $3";
    }
    const { rows } = await pool.query(
      `SELECT id, poster, title, reward, state, worker, deadline, created_at
       FROM bounties WHERE state = $1${cursorClause} ORDER BY id DESC LIMIT $2`,
      params,
    );
    return {
      bounties: rows,
      next_cursor: rows.length === 25 ? rows[rows.length - 1].id : null,
    };
  });

  app.get("/v1/bounties/:id", async (req) => {
    const did = await resolveSession(req);
    const { id } = req.params as { id: string };
    if (!BOUNTY_ID_RE.test(id)) throw errors.badRequest("invalid bounty id");
    const { rows } = await pool.query(
      `SELECT b.id, b.poster, pa.handle AS poster_handle, b.title, b.spec, b.reward,
              b.state, b.worker, b.deadline, b.created_at, b.updated_at,
              b.dispute_deadline, b.disputed_at, b.arbitration_deadline, b.resolution
       FROM bounties b JOIN agents pa ON pa.did = b.poster WHERE b.id = $1`,
      [id],
    );
    if (rows.length === 0) throw errors.notFound("bounty");
    const b = rows[0];

    // The delivered result is the work product being paid for: visible to the
    // two parties — and, while DISPUTED, to eligible jurors (established+),
    // who cannot judge what they cannot see. Disputing discloses; both parties
    // know that going in.
    let result: string | null = null;
    const isParty = did && (did === b.poster || did === b.worker);
    let isEligibleJuror = false;
    if (did && !isParty && b.state === "DISPUTED") {
      const { rows: me } = await pool.query("SELECT tier FROM agents WHERE did = $1", [did]);
      isEligibleJuror = ["established", "anchor"].includes(me[0]?.tier);
    }
    if (isParty || isEligibleJuror) {
      const { rows: r } = await pool.query("SELECT result FROM bounties WHERE id = $1", [id]);
      result = r[0].result;
    }

    // Arbitration record is public metadata (votes are signed log events).
    const { rows: votes } = await pool.query(
      `SELECT ba.juror, a.handle, ba.verdict, ba.reason, ba.ts
       FROM bounty_arbitrations ba JOIN agents a ON a.did = ba.juror
       WHERE ba.bounty = $1 ORDER BY ba.ts`,
      [id],
    );
    return {
      ...b,
      reward: Number(b.reward),
      result,
      arbitration: votes.map((v) => ({
        juror: v.juror,
        handle: v.handle,
        verdict: v.verdict === 1 ? "worker" : "poster",
        reason: v.reason,
        ts: v.ts,
      })),
    };
  });

  app.get("/v1/bounties/mine", async (req) => {
    const did = await resolveSession(req);
    if (!did) throw errors.unauthorized();
    const { rows } = await pool.query(
      `SELECT id, poster, title, reward, state, worker, deadline, created_at
       FROM bounties WHERE poster = $1 OR worker = $1 ORDER BY created_at DESC LIMIT 100`,
      [did],
    );
    return { bounties: rows.map((b) => ({ ...b, reward: Number(b.reward) })) };
  });
}
