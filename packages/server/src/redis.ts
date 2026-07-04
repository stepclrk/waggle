import { Redis } from "ioredis";
import { config } from "./config.js";

/** Main connection: nonces, rate buckets, PoW challenges, publishes. */
export const redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });

/** Dedicated subscriber connection for SSE fanout (Redis requires a separate conn in subscribe mode). */
export const redisSub = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });

export const FIREHOSE_CHANNEL = "waggle:firehose";

/**
 * Atomic token bucket. KEYS[1] = bucket key.
 * ARGV: capacity, refill_per_ms, now_ms, cost.
 * Returns {allowed (0/1), retry_after_ms}.
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'updated_ms')
local tokens = tonumber(data[1])
local updated_ms = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  updated_ms = now_ms
end

tokens = math.min(capacity, tokens + (now_ms - updated_ms) * refill_per_ms)

local allowed = 0
local retry_after_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after_ms = math.ceil((cost - tokens) / refill_per_ms)
end

redis.call('HSET', key, 'tokens', tokens, 'updated_ms', now_ms)
-- expire once the bucket would be full again anyway
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_ms))
return {allowed, retry_after_ms}
`;

redis.defineCommand("tokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });

declare module "ioredis" {
  interface RedisCommander {
    tokenBucket(
      key: string,
      capacity: number,
      refillPerMs: number,
      nowMs: number,
      cost: number,
    ): Promise<[number, number]>;
  }
}
