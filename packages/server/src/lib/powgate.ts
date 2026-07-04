/**
 * Registration PoW gate (spec §3.2): server-issued Argon2id challenges, bound to
 * the candidate public key at solve time. Difficulty auto-scales with
 * registration velocity: +1 bit per `scaleEvery` registrations in the trailing
 * hour, capped at bitsMaxExtra.
 */

import { randomBytes, toB64u, verifyPow, type PowParams } from "@waggle/core";
import { redis } from "../redis.js";
import { config } from "../config.js";
import { errors } from "./errors.js";

const REG_VELOCITY_KEY = "pow:reg_velocity";

async function currentDifficultyBits(): Promise<number> {
  const count = Number((await redis.get(REG_VELOCITY_KEY)) ?? 0);
  const extra = Math.min(config.pow.bitsMaxExtra, Math.floor(count / config.pow.scaleEvery));
  return config.pow.bitsBase + extra;
}

export interface IssuedChallenge {
  challenge: string;
  params: PowParams;
  expiresAt: Date;
}

export async function issuePowChallenge(): Promise<IssuedChallenge> {
  // crypto_pwhash salt is 16 bytes; the challenge doubles as the salt.
  const challenge = toB64u(await randomBytes(16));
  const params: PowParams = {
    memKib: config.pow.memKib,
    iters: config.pow.iters,
    difficultyBits: await currentDifficultyBits(),
  };
  await redis.set(`pow:${challenge}`, JSON.stringify(params), "EX", config.pow.challengeTtlSecs);
  return {
    challenge,
    params,
    expiresAt: new Date(Date.now() + config.pow.challengeTtlSecs * 1000),
  };
}

/**
 * Verify and consume a PoW solution. The challenge is burned on first use
 * (GETDEL) regardless of outcome, so a failed solve requires a fresh challenge —
 * this prevents brute-force retries against one challenge.
 */
export async function consumePowSolution(
  pubkey: Uint8Array,
  challenge: string,
  nonce: string,
): Promise<void> {
  const raw = await redis.getdel(`pow:${challenge}`);
  if (!raw) throw errors.powInvalid("unknown or expired challenge");
  const params = JSON.parse(raw) as PowParams;
  if (!(await verifyPow(pubkey, challenge, nonce, params))) {
    throw errors.powInvalid("solution does not meet the difficulty target");
  }
  // Count this successful registration toward velocity-based difficulty scaling.
  const count = await redis.incr(REG_VELOCITY_KEY);
  if (count === 1) await redis.expire(REG_VELOCITY_KEY, 3600);
}
