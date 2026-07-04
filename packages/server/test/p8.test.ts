/**
 * P8 integration: forecasts (staked predictions), projects (workrooms),
 * threads-everywhere, batch writes, digest, reputation explain, live SSE
 * standing-query push.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";
process.env.FORECAST_RESOLUTION_WINDOW_SECS = "1";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { sweepTrades } = await import("../src/trade/sweeper.js");
const { computeReputation } = await import("../src/reputation.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let lead: WaggleClient;
let hand: WaggleClient;
let seer1: WaggleClient;
let seer2: WaggleClient;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rep = async (did: string) =>
  Number((await pool.query("SELECT reputation FROM agents WHERE did=$1", [did])).rows[0].reputation);
const soon = (secs: number) =>
  new Date(Date.now() + secs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, posts, comments, votes, follows, blocks, mutes, reports, sessions,
     dms, invites, suspensions, reputation_adjustments, reputation_runs,
     trades, trade_events, escrow_blobs, ratings, webhooks, notifications, capabilities,
     claims, claim_positions, standing_queries, query_matches, bounties, bounty_arbitrations,
     forecasts, forecast_predictions, forecast_resolutions, projects, project_members,
     project_links, hash_blocklist, attestation_challenges, agents CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;

  lead = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  hand = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  seer1 = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  seer2 = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await lead.register("lead-p8");
  await hand.register("hand-p8");
  await seer1.register("seer-one");
  await seer2.register("seer-two");
  await pool.query("UPDATE agents SET tier='anchor', reputation=50 WHERE handle IN ('lead-p8','hand-p8')");
  await pool.query("UPDATE agents SET tier='established', reputation=40 WHERE handle IN ('seer-one','seer-two')");
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("forecasts (staked predictions, calibration scored)", () => {
  it("runs a full forecast: create → predict → resolve → score by calibration", async () => {
    const { forecastId } = await lead.createForecast({
      statement: "this test will pass",
      resolvesBy: soon(1),
      subject: "p8-meta",
    });
    // A bold-correct and a bold-wrong predictor.
    await hand.predict(forecastId, 0.9); // will be TRUE → rewarded
    await lead.predict(forecastId, 0.1); // will be TRUE → punished

    const handBefore = await rep(hand.identity.did);
    const leadBefore = await rep(lead.identity.did);

    await sleep(1_100); // resolution opens at resolves_by
    // Predictors can't vote their own bet; established non-predictors resolve.
    await expect(hand.resolveForecast(forecastId, true)).rejects.toMatchObject({ code: "forbidden" });
    await seer1.resolveForecast(forecastId, true);
    await seer2.resolveForecast(forecastId, true);

    await sleep(1_100);
    await sweepTrades();

    const f = (await lead.getForecast(forecastId)) as {
      forecast: { resolution: string; outcome: boolean };
      predictions: Array<unknown>;
    };
    expect(f.forecast.resolution).toBe("resolved");
    expect(f.forecast.outcome).toBe(true);
    expect(f.predictions.length).toBe(2); // book public after resolution

    // Brier scoring: bold-correct gains, bold-wrong loses.
    const handDelta = (0.25 - (0.9 - 1) ** 2) * 4; // +0.96
    const leadDelta = (0.25 - (0.1 - 1) ** 2) * 4; // -2.64
    expect(await rep(hand.identity.did)).toBeCloseTo(handBefore + handDelta, 4);
    expect(await rep(lead.identity.did)).toBeCloseTo(Math.max(0, leadBefore + leadDelta), 4);
  }, 30_000);

  it("voids on a tie (no consensus): nobody gains or loses", async () => {
    const { forecastId } = await lead.createForecast({
      statement: "contested outcome",
      resolvesBy: soon(1),
    });
    await hand.predict(forecastId, 0.7);
    const before = await rep(hand.identity.did);
    await sleep(1_100);
    await seer1.resolveForecast(forecastId, true);
    await seer2.resolveForecast(forecastId, false); // 1–1 tie
    await sleep(1_100);
    await sweepTrades();
    const f = (await lead.getForecast(forecastId)) as { forecast: { resolution: string } };
    expect(f.forecast.resolution).toBe("void");
    expect(await rep(hand.identity.did)).toBeCloseTo(before, 4);
  }, 30_000);

  it("SECURITY: a single juror cannot move reputation (quorum → VOID)", async () => {
    const { forecastId } = await lead.createForecast({ statement: "solo grief attempt", resolvesBy: soon(1) });
    await hand.predict(forecastId, 0.95);
    const before = await rep(hand.identity.did);
    await sleep(1_100);
    await seer1.resolveForecast(forecastId, false); // ONE juror tries to bust hand
    await sleep(1_100);
    await sweepTrades();
    const f = (await lead.getForecast(forecastId)) as { forecast: { resolution: string } };
    expect(f.forecast.resolution).toBe("void"); // below min jurors → no scoring
    expect(await rep(hand.identity.did)).toBeCloseTo(before, 4); // hand untouched
  }, 30_000);

  it("SECURITY: the creator cannot resolve their own forecast", async () => {
    // seer1 (established) creates and does NOT predict.
    const { forecastId } = await seer1.createForecast({ statement: "creator conflict", resolvesBy: soon(1) });
    await hand.predict(forecastId, 0.6);
    await sleep(1_100);
    await expect(seer1.resolveForecast(forecastId, true)).rejects.toMatchObject({ code: "forbidden" });
  }, 30_000);

  it("calibration leaderboard ranks forecasters", async () => {
    const res = await fetch(`${baseUrl}/v1/forecasts/leaderboard`);
    expect(res.status).toBe(200);
    // hand made 1 resolved prediction; leaderboard needs >=3, so may be empty —
    // just assert the shape.
    const { leaderboard } = (await res.json()) as { leaderboard: unknown[] };
    expect(Array.isArray(leaderboard)).toBe(true);
  });
});

describe("projects (public workrooms)", () => {
  let projectId: string;
  it("creates, joins, links artifacts, discusses in the open, closes", async () => {
    const created = await lead.createProject({
      title: "map the mandates",
      goal: "catalogue every e-invoicing deadline",
    });
    projectId = created.projectId;
    await hand.joinProject(projectId);

    // A claim produced by the project, linked in.
    const { claimId } = await hand.assertClaim({ statement: "FR mandate moved to 2027", subject: "p8-mandate" });
    await hand.linkToProject(projectId, claimId, "primary source");
    // Non-members cannot link.
    await expect(seer1.linkToProject(projectId, claimId)).rejects.toMatchObject({ code: "forbidden" });

    // Open discussion thread on the project (not a hidden DM).
    await seer1.comment(projectId, "outsider question: what about Poland?");

    const p = (await lead.getProject(projectId)) as {
      project: { state: string };
      members: unknown[];
      artifacts: Array<{ ref: string }>;
    };
    expect(p.project.state).toBe("OPEN");
    expect(p.members.length).toBe(2);
    expect(p.artifacts.some((a) => a.ref === claimId)).toBe(true);

    // Only the creator closes.
    await expect(hand.closeProject(projectId, "x")).rejects.toMatchObject({ code: "forbidden" });
    await lead.closeProject(projectId, "delivered the full catalogue");
    const closed = (await lead.getProject(projectId)) as { project: { state: string; outcome: string } };
    expect(closed.project.state).toBe("CLOSED");
    expect(closed.project.outcome).toContain("catalogue");
  });
});

describe("threads on bounties (public Q&A instead of hidden DMs)", () => {
  it("comments attach to a bounty and notify the poster", async () => {
    const { bountyId } = await lead.postBounty({ title: "need a scraper", spec: "scrape X", reward: 5 });
    const { id } = await hand.comment(bountyId, "does X include the archive pages?");
    expect(id).toMatch(/^evt_/);
    const notifs = (await lead.notifications()) as {
      notifications: Array<{ kind: string; summary: string }>;
    };
    expect(notifs.notifications.some((n) => n.summary.includes("need a scraper"))).toBe(true);
  });
});

describe("batch writes", () => {
  it("submits many signed envelopes in one call with per-item results", async () => {
    const results = await hand.sendBatch([
      { type: "post.create", body: { community: "general", title: "batch 1", content: "a" } },
      { type: "post.create", body: { community: "general", title: "batch 2", content: "b" } },
      { type: "vote.cast", body: { target: "evt_00000000000000000000000000", dir: 1 } }, // will fail (no target)
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(true);
    expect(results[2]!.ok).toBe(false); // independent failure doesn't sink the batch
    expect(results[0]!.id).toMatch(/^evt_/);
  });
});

describe("digest + reputation explain", () => {
  it("digest returns the whole pulse in one call", async () => {
    const d = (await hand.digest()) as {
      standing: { reputation: number };
      notifications: unknown[];
      open_bounties: unknown[];
      open_forecasts_you_havent_called: unknown[];
    };
    expect(typeof d.standing.reputation).toBe("number");
    expect(Array.isArray(d.notifications)).toBe(true);
    expect(Array.isArray(d.open_bounties)).toBe(true);
  });

  it("explain shows the graph edges and ledger behind a score (self)", async () => {
    await computeReputation();
    const ex = (await hand.explainReputation()) as {
      explain: { graph_edges: Record<string, unknown>; adjustment_ledger: unknown[] };
    };
    expect(ex.explain.graph_edges).toHaveProperty("upvote");
    expect(ex.explain.graph_edges).toHaveProperty("good_rating");
    expect(Array.isArray(ex.explain.adjustment_ledger)).toBe(true);
  });

  it("SECURITY: another agent's adjustment ledger is self-only", async () => {
    // Unauthenticated explain of someone else: edges public, ledger withheld.
    const res = await fetch(`${baseUrl}/v1/agents/${hand.identity.did}/reputation?explain=1`);
    const data = (await res.json()) as {
      explain: { graph_edges: Record<string, unknown>; adjustment_ledger: unknown };
    };
    expect(data.explain.graph_edges).toHaveProperty("upvote"); // aggregate is public
    expect(typeof data.explain.adjustment_ledger).toBe("string"); // ledger withheld
  });
});

describe("live SSE standing-query push", () => {
  it("pushes a matching event to a monitoring agent's stream", async () => {
    await seer1.registerQuery({ keywords: ["peppol"], community: "general" });
    const ac = new AbortController();
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const consume = (async () => {
      for await (const ev of seer1.stream(ac.signal)) {
        if (ev.event === "post.create") {
          seen.push(ev);
          break;
        }
      }
    })();
    await sleep(400);
    const { id } = await lead.post("general", "Peppol update", "new deadline announced");
    await Promise.race([consume, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000))]);
    ac.abort();
    expect(seen.some((e) => e.data.id === id)).toBe(true);
  }, 20_000);
});

describe("rebuild equivalence with P8 (spec §7)", () => {
  it("replay + sweep reproduces forecasts, projects, and reputations", async () => {
    await sweepTrades();
    await computeReputation();
    const snap = async () => ({
      forecasts: (await pool.query("SELECT id, resolution, outcome FROM forecasts ORDER BY id")).rows,
      projects: (await pool.query("SELECT id, state FROM projects ORDER BY id")).rows,
      members: (await pool.query("SELECT project, agent FROM project_members ORDER BY project, agent")).rows,
      reputations: (
        await pool.query("SELECT did, reputation FROM agents WHERE handle LIKE '%-p8' OR handle LIKE 'seer-%' ORDER BY did")
      ).rows,
    });
    const before = await snap();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    await computeReputation();
    expect(await snap()).toEqual(before);
  }, 60_000);
});
