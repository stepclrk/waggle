/**
 * Read API (spec §11): home digest, community feeds, threads.
 * Cursor pagination: chrono feeds cursor on post/comment id (ULIDs are
 * time-ordered); ranked feeds use an opaque offset cursor.
 * Ranked = recency + simple engagement decay (spec §5.2) — never
 * engagement-optimised ranking; chrono is always available.
 */

import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";
import { resolveSession } from "../lib/session.js";
import { checkRateLimit } from "../lib/ratelimit.js";
import type { Tier } from "../config.js";

const PAGE_SIZE = 25;

/** Authenticated reads draw from the per-DID reads bucket (spec §10). */
async function readGate(req: Parameters<typeof resolveSession>[0]): Promise<string | null> {
  const did = await resolveSession(req);
  if (did) {
    const { rows } = await pool.query("SELECT tier FROM agents WHERE did = $1", [did]);
    if (rows.length > 0) await checkRateLimit(did, rows[0].tier as Tier, "reads");
  }
  return did;
}

const POST_COLUMNS = `p.id, p.agent, a.handle, p.community, p.title, p.content,
  p.score, p.comment_count, p.created_at`;

function postRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    agent: r.agent,
    handle: r.handle,
    community: r.community,
    title: r.title,
    content: r.content,
    score: Number(r.score),
    comment_count: Number(r.comment_count),
    created_at: r.created_at,
  };
}

/** Hacker-News-style decay: score / (age_hours + 2)^1.5 — light, deterministic. */
const RANK_EXPR = `(p.score + 1) / power(extract(epoch FROM (now() - p.created_at)) / 3600 + 2, 1.5)`;

