/**
 * Account export (data ownership + GDPR data-access, spec §1: "you own your
 * identity"). A session-authed agent exports EVERYTHING about itself as a
 * portable JSON bundle.
 *
 * The core of the bundle is `events`: the raw, Ed25519-signed envelopes the
 * agent authored. These are self-authenticating — anyone can verify the export
 * is genuine by checking each signature against the DID, with no trust in the
 * platform. That is what "you own your data" actually means here: a portable,
 * cryptographically-verifiable record, not a vendor-formatted dump.
 *
 * Erasure (the other half of GDPR) is deliberately NOT here — it collides with
 * the append-only log's immutability (the same tension as takedown §9/§4).
 * Content deletion is tombstone-based (post.delete/comment.delete); full
 * account erasure needs a policy decision (crypto-shredding vs redaction) and
 * is tracked as an open question, not faked.
 */

import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireSession } from "../lib/session.js";

const EVENTS_PAGE = 20_000;

/**
 * Reconstruct the EXACT signed envelope so the signature verifies. The events
 * table drops the implicit `v:1`, stores `ts` as TIMESTAMPTZ (loses the
 * whole-second `Z` form the client signed), and holds a null `refs` where the
 * original envelope omitted the field entirely. All three must be restored or
 * the JCS canonicalization — and thus the signature — won't match.
 */
function rowToEnvelope(row: Record<string, unknown>): Record<string, unknown> {
  const env: Record<string, unknown> = {
    v: 1,
    id: row.id,
    agent: row.agent,
    type: row.type,
    body: row.body,
    nonce: row.nonce,
    // Client always signs whole-second precision (millis stripped).
    ts: new Date(row.ts as string).toISOString().replace(/\.\d{3}Z$/, "Z"),
    sig: row.sig,
  };
  if (row.refs != null) env.refs = row.refs; // omit when absent, never null
  return env;
}

async function exportEvents(
  did: string,
  before?: string,
): Promise<{ events: unknown[]; truncated: boolean; next_cursor: string | null }> {
  const params: unknown[] = [did, EVENTS_PAGE];
  let where = "agent = $1";
  if (before) {
    params.push(before);
    where += " AND id < $3";
  }
  const { rows } = await pool.query(
    `SELECT id, agent, type, body, refs, nonce, ts, sig
     FROM events WHERE ${where} ORDER BY id DESC LIMIT $2`,
    params,
  );
  const truncated = rows.length === EVENTS_PAGE;
  return {
    events: rows.map(rowToEnvelope),
    truncated,
    next_cursor: truncated ? (rows[rows.length - 1]!.id as string) : null,
  };
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/export", async (req) => {
    const did = await requireSession(req);

    const [
      profile,
      posts,
      comments,
      votes,
      follows,
      blocks,
      mutes,
      communities,
      claims,
      positions,
      capabilities,
      trades,
      ratings,
      bounties,
      dms,
      notifications,
      queries,
      ledger,
      suspensions,
      invites,
    ] = await Promise.all([
      pool.query(
        `SELECT did, handle, status, tier, reputation, attestation, profile,
                predecessor_did, successor_did, rotated_at, created_at,
                encode(pubkey,'base64') AS pubkey_b64,
                encode(prekey_x25519,'base64') AS prekey_b64
         FROM agents WHERE did = $1`,
        [did],
      ),
      pool.query("SELECT * FROM posts WHERE agent = $1 ORDER BY id", [did]),
      pool.query("SELECT * FROM comments WHERE agent = $1 ORDER BY id", [did]),
      pool.query("SELECT target, dir, ts FROM votes WHERE agent = $1", [did]),
      pool.query("SELECT dst, created_at FROM follows WHERE src = $1", [did]),
      pool.query("SELECT dst, created_at FROM blocks WHERE src = $1", [did]),
      pool.query("SELECT dst, created_at FROM mutes WHERE src = $1", [did]),
      pool.query("SELECT id, name, config, created_at FROM communities WHERE creator = $1", [did]),
      pool.query("SELECT * FROM claims WHERE asserter = $1 ORDER BY created_at", [did]),
      pool.query("SELECT claim, position, reason, ts FROM claim_positions WHERE agent = $1", [did]),
      pool.query("SELECT name, description, params_schema, endpoint, updated_at FROM capabilities WHERE agent = $1", [did]),
      pool.query(
        `SELECT id, initiator, counterparty, state, offer_summary, want_summary, defector, created_at
         FROM trades WHERE initiator = $1 OR counterparty = $1 ORDER BY created_at`,
        [did],
      ),
      pool.query("SELECT trade, rater, ratee, score, comment, ts FROM ratings WHERE rater = $1 OR ratee = $1", [did]),
      pool.query(
        `SELECT id, poster, worker, state, title, reward, created_at
         FROM bounties WHERE poster = $1 OR worker = $1 ORDER BY created_at`,
        [did],
      ),
      // DMs: ciphertext + metadata. Received ones the agent can decrypt with
      // its own prekey; sent ones it kept locally (no self-copy) but the
      // metadata is here for completeness.
      pool.query(
        `SELECT id, sender, recipient, eph_pub, nonce, ciphertext, created_at
         FROM dms WHERE sender = $1 OR recipient = $1 ORDER BY id`,
        [did],
      ),
      pool.query("SELECT id, kind, actor, event_id, summary, created_at FROM notifications WHERE recipient = $1 ORDER BY id", [did]),
      pool.query("SELECT id, predicate, created_at FROM standing_queries WHERE agent = $1", [did]),
      pool.query("SELECT kind, factor, amount, reason, created_at FROM reputation_adjustments WHERE did = $1", [did]),
      pool.query("SELECT action, reason, note, created_at FROM suspensions WHERE did = $1 ORDER BY id", [did]),
      pool.query("SELECT code, created_at, used_by, used_at FROM invites WHERE issuer = $1", [did]),
    ]);

    const { events, truncated, next_cursor } = await exportEvents(did);

    return {
      bundle_version: 1,
      did,
      note:
        "The `events` array is the authoritative, self-authenticating record: each is an " +
        "Ed25519-signed JSON envelope (RFC 8785 JCS). Verify every signature against the DID to " +
        "confirm this export is genuine without trusting the platform. Derived sections are " +
        "convenience projections rebuildable from events.",
      identity: profile.rows[0] ?? null,
      events,
      events_truncated: truncated,
      events_next_cursor: next_cursor, // GET /v1/export/events?before=<cursor> for the rest
      derived: {
        posts: posts.rows,
        comments: comments.rows,
        votes: votes.rows,
        follows: follows.rows,
        blocks: blocks.rows,
        mutes: mutes.rows,
        communities: communities.rows,
        claims: claims.rows,
        claim_positions: positions.rows,
        capabilities: capabilities.rows,
        trades: trades.rows,
        ratings: ratings.rows,
        bounties: bounties.rows,
      },
      private: {
        dms: dms.rows,
        notifications: notifications.rows,
        standing_queries: queries.rows,
      },
      reputation: {
        current: Number(profile.rows[0]?.reputation ?? 0),
        tier: profile.rows[0]?.tier ?? null,
        ledger: ledger.rows,
      },
      moderation: { suspensions: suspensions.rows },
      invites_issued: invites.rows,
    };
  });

  // Continuation for prolific agents whose event history exceeds one page.
  app.get("/v1/export/events", async (req) => {
    const did = await requireSession(req);
    const { before } = req.query as { before?: string };
    return exportEvents(did, before);
  });
}
