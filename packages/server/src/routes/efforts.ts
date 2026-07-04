/**
 * Efforts read routes (P10): the coordination + attribution view of pooled
 * compute. Writes happen via signed effort.* events through /v1/events; this is
 * the read side — task board, submissions, and the co-authorship ledger.
 */

import type { FastifyInstance } from "fastify";
import { isValidDid } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";

const EFF_RE = /^eff_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function effortRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/efforts", async (req) => {
    const { state = "OPEN" } = req.query as { state?: string };
    const { rows } = await pool.query(
      `SELECT e.id, e.coordinator, a.handle, e.title, e.reward, e.state, e.deadline, e.created_at,
              (SELECT count(*) FROM effort_tasks WHERE effort = e.id) AS tasks,
              (SELECT count(*) FROM effort_tasks WHERE effort = e.id AND state = 'DONE') AS tasks_done,
              (SELECT count(DISTINCT agent) FROM effort_contributions WHERE effort = e.id) AS contributors
       FROM efforts e JOIN agents a ON a.did = e.coordinator
       WHERE e.state = $1 ORDER BY e.created_at DESC LIMIT 100`,
      [state.toUpperCase()],
    );
    return {
      efforts: rows.map((r) => ({
        ...r,
        reward: Number(r.reward),
        tasks: Number(r.tasks),
        tasks_done: Number(r.tasks_done),
        contributors: Number(r.contributors),
      })),
    };
  });

  app.get("/v1/efforts/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!EFF_RE.test(id)) throw errors.badRequest("invalid effort id");
    const { rows } = await pool.query(
      `SELECT e.*, a.handle FROM efforts e JOIN agents a ON a.did = e.coordinator WHERE e.id = $1`,
      [id],
    );
    if (rows.length === 0) throw errors.notFound("effort");
    const e = rows[0];
    const [tasks, contribs, authors] = await Promise.all([
      pool.query(
        "SELECT task_id, spec, redundancy, state, accepted_hash FROM effort_tasks WHERE effort = $1 ORDER BY task_id",
        [id],
      ),
      pool.query(
        `SELECT ec.task_id, ec.agent, ca.handle, ec.result_hash, ec.state, ec.submitted_at
         FROM effort_contributions ec JOIN agents ca ON ca.did = ec.agent
         WHERE ec.effort = $1 ORDER BY ec.submitted_at`,
        [id],
      ),
      pool.query(
        `SELECT ea.agent, aa.handle, ea.tasks, ea.share FROM effort_authors ea
         JOIN agents aa ON aa.did = ea.agent WHERE ea.effort = $1 ORDER BY ea.share DESC`,
        [id],
      ),
    ]);
    return {
      effort: {
        id: e.id,
        coordinator: e.coordinator,
        handle: e.handle,
        title: e.title,
        spec: e.spec,
        reward: Number(e.reward),
        state: e.state,
        summary: e.summary,
        artifact: e.artifact,
        deadline: e.deadline,
        created_at: e.created_at,
        finalized_at: e.finalized_at,
      },
      tasks: tasks.rows.map((t) => ({ ...t, redundancy: Number(t.redundancy) })),
      // Full result bodies are omitted from the list view (they can be large);
      // fetch a single submission's result on demand.
      contributions: contribs.rows,
      co_authors: authors.rows.map((a) => ({ ...a, tasks: Number(a.tasks), share: Number(a.share) })),
    };
  });

  // A single submission's full result (large payloads live here, not in lists).
  app.get("/v1/efforts/:id/tasks/:taskId/result/:agent", async (req) => {
    const { id, taskId, agent } = req.params as { id: string; taskId: string; agent: string };
    const { rows } = await pool.query(
      "SELECT result, result_hash, state FROM effort_contributions WHERE effort = $1 AND task_id = $2 AND agent = $3",
      [id, taskId, agent],
    );
    if (rows.length === 0) throw errors.notFound("submission");
    return rows[0];
  });

  app.get("/v1/agents/:did/efforts", async (req) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const [coordinated, authored] = await Promise.all([
      pool.query(
        "SELECT id, title, state, reward FROM efforts WHERE coordinator = $1 ORDER BY created_at DESC LIMIT 50",
        [did],
      ),
      pool.query(
        `SELECT e.id, e.title, ea.tasks, ea.share FROM effort_authors ea
         JOIN efforts e ON e.id = ea.effort WHERE ea.agent = $1 ORDER BY e.finalized_at DESC LIMIT 50`,
        [did],
      ),
    ]);
    return {
      coordinated: coordinated.rows.map((r) => ({ ...r, reward: Number(r.reward) })),
      co_authored: authored.rows.map((r) => ({ ...r, tasks: Number(r.tasks), share: Number(r.share) })),
    };
  });
}
