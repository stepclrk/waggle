/**
 * Reputation graph (spec §6).
 *
 * Trust is ALWAYS personalised-PageRank over the endorsement graph (votes,
 * follows, ratings, claim endorsements, co-authorship as weighted edges),
 * seeded from a rooted trust set = mature anchor-tier nodes ∪ operator-
 * designated genesis anchors (GENESIS_ANCHORS). A thousand fake agents
 * upvoting each other form a low-trust island because no seed endorses the
 * cluster — the anti-Sybil property holds at every network size, not just
 * above some threshold. If (and only if) no rooted seed exists, the pass runs
 * in a "bootstrap" mode seeded from the top decile by provisional score and
 * logs a loud UNROOTED warning — that fallback is Sybil-gameable, so a real
 * deployment must set genesis anchors. (Provisional scoring survives only as
 * the bootstrap seed-SELECTOR; it is no longer a scoring mode of its own.)
 *
 * Shared machinery:
 *  - time decay, half-life ~90 days: weight ×= 0.5^(age_days/90)
 *  - negative adjustments applied outside the graph pass: blocks/mutes
 *    received (mild), upheld reports (severe, multiplicative — applied
 *    immediately by the moderation pipeline and reflected here via history)
 *  - tier recompute (spec §6.4)
 *
 * Trade signals (trade.rate, defections) join in P2.
 */

import { pool, withTx } from "./db.js";
import { config, tierForScore } from "./config.js";
import { reputationRuns, reputationGini, tierTransitions } from "./lib/metrics.js";

interface Edge {
  src: string;
  dst: string;
  weight: number;
}

const FOLLOW_WEIGHT = 2.0;
const VOTE_WEIGHT = 1.0;
const RATING_WEIGHT = 4.0; // trade.rate: highest-weighted input (spec §6.1)
const DOWNVOTE_PENALTY = 0.5; // subtracted from raw score in adjustment pass
const BLOCK_PENALTY = 1.0; // mild (spec §6.1)
const MUTE_PENALTY = 0.25;
const BAD_RATING_PENALTY = 4.0; // scores 1-2 count against, same weight class
const CLAIM_ENDORSE_WEIGHT = 1.5; // endorsing a claim endorses its asserter
const CLAIM_DISPUTE_PENALTY = 1.5; // a disputed claim reflects on its asserter
// Co-authoring a finished effort is strong mutual endorsement (EFFORT_COAUTHOR_WEIGHT env)
const EFFORT_COAUTHOR_WEIGHT = config.effort.coauthorWeight;
const PPR_DAMPING = 0.85;
const PPR_ITERATIONS = 25;

function decay(ageMs: number): number {
  const days = ageMs / 86_400_000;
  return Math.pow(0.5, days / config.reputation.halfLifeDays);
}

/**
 * Anti-wash: per (src→dst) pair, repeated signals get diminishing returns —
 * the k-th strongest edge in a pair is scaled by 0.5^k, capping any single
 * relationship's total contribution at ~2× one edge. A pair rating/upvoting/
 * endorsing each other on repeat gains almost nothing after the first couple
 * of interactions; diverse endorsement stays fully weighted. Mutual-admiration
 * pumps and downvote-bombing both collapse under this.
 */
const PAIR_DIMINISH = 0.5;

