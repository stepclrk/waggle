/**
 * P11 integration: Efforts phase 2 — dependency DAG (map-reduce), progress
 * streaming, and the open-task feed.
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
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let coord: WaggleClient;
let w1: WaggleClient;
let w2: WaggleClient;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, agents, sessions, notifications, reputation_adjustments, reputation_runs,
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
  await coord.register("coord-p11");
  await w1.register("worker-a-p11");
  await w2.register("worker-b-p11");
  await pool.query(
    "INSERT INTO reputation_adjustments (did, kind, amount, reason) VALUES ($1,'grant',50,'genesis') ON CONFLICT DO NOTHING",
    [coord.identity.did],
  );
  await pool.query("UPDATE agents SET tier='anchor', reputation=50 WHERE handle='coord-p11'");
  await pool.query("UPDATE agents SET tier='standard', reputation=10 WHERE handle LIKE 'worker-%-p11'");
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("dependency DAG (map-reduce)", () => {
  let effortId: string;
  let mapA: string;
  let mapB: string;
  let reduce: string;

  it("adds map tasks and a reduce task depending on them", async () => {
    effortId = (await coord.createEffort({ title: "map-reduce", spec: "sum of parts", reward: 6 })).effortId;
    mapA = (await coord.addTask(effortId, "compute part A", 1)).taskId;
    mapB = (await coord.addTask(effortId, "compute part B", 1)).taskId;
    reduce = (await coord.addTask(effortId, "combine A+B", 1, [mapA, mapB])).taskId;
    const e = (await coord.getEffort(effortId)) as {
      tasks: Array<{ task_id: string; blocked: boolean; deps: string[] }>;
    };
    const r = e.tasks.find((t) => t.task_id === reduce)!;
    expect(r.deps.sort()).toEqual([mapA, mapB].sort());
    expect(r.blocked).toBe(true); // deps not done yet
  });

  it("refuses work on a blocked task", async () => {
    await expect(w1.submitWork(effortId, reduce, "premature")).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("unblocks the reduce task only once ALL deps are done", async () => {
    await w1.submitWork(effortId, mapA, "A=3");
    await coord.acceptWork(effortId, mapA, w1.identity.did);
    // Still blocked — mapB not done.
    let e = (await coord.getEffort(effortId)) as { tasks: Array<{ task_id: string; blocked: boolean }> };
    expect(e.tasks.find((t) => t.task_id === reduce)!.blocked).toBe(true);
    await expect(w1.submitWork(effortId, reduce, "still early")).rejects.toMatchObject({ code: "bad_request" });

    await w1.submitWork(effortId, mapB, "B=4");
    await coord.acceptWork(effortId, mapB, w1.identity.did);
    e = (await coord.getEffort(effortId)) as { tasks: Array<{ task_id: string; blocked: boolean }> };
    expect(e.tasks.find((t) => t.task_id === reduce)!.blocked).toBe(false); // now unblocked

    // And now the reduce task accepts work.
    await w2.submitWork(effortId, reduce, "A+B=7");
    await coord.acceptWork(effortId, reduce, w2.identity.did);
    e = (await coord.getEffort(effortId)) as { tasks: Array<{ task_id: string; state: string }> };
    expect(e.tasks.find((t) => t.task_id === reduce)!.state).toBe("DONE");
  });

  it("rejects a dependency that does not exist in the effort", async () => {
    await expect(
      coord.addTask(effortId, "bad dep", 1, ["tsk_00000000000000000000000000"]),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("progress streaming", () => {
  let effortId: string;
  let task: string;

  it("a worker claims and streams progress; the coordinator can see it", async () => {
    effortId = (await coord.createEffort({ title: "long job", spec: "big", reward: 0 })).effortId;
    task = (await coord.addTask(effortId, "render the frames", 1)).taskId;
    await w1.claimTask(effortId, task);
    await w1.reportProgress(effortId, task, 25, { note: "quarter done" });
    await w1.reportProgress(effortId, task, 60, { note: "past halfway" });

    const { rows } = await pool.query(
      "SELECT progress, progress_note, state FROM effort_contributions WHERE effort=$1 AND task_id=$2 AND agent=$3",
      [effortId, task, w1.identity.did],
    );
    expect(Number(rows[0].progress)).toBe(60); // last write wins
    expect(rows[0].progress_note).toBe("past halfway");
    expect(rows[0].state).toBe("CLAIMED"); // progress doesn't submit
  });

  it("progress on a blocked task is refused", async () => {
    const a = (await coord.addTask(effortId, "dep", 1)).taskId;
    const b = (await coord.addTask(effortId, "blocked", 1, [a])).taskId;
    await expect(w1.reportProgress(effortId, b, 10)).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("open-task feed", () => {
  it("lists open unblocked tasks and filters by text; excludes blocked ones", async () => {
    const all = (await w2.openEffortTasks()) as {
      open_tasks: Array<{ task_id: string; spec: string; effort_title: string }>;
    };
    // The map-reduce reduce task is DONE; its maps are DONE; the "long job" and
    // its unblocked dep task remain open. The blocked "blocked" task must NOT appear.
    expect(all.open_tasks.some((t) => t.spec === "blocked")).toBe(false);
    expect(all.open_tasks.some((t) => t.spec === "render the frames")).toBe(true);

    const filtered = (await w2.openEffortTasks("render")) as { open_tasks: Array<{ spec: string }> };
    expect(filtered.open_tasks.every((t) => t.spec.toLowerCase().includes("render"))).toBe(true);
  });

  it("checkin-style capability match surfaces relevant effort tasks (digest)", async () => {
    const digest = (await w1.digest()) as { open_effort_tasks: Array<{ spec: string }> };
    expect(Array.isArray(digest.open_effort_tasks)).toBe(true);
  });
});

describe("rebuild equivalence with the DAG + progress (spec §7)", () => {
  it("replay reproduces tasks (deps/state), contributions (progress), authors, reputations", async () => {
    await computeReputation();
    const snap = async () => ({
      tasks: (await pool.query("SELECT effort, task_id, state, deps FROM effort_tasks ORDER BY effort, task_id")).rows,
      contribs: (await pool.query(
        "SELECT effort, task_id, agent, state, progress, progress_note FROM effort_contributions ORDER BY effort, task_id, agent",
      )).rows,
      authors: (await pool.query("SELECT effort, agent, share FROM effort_authors ORDER BY effort, agent")).rows,
      reps: (await pool.query("SELECT did, reputation FROM agents WHERE handle LIKE '%-p11' ORDER BY did")).rows,
    });
    const before = await snap();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    await computeReputation();
    expect(await snap()).toEqual(before);
  }, 60_000);
});
