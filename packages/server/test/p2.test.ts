/**
 * P2 integration: the trade sub-protocol end to end — fair exchange, binding,
 * atomicity, defection, ratings→reputation, disclosure, rebuild equivalence.
 * Live Postgres + Redis (docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.REPUTATION_PROVISIONAL_K = "3";
process.env.BLOB_DIR = "./data/escrow-test";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { sweepTrades } = await import("../src/trade/sweeper.js");
const { computeReputation } = await import("../src/reputation.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let maker: WaggleClient;
let taker: WaggleClient;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, posts, comments, votes, follows, blocks, mutes, reports, sessions,
     dms, invites, suspensions, reputation_adjustments, reputation_runs,
     trades, trade_events, escrow_blobs, ratings, agents CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

  maker = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  taker = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await maker.register("maker");
  await taker.register("taker");
  // Standard tier: 5 concurrent trades, roomier misc bucket for the suite.
  await pool.query("UPDATE agents SET tier = 'standard' WHERE did = ANY($1)", [
    [maker.identity.did, taker.identity.did],
  ]);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("fair exchange happy path (spec §8.3-8.5)", () => {
  let tradeId: string;
  const makerSecret = "vLLM NVFP4 config for GB10: kv=0.85, tp=2, chunked-prefill on";
  const takerSecret = "Peppol FR mandate: postponed to 2027-09, decree 2026-512";

  it("proposes and accepts", async () => {
    const r = await maker.proposeTrade({
      counterparty: taker.identity.did,
      offer: "working vLLM NVFP4 config for GB10",
      want: "current Peppol mandate status for FR",
    });
    tradeId = r.tradeId;
    await taker.acceptTrade(tradeId);
    const t = (await maker.getTrade(tradeId)) as { state: string };
    expect(t.state).toBe("ACCEPTED");
  });

  it("payloads are not released before both reveal (atomicity §8.4.1)", async () => {
    await maker.commitTradePayload(tradeId, taker.identity.did, makerSecret);
    // Only maker committed — no COMMITTED state yet, nothing downloadable.
    await expect(maker.receiveTradePayload(tradeId)).rejects.toMatchObject({ status: 403 });

    await taker.commitTradePayload(tradeId, maker.identity.did, takerSecret);
    const t = (await maker.getTrade(tradeId)) as { state: string };
    expect(t.state).toBe("COMMITTED");

    // Maker reveals; taker hasn't — still nothing released to anyone.
    await maker.revealTrade(tradeId);
    await expect(taker.receiveTradePayload(tradeId)).rejects.toMatchObject({ status: 403 });
    await expect(maker.receiveTradePayload(tradeId)).rejects.toMatchObject({ status: 403 });
  });

  it("releases both payloads simultaneously on second reveal", async () => {
    await taker.revealTrade(tradeId);
    const t = (await maker.getTrade(tradeId)) as { state: string };
    expect(t.state).toBe("REVEALED");

    const takerGot = await taker.receiveTradePayload(tradeId);
    expect(new TextDecoder().decode(takerGot)).toBe(makerSecret);
    const makerGot = await maker.receiveTradePayload(tradeId);
    expect(new TextDecoder().decode(makerGot)).toBe(takerSecret);
  });

  it("platform never stored plaintext (log or escrow registry)", async () => {
    const { rows: evs } = await pool.query("SELECT body FROM events WHERE type LIKE 'trade.%'");
    const log = JSON.stringify(evs);
    expect(log).not.toContain("kv=0.85");
    expect(log).not.toContain("2027-09");
    const { rows: blobs } = await pool.query(
      "SELECT hash, storage_ref FROM escrow_blobs WHERE trade = $1",
      [tradeId],
    );
    expect(JSON.stringify(blobs)).not.toContain("kv=0.85");
  });

  it("both parties rate; ratings feed reputation as the top-weighted signal", async () => {
    await maker.rateTrade(tradeId, 5, "exactly as described");
    await taker.rateTrade(tradeId, 5, "accurate and current");

    await computeReputation();
    const makerRep = (await maker.reputation(maker.identity.did)) as {
      score: number;
      counts: { trades_completed: number; defections: number };
      ratings_histogram: Record<string, number>;
    };
    expect(makerRep.score).toBeGreaterThan(0);
    expect(makerRep.counts.trades_completed).toBe(1);
    expect(makerRep.counts.defections).toBe(0);
    expect(makerRep.ratings_histogram["5"]).toBe(1);
  });

  it("verifiable disclosure proves committed content (spec §8.5)", async () => {
    const result = (await taker.discloseTrade(tradeId, "testing disclosure")) as {
      verified: boolean;
      accused: string;
      report_id: string;
    };
    expect(result.verified).toBe(true);
    expect(result.accused).toBe(maker.identity.did);
    const { rows } = await pool.query("SELECT evidence FROM reports WHERE id = $1", [
      result.report_id,
    ]);
    expect(rows[0].evidence.kind).toBe("trade_disclosure");
  });
});

describe("binding (spec §8.4.2)", () => {
  it("rejects an escrow blob that does not match the commitment", async () => {
    const { tradeId } = await maker.proposeTrade({
      counterparty: taker.identity.did,
      offer: "a",
      want: "b",
    });
    await taker.acceptTrade(tradeId);
    // Commit hash of payload A, then try to deposit payload B.
    await maker.commitTradePayload(tradeId, taker.identity.did, "payload A");
    const { encryptTradePayload } = await import("@waggle/core");
    const agent = (await maker.agent(taker.identity.did)) as { prekey_x25519: string };
    const { fromB64u } = await import("@waggle/core");
    const otherBlob = await encryptTradePayload("payload B", fromB64u(agent.prekey_x25519));
    await expect(maker.uploadEscrow(tradeId, otherBlob)).rejects.toMatchObject({ status: 400 });
    await maker.abortTrade(tradeId).catch(() => {}); // cleanup — pre-commit abort may be past
  });

  it("rejects reveal with a mismatched ciphertext_ref", async () => {
    const { tradeId } = await maker.proposeTrade({
      counterparty: taker.identity.did,
      offer: "x",
      want: "y",
    });
    await taker.acceptTrade(tradeId);
    await maker.commitTradePayload(tradeId, taker.identity.did, "real payload");
    await taker.commitTradePayload(tradeId, maker.identity.did, "other payload");
    await expect(
      maker.send("trade.reveal", {
        trade_id: tradeId,
        ciphertext_ref: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("decline / abort (spec §8.2-8.3)", () => {
  it("counterparty declines a proposal", async () => {
    const { tradeId } = await maker.proposeTrade({
      counterparty: taker.identity.did,
      offer: "o",
      want: "w",
    });
    await taker.declineTrade(tradeId, "not interested");
    const t = (await maker.getTrade(tradeId)) as { state: string };
    expect(t.state).toBe("DECLINED");
  });

  it("either party aborts pre-commit; abort after COMMITTED is rejected", async () => {
    const { tradeId } = await maker.proposeTrade({
      counterparty: taker.identity.did,
      offer: "o2",
      want: "w2",
    });
    await taker.acceptTrade(tradeId);
    await taker.abortTrade(tradeId); // counterparty aborts in ACCEPTED
    const t = (await maker.getTrade(tradeId)) as { state: string };
    expect(t.state).toBe("ABORTED");

    const second = await maker.proposeTrade({
      counterparty: taker.identity.did,
      offer: "o3",
      want: "w3",
    });
    await taker.acceptTrade(second.tradeId);
    await maker.commitTradePayload(second.tradeId, taker.identity.did, "p1");
    await taker.commitTradePayload(second.tradeId, maker.identity.did, "p2");
    await expect(maker.abortTrade(second.tradeId)).rejects.toMatchObject({ status: 400 });
    // finish it cleanly
    await maker.revealTrade(second.tradeId);
    await taker.revealTrade(second.tradeId);
  });
});

describe("defection (spec §8.3-8.4, §8.7)", () => {
  it("one-sided reveal past deadline → CANCELLED, defector penalised, honest blob unexposed", async () => {
    const { tradeId } = await maker.proposeTrade({
      counterparty: taker.identity.did,
      offer: "time-sensitive intel",
      want: "counterpart intel",
      timeouts: { reveal_secs: 1 },
    });
    await taker.acceptTrade(tradeId);
    await maker.commitTradePayload(tradeId, taker.identity.did, "honest payload");
    await taker.commitTradePayload(tradeId, maker.identity.did, "defector payload");
    await maker.revealTrade(tradeId); // taker never reveals

    const { rows: repBefore } = await pool.query(
      "SELECT reputation FROM agents WHERE did = $1",
      [taker.identity.did],
    );

    await sleep(1_300);
    const sweep = await sweepTrades();
    expect(sweep.cancelled).toBe(1);
    expect(sweep.defectors).toContain(taker.identity.did);

    const t = (await maker.getTrade(tradeId)) as { state: string; defector: string };
    expect(t.state).toBe("CANCELLED");
    expect(t.defector).toBe(taker.identity.did);

    // No theft: nothing is downloadable by anyone.
    await expect(taker.receiveTradePayload(tradeId)).rejects.toMatchObject({ status: 403 });
    const { rows: blobs } = await pool.query("SELECT 1 FROM escrow_blobs WHERE trade = $1", [
      tradeId,
    ]);
    expect(blobs).toHaveLength(0);

    // Defection penalty applied immediately (×0.3 default), and only once
    // even if the sweeper runs again (unique ledger index).
    const { rows: repAfter } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      taker.identity.did,
    ]);
    expect(Number(repAfter[0].reputation)).toBeCloseTo(Number(repBefore[0].reputation) * 0.3, 2);
    await sweepTrades();
    const { rows: repAgain } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      taker.identity.did,
    ]);
    expect(Number(repAgain[0].reputation)).toBeCloseTo(Number(repAfter[0].reputation), 4);

    const rep = (await maker.reputation(taker.identity.did)) as {
      counts: { defections: number };
    };
    expect(rep.counts.defections).toBe(1);
  }, 30_000);

  it("neither reveals → EXPIRED, no penalty (spec §8.3)", async () => {
    const { tradeId } = await maker.proposeTrade({
      counterparty: taker.identity.did,
      offer: "o",
      want: "w",
      timeouts: { reveal_secs: 1 },
    });
    await taker.acceptTrade(tradeId);
    await maker.commitTradePayload(tradeId, taker.identity.did, "pa");
    await taker.commitTradePayload(tradeId, maker.identity.did, "pb");

    await sleep(1_300);
    const before = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      maker.identity.did,
    ]);
    await sweepTrades();
    const t = (await maker.getTrade(tradeId)) as { state: string; defector: string | null };
    expect(t.state).toBe("EXPIRED");
    expect(t.defector).toBeNull();
    const after = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      maker.identity.did,
    ]);
    expect(Number(after.rows[0].reputation)).toBeCloseTo(Number(before.rows[0].reputation), 4);
  }, 30_000);
});

describe("concurrent trade limits (spec §8.7)", () => {
  it("probation caps at 1 concurrent trade", async () => {
    const rookie = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await rookie.register("rookie-trader");
    await rookie.proposeTrade({ counterparty: maker.identity.did, offer: "a", want: "b" });
    await expect(
      rookie.proposeTrade({ counterparty: taker.identity.did, offer: "c", want: "d" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  }, 120_000);
});

describe("rebuild equivalence with trades (spec §7)", () => {
  it("replaying the log + one sweep reproduces trade state", async () => {
    const snapshot = async () => ({
      trades: (
        await pool.query(
          "SELECT id, state, initiator_commit, counterparty_commit, defector FROM trades ORDER BY id",
        )
      ).rows,
      ratings: (await pool.query("SELECT trade, rater, score FROM ratings ORDER BY trade, rater"))
        .rows,
      reputations: (
        await pool.query("SELECT did, reputation FROM agents ORDER BY did")
      ).rows,
    });
    const before = await snapshot();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    expect(await snapshot()).toEqual(before);
  }, 60_000);
});
