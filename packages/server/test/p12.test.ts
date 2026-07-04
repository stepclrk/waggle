/**
 * P12 integration: fan-in (a reduce task's inputs = its deps' accepted
 * results) and the capability-matched unblock push (agents are notified the
 * moment a task that fits their capability becomes ready).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let coord: WaggleClient;
let mapper: WaggleClient;
let reducer: WaggleClient;

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, agents, sessions, notifications, capabilities, reputation_adjustments,
     reputation_runs, efforts, effort_tasks, effort_contributions, effort_authors CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;

  coord = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  mapper = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  reducer = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await coord.register("coord-p12");
  await mapper.register("mapper-p12");
  await reducer.register("reducer-p12");
  await pool.query(
    "INSERT INTO reputation_adjustments (did, kind, amount, reason) VALUES ($1,'grant',50,'genesis') ON CONFLICT DO NOTHING",
    [coord.identity.did],
  );
  await pool.query("UPDATE agents SET tier='anchor', reputation=50 WHERE handle='coord-p12'");
  await pool.query("UPDATE agents SET tier='standard', reputation=10 WHERE handle IN ('mapper-p12','reducer-p12')");
  // The reducer advertises the capability the reduce task will mention.
  await reducer.setCapabilities([
    { name: "aggregation", description: "combining partial results into totals" },
  ]);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

let effortId: string;
let mapA: string;
let mapB: string;
let reduce: string;

describe("fan-in: a reduce task's inputs are its deps' accepted results", () => {
  it("sets up map tasks and a dependent reduce task", async () => {
    effortId = (await coord.createEffort({ title: "count words", spec: "map then reduce", reward: 0 })).effortId;
    mapA = (await coord.addTask(effortId, "count words in part 1", 1)).taskId;
    mapB = (await coord.addTask(effortId, "count words in part 2", 1)).taskId;
    reduce = (await coord.addTask(effortId, "aggregation of the partial counts", 1, [mapA, mapB])).taskId;
    expect(reduce).toMatch(/^tsk_/);
  });

  it("refuses inputs while the task is still blocked", async () => {
    await expect(reducer.taskInputs(effortId, reduce)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("returns deps' accepted results in declared order once unblocked", async () => {
    await mapper.submitWork(effortId, mapA, "part1=120");
    await coord.acceptWork(effortId, mapA, mapper.identity.did);
    await mapper.submitWork(effortId, mapB, "part2=85");
    await coord.acceptWork(effortId, mapB, mapper.identity.did);

    const { inputs } = await reducer.taskInputs(effortId, reduce);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.task_id).toBe(mapA); // deps[] declaration order preserved
    expect(inputs[0]!.result).toBe("part1=120");
    expect(inputs[1]!.result).toBe("part2=85");
  });

  it("a task with no deps has empty inputs", async () => {
    const { inputs } = await reducer.taskInputs(effortId, mapA);
    expect(inputs).toEqual([]);
  });
});

describe("capability-matched unblock push", () => {
  it("notified the capability-matched agent the moment the reduce task unblocked", async () => {
    // The reduce task spec contains "aggregation" — reducer's capability. It
    // unblocked when mapB was accepted; a notification must have been pushed.
    const { rows } = await pool.query(
      `SELECT summary FROM notifications WHERE recipient = $1 AND kind = 'effort'
         AND summary LIKE 'task ready%'`,
      [reducer.identity.did],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.summary.includes(reduce))).toBe(true);
  });

  it("pushes tasks that are created already-ready (no deps) too", async () => {
    const eid = (await coord.createEffort({ title: "fresh", spec: "x", reward: 0 })).effortId;
    const t = (await coord.addTask(eid, "an aggregation job, ready now", 1)).taskId;
    const { rows } = await pool.query(
      "SELECT 1 FROM notifications WHERE recipient = $1 AND summary LIKE '%' || $2 || '%'",
      [reducer.identity.did, t],
    );
    expect(rows.length).toBe(1);
  });

  it("does not notify agents whose capabilities don't match", async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM notifications WHERE recipient = $1 AND summary LIKE 'task ready%'`,
      [mapper.identity.did], // mapper declared no capabilities
    );
    expect(rows.length).toBe(0);
  });
});

describe("rebuild equivalence incl. push notifications (spec §7)", () => {
  it("replay reproduces tasks, contributions, and the notification set", async () => {
    const snap = async () => ({
      tasks: (await pool.query("SELECT effort, task_id, state, deps FROM effort_tasks ORDER BY effort, task_id")).rows,
      contribs: (await pool.query("SELECT effort, task_id, agent, state FROM effort_contributions ORDER BY effort, task_id, agent")).rows,
      readyNotifs: (await pool.query(
        "SELECT recipient, summary FROM notifications WHERE summary LIKE 'task ready%' ORDER BY recipient, summary",
      )).rows,
    });
    const before = await snap();
    expect(before.readyNotifs.length).toBeGreaterThan(0);
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    expect(await snap()).toEqual(before);
  }, 60_000);
});
