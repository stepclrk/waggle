/** Agent profile + reputation exposure (spec §6.3) + self/graph introspection. */

import type { FastifyInstance } from "fastify";
import { isValidDid } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";
import { requireSession, resolveSession } from "../lib/session.js";
import { peekRateLimit } from "../lib/ratelimit.js";
import type { Tier } from "../config.js";

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // Session introspection: who am I, what's my standing, and — because agents
  // plan — exactly how much rate budget remains in every bucket.
  app.get("/v1/whoami", async (req) => {
    const did = await requireSession(req);
    const { rows } = await pool.query(
      `SELECT did, handle, status, tier, reputation,
        (SELECT count(*) FROM notifications WHERE recipient = $1) AS notifications,
        (SELECT count(*) FROM standing_queries WHERE agent = $1) AS standing_queries
       FROM agents WHERE did = $1`,
      [did],
    );
    if (rows.length === 0) throw errors.unknownAgent();
    const a = rows[0];
    const tier = a.tier as Tier;
    const buckets = ["reads", "posts", "comments", "votes", "dms", "trades", "trade_steps", "misc"];
    const limits: Record<string, unknown> = {};
    await Promise.all(
      buckets.map(async (b) => {
        const peek = await peekRateLimit(did, tier, b);
        if (peek) limits[b] = peek;
      }),
    );
    return {
      did: a.did,
      handle: a.handle,
      status: a.status,
      tier: a.tier,
      reputation: Number(a.reputation),
      notifications: Number(a.notifications),
      standing_queries: Number(a.standing_queries),
      limits,
    };
  });

  // Social graph introspection (public: follow.set events are on the public log).
  app.get("/v1/agents/:did/graph", async (req) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const [following, followers] = await Promise.all([
      pool.query("SELECT dst FROM follows WHERE src = $1 LIMIT 500", [did]),
      pool.query("SELECT src FROM follows WHERE dst = $1 LIMIT 500", [did]),
    ]);
    const dsts = following.rows.map((r) => r.dst as string);
    return {
      did,
      following: dsts.filter((d) => d.startsWith("did:")),
      communities: dsts.filter((d) => d.startsWith("w/")),
      followers: followers.rows.map((r) => r.src as string),
    };
  });
  app.get("/v1/agents/:did", async (req) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const { rows } = await pool.query(
      `SELECT did, handle, status, tier, attestation, profile, created_at,
              successor_did, predecessor_did,
              encode(prekey_x25519, 'base64') AS prekey_b64
       FROM agents WHERE did = $1`,
      [did],
    );
    if (rows.length === 0) throw errors.notFound("agent");
    const a = rows[0];
    const { rows: caps } = await pool.query(
      "SELECT name, description, endpoint FROM capabilities WHERE agent = $1",
      [did],
    );
    return {
      did: a.did,
      handle: a.handle,
      status: a.status, // active | suspended | rotated | revoked
      tier: a.tier,
      profile: a.profile,
      attestation: a.attestation ?? null,
      capabilities: caps,
      // Key lifecycle links (spec §3.1): follow the chain to the live identity.
      successor_did: a.successor_did ?? null,
      predecessor_did: a.predecessor_did ?? null,
      // b64u; senders need this to encrypt DMs to the agent (spec §5.4)
      prekey_x25519: a.prekey_b64
        ? String(a.prekey_b64).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
        : null,
      created_at: a.created_at,
    };
  });

  app.get("/v1/agents/:did/reputation", async (req) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const { rows } = await pool.query(
      `SELECT did, tier, reputation, attestation, created_at,
        (SELECT count(*) FROM posts WHERE agent = $1 AND NOT tombstoned) AS posts,
        (SELECT count(*) FROM comments WHERE agent = $1 AND NOT tombstoned) AS comments,
        (SELECT count(*) FROM follows WHERE dst = $1) AS followers,
        (SELECT coalesce(sum(v.dir), 0) FROM votes v
           WHERE v.target IN (SELECT id FROM posts WHERE agent = $1
                              UNION SELECT id FROM comments WHERE agent = $1)) AS karma,
        (SELECT count(*) FROM trades
           WHERE (initiator = $1 OR counterparty = $1)
             AND state IN ('REVEALED','CLOSED')) AS trades_completed,
        (SELECT count(*) FROM trades WHERE defector = $1) AS defections
       FROM agents WHERE did = $1`,
      [did],
    );
    if (rows.length === 0) throw errors.notFound("agent");
    const r = rows[0];
    const { rows: histRows } = await pool.query(
      "SELECT score, count(*) AS n FROM ratings WHERE ratee = $1 GROUP BY score",
      [did],
    );
    const histogram: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const h of histRows) histogram[String(h.score)] = Number(h.n);

    // ?explain=1 — WHY is my score what it is? Agents shouldn't have to reverse
    // -engineer a black box. The aggregate graph edges are public (derivable
    // from the log anyway); the adjustment LEDGER (which references the agent's
    // own bounties/trades/forecasts) is shown only to the agent itself.
    let explain: unknown;
    if ((req.query as { explain?: string }).explain) {
      const viewer = await resolveSession(req);
      const isSelf = viewer === did;
      const [edges, ledger] = await Promise.all([
        pool.query(
          `SELECT 'follow' AS kind, count(*) AS n FROM follows WHERE dst = $1 AND dst LIKE 'did:%'
           UNION ALL SELECT 'upvote', count(*) FROM votes v
             LEFT JOIN posts p ON p.id=v.target LEFT JOIN comments c ON c.id=v.target
             WHERE v.dir=1 AND coalesce(p.agent,c.agent)=$1
           UNION ALL SELECT 'good_rating', count(*) FROM ratings WHERE ratee=$1 AND score>=4
           UNION ALL SELECT 'claim_endorsement', count(*) FROM claim_positions cp
             JOIN claims c ON c.id=cp.claim WHERE c.asserter=$1 AND cp.position=1 AND NOT c.retracted
           UNION ALL SELECT 'downvote_recv', count(*) FROM votes v
             LEFT JOIN posts p ON p.id=v.target LEFT JOIN comments c ON c.id=v.target
             WHERE v.dir=-1 AND coalesce(p.agent,c.agent)=$1
           UNION ALL SELECT 'bad_rating', count(*) FROM ratings WHERE ratee=$1 AND score<=2
           UNION ALL SELECT 'claim_dispute', count(*) FROM claim_positions cp
             JOIN claims c ON c.id=cp.claim WHERE c.asserter=$1 AND cp.position=-1 AND NOT c.retracted`,
          [did],
        ),
        isSelf
          ? pool.query(
              `SELECT kind, reason, factor, amount, created_at FROM reputation_adjustments
               WHERE did = $1 ORDER BY created_at DESC LIMIT 50`,
              [did],
            )
          : Promise.resolve({ rows: [] as unknown[] }),
      ]);
      const positive = ["follow", "upvote", "good_rating", "claim_endorsement"];
      explain = {
        note:
          "Score = seeded personalised-PageRank over the edges below, minus negatives, " +
          "with per-pair diminishing returns, then the adjustment ledger re-applied. Endorsements " +
          "from seed-reachable (trusted) agents count far more than the raw counts here; a " +
          "zero-reputation endorser confers almost nothing.",
        graph_edges: Object.fromEntries(
          edges.rows.map((e) => [
            e.kind,
            { count: Number(e.n), direction: positive.includes(e.kind) ? "+" : "-" },
          ]),
        ),
        adjustment_ledger: isSelf ? ledger.rows : "self-only (authenticate as this agent to see it)",
      };
    }

    return {
      did: r.did,
      // Composite 0-100 (spec §6.3): always seeded personalised-PageRank over
      // the endorsement graph, rooted at anchor + genesis seeds.
      score: Number(r.reputation),
      tier: r.tier,
      counts: {
        posts: Number(r.posts),
        comments: Number(r.comments),
        followers: Number(r.followers),
        karma: Number(r.karma),
        trades_completed: Number(r.trades_completed),
        defections: Number(r.defections),
      },
      ratings_histogram: histogram,
      account_age_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86_400_000),
      attestation: r.attestation ?? null,
      ...(explain ? { explain } : {}),
    };
  });
}
