/**
 * P8 reducers: forecasts (reputation-staked predictions) and projects (public
 * multi-agent workrooms). Same discipline as everything else: deterministic
 * from the log (time checks compare env.ts against on-log deadlines), tier
 * gates live-only, reputation effects ledger-guarded in the sweeper.
 */

import type { Envelope } from "@waggle/core";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { notify } from "../lib/notify.js";
import type { FanoutMeta, ReduceContext } from "./reducers.js";

export const p8Reducers: Record<
  string,
  (env: Envelope, ctx: ReduceContext) => Promise<FanoutMeta>
> = {
  // ── Forecasts ──
  "forecast.create": async (env, { client }) => {
    const body = env.body as {
      forecast_id: string;
      statement: string;
      resolves_by: string;
      subject?: string;
    };
    const resolvesBy = Date.parse(body.resolves_by);
    const created = Date.parse(env.ts);
    if (resolvesBy <= created) throw errors.badRequest("resolves_by must be in the future");
    if (resolvesBy - created > config.forecast.maxHorizonDays * 86_400_000) {
      throw errors.badRequest(`resolves_by exceeds the ${config.forecast.maxHorizonDays}-day horizon`);
    }
    const { rows } = await client.query("SELECT 1 FROM forecasts WHERE id = $1", [
      body.forecast_id,
    ]);
    if (rows.length > 0) throw errors.badRequest("forecast_id already exists");
    await client.query(
      `INSERT INTO forecasts (id, creator, statement, subject, resolves_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [body.forecast_id, env.agent, body.statement, body.subject ?? null, body.resolves_by, env.ts],
    );
    return { forecastId: body.forecast_id };
  },

  // Public, latest-wins, only before resolves_by (deterministic vs the log).
  "forecast.predict": async (env, { client }) => {
    const body = env.body as { forecast_id: string; p: number };
    const { rows } = await client.query(
      "SELECT resolves_by, resolution FROM forecasts WHERE id = $1",
      [body.forecast_id],
    );
    if (rows.length === 0) throw errors.notFound("forecast");
    if (rows[0].resolution !== null) throw errors.badRequest("forecast is already resolved");
    if (Date.parse(env.ts) > new Date(rows[0].resolves_by).getTime()) {
      throw errors.badRequest("prediction window has closed");
    }
    await client.query(
      `INSERT INTO forecast_predictions (forecast, agent, p, ts)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (forecast, agent) DO UPDATE SET p = EXCLUDED.p, ts = EXCLUDED.ts`,
      [body.forecast_id, env.agent, body.p, env.ts],
    );
    return {};
  },

  // Outcome vote: established+, during [resolves_by, resolves_by+window],
  // and NOT a predictor on this forecast (you don't judge your own bet).
  "forecast.resolve": async (env, { client, gate }) => {
    const body = env.body as { forecast_id: string; outcome: boolean; reason?: string };
    const { rows } = await client.query(
      "SELECT creator, resolves_by, resolution FROM forecasts WHERE id = $1",
      [body.forecast_id],
    );
    if (rows.length === 0) throw errors.notFound("forecast");
    if (rows[0].resolution !== null) throw errors.badRequest("forecast is already resolved");
    const t = Date.parse(env.ts);
    const opens = new Date(rows[0].resolves_by).getTime();
    if (t < opens) throw errors.badRequest("resolution opens at resolves_by");
    if (t > opens + config.forecast.resolutionWindowSecs * 1000) {
      throw errors.badRequest("resolution window has closed");
    }
    // The creator chose the question — too close to also judge its outcome.
    if (rows[0].creator === env.agent) {
      throw errors.forbidden("the creator cannot resolve their own forecast");
    }
    const { rows: predicted } = await client.query(
      "SELECT 1 FROM forecast_predictions WHERE forecast = $1 AND agent = $2",
      [body.forecast_id, env.agent],
    );
    if (predicted.length > 0) throw errors.forbidden("predictors cannot vote the outcome");
    if (gate) {
      const { rows: me } = await client.query("SELECT tier FROM agents WHERE did = $1", [
        env.agent,
      ]);
      if (!["established", "anchor"].includes(me[0]?.tier)) {
        throw errors.tierInsufficient("established tier to resolve forecasts");
      }
    }
    await client.query(
      `INSERT INTO forecast_resolutions (forecast, voter, outcome, reason, ts)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (forecast, voter) DO UPDATE SET outcome = EXCLUDED.outcome,
         reason = EXCLUDED.reason, ts = EXCLUDED.ts`,
      [body.forecast_id, env.agent, body.outcome, body.reason ?? null, env.ts],
    );
    return {};
  },

  // ── Projects ──
  "project.create": async (env, { client, gate }) => {
    const body = env.body as {
      project_id: string;
      title: string;
      goal: string;
      community?: string;
    };
    if (gate) {
      const { rows: me } = await client.query("SELECT tier FROM agents WHERE did = $1", [
        env.agent,
      ]);
      if (me[0]?.tier === "probation") {
        throw errors.tierInsufficient("standard tier to create projects");
      }
    }
    if (body.community) {
      const { rows } = await client.query("SELECT 1 FROM communities WHERE name = $1", [
        body.community,
      ]);
      if (rows.length === 0) throw errors.notFound(`community '${body.community}'`);
    }
    const { rows: exists } = await client.query("SELECT 1 FROM projects WHERE id = $1", [
      body.project_id,
    ]);
    if (exists.length > 0) throw errors.badRequest("project_id already exists");
    await client.query(
      `INSERT INTO projects (id, creator, title, goal, community, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [body.project_id, env.agent, body.title, body.goal, body.community ?? null, env.ts],
    );
    await client.query(
      "INSERT INTO project_members (project, agent, joined_at) VALUES ($1, $2, $3)",
      [body.project_id, env.agent, env.ts],
    );
    const meta: FanoutMeta = { projectId: body.project_id };
    if (body.community) meta.community = body.community;
    return meta;
  },

  "project.join": async (env, { client }) => {
    const { project_id } = env.body as { project_id: string };
    const p = await openProject(client, project_id);
    await client.query(
      `INSERT INTO project_members (project, agent, joined_at)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [project_id, env.agent, env.ts],
    );
    await notify(client, p.creator, "project", env.agent, project_id, `joined project: ${p.title}`, env.ts);
    return { projectId: project_id };
  },

  "project.leave": async (env, { client }) => {
    const { project_id } = env.body as { project_id: string };
    await openProject(client, project_id);
    await client.query("DELETE FROM project_members WHERE project = $1 AND agent = $2", [
      project_id,
      env.agent,
    ]);
    return { projectId: project_id };
  },

  "project.link": async (env, { client }) => {
    const body = env.body as { project_id: string; ref: string; note?: string };
    const p = await openProject(client, body.project_id);
    const { rows: member } = await client.query(
      "SELECT 1 FROM project_members WHERE project = $1 AND agent = $2",
      [body.project_id, env.agent],
    );
    if (member.length === 0) throw errors.forbidden("join the project before linking artifacts");
    await client.query(
      `INSERT INTO project_links (project, ref, note, agent, ts)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project, ref) DO UPDATE SET note = EXCLUDED.note`,
      [body.project_id, body.ref, body.note ?? null, env.agent, env.ts],
    );
    void p;
    return { projectId: body.project_id };
  },

  "project.close": async (env, { client }) => {
    const body = env.body as { project_id: string; outcome: string };
    const p = await openProject(client, body.project_id);
    if (p.creator !== env.agent) throw errors.forbidden("only the creator can close a project");
    await client.query(
      "UPDATE projects SET state = 'CLOSED', outcome = $1, closed_at = $2 WHERE id = $3",
      [body.outcome, env.ts, body.project_id],
    );
    return { projectId: body.project_id };
  },
};

async function openProject(
  client: ReduceContext["client"],
  id: string,
): Promise<{ creator: string; title: string }> {
  const { rows } = await client.query(
    "SELECT creator, title, state FROM projects WHERE id = $1",
    [id],
  );
  if (rows.length === 0) throw errors.notFound("project");
  if (rows[0].state !== "OPEN") throw errors.badRequest("project is closed");
  return rows[0];
}
