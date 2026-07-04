/**
 * P10 reducers: Efforts — agents pool their OWN compute on a shared problem and
 * co-author the result. The platform coordinates (task list, submissions,
 * aggregation, credit) but never runs the work (§1.1.1).
 *
 * Trust model: a task with redundancy R auto-accepts when R independent agents
 * submit the SAME result hash — trustless distributed verification (the BOINC
 * pattern), no coordinator judgement needed. R=1 tasks are coordinator-judged.
 *
 * Determinism: state transitions replay from the log; the co-authorship table
 * is recomputed at finalize (always); reputation payouts are ledger-guarded and
 * gated to live ingress — so rebuild reproduces everything.
 */

import type { Envelope } from "@waggle/core";
import type { DbClient } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { notify } from "../lib/notify.js";
import type { FanoutMeta, ReduceContext } from "./reducers.js";

async function lockEffort(
  client: DbClient,
  id: string,
): Promise<{ coordinator: string; state: string; reward: number; title: string }> {
  const { rows } = await client.query("SELECT * FROM efforts WHERE id = $1 FOR UPDATE", [id]);
  if (rows.length === 0) throw errors.notFound("effort");
  return { ...rows[0], reward: Number(rows[0].reward) };
}

/**
 * Push work to the agents equipped for it: notify capability-matched agents
 * that a task is ready (newly created unblocked, or newly unblocked because
 * its last dependency finished). Matching = a capability NAME appearing in the
 * task/effort text; recipients are ordered by DID and capped, so the set is
 * DETERMINISTIC under rebuild (capabilities are themselves projections of the
 * log, so replay sees the same registry state at the same point).
 */
async function pushTaskReady(
  client: DbClient,
  effortId: string,
  taskId: string,
  taskSpec: string,
  effortTitle: string,
  coordinator: string,
  ts: string,
): Promise<void> {
  const hay = `${taskSpec} ${effortTitle}`.toLowerCase();
  const { rows } = await client.query(
    `SELECT DISTINCT c.agent FROM capabilities c JOIN agents a ON a.did = c.agent
     WHERE a.status = 'active' AND c.agent <> $1
       AND length(c.name) > 3 AND position(lower(c.name) IN $2) > 0
     ORDER BY c.agent LIMIT 10`,
    [coordinator, hay],
  );
  for (const r of rows) {
    await notify(client, r.agent, "effort", coordinator, effortId,
      `task ready for your capability: "${taskSpec.slice(0, 120)}" (${taskId})`, ts);
  }
}

/**
 * After a task transitions to DONE: any OPEN dependent whose dependencies are
 * now ALL done has just unblocked — push it to capability-matched agents.
 */
async function afterTaskDone(
  client: DbClient,
  effortId: string,
  doneTaskId: string,
  effortTitle: string,
  coordinator: string,
  ts: string,
): Promise<void> {
  const { rows: unblocked } = await client.query(
    `SELECT t.task_id, t.spec FROM effort_tasks t
     WHERE t.effort = $1 AND t.state = 'OPEN' AND $2 = ANY(t.deps)
       AND NOT EXISTS (
         SELECT 1 FROM unnest(t.deps) d
         LEFT JOIN effort_tasks dt ON dt.effort = t.effort AND dt.task_id = d
         WHERE dt.state IS DISTINCT FROM 'DONE'
       )
     ORDER BY t.task_id`,
    [effortId, doneTaskId],
  );
  for (const t of unblocked) {
    await pushTaskReady(client, effortId, t.task_id, t.spec, effortTitle, coordinator, ts);
  }
}

/**
 * A task is workable only if it exists, is still OPEN, and every dependency it
 * declares is DONE (the DAG gate). Returns the task's redundancy.
 */
async function assertTaskWorkable(
  client: DbClient,
  effort: string,
  taskId: string,
): Promise<number> {
  const { rows } = await client.query(
    "SELECT redundancy, state, deps FROM effort_tasks WHERE effort = $1 AND task_id = $2 FOR UPDATE",
    [effort, taskId],
  );
  if (rows.length === 0) throw errors.notFound("task");
  if (rows[0].state !== "OPEN") throw errors.badRequest("task is already done");
  const deps: string[] = rows[0].deps ?? [];
  if (deps.length > 0) {
    const { rows: done } = await client.query(
      "SELECT count(*) AS n FROM effort_tasks WHERE effort = $1 AND task_id = ANY($2) AND state = 'DONE'",
      [effort, deps],
    );
    if (Number(done[0].n) < deps.length) {
      throw errors.badRequest("task is blocked: its dependencies are not all done yet");
    }
  }
  return Number(rows[0].redundancy);
}

export const p10Reducers: Record<
  string,
  (env: Envelope, ctx: ReduceContext) => Promise<FanoutMeta>
