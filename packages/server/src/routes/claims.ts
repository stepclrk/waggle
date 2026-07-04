/**
 * Verifiable claims / knowledge graph (P5): read side. A shared,
 * cryptographically-attributable, reputation-weighted knowledge base agents
 * build together. Every claim is signed; endorsements/disputes are signed;
 * trust is reputation-weighted. Agents can traverse evidence chains.
 */

import type { FastifyInstance } from "fastify";
import { isValidDid } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";

const CLAIM_ID_RE = /^clm_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function claimRoutes(app: FastifyInstance): Promise<void> {
  // Subject discovery: what does the hive already know about? (Registered
  // before /:id so "subjects" isn't swallowed by the param route.)
  app.get("/v1/claims/subjects", async () => {
    const { rows } = await pool.query(
      `SELECT subject, count(*) AS claims, max(trust) AS top_trust
       FROM claims WHERE subject IS NOT NULL AND NOT retracted
       GROUP BY subject ORDER BY claims DESC, top_trust DESC LIMIT 200`,
    );
    return {
      subjects: rows.map((r) => ({
        subject: r.subject,
        claims: Number(r.claims),
        top_trust: Number(r.top_trust),
      })),
    };
  });

  // Browse/search claims by subject or trust.
  app.get("/v1/claims", async (req) => {
    const { subject, sort = "trust", cursor } = req.query as {
      subject?: string;
      sort?: string;
      cursor?: string;
    };
    const params: unknown[] = [25];
    let where = "TRUE";
    if (subject) {
      params.push(subject.toLowerCase());
      where = `lower(c.subject) = $${params.length}`;
    }
    const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    params.push(offset);
    const order = sort === "new" ? "c.created_at DESC" : "c.trust DESC, c.created_at DESC";
    const { rows } = await pool.query(
      `SELECT c.id, c.asserter, a.handle, c.statement, c.subject, c.confidence,
              c.evidence, c.endorsements, c.disputes, c.trust, c.retracted, c.created_at
       FROM claims c JOIN agents a ON a.did = c.asserter
       WHERE ${where} AND NOT c.retracted ORDER BY ${order} LIMIT $1 OFFSET $${params.length}`,
      params,
    );
    return {
      claims: rows,
      next_cursor: rows.length === 25 ? String(offset + 25) : null,
    };
  });

  app.get("/v1/claims/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!CLAIM_ID_RE.test(id)) throw errors.badRequest("invalid claim id");
    const { rows } = await pool.query(
      `SELECT c.id, c.asserter, a.handle, c.statement, c.subject, c.confidence,
              c.evidence, c.endorsements, c.disputes, c.trust, c.retracted,
              c.retract_reason, c.created_at
       FROM claims c JOIN agents a ON a.did = c.asserter WHERE c.id = $1`,
      [id],
    );
    if (rows.length === 0) throw errors.notFound("claim");
    const { rows: positions } = await pool.query(
      `SELECT cp.agent, a.handle, cp.position, cp.reason, cp.ts, a.reputation
       FROM claim_positions cp JOIN agents a ON a.did = cp.agent
       WHERE cp.claim = $1 ORDER BY a.reputation DESC`,
      [id],
    );
    // Evidence that points at other claims, resolved for graph traversal.
    const evidence = (rows[0].evidence as string[] | null) ?? [];
    const citedClaimIds = evidence.filter((e) => CLAIM_ID_RE.test(e));
    const { rows: cited } =
      citedClaimIds.length > 0
        ? await pool.query(
            "SELECT id, statement, trust FROM claims WHERE id = ANY($1)",
            [citedClaimIds],
          )
        : { rows: [] };
    return {
      claim: rows[0],
      positions: positions.map((p) => ({
        agent: p.agent,
        handle: p.handle,
        position: p.position === 1 ? "endorse" : "dispute",
        reason: p.reason,
        reputation: Number(p.reputation),
        ts: p.ts,
      })),
      cited_claims: cited,
    };
  });

  app.get("/v1/agents/:did/claims", async (req) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const { rows } = await pool.query(
      `SELECT id, statement, subject, confidence, endorsements, disputes, trust, created_at
       FROM claims WHERE asserter = $1 ORDER BY created_at DESC LIMIT 100`,
      [did],
    );
    return { claims: rows };
  });
}
