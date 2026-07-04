/**
 * Session flow (spec §5.3/§11): signed challenge → bearer token bound to the DID,
 * 24 h expiry. Tokens are random 32 bytes; only the SHA-256 hash is stored.
 */

import { randomBytes, sha256, toB64u, utf8, fromB64u, verify, publicKeyFromDid } from "@waggle/core";
import type { FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { redis } from "../redis.js";
import { config } from "../config.js";
import { errors } from "./errors.js";

const CHALLENGE_TTL_SECS = 120;
export const SESSION_SIGNING_PREFIX = "waggle:session:v1:";

export async function issueChallenge(did: string): Promise<string> {
  const challenge = toB64u(await randomBytes(32));
  await redis.set(`sc:${did}`, challenge, "EX", CHALLENGE_TTL_SECS);
  return challenge;
}

export async function redeemChallenge(
  did: string,
  sigB64u: string,
): Promise<{ token: string; expiresAt: Date }> {
  const challenge = await redis.getdel(`sc:${did}`);
  if (!challenge) throw errors.badRequest("no active challenge for this DID");

  let pubkey: Uint8Array;
  try {
    pubkey = publicKeyFromDid(did);
  } catch {
    throw errors.badRequest("invalid DID");
  }

  let sig: Uint8Array;
  try {
    sig = fromB64u(sigB64u);
  } catch {
    throw errors.badSignature();
  }
  const message = utf8(SESSION_SIGNING_PREFIX + challenge);
  if (!(await verify(sig, message, pubkey))) throw errors.badSignature();

  const { rows } = await pool.query("SELECT status FROM agents WHERE did = $1", [did]);
  if (rows.length === 0) throw errors.unknownAgent();
  if (rows[0].status === "suspended") throw errors.agentSuspended();

  const token = toB64u(await randomBytes(32));
  const tokenHash = toB64u(await sha256(utf8(token)));
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await pool.query(
    "INSERT INTO sessions (token_hash, did, expires_at) VALUES ($1, $2, $3)",
    [tokenHash, did, expiresAt],
  );
  return { token, expiresAt };
}

/** Resolve a bearer token to a DID, or null. */
export async function resolveSession(req: FastifyRequest): Promise<string | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const tokenHash = toB64u(await sha256(utf8(token)));
  const { rows } = await pool.query(
    "SELECT did FROM sessions WHERE token_hash = $1 AND expires_at > now()",
    [tokenHash],
  );
  return rows.length > 0 ? (rows[0].did as string) : null;
}

export async function requireSession(req: FastifyRequest): Promise<string> {
  const did = await resolveSession(req);
  if (!did) throw errors.unauthorized();
  return did;
}
