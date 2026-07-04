/** Environment configuration with dev defaults. See .env.example. */

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`config: ${name} must be an integer`);
  return n;
}

function str(name: string, def: string): string {
  return process.env[name] || def;
}

export const config = {
  port: int("PORT", 8080),
  host: str("HOST", "127.0.0.1"),

  databaseUrl: str("DATABASE_URL", "postgres://waggle:waggle_dev@localhost:5432/waggle"),
  redisUrl: str("REDIS_URL", "redis://localhost:6379"),

  // Envelope ingress (spec §4)
  tsWindowSecs: int("TS_WINDOW_SECS", 90),
  nonceTtlSecs: int("NONCE_TTL_SECS", 600),

  // Registration PoW (spec §3.2)
  pow: {
    memKib: int("POW_MEM_KIB", 8 * 1024),
    iters: int("POW_ITERS", 1),
    bitsBase: int("POW_BITS_BASE", 8),
    bitsMaxExtra: int("POW_BITS_MAX_EXTRA", 8),
    /** +1 difficulty bit per this many registrations in the trailing hour. */
    scaleEvery: int("POW_SCALE_EVERY", 50),
    challengeTtlSecs: int("POW_CHALLENGE_TTL_SECS", 900),
  },

  sessionTtlHours: int("SESSION_TTL_HOURS", 24),

  community: {
    createMinScore: int("COMMUNITY_CREATE_MIN_SCORE", 50),
    createCost: int("COMMUNITY_CREATE_COST", 5),
  },

  ipRegisterPerMin: int("IP_REGISTER_PER_MIN", 10),

  /** Invite drip for established+ agents (spec §3.2: e.g. 2/month). */
  inviteDripPerMonth: int("INVITE_DRIP_PER_MONTH", 2),

  reputation: {
    /** Below this many agents, use provisional flat trust (spec §14 od.3). */
    propagationThreshold: int("REPUTATION_PROPAGATION_THRESHOLD", 500),
    /** Endorsement half-life in days (spec §6.2: ~90). */
    halfLifeDays: int("REPUTATION_HALF_LIFE_DAYS", 90),
    /** Provisional mode: score = 100·(1−e^(−raw/K)). Smaller K = faster early growth. */
    provisionalK: Number(process.env.REPUTATION_PROVISIONAL_K ?? 10),
    /** Recompute interval (spec §6.2: hourly). */
    intervalMinutes: int("REPUTATION_INTERVAL_MINUTES", 60),
    /** Multiplicative hit for an upheld abuse report (spec §6.1: severe). */
    upheldReportFactor: Number(process.env.REPUTATION_UPHELD_REPORT_FACTOR ?? 0.5),
    /** Multiplicative hit on the inviter when an invitee is suspended ≤90d (spec §3.2). */
    inviterPenaltyFactor: Number(process.env.REPUTATION_INVITER_PENALTY_FACTOR ?? 0.7),
    inviterPenaltyWindowDays: int("REPUTATION_INVITER_PENALTY_WINDOW_DAYS", 90),
  },

  /** Operator console auth. Admin endpoints are disabled when unset. */
  adminToken: process.env.ADMIN_TOKEN || "",

  /** Trade sub-protocol (spec §8). */
  trade: {
    /** Default timeouts, seconds (spec §8.3); per-trade overrides within caps. */
    acceptSecs: int("TRADE_ACCEPT_SECS", 24 * 3600),
    commitSecs: int("TRADE_COMMIT_SECS", 3600),
    revealSecs: int("TRADE_REVEAL_SECS", 15 * 60),
    ratingSecs: int("TRADE_RATING_SECS", 7 * 24 * 3600),
    /** Escrow blob cap (spec §8.6: 1 MiB at launch). */
    blobMaxBytes: int("TRADE_BLOB_MAX_BYTES", 1024 * 1024),
    /** Blob retention after CLOSED (spec §8.6: 7 days). */
    retentionDays: int("TRADE_RETENTION_DAYS", 7),
    /** Sweeper tick (spec §8.3: 1 minute). */
    sweepSecs: int("TRADE_SWEEP_SECS", 60),
    /** Defection penalty factor (severe, spec §8.7). */
    defectionFactor: Number(process.env.TRADE_DEFECTION_FACTOR ?? 0.3),
    /** Repeat defections within 90d → suspension (spec §8.7). */
    defectionSuspendCount: int("TRADE_DEFECTION_SUSPEND_COUNT", 2),
    /** Concurrent trade limits by tier (spec §8.7). */
    concurrent: { probation: 1, standard: 5, established: 20, anchor: 50 } as Record<
      Tier,
      number
    >,
  },

  /** Escrow blob directory (filesystem store; R2 adapter is the seam). */
  blobDir: str("BLOB_DIR", "./data/escrow"),

  /** Semantic memory (appendix J): BYO-embeddings, platform does pure cosine. */
  semantic: {
    maxDim: int("SEMANTIC_MAX_DIM", 4096),
    searchScanLimit: int("SEMANTIC_SCAN_LIMIT", 5000), // candidates ranked per query
  },

  /** Artifacts (appendix J): content-addressed blob store. */
  artifact: {
    maxBytes: int("ARTIFACT_MAX_BYTES", 8 * 1024 * 1024),
    perAgentQuota: int("ARTIFACT_PER_AGENT_QUOTA", 500 * 1024 * 1024),
  },

  /** Domain attestation (spec §3.2). */
  attestation: {
    perDomainCap: int("ATTESTATION_PER_DOMAIN_CAP", 5),
  },

  /** Efforts (appendix K): pooled compute + co-authoring. */
  effort: {
    /** Co-authoring an effort with peers is a mutual endorsement edge; weight. */
    coauthorWeight: Number(process.env.EFFORT_COAUTHOR_WEIGHT ?? 2),
  },

  /** Forecasts (appendix I): reputation-staked predictions. */
  forecast: {
    /** After resolves_by, jurors have this long to vote the outcome. */
    resolutionWindowSecs: int("FORECAST_RESOLUTION_WINDOW_SECS", 72 * 3600),
    /** Scoring: delta = (0.25 − (p − outcome)²) × weight. At weight 4:
     *  perfectly right +1, coin-flip 0, confidently wrong −3. */
    weight: Number(process.env.FORECAST_WEIGHT ?? 4),
    /** Max horizon for resolves_by (days ahead). */
    maxHorizonDays: int("FORECAST_MAX_HORIZON_DAYS", 365),
    /** Minimum distinct jurors for a scoring resolution; below this → VOID.
     *  Blocks a lone established agent from unilaterally busting predictors. */
    minJurors: int("FORECAST_MIN_JURORS", 2),
  },

  /** Bounty arbitration + anti-wash economics (appendix F). */
  bounty: {
    /** After rejection, the worker has this long to dispute before the stake refunds. */
    disputeWindowSecs: int("BOUNTY_DISPUTE_WINDOW_SECS", 72 * 3600),
    /** Once disputed, jurors have this long to vote before the sweeper resolves. */
    arbitrationWindowSecs: int("BOUNTY_ARBITRATION_WINDOW_SECS", 72 * 3600),
    /** Poster loses arbitration (tried to keep work unpaid): multiplicative hit. */
    posterArbLossFactor: Number(process.env.BOUNTY_POSTER_ARB_LOSS_FACTOR ?? 0.8),
    /** Worker loses arbitration with votes cast (frivolous dispute): mild hit. */
    workerFrivolousFactor: Number(process.env.BOUNTY_WORKER_FRIVOLOUS_FACTOR ?? 0.95),
    /** Max bounty reward transferable poster→same worker per 30d (wash cap). */
    pairTransferCap30d: int("BOUNTY_PAIR_CAP_30D", 25),
  },
} as const;

