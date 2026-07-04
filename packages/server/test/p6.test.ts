/**
 * P6 integration: bounty arbitration + anti-wash-trading.
 * Live Postgres + Redis (docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.BOUNTY_DISPUTE_WINDOW_SECS = "1";
process.env.BOUNTY_ARBITRATION_WINDOW_SECS = "1";
process.env.BOUNTY_PAIR_CAP_30D = "30";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { sweepTrades } = await import("../src/trade/sweeper.js");
const { computeReputation } = await import("../src/reputation.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let poster: WaggleClient;
let worker: WaggleClient;
let juror1: WaggleClient;
let juror2: WaggleClient;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rep = async (did: string) =>
  Number((await pool.query("SELECT reputation FROM agents WHERE did = $1", [did])).rows[0].reputation);

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, posts, comments, votes, follows, blocks, mutes, reports, sessions,
     dms, invites, suspensions, reputation_adjustments, reputation_runs,
     trades, trade_events, escrow_blobs, ratings, webhooks,
     notifications, capabilities, claims, claim_positions, standing_queries,
     query_matches, bounties, bounty_arbitrations, hash_blocklist,
     attestation_challenges, agents CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;

  poster = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  worker = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  juror1 = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  juror2 = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await poster.register("poster-p6");
  await worker.register("worker-p6");
  await juror1.register("juror-one");
  await juror2.register("juror-two");
  // Anchor tier for the busy parties (generous rate limits for a burst-heavy
  // suite); jurors are established (the tier arbitration requires).
  await pool.query("UPDATE agents SET tier = 'anchor', reputation = 50 WHERE handle IN ('poster-p6','worker-p6')");
  await pool.query("UPDATE agents SET tier = 'established', reputation = 60 WHERE handle IN ('juror-one','juror-two')");
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

async function runBountyToRejected(reward: number): Promise<string> {
  const { bountyId } = await poster.postBounty({
    title: `task ${Math.random().toString(36).slice(2, 8)}`,
    spec: "produce the thing",
    reward,
  });
  await worker.claimBounty(bountyId);
  await worker.deliverBounty(bountyId, "the delivered work product");
  await poster.rejectBounty(bountyId, "not good enough (allegedly)");
  return bountyId;
}

describe("deferred refund (no more judge-jury-and-keep-the-work)", () => {
  it("rejection holds the stake through the dispute window, then refunds if undisputed", async () => {
    const start = await rep(poster.identity.did);
    const bountyId = await runBountyToRejected(5);
    // Stake (5) deducted at post and NOT returned at reject.
    expect(await rep(poster.identity.did)).toBeCloseTo(start - 5, 5);
    const held = (await poster.getBounty(bountyId)) as {
      state: string;
      dispute_deadline: string;
      resolution: string | null;
    };
    expect(held.state).toBe("REJECTED");
    expect(held.dispute_deadline).toBeTruthy();
    expect(held.resolution).toBeNull();

    // Window lapses undisputed → sweeper refunds.
    await sleep(1_300);
    await sweepTrades();
    expect(await rep(poster.identity.did)).toBeCloseTo(start, 5);
    const resolved = (await poster.getBounty(bountyId)) as { resolution: string };
    expect(resolved.resolution).toBe("undisputed");
  }, 30_000);
});

describe("dispute + peer arbitration", () => {
  it("worker wins: jury majority pays the worker and penalises the poster", async () => {
    const bountyId = await runBountyToRejected(10);
    await worker.disputeBounty(bountyId, "the work meets every acceptance criterion in the spec");
    const disputed = (await poster.getBounty(bountyId)) as { state: string };
    expect(disputed.state).toBe("DISPUTED");

    // Jurors (established, non-parties) can see the deliverable while disputed.
    await juror1.createSession();
    const seen = (await juror1.getBounty(bountyId)) as { result: string | null };
    expect(seen.result).toContain("delivered work product");

    await juror1.arbitrateBounty(bountyId, "worker", "delivery matches spec");
    await juror2.arbitrateBounty(bountyId, "worker");

    const posterBefore = await rep(poster.identity.did);
    const workerBefore = await rep(worker.identity.did);
    await sleep(1_300);
    await sweepTrades();

    const b = (await poster.getBounty(bountyId)) as {
      state: string;
      resolution: string;
      arbitration: Array<{ verdict: string }>;
    };
    expect(b.state).toBe("PAID");
    expect(b.resolution).toBe("worker");
    expect(b.arbitration).toHaveLength(2);

    // Worker got the reward; poster took the arb-loss penalty (×0.8) and NO refund.
    expect(await rep(worker.identity.did)).toBeCloseTo(workerBefore + 10, 5);
    expect(await rep(poster.identity.did)).toBeCloseTo(posterBefore * 0.8, 5);
  }, 30_000);

  it("poster wins: refund + mild frivolous-dispute penalty on the worker", async () => {
    const bountyId = await runBountyToRejected(6);
    await worker.disputeBounty(bountyId, "I disagree");
    await juror1.arbitrateBounty(bountyId, "poster", "delivery is junk");
    await juror2.arbitrateBounty(bountyId, "poster");

    const posterBefore = await rep(poster.identity.did);
    const workerBefore = await rep(worker.identity.did);
    await sleep(1_300);
    await sweepTrades();

    const b = (await poster.getBounty(bountyId)) as { state: string; resolution: string };
    expect(b.state).toBe("REJECTED");
    expect(b.resolution).toBe("poster");
    expect(await rep(poster.identity.did)).toBeCloseTo(posterBefore + 6, 5);
    expect(await rep(worker.identity.did)).toBeCloseTo(workerBefore * 0.95, 5);
  }, 30_000);

  it("no votes → poster prevails (status quo), no frivolous penalty", async () => {
    const bountyId = await runBountyToRejected(4);
    await worker.disputeBounty(bountyId, "nobody will vote on this");
    const posterBefore = await rep(poster.identity.did);
    const workerBefore = await rep(worker.identity.did);
    await sleep(1_300);
    await sweepTrades();
    const b = (await poster.getBounty(bountyId)) as { resolution: string };
    expect(b.resolution).toBe("poster");
    expect(await rep(poster.identity.did)).toBeCloseTo(posterBefore + 4, 5);
    expect(await rep(worker.identity.did)).toBeCloseTo(workerBefore, 5); // no penalty
  }, 30_000);

  it("eligibility enforced: parties and low-tier agents cannot arbitrate", async () => {
    const bountyId = await runBountyToRejected(3);
    await worker.disputeBounty(bountyId, "eligibility test");
    await expect(poster.arbitrateBounty(bountyId, "poster")).rejects.toMatchObject({
      code: "forbidden",
    });
    const rando = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await rando.register("rando-p6"); // probation tier
    await expect(rando.arbitrateBounty(bountyId, "worker")).rejects.toMatchObject({
      code: "tier_insufficient",
    });
    // clean up: let it resolve
    await sleep(1_300);
    await sweepTrades();
  }, 120_000);
});

describe("anti-wash-trading", () => {
  it("pair transfer cap blocks repeat poster→worker laundering", async () => {
    // Cap is 30/30d. Transferred to worker so far: 10 (the arb win). A new
    // 21-reward bounty claim by the SAME worker would exceed 30.
    const { bountyId } = await poster.postBounty({ title: "wash attempt", spec: "s", reward: 21 });
    await expect(worker.claimBounty(bountyId)).rejects.toMatchObject({ code: "forbidden" });
    // A different worker is unaffected.
    await juror1.claimBounty(bountyId);
  });

  it("per-pair diminishing returns: diverse endorsement beats repeat endorsement", async () => {
    // Two fresh targets with equal TOTAL incoming rating edges; one concentrated
    // from a single rater, one diversified across three raters.
    await pool.query(`
      INSERT INTO agents (did, handle, pubkey, status, tier, reputation) VALUES
      ('did:key:zWashTarget1111111111111111111111111111111', 'concentrated', '\\x00', 'active', 'standard', 0),
      ('did:key:zWashTarget2222222222222222222222222222222', 'diversified', '\\x00', 'active', 'standard', 0),
      ('did:key:zWashRaterA111111111111111111111111111111', 'rater-a', '\\x00', 'active', 'standard', 10),
      ('did:key:zWashRaterB111111111111111111111111111111', 'rater-b', '\\x00', 'active', 'standard', 10),
      ('did:key:zWashRaterC111111111111111111111111111111', 'rater-c', '\\x00', 'active', 'standard', 10)
      ON CONFLICT (did) DO NOTHING`);
    // concentrated: 3 five-star ratings all from rater-a
    // diversified: 3 five-star ratings from a, b, c
    await pool.query(`
      INSERT INTO ratings (trade, rater, ratee, score, ts) VALUES
      ('trd_00000000000000000000000001', 'did:key:zWashRaterA111111111111111111111111111111', 'did:key:zWashTarget1111111111111111111111111111111', 5, now()),
      ('trd_00000000000000000000000002', 'did:key:zWashRaterA111111111111111111111111111111', 'did:key:zWashTarget1111111111111111111111111111111', 5, now()),
      ('trd_00000000000000000000000003', 'did:key:zWashRaterA111111111111111111111111111111', 'did:key:zWashTarget1111111111111111111111111111111', 5, now()),
      ('trd_00000000000000000000000004', 'did:key:zWashRaterA111111111111111111111111111111', 'did:key:zWashTarget2222222222222222222222222222222', 5, now()),
      ('trd_00000000000000000000000005', 'did:key:zWashRaterB111111111111111111111111111111', 'did:key:zWashTarget2222222222222222222222222222222', 5, now()),
      ('trd_00000000000000000000000006', 'did:key:zWashRaterC111111111111111111111111111111', 'did:key:zWashTarget2222222222222222222222222222222', 5, now())
      ON CONFLICT DO NOTHING`);

    await computeReputation();
    const concentrated = await rep("did:key:zWashTarget1111111111111111111111111111111");
    const diversified = await rep("did:key:zWashTarget2222222222222222222222222222222");
    // Same edge count, same weights — diversity must strictly win.
    expect(diversified).toBeGreaterThan(concentrated);
  });

  it("admin anomaly surface lists concentrated pairs", async () => {
    const res = await fetch(`${baseUrl}/v1/admin/anomalies`, {
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(res.status).toBe(200);
    const a = (await res.json()) as {
      bounty_transfer_pairs_30d: Array<{ poster: string; worker: string; transferred: number }>;
      mutual_rating_pairs: unknown[];
    };
    expect(
      a.bounty_transfer_pairs_30d.some(
        (p) => p.poster === poster.identity.did && p.worker === worker.identity.did,
      ),
    ).toBe(true);
  });

  it("anomalies endpoint is admin-gated", async () => {
    const res = await fetch(`${baseUrl}/v1/admin/anomalies`);
    expect(res.status).toBe(401);
  });
});

describe("observability (/metrics)", () => {
  it("exposes Prometheus metrics reflecting real activity", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    // Ingested events from this very suite.
    expect(text).toMatch(/waggle_events_total\{type="bounty\.post"\} [1-9]/);
    expect(text).toMatch(/waggle_events_total\{type="bounty\.dispute"\} [1-9]/);
    // HTTP metrics with route labels (not raw paths).
    expect(text).toMatch(/waggle_http_requests_total\{[^}]*route="\/v1\/events"[^}]*\} [1-9]/);
    expect(text).toContain("waggle_http_request_duration_seconds_bucket");
    // Rejections were counted (this suite exercised forbidden/tier errors).
    expect(text).toMatch(/waggle_ingress_rejections_total\{code="(forbidden|tier_insufficient)"\}/);
    // Gauges present.
    expect(text).toContain("waggle_pg_pool_total");
    expect(text).toContain("waggle_sse_connections");
    expect(text).toContain("process_resident_memory_bytes");
  });

  it("honors METRICS_TOKEN when set", async () => {
    process.env.METRICS_TOKEN = "sekret";
    try {
      const denied = await fetch(`${baseUrl}/metrics`);
      expect(denied.status).toBe(401);
      const ok = await fetch(`${baseUrl}/metrics`, {
        headers: { authorization: "Bearer sekret" },
      });
      expect(ok.status).toBe(200);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });
});

describe("human guide (/guide)", () => {
  it("serves the illustrated explainer, linked from the deck", async () => {
    const res = await fetch(`${baseUrl}/guide`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("WHAT IS THIS?");
    // The ASCII illustrations render.
    expect(html).toContain("PRIVATE KEY");
    expect(html).toContain("APPEND-ONLY EVENT LOG");
    expect(html).toContain("FAIR EXCHANGE");
    expect(html).toContain("BOUNTY LIFECYCLE");
    expect(html).toContain("GLOSSARY");
    // Read-only guarantees stated.
    expect(html).toContain("READ-ONLY");

    const deck = await (await fetch(`${baseUrl}/`)).text();
    expect(deck).toContain("read the guide");
  });
});

describe("rebuild equivalence with arbitration (spec §7)", () => {
  it("replay + sweep reproduces disputed/arbitrated bounty state and reputations", async () => {
    const snapshot = async () => ({
      bounties: (
        await pool.query("SELECT id, state, resolution, worker FROM bounties ORDER BY id")
      ).rows,
      arbitrations: (
        await pool.query("SELECT bounty, juror, verdict FROM bounty_arbitrations ORDER BY bounty, juror")
      ).rows,
      reputations: (
        await pool.query("SELECT did, reputation FROM agents WHERE handle LIKE '%-p6' OR handle LIKE 'juror-%' ORDER BY did")
      ).rows,
    });
    // Reputation is a batch projection (computeReputation over the graph +
    // ledger), not pure event-replay — so it must be recomputed on BOTH sides
    // to compare. The ledger and graph are rebuilt identically, so the batch
    // yields identical scores; bounty/arbitration state rebuilds from the log
    // directly.
    await computeReputation();
    const before = await snapshot();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    await computeReputation();
    expect(await snapshot()).toEqual(before);
  }, 60_000);
});
