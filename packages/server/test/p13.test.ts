/**
 * P13 integration: epistemic discipline (appendix N) — falsifier trust ceiling,
 * predictive claims (claim ⟷ forecast), resolver stake with Schelling refunds,
 * per-domain calibration, and rebuild equivalence.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";
process.env.FORECAST_RESOLUTION_WINDOW_SECS = "2";
process.env.FORECAST_RESOLVER_STAKE = "2";
process.env.CLAIM_UNFALSIFIED_TRUST_CAP = "25";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { computeReputation } = await import("../src/reputation.js");
const { sweepTrades } = await import("../src/trade/sweeper.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let asserter: WaggleClient;
let backer: WaggleClient; // high-rep endorser
let judgeA: WaggleClient; // non-predictor attestors
let judgeB: WaggleClient;
let judgeC: WaggleClient;

const rep = async (did: string) =>
  Number((await pool.query("SELECT reputation FROM agents WHERE did=$1", [did])).rows[0].reputation);
const shortHorizon = () => new Date(Date.now() + 1_500).toISOString().replace(/\.\d{3}Z$/, "Z");

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, agents, sessions, notifications, reputation_adjustments, reputation_runs,
     claims, claim_positions, forecasts, forecast_predictions, forecast_resolutions CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;

  asserter = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  backer = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  judgeA = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  judgeB = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  judgeC = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await asserter.register("asserter-p13");
  await backer.register("backer-p13");
  await judgeA.register("judge-a-p13");
  await judgeB.register("judge-b-p13");
  await judgeC.register("judge-c-p13");
  // Genesis standing via ledger grants (survives recompute).
  for (const [c, amt] of [[backer, 60], [judgeA, 30], [judgeB, 30], [judgeC, 30], [asserter, 20]] as const) {
    await pool.query(
      "INSERT INTO reputation_adjustments (did, kind, amount, reason) VALUES ($1,'grant',$2,'genesis') ON CONFLICT DO NOTHING",
      [c.identity.did, amt],
    );
  }
  await pool.query("UPDATE agents SET tier='anchor', reputation=60 WHERE handle='backer-p13'");
  await pool.query("UPDATE agents SET tier='established', reputation=30 WHERE handle LIKE 'judge-%-p13'");
  await pool.query("UPDATE agents SET tier='standard', reputation=20 WHERE handle='asserter-p13'");
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("falsifier discipline: no falsifier, capped trust", () => {
  it("caps trust for unfalsified claims; uncapped when a falsifier is named", async () => {
    const { claimId: vague } = await asserter.assertClaim({
      statement: "this architecture will not scale",
      subject: "arch-review",
    });
    const { claimId: sharp } = await asserter.assertClaim({
      statement: "the session store holds a single write lock",
      subject: "arch-review",
      falsifier: "p99 latency rises gradually (not a cliff) past 10k concurrent connections",
      horizon: new Date(Date.now() + 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    // The same heavy backer endorses both.
    await backer.endorseClaim(vague);
    await backer.endorseClaim(sharp);

    const trusts = await pool.query("SELECT id, trust, falsifier FROM claims WHERE id = ANY($1)", [
      [vague, sharp],
    ]);
    const byId = Object.fromEntries(trusts.rows.map((r) => [r.id, r]));
    expect(Number(byId[vague]!.trust)).toBeLessThanOrEqual(25); // capped
    expect(Number(byId[sharp]!.trust)).toBeGreaterThan(25); // backer rep 60, uncapped
  });

  it("the API exposes falsifier + falsified flag", async () => {
    const { claimId } = await asserter.assertClaim({
      statement: "x",
      falsifier: "observation Y occurs",
    });
    const detail = (await asserter.getClaim(claimId)) as { claim: { falsifier: string }; falsified: boolean };
    expect(detail.falsified).toBe(true);
    expect(detail.claim.falsifier).toContain("observation Y");
  });
});

describe("predictive claims: claim ⟷ forecast composition", () => {
  it("assertPredictiveClaim creates both halves, linked", async () => {
    const { claimId, forecastId } = await asserter.assertPredictiveClaim({
      statement: "the session store write lock causes a latency cliff",
      prediction: "p99 latency exceeds 500ms at 10k concurrent connections",
      resolvesBy: new Date(Date.now() + 10 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      subject: "arch-review",
    });
    const f = (await asserter.getForecast(forecastId)) as { forecast: { claim: string } };
    expect(f.forecast.claim).toBe(claimId);
    const c = (await asserter.getClaim(claimId)) as {
      claim: { falsifier: string };
      linked_forecasts: Array<{ id: string }>;
    };
    expect(c.linked_forecasts.map((x) => x.id)).toContain(forecastId);
    expect(c.claim.falsifier).toContain("NOT(");
  });

  it("only the claim's asserter can attach a forecast to it", async () => {
    const { claimId } = await asserter.assertClaim({ statement: "mine", subject: "s" });
    await expect(
      backer.createForecast({ statement: "hijack", resolvesBy: shortHorizon(), claimId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("resolver stake: lying at settlement costs", () => {
  it("stakes attestors; majority refunded, minority forfeits", async () => {
    const { forecastId } = await asserter.createForecast({
      statement: "the observable thing happens",
      resolvesBy: shortHorizon(),
      subject: "settlement-test",
    });
    await backer.predict(forecastId, 0.9); // backer is now a predictor (can't attest)
    await new Promise((r) => setTimeout(r, 1_600)); // pass resolves_by

    const [a0, b0, c0] = [await rep(judgeA.identity.did), await rep(judgeB.identity.did), await rep(judgeC.identity.did)];
    await judgeA.resolveForecast(forecastId, true);
    await judgeB.resolveForecast(forecastId, true);
    await judgeC.resolveForecast(forecastId, false); // minority
    // Stake deducted immediately.
    expect(await rep(judgeA.identity.did)).toBeCloseTo(a0 - 2, 4);
    expect(await rep(judgeC.identity.did)).toBeCloseTo(c0 - 2, 4);

    await new Promise((r) => setTimeout(r, 2_100)); // pass resolution window
    await sweepTrades();

    // Majority (true) refunded; minority forfeits.
    expect(await rep(judgeA.identity.did)).toBeCloseTo(a0, 4);
    expect(await rep(judgeB.identity.did)).toBeCloseTo(b0, 4);
    expect(await rep(judgeC.identity.did)).toBeCloseTo(c0 - 2, 4);

    const { rows } = await pool.query("SELECT resolution, outcome FROM forecasts WHERE id=$1", [forecastId]);
    expect(rows[0].resolution).toBe("resolved");
    expect(rows[0].outcome).toBe(true);
  });

  it("VOID refunds all attestors (nothing to be right about)", async () => {
    const { forecastId } = await asserter.createForecast({
      statement: "ambiguous thing",
      resolvesBy: shortHorizon(),
    });
    await new Promise((r) => setTimeout(r, 1_600));
    const a0 = await rep(judgeA.identity.did);
    await judgeA.resolveForecast(forecastId, true); // single attestor → below quorum
    expect(await rep(judgeA.identity.did)).toBeCloseTo(a0 - 2, 4);
    await new Promise((r) => setTimeout(r, 2_100));
    await sweepTrades();
    expect(await rep(judgeA.identity.did)).toBeCloseTo(a0, 4); // refunded on VOID
    const { rows } = await pool.query("SELECT resolution FROM forecasts WHERE id=$1", [forecastId]);
    expect(rows[0].resolution).toBe("void");
  });
});

describe("per-domain calibration", () => {
  it("exposes Brier by subject with the endorsement weight it earns", async () => {
    const cal = (await backer.calibration()) as {
      domains: Array<{ subject: string; resolved: number; brier: number; endorsement_weight: number }>;
      overall: { resolved: number };
    };
    // backer predicted 0.9 on the settlement-test forecast that resolved true.
    const dom = cal.domains.find((d) => d.subject === "settlement-test");
    expect(dom).toBeDefined();
    expect(dom!.resolved).toBe(1);
    expect(dom!.brier).toBeCloseTo(0.01, 3); // (0.9-1)^2
    expect(dom!.endorsement_weight).toBe(1.0); // <3 resolved → neutral
    expect(cal.overall.resolved).toBeGreaterThanOrEqual(1);
  });

  it("leaderboard accepts a subject filter", async () => {
    const res = await fetch(`${baseUrl}/v1/forecasts/leaderboard?subject=settlement-test`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leaderboard: unknown[] };
    expect(Array.isArray(body.leaderboard)).toBe(true);
  });
});

describe("rebuild equivalence with P13 (spec §7)", () => {
  it("replay + sweep + pass reproduces claims (falsifier/trust), forecasts (links), stakes", async () => {
    await sweepTrades();
    await computeReputation();
    const snap = async () => ({
      claims: (await pool.query("SELECT id, falsifier, horizon, trust FROM claims ORDER BY id")).rows,
      forecasts: (await pool.query("SELECT id, claim, resolution, outcome FROM forecasts ORDER BY id")).rows,
      // round(…,2): reputation decays continuously from now(), so the seconds
      // elapsed across the rebuild legitimately shift the 4th decimal — that
      // drift is time passing, not a determinism failure.
      reps: (await pool.query("SELECT did, round(reputation, 2) AS reputation FROM agents WHERE handle LIKE '%-p13' ORDER BY did")).rows,
    });
    const before = await snap();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    await sweepTrades();
    await computeReputation();
    expect(await snap()).toEqual(before);
  }, 60_000);
});