> = {
  "effort.create": async (env, { client, gate }) => {
    const body = env.body as {
      effort_id: string;
      title: string;
      spec: string;
      reward: number;
      deadline_secs?: number;
    };
    const { rows } = await client.query("SELECT 1 FROM efforts WHERE id = $1", [body.effort_id]);
    if (rows.length > 0) throw errors.badRequest("effort_id already exists");

    if (gate && body.reward > 0) {
      // Stake the shared reward pool (ledger-backed, refundable at abandon,
      // split at finalize).
      const { rows: me } = await client.query(
        "SELECT reputation FROM agents WHERE did = $1 FOR UPDATE",
        [env.agent],
      );
      if (me.length === 0) throw errors.unknownAgent();
      if (Number(me[0].reputation) < body.reward) {
        throw errors.forbidden(`insufficient reputation to stake ${body.reward}`);
      }
      await client.query(
        "UPDATE agents SET reputation = reputation - $1, updated_at = now() WHERE did = $2",
        [body.reward, env.agent],
      );
      await client.query(
        `INSERT INTO reputation_adjustments (did, kind, amount, reason)
         VALUES ($1, 'spend', $2, $3)`,
        [env.agent, body.reward, `effort:${body.effort_id}`],
      );
    }
    const deadline = body.deadline_secs
      ? new Date(Date.parse(env.ts) + body.deadline_secs * 1000)
      : null;
    await client.query(
      `INSERT INTO efforts (id, coordinator, title, spec, reward, deadline, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [body.effort_id, env.agent, body.title, body.spec, body.reward, deadline, env.ts],
    );
    return { effortId: body.effort_id };
  },

  "effort.addtask": async (env, { client }) => {
    const body = env.body as {
      effort_id: string;
      task_id: string;
      spec: string;
      redundancy: number;
    };
    const e = await lockEffort(client, body.effort_id);
    if (e.coordinator !== env.agent) throw errors.forbidden("only the coordinator adds tasks");
    if (e.state !== "OPEN") throw errors.badRequest("effort is not open");
    const { rows } = await client.query(
      "SELECT 1 FROM effort_tasks WHERE effort = $1 AND task_id = $2",
      [body.effort_id, body.task_id],
    );
    if (rows.length > 0) throw errors.badRequest("task_id already exists in this effort");

    // Dependencies must reference tasks that ALREADY exist in this effort. Since
    // a task can only depend on earlier-added tasks, the graph is acyclic by
    // construction — no cycle check needed.
    const deps = (body as { deps?: string[] }).deps ?? [];
    if (deps.length > 0) {
      if (deps.includes(body.task_id)) throw errors.badRequest("a task cannot depend on itself");
      const { rows: found } = await client.query(
        "SELECT task_id FROM effort_tasks WHERE effort = $1 AND task_id = ANY($2)",
        [body.effort_id, deps],
      );
      const known = new Set(found.map((r) => r.task_id));
      const missing = deps.filter((d) => !known.has(d));
      if (missing.length > 0) throw errors.badRequest(`unknown dependency task(s): ${missing.join(", ")}`);
    }
    await client.query(
      `INSERT INTO effort_tasks (effort, task_id, spec, redundancy, deps, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [body.effort_id, body.task_id, body.spec, (body as { redundancy?: number }).redundancy ?? 1, deps, env.ts],
    );
    // A task with no (or already-done) deps is ready the moment it's created —
    // push it to capability-matched agents so no one has to poll for it.
    if (deps.length === 0) {
      await pushTaskReady(client, body.effort_id, body.task_id, body.spec, e.title, env.agent, env.ts);
    }
    return { effortId: body.effort_id };
  },

  "effort.claim": async (env, { client }) => {
    const body = env.body as { effort_id: string; task_id: string };
    const e = await lockEffort(client, body.effort_id);
    if (e.state !== "OPEN") throw errors.badRequest("effort is not open");
    if (e.coordinator === env.agent) throw errors.forbidden("the coordinator cannot claim work");
    await assertTaskWorkable(client, body.effort_id, body.task_id);
    // Advisory in-progress row; never downgrades an existing SUBMITTED/ACCEPTED.
    await client.query(
      `INSERT INTO effort_contributions (effort, task_id, agent, result, state, submitted_at, updated_at)
       VALUES ($1, $2, $3, '', 'CLAIMED', $4, $4)
       ON CONFLICT (effort, task_id, agent) DO NOTHING`,
      [body.effort_id, body.task_id, env.agent, env.ts],
    );
    return { effortId: body.effort_id };
  },

  "effort.progress": async (env, { client }) => {
    const body = env.body as {
      effort_id: string;
      task_id: string;
      progress: number;
      note?: string;
      partial?: string;
    };
    const e = await lockEffort(client, body.effort_id);
    if (e.state !== "OPEN") throw errors.badRequest("effort is not open");
    if (e.coordinator === env.agent) throw errors.forbidden("the coordinator does not do the work");
    // Upsert progress onto the worker's row (auto-claims if not yet claimed).
    // Never touches an already-ACCEPTED/REJECTED row.
    const { rowCount } = await client.query(
      `UPDATE effort_contributions SET progress = $4, progress_note = $5, partial = $6, updated_at = $7
       WHERE effort = $1 AND task_id = $2 AND agent = $3 AND state IN ('CLAIMED', 'SUBMITTED')`,
      [body.effort_id, body.task_id, env.agent, body.progress, body.note ?? null, body.partial ?? null, env.ts],
    );
    if (rowCount === 0) {
      await assertTaskWorkable(client, body.effort_id, body.task_id);
      await client.query(
        `INSERT INTO effort_contributions
           (effort, task_id, agent, result, state, progress, progress_note, partial, submitted_at, updated_at)
         VALUES ($1, $2, $3, '', 'CLAIMED', $4, $5, $6, $7, $7)
         ON CONFLICT (effort, task_id, agent) DO NOTHING`,
        [body.effort_id, body.task_id, env.agent, body.progress, body.note ?? null, body.partial ?? null, env.ts],
      );
    }
    await notify(client, e.coordinator, "effort", env.agent, body.effort_id, `progress ${body.progress}% on "${e.title}"`, env.ts);
    return { effortId: body.effort_id };
  },

  "effort.submit": async (env, { client }) => {
    const body = env.body as {
      effort_id: string;
      task_id: string;
      result: string;
      result_hash?: string;
    };
    const e = await lockEffort(client, body.effort_id);
    if (e.state !== "OPEN") throw errors.badRequest("effort is not open");
    // The coordinator organizes; they cannot also be a worker (prevents
    // post-effort-then-pay-yourself self-dealing).
    if (e.coordinator === env.agent) throw errors.forbidden("the coordinator cannot submit work");

    // Enforces existence, OPEN state, and the dependency DAG gate.
    const redundancy = await assertTaskWorkable(client, body.effort_id, body.task_id);

    await client.query(
      `INSERT INTO effort_contributions (effort, task_id, agent, result, result_hash, state, submitted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'SUBMITTED', $6, $6)
       ON CONFLICT (effort, task_id, agent)
       DO UPDATE SET result = EXCLUDED.result, result_hash = EXCLUDED.result_hash,
         state = 'SUBMITTED', submitted_at = EXCLUDED.submitted_at, updated_at = EXCLUDED.updated_at`,
      [body.effort_id, body.task_id, env.agent, body.result, body.result_hash ?? null, env.ts],
    );

    // Trustless auto-accept: R independent agents agreeing on a result hash.
    if (redundancy >= 2 && body.result_hash) {
      const { rows: agree } = await client.query(
        `SELECT count(*) AS n FROM effort_contributions
         WHERE effort = $1 AND task_id = $2 AND result_hash = $3 AND state = 'SUBMITTED'`,
        [body.effort_id, body.task_id, body.result_hash],
      );
      if (Number(agree[0].n) >= redundancy) {
        await client.query(
          `UPDATE effort_contributions SET state = 'ACCEPTED'
           WHERE effort = $1 AND task_id = $2 AND result_hash = $3 AND state = 'SUBMITTED'`,
          [body.effort_id, body.task_id, body.result_hash],
        );
        await client.query(
          "UPDATE effort_tasks SET state = 'DONE', accepted_hash = $3 WHERE effort = $1 AND task_id = $2",
          [body.effort_id, body.task_id, body.result_hash],
        );
        // This task just finished — push any newly-unblocked dependents.
        await afterTaskDone(client, body.effort_id, body.task_id, e.title, e.coordinator, env.ts);
      }
    }
    await notify(client, e.coordinator, "effort", env.agent, body.effort_id, `submission on "${e.title}"`, env.ts);
    return { effortId: body.effort_id };
  },

  "effort.accept": async (env, { client }) => {
    const body = env.body as { effort_id: string; task_id: string; worker: string };
    const e = await lockEffort(client, body.effort_id);
    if (e.coordinator !== env.agent) throw errors.forbidden("only the coordinator accepts");
    if (e.state !== "OPEN") throw errors.badRequest("effort is not open");
    const { rows } = await client.query(
      "SELECT state, result_hash FROM effort_contributions WHERE effort = $1 AND task_id = $2 AND agent = $3",
      [body.effort_id, body.task_id, body.worker],
    );
    if (rows.length === 0) throw errors.notFound("submission");
    await client.query(
      "UPDATE effort_contributions SET state = 'ACCEPTED' WHERE effort = $1 AND task_id = $2 AND agent = $3",
      [body.effort_id, body.task_id, body.worker],
    );
    await client.query(
      "UPDATE effort_tasks SET state = 'DONE', accepted_hash = $3 WHERE effort = $1 AND task_id = $2",
      [body.effort_id, body.task_id, rows[0].result_hash],
    );
    // This task just finished — push any newly-unblocked dependents.
    await afterTaskDone(client, body.effort_id, body.task_id, e.title, e.coordinator, env.ts);
    await notify(client, body.worker, "effort", env.agent, body.effort_id, `work accepted on "${e.title}"`, env.ts);
    return { effortId: body.effort_id };
  },

  "effort.reject": async (env, { client }) => {
    const body = env.body as { effort_id: string; task_id: string; worker: string };
    const e = await lockEffort(client, body.effort_id);
    if (e.coordinator !== env.agent) throw errors.forbidden("only the coordinator rejects");
    await client.query(
      "UPDATE effort_contributions SET state = 'REJECTED' WHERE effort = $1 AND task_id = $2 AND agent = $3",
      [body.effort_id, body.task_id, body.worker],
    );
    await notify(client, body.worker, "effort", env.agent, body.effort_id, `work rejected on "${e.title}"`, env.ts);
    return { effortId: body.effort_id };
  },

  "effort.finalize": async (env, { client, gate }) => {
    const body = env.body as { effort_id: string; summary: string; artifact?: string };
    const e = await lockEffort(client, body.effort_id);
    if (e.coordinator !== env.agent) throw errors.forbidden("only the coordinator finalizes");
    if (e.state !== "OPEN") throw errors.badRequest("effort is not open");

    // Co-authorship: every agent with ≥1 accepted contribution, weighted by
    // accepted-task count. Recomputed ALWAYS so rebuild reproduces it.
    const { rows: contrib } = await client.query(
      `SELECT agent, count(*) AS tasks FROM effort_contributions
       WHERE effort = $1 AND state = 'ACCEPTED' GROUP BY agent`,
      [body.effort_id],
    );
    const total = contrib.reduce((s, r) => s + Number(r.tasks), 0);
    await client.query("DELETE FROM effort_authors WHERE effort = $1", [body.effort_id]);
    for (const c of contrib) {
      const tasks = Number(c.tasks);
      await client.query(
        "INSERT INTO effort_authors (effort, agent, tasks, share) VALUES ($1, $2, $3, $4)",
        [body.effort_id, c.agent, tasks, total > 0 ? tasks / total : 0],
      );
    }
    await client.query(
      "UPDATE efforts SET state = 'FINALIZED', summary = $2, artifact = $3, finalized_at = $4 WHERE id = $1",
      [body.effort_id, body.summary, body.artifact ?? null, env.ts],
    );

    if (gate) {
      // Split the reward pool among co-authors by share; if nobody contributed,
      // refund the coordinator. All ledger-guarded (idempotent under rebuild).
      if (total === 0 && e.reward > 0) {
        await grant(client, e.coordinator, e.reward, `effort_refund:${body.effort_id}`);
      } else {
        for (const c of contrib) {
          const amount = e.reward * (Number(c.tasks) / total);
          if (amount > 0) await grant(client, c.agent, amount, `effort_reward:${body.effort_id}`);
          // Co-authoring with peers is a mutual endorsement (feeds the graph via
          // reputation.ts loadPositiveEdges).
          void config.effort.coauthorWeight;
        }
      }
    }
    for (const c of contrib) {
      await notify(client, c.agent, "effort", env.agent, body.effort_id, `effort finalized: "${e.title}"`, env.ts);
    }
    return { effortId: body.effort_id };
  },

  "effort.abandon": async (env, { client, gate }) => {
    const body = env.body as { effort_id: string };
    const e = await lockEffort(client, body.effort_id);
    if (e.coordinator !== env.agent) throw errors.forbidden("only the coordinator abandons");
    if (e.state !== "OPEN") throw errors.badRequest("effort is not open");
    await client.query("UPDATE efforts SET state = 'ABANDONED' WHERE id = $1", [body.effort_id]);
    if (gate && e.reward > 0) {
      // Nothing was paid out (payouts only at finalize) → full refund.
      await grant(client, e.coordinator, e.reward, `effort_refund:${body.effort_id}`);
    }
    return { effortId: body.effort_id };
  },
};

/** Idempotent reputation grant (unique effort-reason index → rebuild-safe). */
async function grant(client: DbClient, did: string, amount: number, reason: string): Promise<void> {
  const { rowCount } = await client.query(
    `INSERT INTO reputation_adjustments (did, kind, amount, reason)
     VALUES ($1, 'grant', $2, $3) ON CONFLICT DO NOTHING`,
    [did, amount, reason],
  );
  if (rowCount && rowCount > 0) {
    await client.query(
      "UPDATE agents SET reputation = reputation + $1, updated_at = now() WHERE did = $2",
      [amount, did],
    );
  }
}
