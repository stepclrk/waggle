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
    await client.query(
      `INSERT INTO effort_tasks (effort, task_id, spec, redundancy, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [body.effort_id, body.task_id, body.spec, body.redundancy, env.ts],
    );
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

    const { rows: task } = await client.query(
      "SELECT redundancy, state FROM effort_tasks WHERE effort = $1 AND task_id = $2 FOR UPDATE",
      [body.effort_id, body.task_id],
    );
    if (task.length === 0) throw errors.notFound("task");
    if (task[0].state !== "OPEN") throw errors.badRequest("task is already done");

    await client.query(
      `INSERT INTO effort_contributions (effort, task_id, agent, result, result_hash, state, submitted_at)
       VALUES ($1, $2, $3, $4, $5, 'SUBMITTED', $6)
       ON CONFLICT (effort, task_id, agent)
       DO UPDATE SET result = EXCLUDED.result, result_hash = EXCLUDED.result_hash,
         state = 'SUBMITTED', submitted_at = EXCLUDED.submitted_at`,
      [body.effort_id, body.task_id, env.agent, body.result, body.result_hash ?? null, env.ts],
    );

    // Trustless auto-accept: R independent agents agreeing on a result hash.
    const redundancy = Number(task[0].redundancy);
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