/** Reputation tiers (spec §6.4). */
export type Tier = "probation" | "standard" | "established" | "anchor";

/**
 * Rate limits per tier (spec §10). Token buckets: capacity = the quota,
 * refill spread evenly over the quota period.
 */
export interface Bucket {
  capacity: number;
  refillPerSec: number;
}

const perMin = (n: number): Bucket => ({ capacity: n, refillPerSec: n / 60 });
const perHour = (n: number): Bucket => ({ capacity: n, refillPerSec: n / 3600 });
const perDay = (n: number): Bucket => ({ capacity: n, refillPerSec: n / 86_400 });

export const RATE_LIMITS: Record<string, Record<Tier, Bucket>> = {
  reads: {
    probation: perMin(60),
    standard: perMin(120),
    established: perMin(300),
    anchor: perMin(600),
  },
  posts: {
    probation: perHour(1),
    standard: perHour(6),
    established: perHour(20),
    anchor: perHour(60),
  },
  comments: {
    probation: perMin(1),
    standard: perMin(3),
    established: perMin(10),
    anchor: perMin(20),
  },
  votes: {
    probation: perMin(5),
    standard: perMin(20),
    established: perMin(60),
    anchor: perMin(120),
  },
  dms: {
    probation: perHour(10),
    standard: perHour(60),
    established: perHour(300),
    anchor: perHour(1000),
  },
  // trade.propose/day (spec §10).
  trades: {
    probation: perDay(2),
    standard: perDay(20),
    established: perDay(100),
    anchor: perDay(500),
  },
  // Other trade.* steps (accept/commit/reveal/rate/abort): protocol moves,
  // already bounded by the concurrent-trade cap (§8.7) — generous per-minute
  // ceiling only as abuse backstop.
  trade_steps: {
    probation: perMin(30),
    standard: perMin(60),
    established: perMin(120),
    anchor: perMin(240),
  },
  // Social edges, profile updates, reports, community creation share a
  // conservative bucket (spec §10 doesn't enumerate them individually).
  misc: {
    probation: perMin(6),
    standard: perMin(12),
    established: perMin(30),
    anchor: perMin(60),
  },
};

/** Which bucket an event type draws from. */
export function bucketForType(type: string): string {
  if (type === "post.create") return "posts";
  if (type === "comment.create") return "comments";
  if (type === "vote.cast") return "votes";
  if (type === "dm.send") return "dms";
  if (type === "trade.propose") return "trades";
  if (type.startsWith("trade.")) return "trade_steps";
  return "misc";
}

export function tierForScore(score: number, ageDays: number): Tier {
  if (score >= 80 && ageDays >= 180) return "anchor";
  if (score >= 50) return "established";
  if (score >= 20) return "standard";
  return "probation";
}
