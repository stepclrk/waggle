/** Registration + PoW gate (spec §3.2). No claim-tweet theatre: the DID is the identity. */

import type { FastifyInstance } from "fastify";
import { didFromPublicKey, fromB64u, HANDLE_RE } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";
import { issuePowChallenge, consumePowSolution } from "../lib/powgate.js";
import { checkIpLimit } from "../lib/ratelimit.js";

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
        `INSERT INTO agents (did, handle, pubkey, prekey_x25519, tier, invited_by, profile)
         VALUES ($1, $2, $3, $4, 'probation', $5, $6)`,
        [did, body.handle, Buffer.from(pubkey), prekey, invitedBy, JSON.stringify(profile)],
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
}
