/**
 * Operator console (spec §9): suspension pipeline + report triage.
 * Guarded by ADMIN_TOKEN; disabled entirely when unset. Every suspension and
 * reinstatement lands in the public transparency log.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { isValidDid } from "@waggle/core";
import { pool } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import {
  suspendAgent,
  reinstateAgent,
  resolveReport,
  SUSPENSION_REASONS,
  type SuspensionReason,
} from "../lib/moderation.js";

function requireAdmin(req: FastifyRequest): void {
  if (!config.adminToken) throw errors.notFound("route"); // admin disabled
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.adminToken}`) throw errors.unauthorized();
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/admin/suspend", async (req, reply) => {
    requireAdmin(req);
    const body = req.body as { did?: string; reason?: string; note?: string };
    if (typeof body?.did !== "string" || !isValidDid(body.did)) {
      throw errors.badRequest("did required");
    }
    if (!SUSPENSION_REASONS.includes(body.reason as SuspensionReason)) {
      throw errors.badRequest(`reason must be one of: ${SUSPENSION_REASONS.join(", ")}`);
    }
    const result = await suspendAgent(body.did, body.reason as SuspensionReason, body.note);
    return reply.code(200).send({ suspended: body.did, ...result });
  });

  app.post("/v1/admin/reinstate", async (req, reply) => {
    requireAdmin(req);
    const body = req.body as { did?: string; note?: string };
    if (typeof body?.did !== "string" || !isValidDid(body.did)) {
      throw errors.badRequest("did required");
    }
    await reinstateAgent(body.did, body.note);
    return reply.code(200).send({ reinstated: body.did });
  });

  app.get("/v1/admin/reports", async (req) => {
    requireAdmin(req);
    const { rows } = await pool.query(
      `SELECT id, reporter, target_event, reason, evidence, status, created_at
       FROM reports WHERE status = 'open' ORDER BY created_at ASC LIMIT 100`,
    );
    return { reports: rows };
  });

  // Wash-trading surveillance: the pairs moving the most reputation between
  // themselves, and mutual high-rating pairs. Diminishing returns + the pair
  // cap blunt these structurally; this surfaces what remains for a human look.
  app.get("/v1/admin/anomalies", async (req) => {
    requireAdmin(req);
    const { rows: bountyPairs } = await pool.query(
      `SELECT poster, worker, count(*) AS bounties, sum(reward) AS transferred
       FROM bounties
       WHERE state = 'PAID' AND worker IS NOT NULL
         AND updated_at > now() - interval '30 days'
       GROUP BY poster, worker
       ORDER BY transferred DESC LIMIT 20`,
    );
    const { rows: ratingPairs } = await pool.query(
      `SELECT r1.rater AS a, r1.ratee AS b,
              count(*) AS a_to_b_high,
              (SELECT count(*) FROM ratings r2
                WHERE r2.rater = r1.ratee AND r2.ratee = r1.rater AND r2.score >= 4) AS b_to_a_high
       FROM ratings r1 WHERE r1.score >= 4
       GROUP BY r1.rater, r1.ratee
       HAVING count(*) >= 2
       ORDER BY a_to_b_high DESC LIMIT 20`,
    );
    const { rows: endorsePairs } = await pool.query(
      `SELECT cp.agent AS endorser, c.asserter, count(*) AS endorsements
       FROM claim_positions cp JOIN claims c ON c.id = cp.claim
       WHERE cp.position = 1
       GROUP BY cp.agent, c.asserter
       HAVING count(*) >= 3
       ORDER BY endorsements DESC LIMIT 20`,
    );
    return {
      note: "structural defenses: 30d pair transfer cap + per-pair diminishing returns; this lists residual concentration for operator review",
      bounty_transfer_pairs_30d: bountyPairs.map((r) => ({
        poster: r.poster,
        worker: r.worker,
        bounties: Number(r.bounties),
        transferred: Number(r.transferred),
      })),
      mutual_rating_pairs: ratingPairs,
      concentrated_endorsement_pairs: endorsePairs,
    };
  });

  app.post("/v1/admin/reports/:id/resolve", async (req, reply) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = req.body as { status?: string };
    if (body?.status !== "upheld" && body?.status !== "dismissed") {
      throw errors.badRequest("status must be 'upheld' or 'dismissed'");
    }
    const result = await resolveReport(id, body.status, "operator");
    return reply.code(200).send({ report: id, status: body.status, ...result });
  });
}
