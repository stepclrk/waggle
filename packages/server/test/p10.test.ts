/**
 * P10 integration: Efforts — pooled compute + co-authoring. Trustless redundant
 * verification, coordinator-judged tasks, reward split, co-authorship, and
 * rebuild equivalence.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { computeReputation } = await import("../src/reputation.js");
const { sweepTrades } = await import("../src/trade/sweeper.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let coord: WaggleClient;
let w1: WaggleClient;
let w2: WaggleClient;
let w3: WaggleClient;

const rep = async (did: string) =>
  Number((await pool.query("SELECT reputation FROM agents WHERE did=$1", [did])).rows[0].reputation);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, posts, comments, votes, follows, blocks, mutes, sessions, notifications,
     reputation_adjustments, reputation_runs, agents,
     efforts, effort_tasks, effort_contributions, effort_authors CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;

  coord = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  w1 = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  w2 = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  w3 = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await coord.register("coordinator-p10");
  await w1.register("worker-one");
  await w2.register("worker-two");
  await w3.register("worker-three");
  // Coordinator standing is a LEDGER grant (genesis) so it survives the
  // reputation recompute a later test triggers — a raw UPDATE would be wiped
  // (the same lesson the founding-society seed encodes).
  await pool.query(
    "INSERT INTO reputation_adjustments (did, kind, amount, reason) VALUES ($1,'grant',60,'genesis') ON CONFLICT DO NOTHING",
    [coord.identity.did],
  );
  await pool.query("UPDATE agents SET tier='anchor', reputation=60 WHERE handle='coordinator-p10'");
  await pool.query("UPDATE agents SET tier='standard', reputation=10 WHERE handle LIKE 'worker-%'");
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("effort lifecycle: pooled compute + co-authoring", () => {
  let effortId: string;
  let taskR: string; // redundant (trustless) task
  let taskJ: string; // coordinator-judged task

  it("creates an effort, staking the reward pool", async () => {
    const before = await rep(coord.identity.did);
    const r = await coord.createEffort({ title: "factor these", spec: "big compute", reward: 12 });
    effortId = r.effortId;
    expect(await rep(coord.identity.did)).toBeCloseTo(before - 12, 5); // pool staked
  });

  it("adds a trustless (redundancy 2) task and a coordinator-judged task", async () => {
    taskR = (await coord.addTask(effortId, "compute chunk A", 2)).taskId;
    taskJ = (await coord.addTask(effortId, "write the summary", 1)).taskId;
    const e = (await coord.getEffort(effortId)) as { tasks: Array<{ task_id: string; redundancy: number }> };
    expect(e.tasks).toHaveLength(2);
  });

  it("the coordinator cannot submit work to their own effort", async () => {
    await expect(coord.submitWork(effortId, taskR, "x", sha("x"))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("TRUSTLESS: a redundant task auto-accepts when independent agents agree on the hash", async () => {
    const result = "chunk A = 42";
    const h = sha(result);
    await w1.submitWork(effortId, taskR, result, h); // 1st — task still OPEN
    let e = (await coord.getEffort(effortId)) as { tasks: Array<{ task_id: string; state: string }> };
    expect(e.tasks.find((t) => t.task_id === taskR)!.state).toBe("OPEN");

    await w2.submitWork(effortId, taskR, result, h); // 2nd matching → auto-accept
    e = (await coord.getEffort(effortId)) as {
      tasks: Array<{ task_id: string; state: string; accepted_hash: string }>;
      contributions: Array<{ agent: string; state: string }>;
    };
    const t = e.tasks.find((t) => t.task_id === taskR)!;
    expect(t.state).toBe("DONE");
    expect(t.accepted_hash).toBe(h);
    // Both agreeing agents are accepted; no coordinator judgement was needed.
    const accepted = (e as { contributions: Array<{ agent: string; state: string }> }).contributions.filter(
      (c) => c.state === "ACCEPTED",
    );
    expect(accepted.map((c) => c.agent).sort()).toEqual([w1.identity.did, w2.identity.did].sort());
  });

  it("SAFETY: once agreed, a later disagreeing submission is refused outright", async () => {
    // taskR auto-completed on the w1/w2 hash agreement; a wrong answer arriving
    // afterward is rejected at ingress (task is done), so it can never overwrite
    // or dilute the agreed result.
    await expect(
      w3.submitWork(effortId, taskR, "chunk A = 99", sha("chunk A = 99")),
    ).rejects.toMatchObject({ code: "bad_request" });
    const { rows } = await pool.query(
      "SELECT 1 FROM effort_contributions WHERE effort=$1 AND task_id=$2 AND agent=$3",
      [effortId, taskR, w3.identity.did],
    );
    expect(rows.length).toBe(0); // never even recorded
  });

  it("coordinator judges the redundancy-1 task", async () => {
    await w3.submitWork(effortId, taskJ, "the summary text");
    await coord.acceptWork(effortId, taskJ, w3.identity.did);
    const e = (await coord.getEffort(effortId)) as { tasks: Array<{ task_id: string; state: string }> };
    expect(e.tasks.find((t) => t.task_id === taskJ)!.state).toBe("DONE");
  });

  it("SAFETY: cannot accept a submission on an already-DONE task (no hash overwrite / extra co-author)", async () => {
    // taskR auto-accepted (w1+w2 agreed). A coordinator accept on the DONE task
    // must be refused — otherwise it would overwrite the trustlessly-agreed
    // accepted_hash and add an extra ACCEPTED contributor (an extra reward share).
    await expect(coord.acceptWork(effortId, taskR, w1.identity.did)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("finalizes: co-authorship recorded and the reward pool split by share", async () => {
    const w1Before = await rep(w1.identity.did);
    const w2Before = await rep(w2.identity.did);
    const w3Before = await rep(w3.identity.did);

    await coord.finalizeEffort(effortId, "solved: A=42, summarized");

    const e = (await coord.getEffort(effortId)) as {
      effort: { state: string };
      co_authors: Array<{ agent: string; tasks: number; share: number }>;
    };
    expect(e.effort.state).toBe("FINALIZED");
    // Accepted tasks: w1 (taskR), w2 (taskR), w3 (taskJ) → 3 total, each 1/3.
    const byAgent = Object.fromEntries(e.co_authors.map((a) => [a.agent, a]));
    expect(e.co_authors).toHaveLength(3);
    expect(byAgent[w1.identity.did]!.share).toBeCloseTo(1 / 3, 4);

    // Reward 12 split 1/3 each = 4 each.
    expect(await rep(w1.identity.did)).toBeCloseTo(w1Before + 4, 4);
    expect(await rep(w2.identity.did)).toBeCloseTo(w2Before + 4, 4);
    expect(await rep(w3.identity.did)).toBeCloseTo(w3Before + 4, 4);
  });

  it("co-authoring forms a mutual reputation endorsement", async () => {
    await computeReputation();
    // Workers who co-authored with each other and the (high-rep) network gain
    // standing beyond the raw reward.
    const w1rep = await rep(w1.identity.did);
    expect(w1rep).toBeGreaterThan(0);
  });
});

describe("abandon refunds the pool", () => {
  it("refunds the coordinator when an effort is abandoned", async () => {
    const before = await rep(coord.identity.did);
    const { effortId } = await coord.createEffort({ title: "dead end", spec: "nope", reward: 5 });
    expect(await rep(coord.identity.did)).toBeCloseTo(before - 5, 5);
    await coord.abandonEffort(effortId, "not worth it");
    expect(await rep(coord.identity.did)).toBeCloseTo(before, 5);
  });
});

describe("rebuild equivalence with efforts (spec §7)", () => {
  it("replay reproduces efforts, tasks, contributions, co-authors, reputations", async () => {
    await sweepTrades();
    await computeReputation();
    const snap = async () => ({
      efforts: (await pool.query("SELECT id, state, summary FROM efforts ORDER BY id")).rows,
      tasks: (await pool.query("SELECT effort, task_id, state, accepted_hash FROM effort_tasks ORDER BY effort, task_id")).rows,
      contribs: (await pool.query("SELECT effort, task_id, agent, state FROM effort_contributions ORDER BY effort, task_id, agent")).rows,
      authors: (await pool.query("SELECT effort, agent, tasks, share FROM effort_authors ORDER BY effort, agent")).rows,
      reps: (await pool.query("SELECT did, reputation FROM agents WHERE handle LIKE '%-p10' OR handle LIKE 'worker-%' ORDER BY did")).rows,
    });
    const before = await snap();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    await computeReputation();
    expect(await snap()).toEqual(before);
  }, 60_000);
});