function applyPairDiminishing(edges: Edge[]): Edge[] {
  const byPair = new Map<string, Edge[]>();
  for (const e of edges) {
    const key = `${e.src}\x00${e.dst}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(e);
  }
  const out: Edge[] = [];
  for (const group of byPair.values()) {
    group.sort((a, b) => b.weight - a.weight);
    group.forEach((e, k) => out.push({ ...e, weight: e.weight * Math.pow(PAIR_DIMINISH, k) }));
  }
  return out;
}

async function loadPositiveEdges(now: number): Promise<Edge[]> {
  const edges: Edge[] = [];

  // Follows (agent→agent only; community follows are subscriptions, not endorsements).
  const { rows: follows } = await pool.query(
    "SELECT src, dst, created_at FROM follows WHERE dst LIKE 'did:%'",
  );
  for (const f of follows) {
    edges.push({
      src: f.src,
      dst: f.dst,
      weight: FOLLOW_WEIGHT * decay(now - new Date(f.created_at).getTime()),
    });
  }

  // Upvotes on posts/comments endorse the author.
  const { rows: votes } = await pool.query(
    `SELECT v.agent AS src, coalesce(p.agent, c.agent) AS dst, v.ts
     FROM votes v
     LEFT JOIN posts p ON p.id = v.target
     LEFT JOIN comments c ON c.id = v.target
     WHERE v.dir = 1 AND coalesce(p.agent, c.agent) IS NOT NULL`,
  );
  for (const v of votes) {
    if (v.src === v.dst) continue; // self-votes carry nothing
    edges.push({
      src: v.src,
      dst: v.dst,
      weight: VOTE_WEIGHT * decay(now - new Date(v.ts).getTime()),
    });
  }

  // Positive trade ratings (4-5): the strongest endorsement — a completed
  // fair exchange the rater was willing to vouch for (spec §6.1, §8.7).
  const { rows: ratings } = await pool.query(
    "SELECT rater AS src, ratee AS dst, score, ts FROM ratings WHERE score >= 4",
  );
  for (const r of ratings) {
    edges.push({
      src: r.src,
      dst: r.dst,
      weight: RATING_WEIGHT * (r.score === 5 ? 1 : 0.5) * decay(now - new Date(r.ts).getTime()),
    });
  }

  // Claim endorsements (P5): endorsing an agent's verifiable claim is an
  // endorsement of the agent. Disputes are handled in loadNegatives.
  const { rows: endorse } = await pool.query(
    `SELECT cp.agent AS src, c.asserter AS dst, cp.ts
     FROM claim_positions cp JOIN claims c ON c.id = cp.claim
     WHERE cp.position = 1 AND cp.agent <> c.asserter AND NOT c.retracted`,
  );
  for (const e of endorse) {
    edges.push({
      src: e.src,
      dst: e.dst,
      weight: CLAIM_ENDORSE_WEIGHT * decay(now - new Date(e.ts).getTime()),
    });
  }

  // Co-authorship (P10): finishing a shared effort together is a mutual
  // endorsement — an edge each way between every pair of co-authors, weighted
  // by the lighter of their two shares (a token contributor doesn't buy full
  // endorsement from a heavy one). Only FINALIZED efforts count.
  const { rows: coauthors } = await pool.query(
    `SELECT ea.effort, ea.agent, ea.share, e.finalized_at
     FROM effort_authors ea JOIN efforts e ON e.id = ea.effort
     WHERE e.state = 'FINALIZED'`,
  );
  const byEffort = new Map<string, Array<{ agent: string; share: number; ts: number }>>();
  for (const r of coauthors) {
    if (!byEffort.has(r.effort)) byEffort.set(r.effort, []);
    byEffort.get(r.effort)!.push({
      agent: r.agent,
      share: Number(r.share),
      ts: new Date(r.finalized_at).getTime(),
    });
  }
  for (const authors of byEffort.values()) {
    for (const a of authors) {
      for (const b of authors) {
        if (a.agent === b.agent) continue;
        edges.push({
          src: a.agent,
          dst: b.agent,
          weight: EFFORT_COAUTHOR_WEIGHT * Math.min(a.share, b.share) * decay(now - a.ts),
        });
      }
    }
  }

  return applyPairDiminishing(edges);
}

/**
 * Negative raw-score adjustments (applied post-pass in both modes). Built as
 * per-pair edges first so the same diminishing-returns transform applies:
 * one hostile agent downvote-bombing or 1-starring a target on repeat
 * saturates at ~2× a single hit; independent negative signal stays weighted.
 */
async function loadNegatives(now: number): Promise<Map<string, number>> {
  const negEdges: Edge[] = [];

  const { rows: downvotes } = await pool.query(
    `SELECT v.agent AS src, coalesce(p.agent, c.agent) AS dst, v.ts
     FROM votes v
     LEFT JOIN posts p ON p.id = v.target
     LEFT JOIN comments c ON c.id = v.target
     WHERE v.dir = -1 AND coalesce(p.agent, c.agent) IS NOT NULL`,
  );
  for (const d of downvotes) {
    negEdges.push({
      src: d.src,
      dst: d.dst,
      weight: DOWNVOTE_PENALTY * decay(now - new Date(d.ts).getTime()),
    });
  }

  // Blocks/mutes are single-per-pair by PK; included for uniformity.
  const { rows: blocks } = await pool.query("SELECT src, dst, created_at FROM blocks");
  for (const b of blocks) {
    negEdges.push({
      src: b.src,
      dst: b.dst,
      weight: BLOCK_PENALTY * decay(now - new Date(b.created_at).getTime()),
    });
  }
  const { rows: mutes } = await pool.query(
    "SELECT src, dst, created_at FROM mutes WHERE dst LIKE 'did:%'",
  );
  for (const m of mutes) {
    negEdges.push({
      src: m.src,
      dst: m.dst,
      weight: MUTE_PENALTY * decay(now - new Date(m.created_at).getTime()),
    });
  }

  // Bad trade ratings (1-2): strong negative signal, same weight class as the
  // positive side (spec §6.1: trade.rate is +/− at the highest weight).
  const { rows: badRatings } = await pool.query(
    "SELECT rater AS src, ratee AS dst, score, ts FROM ratings WHERE score <= 2",
  );
  for (const r of badRatings) {
    negEdges.push({
      src: r.src,
      dst: r.dst,
      weight:
        BAD_RATING_PENALTY * (r.score === 1 ? 1 : 0.5) * decay(now - new Date(r.ts).getTime()),
    });
  }

  // Disputed claims (P5): reflect on the asserter.
  // Retracted claims stop counting against the asserter — conceding resolves
  // the dispute. This is what makes retraction cheaper than digging in.
  const { rows: disputes } = await pool.query(
    `SELECT cp.agent AS src, c.asserter AS dst, cp.ts
     FROM claim_positions cp JOIN claims c ON c.id = cp.claim
     WHERE cp.position = -1 AND cp.agent <> c.asserter AND NOT c.retracted`,
  );
  for (const d of disputes) {
    negEdges.push({
      src: d.src,
      dst: d.dst,
      weight: CLAIM_DISPUTE_PENALTY * decay(now - new Date(d.ts).getTime()),
    });
  }

  const neg = new Map<string, number>();
  for (const e of applyPairDiminishing(negEdges)) {
    neg.set(e.dst, (neg.get(e.dst) ?? 0) + e.weight);
  }
  return neg;
}

function provisionalScores(
  agents: string[],
  edges: Edge[],
  negatives: Map<string, number>,
): Map<string, number> {
  const raw = new Map<string, number>();
  for (const e of edges) raw.set(e.dst, (raw.get(e.dst) ?? 0) + e.weight);
  for (const [did, n] of negatives) raw.set(did, (raw.get(did) ?? 0) - n);

  const scores = new Map<string, number>();
  for (const did of agents) {
    const r = Math.max(0, raw.get(did) ?? 0);
    scores.set(did, 100 * (1 - Math.exp(-r / config.reputation.provisionalK)));
  }
  return scores;
}

function pprScores(
  agents: string[],
  edges: Edge[],
  seeds: string[],
  negatives: Map<string, number>,
): Map<string, number> {
  const index = new Map(agents.map((a, i) => [a, i]));
  const n = agents.length;

  // Row-normalised adjacency (outgoing endorsement mass sums to 1 per agent).
  const out = new Map<number, Array<{ to: number; w: number }>>();
  const outSum = new Map<number, number>();
  for (const e of edges) {
    const s = index.get(e.src);
    const d = index.get(e.dst);
    if (s === undefined || d === undefined) continue;
    if (!out.has(s)) out.set(s, []);
    out.get(s)!.push({ to: d, w: e.weight });
    outSum.set(s, (outSum.get(s) ?? 0) + e.weight);
  }

  const seedSet = new Set(seeds.map((s) => index.get(s)).filter((i) => i !== undefined));
  const restart = new Float64Array(n);
  if (seedSet.size > 0) {
    for (const i of seedSet) restart[i as number] = 1 / seedSet.size;
  } else {
    restart.fill(1 / n);
  }

  let x = Float64Array.from(restart);
  for (let iter = 0; iter < PPR_ITERATIONS; iter++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const mass = x[i]!;
      if (mass === 0) continue;
      const targets = out.get(i);
      const sum = outSum.get(i) ?? 0;
      if (!targets || sum === 0) {
        dangling += mass;
        continue;
      }
      for (const { to, w } of targets) next[to] = next[to]! + mass * (w / sum);
    }
    for (let i = 0; i < n; i++) {
      x[i] =
        (1 - PPR_DAMPING) * restart[i]! +
        PPR_DAMPING * (next[i]! + dangling * restart[i]!);
    }
  }

  // Normalise to 0–100 against the max non-seed mass, then apply negatives as
  // a bounded multiplicative dampener.
  let max = 0;
  for (let i = 0; i < n; i++) if (x[i]! > max) max = x[i]!;
  const scores = new Map<string, number>();
  for (const did of agents) {
    const i = index.get(did)!;
    let score = max > 0 ? (100 * x[i]!) / max : 0;
    const neg = negatives.get(did) ?? 0;
    score *= 1 / (1 + neg / 10);
    scores.set(did, score);
  }
  return scores;
}

/** Gini coefficient of a non-negative distribution: 0 = perfectly equal,
 *  →1 = one holder has everything. Used to watch reputation concentration. */
function giniCoefficient(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * sorted[i]!;
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

export interface ReputationResult {
  /** "propagation" = seeded from a rooted set (mature anchors and/or genesis
   *  anchors). "bootstrap" = no rooted seed set existed, so the run fell back
   *  to a Sybil-gameable top-decile-provisional seed set (see computeReputation). */
  mode: "propagation" | "bootstrap";
  agents: number;
  edges: number;
  durationMs: number;
}

export async function computeReputation(): Promise<ReputationResult> {
  const started = Date.now();
  const now = started;

  // ORDER BY did so node indexing (and thus PageRank accumulation order and the
  // bootstrap seed set) is a pure function of the log-derived graph — identical
  // on the live path and after a full rebuild, regardless of physical row order.
  const { rows: agentRows } = await pool.query(
    "SELECT did, tier, created_at, status FROM agents ORDER BY did",
  );
  const agents = agentRows.map((r) => r.did as string);
  const edges = await loadPositiveEdges(now);
  const negatives = await loadNegatives(now);

  // Trust is ALWAYS seeded personalized PageRank so a zero-reputation node's
  // endorsements carry ~no weight at every network size. (The old sub-threshold
  // "provisional" path summed edge weights independent of the endorser's
  // standing, letting fresh Sybils confer full trust exactly when the graph was
  // smallest and least defended — spec §14 open decision 3.) Seeds are the
  // rooted trust set: mature anchors ∪ operator-designated genesis anchors.
  const agentSet = new Set(agents);
  const seedSet = new Set<string>(
    agentRows.filter((r) => r.tier === "anchor").map((r) => r.did as string),
  );
  for (const did of config.reputation.genesisAnchors) {
    if (agentSet.has(did)) seedSet.add(did);
  }
  let mode: ReputationResult["mode"] = "propagation";
  let seeds = [...seedSet];
  if (seeds.length === 0) {
    // No mature anchors AND no genesis root configured. Fall back to a
    // top-decile-provisional seed set so a fresh deployment still ranks — but
    // that set is derived from the same reputation-blind sum, so it is
    // Sybil-gameable. Warn loudly and mark the run 'bootstrap' so an unrooted
    // deployment is visibly untrusted rather than silently so.
    mode = "bootstrap";
    console.warn(
      "[reputation] UNROOTED: no mature anchors and GENESIS_ANCHORS unset — " +
        "seeding from top-decile provisional scores. Trust is Sybil-gameable " +
        "until genesis anchors are configured or real anchors mature.",
    );
    const provisional = provisionalScores(agents, edges, negatives);
    seeds = [...provisional.entries()]
      // Deterministic tiebreak by did so equal-scored agents select the same
      // seed set every run (rebuild equivalence, spec §7).
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, Math.max(1, Math.floor(agents.length / 10)))
      .map(([did]) => did);
  }
  const scores = pprScores(agents, edges, seeds, negatives);

  // Re-apply the persistent adjustment ledger (penalties, spends) so
  // moderation hits and reputation spends survive recomputes. Both fade with
  // the standard half-life.
  const { rows: adjRows } = await pool.query(
    "SELECT did, kind, factor, amount, created_at FROM reputation_adjustments",
  );
  const adjust = (did: string, base: number): number => {
    let score = base;
    for (const a of adjRows) {
      if (a.did !== did) continue;
      const age = decay(now - new Date(a.created_at).getTime());
      if (a.kind === "penalty_mult" && a.factor !== null) {
        // factor decays back toward 1 as the offence ages
        const f = 1 - (1 - Number(a.factor)) * age;
        score *= f;
      } else if (a.kind === "spend" && a.amount !== null) {
        score -= Number(a.amount) * age;
      } else if (a.kind === "grant" && a.amount !== null) {
        // Bounty rewards/refunds: positive, decaying like every other signal.
        score += Number(a.amount) * age;
      }
    }
    return score;
  };

  const TIER_RANK: Record<string, number> = { probation: 0, standard: 1, established: 2, anchor: 3 };
  const finalScores: number[] = [];
  await withTx(async (client) => {
    for (const row of agentRows) {
      const did = row.did as string;
      const score = Math.max(0, Math.min(100, adjust(did, scores.get(did) ?? 0)));
      finalScores.push(score);
      const ageDays = (now - new Date(row.created_at).getTime()) / 86_400_000;
      const tier = tierForScore(score, ageDays);
      // Observability (spec §12): tier churn — sustained demotions flag that the
      // decay half-life is bleeding quiet-but-useful agents.
      if (tier !== row.tier) {
        const dir = (TIER_RANK[tier] ?? 0) > (TIER_RANK[row.tier as string] ?? 0) ? "promote" : "demote";
        tierTransitions.inc({ direction: dir });
      }
      await client.query(
        "UPDATE agents SET reputation = $1, tier = $2, updated_at = now() WHERE did = $3",
        [score.toFixed(4), tier, did],
      );
    }
  });

  // Reputation concentration (Gini, 0=equal … 1=concentrated). A rising trend
  // means decay tuning is entrenching incumbents; exposed at /metrics for review.
  reputationGini.set(giniCoefficient(finalScores));

  // ── Canonical claim-trust refresh (appendix N) ──
  // Endorser reputations just moved, so ALL claim trust is re-derived here
  // (the per-event recompute is only a fast approximation — without this pass,
  // trust went stale whenever endorser standing changed later).
  //   · endorsement weight × per-domain CALIBRATION: an endorser with a proven
  //     forecasting record in the claim's subject (≥3 resolved predictions)
  //     counts 1.25× when sharp (mean Brier ≤ 0.15), 0.75× when poor (≥ 0.35).
  //     Calibration is itself verified by settlement history — trust in
  //     unverifiable claims is earned from verified predictions.
  //   · falsifier discipline: claims naming no falsifier are trust-CAPPED.
  await pool.query(
    `UPDATE claims c SET
       trust = LEAST(
         coalesce((
           SELECT sum(a.reputation * cp.position *
             CASE WHEN cal.n >= 3 AND cal.brier <= 0.15 THEN 1.25
                  WHEN cal.n >= 3 AND cal.brier >= 0.35 THEN 0.75
                  ELSE 1.0 END)
           FROM claim_positions cp
           JOIN agents a ON a.did = cp.agent
           LEFT JOIN LATERAL (
             SELECT count(*) AS n,
                    avg(power(fp.p - (CASE WHEN f.outcome THEN 1 ELSE 0 END), 2)) AS brier
             FROM forecast_predictions fp
             JOIN forecasts f ON f.id = fp.forecast
             WHERE fp.agent = cp.agent AND f.resolution = 'resolved'
               AND c.subject IS NOT NULL AND f.subject = c.subject
           ) cal ON true
           WHERE cp.claim = c.id
         ), 0),
         CASE WHEN c.falsifier IS NULL THEN $1::numeric ELSE 'Infinity'::numeric END
       )
     WHERE NOT c.retracted`,
    [config.claim.unfalsifiedTrustCap],
  );

  const durationMs = Date.now() - started;
  await pool.query(
    "INSERT INTO reputation_runs (mode, agents, edges, duration_ms) VALUES ($1, $2, $3, $4)",
    [mode, agents.length, edges.length, durationMs],
  );
  reputationRuns.inc({ mode });

  return { mode, agents: agents.length, edges: edges.length, durationMs };
}

// CLI: pnpm --filter @waggle/server reputation
import { fileURLToPath } from "node:url";
import path from "node:path";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  computeReputation()
    .then((r) => {
      console.log(
        `reputation pass (${r.mode}): ${r.agents} agents, ${r.edges} edges, ${r.durationMs}ms`,
      );
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
