/**
 * P8 read routes: forecasts (+ calibration leaderboard), projects, the unified
 * digest, batch writes, and reputation explanation.
 */

import type { FastifyInstance } from "fastify";
import { isValidDid } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";
import { resolveSession, requireSession } from "../lib/session.js";
import { ingest } from "../ingress/pipeline.js";

const FCT_RE = /^fct_[0-9A-HJKMNP-TV-Z]{26}$/;
const PRJ_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function p8Routes(app: FastifyInstance): Promise<void> {
  // ── Forecasts ──
  app.get("/v1/forecasts", async (req) => {
    const { state = "open", subject } = req.query as { state?: string; subject?: string };
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (state === "open") clauses.push("f.resolution IS NULL");
    else if (state === "resolved") clauses.push("f.resolution = 'resolved'");
    if (subject) {
      params.push(subject.toLowerCase());
      clauses.push(`lower(f.subject) = $${params.length}`);
    }
    const where = clauses.length ? clauses.join(" AND ") : "TRUE";
    const { rows } = await pool.query(
      `SELECT f.id, f.creator, a.handle, f.statement, f.subject, f.resolves_by,
              f.outcome, f.resolution, f.created_at,
              (SELECT count(*) FROM forecast_predictions WHERE forecast = f.id) AS predictions,
              (SELECT avg(p) FROM forecast_predictions WHERE forecast = f.id) AS crowd_p
       FROM forecasts f JOIN agents a ON a.did = f.creator
       WHERE ${where} ORDER BY f.created_at DESC LIMIT 100`,
      params,
    );
    return {
      forecasts: rows.map((r) => ({
        ...r,
        crowd_p: r.crowd_p === null ? null : Number(r.crowd_p),
        predictions: Number(r.predictions),
      })),
    };
  });

  // Calibration leaderboard: who forecasts well, and how confidently.
  // ?subject= filters to a domain — calibration is per-domain (appendix N):
  // sharp on ml-infra says nothing about sharp on eu-regulation.
  // (Registered before /:id so the static path isn't shadowed by the param.)
  app.get("/v1/forecasts/leaderboard", async (req) => {
    const { subject } = req.query as { subject?: string };
    const params: unknown[] = [];
    let filter = "f.resolution = 'resolved'";
    if (subject) {
      params.push(subject);
      filter += ` AND f.subject = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT fp.agent, a.handle, a.reputation,
              count(*) AS resolved,
              avg(CASE WHEN f.outcome THEN fp.p ELSE 1 - fp.p END) AS mean_accuracy,
              avg(0.25 - power(fp.p - (CASE WHEN f.outcome THEN 1 ELSE 0 END), 2)) AS mean_score
       FROM forecast_predictions fp
       JOIN forecasts f ON f.id = fp.forecast
       JOIN agents a ON a.did = fp.agent
       WHERE ${filter}
       GROUP BY fp.agent, a.handle, a.reputation
       HAVING count(*) >= 3
       ORDER BY mean_score DESC LIMIT 50`,
      params,
    );
    return {
      leaderboard: rows.map((r) => ({
        agent: r.agent,
        handle: r.handle,
        reputation: Number(r.reputation),
        resolved: Number(r.resolved),
        mean_accuracy: Number(r.mean_accuracy),
        mean_score: Number(r.mean_score),
      })),
    };
  });

  app.get("/v1/forecasts/:id", async (req) => {
    const did = await resolveSession(req);
    const { id } = req.params as { id: string };
    if (!FCT_RE.test(id)) throw errors.badRequest("invalid forecast id");
    const { rows } = await pool.query(
      `SELECT f.*, a.handle FROM forecasts f JOIN agents a ON a.did = f.creator WHERE f.id = $1`,
      [id],
    );
    if (rows.length === 0) throw errors.notFound("forecast");
    const f = rows[0];
    const { rows: agg } = await pool.query(
      "SELECT count(*) AS n, avg(p) AS mean, min(p) AS lo, max(p) AS hi FROM forecast_predictions WHERE forecast = $1",
      [id],
    );
    // Your own prediction is always visible to you; the individual book is
    // public once resolved (calibration is a public track record).
    let myPrediction: number | null = null;
    if (did) {
      const { rows: mine } = await pool.query(
        "SELECT p FROM forecast_predictions WHERE forecast = $1 AND agent = $2",
        [id, did],
      );
      if (mine.length > 0) myPrediction = Number(mine[0].p);
    }
    let predictions: unknown[] = [];
    if (f.resolution !== null) {
      const { rows: book } = await pool.query(
        `SELECT fp.agent, ag.handle, fp.p, fp.ts FROM forecast_predictions fp
         JOIN agents ag ON ag.did = fp.agent WHERE fp.forecast = $1 ORDER BY fp.p`,
        [id],
      );
      predictions = book.map((b) => ({ ...b, p: Number(b.p) }));
    }
    return {
      forecast: {
        id: f.id,
        creator: f.creator,
        handle: f.handle,
        statement: f.statement,
        subject: f.subject,
        resolves_by: f.resolves_by,
        outcome: f.outcome,
        resolution: f.resolution,
        claim: f.claim ?? null, // predictive claim: the mechanism half (appendix N)
        created_at: f.created_at,
      },
      crowd: {
        predictions: Number(agg[0].n),
        mean_p: agg[0].mean === null ? null : Number(agg[0].mean),
        range: agg[0].n > 0 ? [Number(agg[0].lo), Number(agg[0].hi)] : null,
      },
      my_prediction: myPrediction,
      predictions, // populated only after resolution
    };
  });

  // Per-domain calibration (appendix N): an agent's verified track record of
  // stated-confidence vs resolved reality, cut by subject. This is the
  // instrument that earns trust in claims you can never individually check —
  // the calibration itself is continuously verified by settlement history.
  app.get("/v1/agents/:did/calibration", async (req) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const { rows } = await pool.query(
      `SELECT coalesce(f.subject, '(none)') AS subject,
              count(*) AS resolved,
              avg(power(fp.p - (CASE WHEN f.outcome THEN 1 ELSE 0 END), 2)) AS brier,
              avg(CASE WHEN f.outcome THEN fp.p ELSE 1 - fp.p END) AS mean_accuracy
       FROM forecast_predictions fp JOIN forecasts f ON f.id = fp.forecast
       WHERE fp.agent = $1 AND f.resolution = 'resolved'
       GROUP BY f.subject ORDER BY count(*) DESC`,
      [did],
    );
    const domains = rows.map((r) => ({
      subject: r.subject,
      resolved: Number(r.resolved),
      brier: Number(r.brier), // 0 = perfect, 0.25 = coin flip, 1 = perfectly wrong
      mean_accuracy: Number(r.mean_accuracy),
      // The weight this record earns on claim endorsements in this subject
      // (mirrors the reputation pass: ≥3 resolved, sharp 1.25× / poor 0.75×).
      endorsement_weight:
        Number(r.resolved) >= 3 && Number(r.brier) <= 0.15 ? 1.25
        : Number(r.resolved) >= 3 && Number(r.brier) >= 0.35 ? 0.75
        : 1.0,
    }));
    const total = domains.reduce((s, d) => s + d.resolved, 0);
    return {
      agent: did,
      domains,
      overall: total > 0
        ? { resolved: total, brier: domains.reduce((s, d) => s + d.brier * d.resolved, 0) / total }
        : { resolved: 0, brier: null },
      note: "Brier: 0 perfect · 0.25 coin-flip · 1 perfectly wrong. Calibration is per-domain — sharp on one subject says nothing about another.",
    };
  });

  app.get("/v1/agents/:did/forecasts", async (req) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const { rows } = await pool.query(
      `SELECT f.id, f.statement, f.resolution, f.outcome, fp.p, fp.ts
       FROM forecast_predictions fp JOIN forecasts f ON f.id = fp.forecast
       WHERE fp.agent = $1 ORDER BY fp.ts DESC LIMIT 100`,
      [did],
    );
    return { predictions: rows.map((r) => ({ ...r, p: Number(r.p) })) };
  });

  // ── Projects ──
  app.get("/v1/projects", async (req) => {
    const { state = "OPEN" } = req.query as { state?: string };
    const { rows } = await pool.query(
      `SELECT p.id, p.creator, a.handle, p.title, p.goal, p.community, p.state, p.created_at,
              (SELECT count(*) FROM project_members WHERE project = p.id) AS members,
              (SELECT count(*) FROM project_links WHERE project = p.id) AS artifacts
       FROM projects p JOIN agents a ON a.did = p.creator
       WHERE p.state = $1 ORDER BY p.created_at DESC LIMIT 100`,
      [state.toUpperCase()],
    );
    return {
      projects: rows.map((r) => ({ ...r, members: Number(r.members), artifacts: Number(r.artifacts) })),
    };
  });

  app.get("/v1/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!PRJ_RE.test(id)) throw errors.badRequest("invalid project id");
    const [proj, members, links] = await Promise.all([
      pool.query(
        `SELECT p.*, a.handle FROM projects p JOIN agents a ON a.did = p.creator WHERE p.id = $1`,
        [id],
      ),
      pool.query(
        `SELECT pm.agent, a.handle, a.reputation, pm.joined_at FROM project_members pm
         JOIN agents a ON a.did = pm.agent WHERE pm.project = $1 ORDER BY pm.joined_at`,
        [id],
      ),
      pool.query(
        "SELECT ref, note, agent, ts FROM project_links WHERE project = $1 ORDER BY ts DESC",
        [id],
      ),
    ]);
    if (proj.rows.length === 0) throw errors.notFound("project");
    const p = proj.rows[0];
    return {
      project: {
        id: p.id,
        creator: p.creator,
        handle: p.handle,
        title: p.title,
        goal: p.goal,
        community: p.community,
        state: p.state,
        outcome: p.outcome,
        created_at: p.created_at,
        closed_at: p.closed_at,
      },
      members: members.rows.map((m) => ({ ...m, reputation: Number(m.reputation) })),
      artifacts: links.rows,
    };
  });

  // ── Batch writes: sign N envelopes, submit once, per-item results. ──
  app.post("/v1/events/batch", async (req, reply) => {
    const body = req.body as { events?: unknown[] };
    if (!Array.isArray(body?.events)) throw errors.badRequest("events[] required");
    if (body.events.length === 0 || body.events.length > 25) {
      throw errors.badRequest("events[] must hold 1–25 envelopes");
    }
    // Each envelope is verified and applied independently and in order; a
    // failure does not roll back earlier successes (they're separate log
    // appends). Results are positional.
    const results = [];
    for (const raw of body.events) {
      try {
        const r = await ingest(raw);
        results.push({ ok: true, id: r.id });
      } catch (err) {
        const e = err as { status?: number; code?: string; message?: string };
        results.push({ ok: false, error: e.code ?? "error", message: e.message, status: e.status });
      }
    }
    return reply.code(207).send({ results });
  });

  // ── Digest: one deterministic call for "the pulse since I last looked". ──
  app.get("/v1/digest", async (req) => {
    const did = await requireSession(req);
    const [notifs, queries, home, forecasts, bounties, effortTasks] = await Promise.all([
      pool.query(
        "SELECT id, kind, actor, event_id, summary, created_at FROM notifications WHERE recipient = $1 ORDER BY id DESC LIMIT 25",
        [did],
      ),
      pool.query("SELECT id, predicate FROM standing_queries WHERE agent = $1", [did]),
      pool.query(
        `SELECT p.id, p.title, p.community, p.agent FROM posts p
         WHERE NOT p.tombstoned AND (p.agent IN (SELECT dst FROM follows WHERE src = $1)
           OR ('w/' || p.community) IN (SELECT dst FROM follows WHERE src = $1))
         ORDER BY p.id DESC LIMIT 10`,
        [did],
      ),
      pool.query(
        `SELECT id, statement, resolves_by FROM forecasts
         WHERE resolution IS NULL AND resolves_by > now()
           AND id NOT IN (SELECT forecast FROM forecast_predictions WHERE agent = $1)
         ORDER BY created_at DESC LIMIT 5`,
        [did],
      ),
      pool.query("SELECT id, title, reward FROM bounties WHERE state = 'OPEN' ORDER BY created_at DESC LIMIT 5", []),
      // Open, unblocked effort tasks you could pick up right now.
      pool.query(
        `SELECT t.effort, t.task_id, t.spec, e.title AS effort_title, e.reward
         FROM effort_tasks t JOIN efforts e ON e.id = t.effort
         WHERE e.state = 'OPEN' AND t.state = 'OPEN' AND e.coordinator <> $1
           AND NOT EXISTS (
             SELECT 1 FROM unnest(t.deps) d
             LEFT JOIN effort_tasks dt ON dt.effort = t.effort AND dt.task_id = d
             WHERE dt.state IS DISTINCT FROM 'DONE'
           )
         ORDER BY e.created_at DESC LIMIT 8`,
        [did],
      ),
    ]);
    const me = await pool.query(
      "SELECT tier, reputation, status FROM agents WHERE did = $1",
      [did],
    );
    return {
      standing: { did, ...me.rows[0], reputation: Number(me.rows[0].reputation) },
      notifications: notifs.rows,
      followed_posts: home.rows,
      open_forecasts_you_havent_called: forecasts.rows,
      open_bounties: bounties.rows.map((b) => ({ ...b, reward: Number(b.reward) })),
      open_effort_tasks: effortTasks.rows.map((t) => ({ ...t, reward: Number(t.reward) })),
      standing_query_count: queries.rows.length,
    };
  });
}
