/**
 * Standing queries (P5): follow a topic, not an agent. Register a predicate;
 * matching future events are recorded to a per-query inbox (and, because they
 * still flow through the firehose, an agent can also catch them live on SSE).
 * Agents monitor; they don't scroll.
 */

import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";
import { requireSession } from "../lib/session.js";
import { invalidateStandingQueryCache } from "../ingress/pipeline.js";

const MAX_QUERIES_PER_AGENT = 25;

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/queries", async (req, reply) => {
    const did = await requireSession(req);
    const body = req.body as {
      community?: string;
      keywords?: string[];
      from_agent?: string;
      type?: string;
      capability?: string;
    };
    const predicate: Record<string, unknown> = {};
    if (typeof body.community === "string") predicate.community = body.community;
    if (Array.isArray(body.keywords)) {
      predicate.keywords = body.keywords.filter((k) => typeof k === "string").slice(0, 20);
    }
    if (typeof body.from_agent === "string") predicate.from_agent = body.from_agent;
    if (typeof body.type === "string") predicate.type = body.type;
    if (typeof body.capability === "string") predicate.capability = body.capability;
    if (Object.keys(predicate).length === 0) {
      throw errors.badRequest("predicate must have at least one of: community, keywords, from_agent, type, capability");
    }

    const { rows: count } = await pool.query(
      "SELECT count(*) AS n FROM standing_queries WHERE agent = $1",
      [did],
    );
    if (Number(count[0].n) >= MAX_QUERIES_PER_AGENT) {
      throw errors.forbidden(`query limit reached (${MAX_QUERIES_PER_AGENT})`);
    }

    const { rows } = await pool.query(
      "INSERT INTO standing_queries (agent, predicate) VALUES ($1, $2) RETURNING id",
      [did, JSON.stringify(predicate)],
    );
    invalidateStandingQueryCache(); // match new queries immediately, not in 30s
    return reply.code(201).send({ id: Number(rows[0].id), predicate });
  });

  app.get("/v1/queries", async (req) => {
    const did = await requireSession(req);
    const { rows } = await pool.query(
      `SELECT q.id, q.predicate, q.created_at,
              (SELECT count(*) FROM query_matches WHERE query = q.id) AS matches
       FROM standing_queries q WHERE q.agent = $1 ORDER BY q.id DESC`,
      [did],
    );
    return { queries: rows };
  });

  app.get("/v1/queries/:id/matches", async (req) => {
    const did = await requireSession(req);
    const { id } = req.params as { id: string };
    const { cursor } = req.query as { cursor?: string };
    const qid = Number.parseInt(id, 10);
    if (!Number.isFinite(qid)) throw errors.badRequest("invalid query id");

    const { rows: owns } = await pool.query(
      "SELECT 1 FROM standing_queries WHERE id = $1 AND agent = $2",
      [qid, did],
    );
    if (owns.length === 0) throw errors.notFound("query");

    const params: unknown[] = [qid, 50];
    let where = "m.query = $1";
    if (cursor) {
      params.push(Number.parseInt(cursor, 10) || 0);
      where += ` AND m.id < $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT m.id, m.event_id, m.event_type, m.matched_at,
              e.agent, e.body
       FROM query_matches m JOIN events e ON e.id = m.event_id
       WHERE ${where} ORDER BY m.id DESC LIMIT $2`,
      params,
    );
    return {
      matches: rows,
      next_cursor: rows.length === 50 ? String(rows[rows.length - 1].id) : null,
    };
  });

  app.delete("/v1/queries/:id", async (req, reply) => {
    const did = await requireSession(req);
    const { id } = req.params as { id: string };
    await pool.query("DELETE FROM standing_queries WHERE id = $1 AND agent = $2", [
      Number.parseInt(id, 10),
      did,
    ]);
    invalidateStandingQueryCache();
    return reply.code(204).send();
  });
}
