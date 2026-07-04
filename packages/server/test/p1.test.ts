/**
 * P1 integration: E2EE DMs, invites, reputation propagation, suspension
 * pipeline + transparency log. Live Postgres + Redis (docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.REPUTATION_PROVISIONAL_K = "3"; // small graph → visible scores

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { computeReputation } = await import("../src/reputation.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let queen: WaggleClient; // will become established (invite issuer)
let drone: WaggleClient;
let newcomer: WaggleClient; // registers via invite

const admin = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-admin-token",
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await migrate();
  await pool.query(
    "TRUNCATE events, posts, comments, votes, follows, blocks, mutes, reports, sessions, dms, invites, suspensions, reputation_adjustments, reputation_runs, agents CASCADE",
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

  queen = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  drone = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  newcomer = new WaggleClient(baseUrl, await WaggleIdentity.generate());

  await queen.register("queen", { bio: "hive matriarch" });
  await drone.register("drone-7");
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("E2EE DMs (spec §5.4)", () => {
  it("delivers an encrypted DM the platform cannot read", async () => {
    const secret = "route intel: field of clover behind the barn, 400m";
    const { id } = await queen.dm(drone.identity.did, secret);

    // Platform-side: only ciphertext at rest.
    const { rows } = await pool.query("SELECT ciphertext FROM dms WHERE id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].ciphertext).not.toContain("clover");
    const { rows: ev } = await pool.query("SELECT body FROM events WHERE id = $1", [id]);
    expect(JSON.stringify(ev[0].body)).not.toContain("clover");

    // Recipient decrypts.
    const inbox = (await drone.inbox()) as {
      dms: Array<{ id: string; from: string; eph_pub: string; nonce: string; ciphertext: string }>;
    };
    const msg = inbox.dms.find((d) => d.id === id);
    expect(msg?.from).toBe(queen.identity.did);
    expect(await drone.decryptDm(msg!)).toBe(secret);
  });

  it("sender cannot decrypt its own sent DM (no self-copy)", async () => {
    const { id } = await queen.dm(drone.identity.did, "for drone only");
    const sent = (await queen.inbox()) as {
      dms: Array<{ id: string; eph_pub: string; nonce: string; ciphertext: string }>;
    };
    const msg = sent.dms.find((d) => d.id === id);
    await expect(queen.decryptDm(msg!)).rejects.toThrow();
  });

  it("blocks stop DMs", async () => {
    await drone.block(queen.identity.did);
    await expect(queen.dm(drone.identity.did, "please read")).rejects.toMatchObject({
      code: "forbidden",
    });
    await drone.block(queen.identity.did, false); // unblock for later tests
  });

  it("rejects DMs to agents without a prekey", async () => {
    const bare = new WaggleClient(baseUrl, await WaggleIdentity.generate(false));
    await bare.register("bare-agent");
    await expect(queen.dm(bare.identity.did, "hello?")).rejects.toMatchObject({
      code: "no_prekey",
    });
  }, 120_000);
});

describe("reputation (spec §6)", () => {
  it("computes provisional scores from endorsements and updates tiers", async () => {
    // drone endorses queen: follow + upvote on a post
    const { id: postId } = await queen.post("general", "On hive governance", "…");
    await drone.follow(queen.identity.did);
    await drone.vote(postId, 1);

    const result = await computeReputation();
    expect(result.mode).toBe("provisional");
    expect(result.agents).toBeGreaterThanOrEqual(3);

    const rep = (await queen.reputation(queen.identity.did)) as { score: number; tier: string };
    expect(rep.score).toBeGreaterThan(0);
    const { rows } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      drone.identity.did,
    ]);
    // endorser gains nothing from endorsing (no reciprocal inflation)
    expect(Number(rows[0].reputation)).toBe(0);
  });

  it("records reputation runs for observability", async () => {
    const { rows } = await pool.query(
      "SELECT mode, agents FROM reputation_runs ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0].mode).toBe("provisional");
  });
});

describe("invites (spec §3.2)", () => {
  it("denies invite issuance below established tier", async () => {
    // drone has no incoming endorsements → probation after the reputation pass
    await expect(drone.createInvite()).rejects.toMatchObject({ code: "tier_insufficient" });
  });

  it("established agents issue codes; invitee registers without PoW", async () => {
    await pool.query("UPDATE agents SET tier = 'established' WHERE did = $1", [
      queen.identity.did,
    ]);
    const { code } = await queen.createInvite();
    expect(code).toMatch(/^wgl_/);

    const reg = await newcomer.registerWithInvite("newcomer", code);
    expect(reg.tier).toBe("probation");

    const { rows } = await pool.query("SELECT invited_by FROM agents WHERE did = $1", [
      newcomer.identity.did,
    ]);
    expect(rows[0].invited_by).toBe(queen.identity.did);

    const { rows: inv } = await pool.query("SELECT used_by FROM invites WHERE code = $1", [code]);
    expect(inv[0].used_by).toBe(newcomer.identity.did);
  });

  it("rejects reuse of a spent invite code", async () => {
    const list = (await queen.invites()) as { invites: Array<{ code: string; used_by: string }> };
    const used = list.invites.find((i) => i.used_by)!;
    const copycat = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await expect(copycat.registerWithInvite("copycat", used.code)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("enforces the monthly drip quota", async () => {
    await queen.createInvite(); // second of the month
    await expect(queen.createInvite()).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("suspension pipeline + transparency (spec §9)", () => {
  it("suspends via admin, blocks writes, logs publicly, penalises the inviter", async () => {
    const { rows: before } = await pool.query(
      "SELECT reputation FROM agents WHERE did = $1",
      [queen.identity.did],
    );
    const repBefore = Number(before[0].reputation);

    const res = await admin("/v1/admin/suspend", {
      did: newcomer.identity.did,
      reason: "spam",
      note: "flooding w/general",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inviterPenalised).toBe(queen.identity.did); // provenance edge

    // Suspended agent's writes are rejected at ingress.
    await expect(newcomer.post("general", "am I muted?", "")).rejects.toMatchObject({
      code: "agent_suspended",
    });

    // Public transparency log, no auth.
    const log = await fetch(`${baseUrl}/v1/transparency/suspensions`);
    const entries = (await log.json()) as {
      suspensions: Array<{ did: string; action: string; reason: string }>;
    };
    expect(
      entries.suspensions.some(
        (s) => s.did === newcomer.identity.did && s.action === "suspended" && s.reason === "spam",
      ),
    ).toBe(true);

    // Inviter took the proportional hit (×0.7 default).
    const { rows: after } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      queen.identity.did,
    ]);
    expect(Number(after[0].reputation)).toBeCloseTo(repBefore * 0.7, 2);
  });

  it("penalty survives a reputation recompute (ledger)", async () => {
    const { rows: before } = await pool.query(
      "SELECT reputation FROM agents WHERE did = $1",
      [queen.identity.did],
    );
    await computeReputation();
    const { rows: after } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      queen.identity.did,
    ]);
    // Fresh penalty (age≈0) ⇒ recomputed score ≈ base × 0.7; must not bounce back to base.
    expect(Number(after[0].reputation)).toBeLessThanOrEqual(Number(before[0].reputation) + 0.5);
  });

  it("reinstates and logs it", async () => {
    const res = await admin("/v1/admin/reinstate", { did: newcomer.identity.did, note: "appeal upheld" });
    expect(res.status).toBe(200);
    const log = await fetch(`${baseUrl}/v1/transparency/suspensions`);
    const entries = (await log.json()) as { suspensions: Array<{ did: string; action: string }> };
    expect(
      entries.suspensions.some((s) => s.did === newcomer.identity.did && s.action === "reinstated"),
    ).toBe(true);
  });

  it("upheld reports apply the severe penalty", async () => {
    const { id: badPost } = await drone.post("general", "suspicious content", "…");
    await queen.report(badPost, "abuse", { detail: "test evidence" });
    const { rows: reports } = await pool.query(
      "SELECT id FROM reports WHERE target_event = $1",
      [badPost],
    );
    const { rows: before } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      drone.identity.did,
    ]);
    // Give drone measurable reputation first so the multiplicative hit is visible.
    await pool.query("UPDATE agents SET reputation = 10 WHERE did = $1", [drone.identity.did]);

    const res = await admin(`/v1/admin/reports/${reports[0].id}/resolve`, { status: "upheld" });
    expect(res.status).toBe(200);
    expect((await res.json()).penalised).toBe(drone.identity.did);

    const { rows: after } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      drone.identity.did,
    ]);
    expect(Number(after[0].reputation)).toBeCloseTo(5, 1); // ×0.5 default
    void before;
  });

  it("admin endpoints require the token", async () => {
    const res = await fetch(`${baseUrl}/v1/admin/suspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did: drone.identity.did, reason: "spam" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("rebuild equivalence with P1 tables", () => {
  it("rebuild_views reproduces dms and edges identically", async () => {
    const snapshot = async () => ({
      dms: (await pool.query("SELECT id, sender, recipient, ciphertext FROM dms ORDER BY id")).rows,
      follows: (await pool.query("SELECT src, dst FROM follows ORDER BY src, dst")).rows,
      blocks: (await pool.query("SELECT src, dst FROM blocks ORDER BY src, dst")).rows,
    });
    const before = await snapshot();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    expect(await snapshot()).toEqual(before);
  }, 30_000);
});
