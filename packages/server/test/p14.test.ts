/**
 * P14 integration: offline key recovery (spec §3.1).
 * Live Postgres + Redis (docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";
import { toB64u } from "@waggle/core";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

const agentRow = async (did: string) =>
  (await pool.query("SELECT status, reputation, successor_did, recovery_pubkey FROM agents WHERE did = $1", [did]))
    .rows[0];

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
  await redis.flushdb();
  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

/** Register a fresh agent that has committed an offline recovery key. Returns
 *  the client, its recovery keypair, and gives it some reputation to track. */
async function registerWithRecovery(handle: string, reputation = 40) {
  const recoveryKey = await WaggleIdentity.generate(false); // keypair-only recovery key
  const client = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await client.register(handle, undefined, undefined, recoveryKey.publicKey);
  await pool.query("UPDATE agents SET tier = 'established', reputation = $1 WHERE did = $2", [
    reputation,
    client.identity.did,
  ]);
  return { client, recoveryKey };
}

describe("offline key recovery (spec §3.1)", () => {
  it("recovers a lost key: reputation moves to the new DID, old is revoked", async () => {
    const { client, recoveryKey } = await registerWithRecovery("victim-a", 42);
    const oldIdentity = client.identity;
    const oldDid = oldIdentity.did;

    const newId = await WaggleIdentity.generate();
    const res = await client.recover(oldDid, recoveryKey.privateKey, newId);

    expect(res.did).toBe(newId.did);
    expect(res.recovered_from).toBe(oldDid);

    const oldRow = await agentRow(oldDid);
    const newRow = await agentRow(newId.did);
    expect(oldRow.status).toBe("revoked");
    expect(oldRow.successor_did).toBe(newId.did);
    expect(newRow.status).toBe("active");
    expect(Number(newRow.reputation)).toBe(42); // reputation preserved
    // Recovery key carried onto the recovered identity so it can recover again.
    expect(newRow.recovery_pubkey).not.toBeNull();

    // The recovered (new) key can write (proves the new identity is active).
    const { id } = await client.post("general", "back in control", "recovered");
    expect(id).toBeTruthy();

    // The old (revoked) key can no longer write — the ingress pipeline denies it.
    const oldClient = new WaggleClient(baseUrl, oldIdentity);
    await expect(oldClient.post("general", "still here?", "nope")).rejects.toMatchObject({
      status: 403,
    });
  }, 60_000);

  it("rejects a key.recover submitted through the normal /v1/events pipeline", async () => {
    // A key.recover signed by the OPERATIONAL key must not be accepted on the
    // event path — recovery is authorised only by the offline recovery key via
    // POST /v1/agents/recover. Otherwise the "verifies against recovery_pubkey"
    // invariant breaks and the log stops being cleanly self-verifying.
    const { client } = await registerWithRecovery("victim-pipeline");
    const usurper = await WaggleIdentity.generate();
    await expect(
      client.send("key.recover", { new_pubkey: toB64u(usurper.publicKey) }),
    ).rejects.toMatchObject({ status: 403 });
  }, 60_000);

  it("claws the identity back after an attacker rotated the stolen key away", async () => {
    const { client, recoveryKey } = await registerWithRecovery("victim-b", 55);
    const originalDid = client.identity.did;

    // Attacker holds the operational key and rotates the victim to their own DID,
    // moving reputation to the attacker-controlled successor.
    const attackerId = await client.rotateKey(); // returns the new (attacker) identity
    const afterRotate = await agentRow(attackerId.did);
    expect(afterRotate.status).toBe("active");
    expect(Number(afterRotate.reputation)).toBe(55);
    expect((await agentRow(originalDid)).status).toBe("rotated");

    // Victim, holding the OFFLINE recovery key, recovers from the ORIGINAL did.
    const rescueId = await WaggleIdentity.generate();
    const rescueClient = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    const res = await rescueClient.recover(originalDid, recoveryKey.privateKey, rescueId);
    expect(res.did).toBe(rescueId.did);

    // Reputation clawed back from the attacker's head DID; attacker is revoked.
    expect(Number((await agentRow(rescueId.did)).reputation)).toBe(55);
    expect((await agentRow(rescueId.did)).status).toBe("active");
    expect((await agentRow(attackerId.did)).status).toBe("revoked");
    expect((await agentRow(attackerId.did)).successor_did).toBe(rescueId.did);
  }, 60_000);

  it("rejects recovery with the wrong key, with no committed key, and on replay", async () => {
    const { client, recoveryKey } = await registerWithRecovery("victim-c");
    const targetDid = client.identity.did;

    // Wrong recovery key → rejected.
    const wrongKey = await WaggleIdentity.generate(false);
    const badClient = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await expect(
      badClient.recover(targetDid, wrongKey.privateKey, await WaggleIdentity.generate()),
    ).rejects.toMatchObject({ status: 400 });

    // Identity that committed no recovery key → rejected.
    const noRecovery = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await noRecovery.register("no-recovery-c");
    await expect(
      badClient.recover(noRecovery.identity.did, recoveryKey.privateKey, await WaggleIdentity.generate()),
    ).rejects.toMatchObject({ status: 400 });

    // Recover once (succeeds), then attempt to recover again to the SAME (now
    // already-registered) DID → rejected by the duplicate-target guard.
    const rescueId = await WaggleIdentity.generate();
    await client.recover(targetDid, recoveryKey.privateKey, rescueId);
    await expect(
      client.recover(targetDid, recoveryKey.privateKey, rescueId),
    ).rejects.toMatchObject({ status: 400 });
  }, 60_000);

  it("keeps recovery available after a legitimate rotation (commitment carried forward)", async () => {
    const { client, recoveryKey } = await registerWithRecovery("victim-d", 33);
    const originalDid = client.identity.did;

    // Legitimate rotation by the owner.
    const rotatedId = await client.rotateKey();
    expect((await agentRow(rotatedId.did)).recovery_pubkey).not.toBeNull();

    // Later the rotated key is lost; recover from the ORIGINAL did still works.
    const rescueId = await WaggleIdentity.generate();
    const res = await client.recover(originalDid, recoveryKey.privateKey, rescueId);
    expect(res.did).toBe(rescueId.did);
    expect(Number((await agentRow(rescueId.did)).reputation)).toBe(33);
    expect((await agentRow(rotatedId.did)).status).toBe("revoked");
  }, 60_000);

  it("rebuild reproduces recovered identity state (spec §7)", async () => {
    const snap = async () =>
      (
        await pool.query(
          "SELECT did, status, successor_did, predecessor_did FROM agents WHERE handle LIKE 'victim-%' OR handle LIKE 'rec:%' ORDER BY did",
        )
      ).rows;
    const before = await snap();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    // Registration + recovery mutate the agents table on the live path only
    // (agents is not truncated by rebuild), so the recovered state persists and
    // must be byte-identical after replay.
    expect(await snap()).toEqual(before);
  }, 60_000);
});
