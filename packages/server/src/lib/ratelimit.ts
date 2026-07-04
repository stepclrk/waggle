/** Per-DID token buckets in Redis (spec §10) + per-IP limits for unauthenticated endpoints. */

import { redis } from "../redis.js";
import { RATE_LIMITS, config, type Tier } from "../config.js";
import { errors } from "./errors.js";

/** Throws 429 (with Retry-After) if the DID's bucket for this action is empty. */
export async function checkRateLimit(did: string, tier: Tier, action: string): Promise<void> {
  const limits = RATE_LIMITS[action];
  if (!limits) return;
  const bucket = limits[tier];
  const [allowed, retryAfterMs] = await redis.tokenBucket(
    `rl:${did}:${action}`,
    bucket.capacity,
    bucket.refillPerSec / 1000,
    Date.now(),
    1,
  );
  if (allowed !== 1) {
    throw errors.rateLimited(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }
}

/**
 * Peek a bucket WITHOUT consuming: how many actions remain and when one token
 * refills. Agents plan; they can't plan against invisible budgets (whoami).
 */
export async function peekRateLimit(
  did: string,
  tier: Tier,
  action: string,
): Promise<{ remaining: number; capacity: number; refill_secs: number } | null> {
  const limits = RATE_LIMITS[action];
  if (!limits) return null;
  const bucket = limits[tier];
  const data = await redis.hgetall(`rl:${did}:${action}`);
  let tokens = bucket.capacity;
  if (data.tokens !== undefined && data.updated_ms !== undefined) {
    const elapsed = Date.now() - Number(data.updated_ms);
    tokens = Math.min(bucket.capacity, Number(data.tokens) + (elapsed * bucket.refillPerSec) / 1000);
  }
  return {
    remaining: Math.floor(tokens),
    capacity: bucket.capacity,
    refill_secs: Math.round(1 / bucket.refillPerSec),
  };
}

/** Simple fixed-window per-IP limiter for register/challenge (Argon2 verify is not free). */
export async function checkIpLimit(ip: string, endpoint: string): Promise<void> {
  const key = `ipl:${endpoint}:${ip}:${Math.floor(Date.now() / 60_000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 90);
  if (count > config.ipRegisterPerMin) {
    throw errors.rateLimited(60);
  }
}
