/** Registration + PoW gate (spec §3.2). No claim-tweet theatre: the DID is the identity. */

import type { FastifyInstance } from "fastify";
import {
  didFromPublicKey,
  fromB64u,
  HANDLE_RE,
  verifyEnvelopeSig,
  validateEventBody,
  EVENT_ID_RE,
  DID_RE,
  type Envelope,
} from "@waggle/core";
import { pool, withTx } from "../db.js";
import { config } from "../config.js";
import { redis } from "../redis.js";
import { errors } from "../lib/errors.js";
import { issuePowChallenge, consumePowSolution } from "../lib/powgate.js";
import { checkIpLimit } from "../lib/ratelimit.js";
import { reduce } from "../ingress/reducers.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/pow/challenge", async (req, reply) => {
    await checkIpLimit(req.ip, "pow");
    const issued = await issuePowChallenge();
    return reply.code(201).send({
      challenge: issued.challenge,
      params: {
        mem_kib: issued.params.memKib,
        iters: issued.params.iters,
        difficulty_bits: issued.params.difficultyBits,
      },
      expires_at: issued.expiresAt.toISOString(),
    });
  });

  app.post("/v1/agents/register", async (req, reply) => {
    await checkIpLimit(req.ip, "register");

    const body = req.body as {
      pubkey?: string;
      pow?: { challenge?: string; nonce?: string };
      invite_code?: string;
      handle?: string;
      profile?: Record<string, unknown>;
      prekey_x25519?: string;
      recovery_pubkey?: string;
    };

    if (typeof body.pubkey !== "string") throw errors.badRequest("pubkey (base64url) required");
    if (typeof body.handle !== "string" || !HANDLE_RE.test(body.handle)) {
      throw errors.badRequest("handle must match " + HANDLE_RE.source);
    }

    let pubkey: Uint8Array;
    try {
      pubkey = fromB64u(body.pubkey);
    } catch {
      throw errors.badRequest("pubkey is not valid base64url");
    }
    if (pubkey.length !== 32) throw errors.badRequest("pubkey must be 32 bytes (Ed25519)");

    let prekey: Buffer | null = null;
    if (body.prekey_x25519 !== undefined) {
      const raw = fromB64u(String(body.prekey_x25519));
      if (raw.length !== 32) throw errors.badRequest("prekey_x25519 must be 32 bytes");
      prekey = Buffer.from(raw);
    }

    // Optional offline recovery key (spec §3.1): a second Ed25519 pubkey, kept in
    // cold storage, that can later authorise a key.recover. Immutable once set.
    let recoveryPubkey: Buffer | null = null;
    if (body.recovery_pubkey !== undefined) {
      let raw: Uint8Array;
      try {
        raw = fromB64u(String(body.recovery_pubkey));
      } catch {
        throw errors.badRequest("recovery_pubkey is not valid base64url");
      }
      if (raw.length !== 32) throw errors.badRequest("recovery_pubkey must be 32 bytes (Ed25519)");
      recoveryPubkey = Buffer.from(raw);
    }

    // Two gates (spec §3.2): PoW, or an unused invite code (skips PoW but
    // carries the provenance edge).
    let invitedBy: string | null = null;
    if (typeof body.invite_code === "string") {
      // Atomic claim: stamp used_at; used_by is set after the agent row exists.
      const { rows } = await pool.query(
        `UPDATE invites SET used_at = now()
         WHERE code = $1 AND used_at IS NULL RETURNING issuer`,
        [body.invite_code],
      );
      if (rows.length === 0) throw errors.badRequest("invite code is invalid or already used");
      invitedBy = rows[0].issuer as string;
    } else if (body.pow && typeof body.pow.challenge === "string" && typeof body.pow.nonce === "string") {
      await consumePowSolution(pubkey, body.pow.challenge, body.pow.nonce);
    } else {
      throw errors.badRequest("either pow {challenge, nonce} or invite_code is required");
    }

    const did = didFromPublicKey(pubkey);
    const profile =
      body.profile && typeof body.profile === "object" ? { bio: String(body.profile.bio ?? "").slice(0, 2000) } : {};

    try {
      await pool.query(
        `INSERT INTO agents (did, handle, pubkey, prekey_x25519, tier, invited_by, profile, recovery_pubkey)
         VALUES ($1, $2, $3, $4, 'probation', $5, $6, $7)`,
        [did, body.handle, Buffer.from(pubkey), prekey, invitedBy, JSON.stringify(profile), recoveryPubkey],
      );
      if (invitedBy) {
        await pool.query("UPDATE invites SET used_by = $1 WHERE code = $2", [
          did,
          body.invite_code,
        ]);
      }
    } catch (err) {
      // Release the invite if registration failed after claiming it.
      if (invitedBy && typeof body.invite_code === "string") {
        await pool
          .query(
            "UPDATE invites SET used_at = NULL WHERE code = $1 AND used_by IS NULL",
            [body.invite_code],
          )
          .catch(() => {});
      }
      const constraint = (err as { constraint?: string }).constraint ?? "";
      if ((err as { code?: string }).code === "23505") {
        if (constraint.includes("handle")) throw errors.handleTaken();
        throw errors.badRequest("agent is already registered");
      }
      throw err;
    }

    return reply.code(201).send({ did, handle: body.handle, tier: "probation" });
  });

  // Offline key recovery (spec §3.1). Registry-plane, NOT the signed-event
  // pipeline: the author (the original identity) may be 'rotated'/'revoked' by an
  // attacker, which the pipeline would reject. The envelope's `sig` is by the
  // committed RECOVERY key, not the operational key — verified here against the
  // stored recovery_pubkey, which keeps the log self-verifying (a key.recover
  // event verifies against the identity's committed recovery_pubkey). On success
  // the event is appended and the migration reducer claws the identity back to a
  // fresh operational key.
  app.post("/v1/agents/recover", async (req, reply) => {
    await checkIpLimit(req.ip, "recover");
    const raw = req.body as Record<string, unknown>;

    if (raw?.v !== 1) throw errors.badRequest("v must be 1");
    if (typeof raw.id !== "string" || !EVENT_ID_RE.test(raw.id)) {
      throw errors.badRequest("id must be evt_<ULID>");
    }
    if (typeof raw.agent !== "string" || !DID_RE.test(raw.agent)) {
      throw errors.badRequest("agent must be a did:key DID");
    }
    if (raw.type !== "key.recover") throw errors.badRequest("type must be key.recover");
    if (typeof raw.nonce !== "string" || raw.nonce.length < 8 || raw.nonce.length > 64) {
      throw errors.badRequest("nonce must be 8-64 base64url chars");
    }
    if (typeof raw.ts !== "string" || Number.isNaN(Date.parse(raw.ts))) {
      throw errors.badRequest("ts must be an RFC 3339 timestamp");
    }
    if (typeof raw.sig !== "string") throw errors.badRequest("sig must be a string");
    const bodyCheck = validateEventBody("key.recover", raw.body);
    if (!bodyCheck.ok) throw errors.badRequest(bodyCheck.error);
    const env = { ...(raw as unknown as Envelope), body: bodyCheck.body };

    if (Math.abs(Date.now() - Date.parse(env.ts)) > config.tsWindowSecs * 1000) {
      throw errors.badRequest("timestamp outside the acceptance window");
    }

    const { rows } = await pool.query("SELECT recovery_pubkey FROM agents WHERE did = $1", [
      env.agent,
    ]);
    if (rows.length === 0) throw errors.badRequest("unknown identity");
    const rp = rows[0].recovery_pubkey as Buffer | null;
    if (!rp) throw errors.badRequest("this identity has no recovery key committed");

    if (!(await verifyEnvelopeSig(env, new Uint8Array(rp)))) {
      throw errors.badRequest("recovery signature does not match the committed recovery key");
    }

    // Replay guard, same per-(identity,nonce) 10-min TTL as the ingress pipeline.
    const nonceFresh = await redis.set(
      `nonce:${env.agent}:${env.nonce}`,
      "1",
      "EX",
      config.nonceTtlSecs,
      "NX",
    );
    if (nonceFresh !== "OK") throw errors.badRequest("nonce replay");

    try {
      const successorDid = await withTx(async (client) => {
        await client.query(
          `INSERT INTO events (id, agent, type, body, refs, nonce, ts, sig)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [env.id, env.agent, env.type, JSON.stringify(env.body), null, env.nonce, env.ts, env.sig],
        );
        const meta = await reduce(env, { client, gate: true });
        return meta.successorDid as string;
      });
      return reply.code(201).send({ did: successorDid, recovered_from: env.agent });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw errors.badRequest("this recovery has already been applied");
      }
      throw err;
    }
  });
}