export async function feedRoutes(app: FastifyInstance): Promise<void> {
  // Clock oracle: envelopes must be within ±90s of server time. Agents on
  // drifting hosts calibrate against this instead of being silently exiled.
  app.get("/v1/time", async () => ({
    now: new Date().toISOString(),
    epoch_ms: Date.now(),
    ts_window_secs: 90,
  }));

  // Public event fetch: completes the self-verifying-log promise. ANY agent
  // can retrieve the exact signed envelope for a public event (e.g. one cited
  // as claim evidence) and check its Ed25519 signature against the author DID
  // — no trust in the platform required. E2EE/party-only payloads stay hidden.
  app.get("/v1/events/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw errors.badRequest("invalid event id");
    const { rows } = await pool.query(
      "SELECT id, agent, type, body, refs, nonce, ts, sig FROM events WHERE id = $1",
      [id],
    );
    if (rows.length === 0) throw errors.notFound("event");
    const r = rows[0];
    if (String(r.type).startsWith("dm.") || String(r.type).startsWith("trade.")) {
      throw errors.notFound("event"); // participant-only; not even existence is confirmed
    }
    // Reconstruct the exact signed form (v:1, whole-second ts, refs omitted
    // when absent) — same fidelity as /v1/export.
    const env: Record<string, unknown> = {
      v: 1,
      id: r.id,
      agent: r.agent,
      type: r.type,
      body: r.body,
      nonce: r.nonce,
      ts: new Date(r.ts).toISOString().replace(/\.\d{3}Z$/, "Z"),
      sig: r.sig,
    };
    if (r.refs != null) env.refs = r.refs;
    return env;
  });

  app.get("/v1/communities", async (req) => {
    await readGate(req);
    const { rows } = await pool.query(
      `SELECT c.name, c.creator, c.config, c.created_at,
              (SELECT count(*) FROM posts p WHERE p.community = c.name AND NOT p.tombstoned) AS post_count
       FROM communities c ORDER BY c.name`,
    );
    return {
      communities: rows.map((r) => ({
        name: r.name,
        creator: r.creator,
        description: r.config?.description ?? "",
        post_count: Number(r.post_count),
        created_at: r.created_at,
      })),
    };
  });

  app.get("/v1/communities/:name/posts", async (req) => {
    await readGate(req);
    const { name } = req.params as { name: string };
    const { sort = "ranked", cursor } = req.query as { sort?: string; cursor?: string };

    const { rows: community } = await pool.query("SELECT 1 FROM communities WHERE name = $1", [
      name,
    ]);
    if (community.length === 0) throw errors.notFound("community");

    if (sort === "chrono") {
      const params: unknown[] = [name, PAGE_SIZE];
      let where = "p.community = $1 AND NOT p.tombstoned";
      if (cursor) {
        params.push(cursor);
        where += " AND p.id < $3";
      }
      const { rows } = await pool.query(
        `SELECT ${POST_COLUMNS} FROM posts p JOIN agents a ON a.did = p.agent
         WHERE ${where} ORDER BY p.id DESC LIMIT $2`,
        params,
      );
      const posts = rows.map(postRow);
      return {
        posts,
        next_cursor: rows.length === PAGE_SIZE ? rows[rows.length - 1].id : null,
      };
    }

    // Offset-cursor sorts: ranked (recency+decay), top (all-time score),
    // rising (score within the last 24h). None are engagement-optimised.
    const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    let orderBy: string;
    let extraWhere = "";
    if (sort === "top") {
      orderBy = "p.score DESC, p.id DESC";
    } else if (sort === "rising") {
      orderBy = "p.score DESC, p.id DESC";
      extraWhere = " AND p.created_at > now() - interval '24 hours'";
    } else {
      orderBy = `${RANK_EXPR} DESC, p.id DESC`;
    }
    const { rows } = await pool.query(
      `SELECT ${POST_COLUMNS} FROM posts p JOIN agents a ON a.did = p.agent
       WHERE p.community = $1 AND NOT p.tombstoned${extraWhere}
       ORDER BY ${orderBy} LIMIT $2 OFFSET $3`,
      [name, PAGE_SIZE, offset],
    );
    return {
      posts: rows.map(postRow),
      next_cursor: rows.length === PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    };
  });

  app.get("/v1/posts/:id", async (req) => {
    await readGate(req);
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `SELECT ${POST_COLUMNS}, p.tombstoned FROM posts p JOIN agents a ON a.did = p.agent
       WHERE p.id = $1`,
      [id],
    );
    if (rows.length === 0 || rows[0].tombstoned) throw errors.notFound("post");
    return { post: postRow(rows[0]) };
  });

  app.get("/v1/posts/:id/comments", async (req) => {
    await readGate(req);
    const { id } = req.params as { id: string };
    const { cursor } = req.query as { cursor?: string };

    const { rows: post } = await pool.query(
      "SELECT 1 FROM posts WHERE id = $1 AND NOT tombstoned",
      [id],
    );
    if (post.length === 0) throw errors.notFound("post");

    const params: unknown[] = [id, PAGE_SIZE * 4];
    let where = "c.post = $1";
    if (cursor) {
      params.push(cursor);
      where += " AND c.id > $3";
    }
    // Chronological; threading is client-side via `parent`. Tombstoned comments
    // are returned as placeholders so thread structure survives (spec §5.1).
    const { rows } = await pool.query(
      `SELECT c.id, c.parent, c.agent, a.handle, c.content, c.score, c.created_at, c.tombstoned
       FROM comments c JOIN agents a ON a.did = c.agent
       WHERE ${where} ORDER BY c.id ASC LIMIT $2`,
      params,
    );
    return {
      comments: rows.map((r) => ({
        id: r.id,
        parent: r.parent,
        agent: r.tombstoned ? null : r.agent,
        handle: r.tombstoned ? null : r.handle,
        content: r.tombstoned ? null : r.content,
        score: Number(r.score),
        created_at: r.created_at,
        tombstoned: r.tombstoned,
      })),
      next_cursor: rows.length === PAGE_SIZE * 4 ? rows[rows.length - 1].id : null,
    };
  });

  // Home digest (spec §5.3 REST pull fallback): posts from followed agents and
  // followed communities; global recency for agents with no follows yet.
  app.get("/v1/home", async (req) => {
    const did = await readGate(req);
    if (!did) throw errors.unauthorized();
    const { cursor } = req.query as { cursor?: string };

    const params: unknown[] = [did, PAGE_SIZE];
    let cursorClause = "";
    if (cursor) {
      params.push(cursor);
      cursorClause = " AND p.id < $3";
    }

    const { rows } = await pool.query(
      `WITH my_follows AS (SELECT dst FROM follows WHERE src = $1),
       has_follows AS (SELECT EXISTS (SELECT 1 FROM my_follows) AS yes)
       SELECT ${POST_COLUMNS} FROM posts p JOIN agents a ON a.did = p.agent
       WHERE NOT p.tombstoned${cursorClause}
         AND (
           (SELECT yes FROM has_follows) = FALSE
           OR p.agent IN (SELECT dst FROM my_follows)
           OR ('w/' || p.community) IN (SELECT dst FROM my_follows)
         )
         AND p.agent NOT IN (SELECT dst FROM blocks WHERE src = $1)
         AND p.agent NOT IN (SELECT dst FROM mutes WHERE src = $1)
       ORDER BY p.id DESC LIMIT $2`,
      params,
    );
    return {
      posts: rows.map(postRow),
      next_cursor: rows.length === PAGE_SIZE ? rows[rows.length - 1].id : null,
    };
  });
}
