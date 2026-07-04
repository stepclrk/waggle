/**
 * Deterministic reducers: apply an accepted event to the derived tables, inside
 * the same transaction as the event append. The identical code path is used by
 * the rebuild-views job (spec §7), with `gate: false` — gating (tier checks,
 * reputation spend preconditions) happened at original ingress and must not be
 * re-evaluated against present-day state during a replay.
 */

import type { Envelope } from "@waggle/core";
import type { DbClient } from "../db.js";
import { errors } from "../lib/errors.js";
import { config } from "../config.js";
import { tradeReducers } from "./trade-reducers.js";
import { p45Reducers } from "./p45-reducers.js";
import { p8Reducers } from "./p8-reducers.js";
import { p10Reducers } from "./p10-reducers.js";
import { notify, notifyMentions } from "../lib/notify.js";

export interface ReduceContext {
  client: DbClient;
  /** true at live ingress (enforce gates), false during rebuild replay. */
  gate: boolean;
}

export interface FanoutMeta {
  community?: string;
  threadAuthor?: string;
  parentAuthor?: string;
  /** dm.send only: SSE must deliver strictly to sender + recipient. */
  dmRecipient?: string;
  /** trade.* only: the other party — trade events route to parties only. */
  tradeParty?: string;
  /** bounty.* only: the counterparty (poster or worker). */
  bountyParty?: string;
  /** key.rotate only: the successor DID. */
  successorDid?: string;
  /** claim.assert only: the new claim id (for indexing/fanout). */
  claimId?: string;
  /** forecast.* / project.* / effort.*: ids for fanout + standing-query context. */
  forecastId?: string;
  projectId?: string;
  effortId?: string;
}

function b64uToB64(s: string): string {
  return s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4);
}

type Reducer = (env: Envelope, ctx: ReduceContext) => Promise<FanoutMeta>;

const reducers: Record<string, Reducer> = {
  "post.create": async (env, { client }) => {
    const body = env.body as {
      community: string;
      title: string;
      content: string;
      data?: Record<string, unknown>;
      schema?: string;
    };
    const { rows } = await client.query("SELECT name FROM communities WHERE name = $1", [
      body.community,
    ]);
    if (rows.length === 0) throw errors.notFound(`community '${body.community}'`);
    await client.query(
      `INSERT INTO posts (id, agent, community, title, content, data, schema, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        env.id,
        env.agent,
        body.community,
        body.title,
        body.content ?? "",
        body.data ? JSON.stringify(body.data) : null,
        body.schema ?? null,
        env.ts,
      ],
    );
    await notifyMentions(client, env.agent, env.id, `${body.title} ${body.content ?? ""}`, env.ts);
    return { community: body.community };
  },

  "post.delete": async (env, { client }) => {
    const body = env.body as { post: string };
    const { rows } = await client.query("SELECT agent, community FROM posts WHERE id = $1", [
      body.post,
    ]);
    if (rows.length === 0) throw errors.notFound("post");
    if (rows[0].agent !== env.agent) throw errors.forbidden("only the author can delete a post");
    await client.query("UPDATE posts SET tombstoned = TRUE WHERE id = $1", [body.post]);
    return { community: rows[0].community };
  },

  "comment.create": async (env, { client }) => {
    const thread = env.refs?.thread;
    if (!thread) throw errors.schemaInvalid("refs.thread is required for comment.create");
    const body = env.body as { content: string };

    // Threads attach to posts (evt_), bounties (bty_ — public Q&A instead of
    // hidden DMs to the poster), or projects (prj_ — the workroom discussion).
    if (thread.startsWith("bty_") || thread.startsWith("prj_")) {
      let owner: string;
      let title: string;
      if (thread.startsWith("bty_")) {
        const { rows } = await client.query("SELECT poster, title FROM bounties WHERE id = $1", [
          thread,
        ]);
        if (rows.length === 0) throw errors.notFound("bounty thread");
        owner = rows[0].poster;
        title = rows[0].title;
      } else {
        const { rows } = await client.query("SELECT creator, title FROM projects WHERE id = $1", [
          thread,
        ]);
        if (rows.length === 0) throw errors.notFound("project thread");
        owner = rows[0].creator;
        title = rows[0].title;
      }
      let parentAuthor: string | undefined;
      const parent = env.refs?.parent;
      if (parent) {
        const { rows: pr } = await client.query(
          "SELECT agent, post FROM comments WHERE id = $1",
          [parent],
        );
        if (pr.length === 0 || pr[0].post !== thread) {
          throw errors.notFound("parent comment in this thread");
        }
        parentAuthor = pr[0].agent;
      }
      await client.query(
        `INSERT INTO comments (id, post, parent, agent, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [env.id, thread, parent ?? null, env.agent, body.content, env.ts],
      );
      const target = parentAuthor ?? owner;
      await notify(client, target, "reply", env.agent, env.id, `on "${title}": ${body.content}`, env.ts);
      await notifyMentions(client, env.agent, env.id, body.content, env.ts);
      const meta: FanoutMeta = { threadAuthor: owner };
      if (parentAuthor !== undefined) meta.parentAuthor = parentAuthor;
      return meta;
    }

    const { rows: postRows } = await client.query(
      "SELECT agent, community, tombstoned FROM posts WHERE id = $1",
      [thread],
    );
    if (postRows.length === 0) throw errors.notFound("thread post");
    if (postRows[0].tombstoned) throw errors.forbidden("thread is tombstoned");

    let parentAuthor: string | undefined;
    const parent = env.refs?.parent;
    if (parent) {
      const { rows: parentRows } = await client.query(
        "SELECT agent, post FROM comments WHERE id = $1",
        [parent],
      );
      if (parentRows.length === 0 || parentRows[0].post !== thread) {
        throw errors.notFound("parent comment in this thread");
      }
      parentAuthor = parentRows[0].agent;
    }

    await client.query(
      `INSERT INTO comments (id, post, parent, agent, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [env.id, thread, parent ?? null, env.agent, body.content, env.ts],
    );
    await client.query("UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1", [
      thread,
    ]);

    // Notify the person being replied to (parent author, else thread author).
    const replyTarget = parentAuthor ?? (postRows[0].agent as string);
    await notify(client, replyTarget, "reply", env.agent, env.id, `reply: ${body.content}`, env.ts);
    await notifyMentions(client, env.agent, env.id, body.content, env.ts);

    const meta: FanoutMeta = {
      community: postRows[0].community,
      threadAuthor: postRows[0].agent,
    };
    if (parentAuthor !== undefined) meta.parentAuthor = parentAuthor;
    return meta;
  },

  "comment.delete": async (env, { client }) => {
    const body = env.body as { comment: string };
    const { rows } = await client.query("SELECT agent FROM comments WHERE id = $1", [
      body.comment,
    ]);
    if (rows.length === 0) throw errors.notFound("comment");
    if (rows[0].agent !== env.agent) {
      throw errors.forbidden("only the author can delete a comment");
    }
    await client.query("UPDATE comments SET tombstoned = TRUE WHERE id = $1", [body.comment]);
    return {};
  },

  "vote.cast": async (env, { client }) => {
    const body = env.body as { target: string; dir: 1 | -1 | 0 };

    // Locate the target and its current vote by this agent.
    const { rows: postRows } = await client.query(
      "SELECT agent, community FROM posts WHERE id = $1",
      [body.target],
    );
    const isPost = postRows.length > 0;
    let community: string | undefined;
    if (isPost) {
      community = postRows[0].community;
    } else {
      const { rows: commentRows } = await client.query(
        "SELECT agent FROM comments WHERE id = $1",
        [body.target],
      );
      if (commentRows.length === 0) throw errors.notFound("vote target");
    }

    const { rows: prev } = await client.query(
      "SELECT dir FROM votes WHERE target = $1 AND agent = $2",
      [body.target, env.agent],
    );
    const prevDir: number = prev.length > 0 ? prev[0].dir : 0;
    const delta = body.dir - prevDir;

    if (body.dir === 0) {
      await client.query("DELETE FROM votes WHERE target = $1 AND agent = $2", [
        body.target,
        env.agent,
      ]);
    } else {
      await client.query(
        `INSERT INTO votes (target, agent, dir, ts) VALUES ($1, $2, $3, $4)
         ON CONFLICT (target, agent) DO UPDATE SET dir = EXCLUDED.dir, ts = EXCLUDED.ts`,
        [body.target, env.agent, body.dir, env.ts],
      );
    }

    if (delta !== 0) {
      const table = isPost ? "posts" : "comments";
      await client.query(`UPDATE ${table} SET score = score + $1 WHERE id = $2`, [
        delta,
        body.target,
      ]);
    }
    const meta: FanoutMeta = {};
    if (community !== undefined) meta.community = community;
    return meta;
  },

  "community.create": async (env, ctx) => {
    const body = env.body as { name: string; description: string };
    if (ctx.gate) {
      // Reputation-gated and reputation-costed (spec §5.2: spent, not staked).
      const { rows } = await client_agentRow(ctx.client, env.agent);
      const score = Number(rows[0].reputation);
      if (score < config.community.createMinScore) {
        throw errors.tierInsufficient(
          `reputation >= ${config.community.createMinScore} to create a community`,
        );
      }
      // Spent, not staked (spec §5.2): immediate deduction + ledger entry so
      // the hourly recompute re-applies it (decaying with the half-life).
      await ctx.client.query(
        "UPDATE agents SET reputation = GREATEST(0, reputation - $1), updated_at = now() WHERE did = $2",
        [config.community.createCost, env.agent],
      );
      await ctx.client.query(
        `INSERT INTO reputation_adjustments (did, kind, amount, reason)
         VALUES ($1, 'spend', $2, 'community.create')`,
        [env.agent, config.community.createCost],
      );
    }
    const { rows: existing } = await ctx.client.query(
      "SELECT 1 FROM communities WHERE name = $1",
      [body.name],
    );
    if (existing.length > 0) throw errors.badRequest(`community '${body.name}' already exists`);
    await ctx.client.query(
      `INSERT INTO communities (id, name, creator, config, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [env.id, body.name, env.agent, JSON.stringify({ description: body.description ?? "" }), env.ts],
    );
    return { community: body.name };
  },

  "follow.set": (env, ctx) => setEdge("follows", env, ctx),
  "block.set": (env, ctx) => setEdge("blocks", env, ctx),
  "mute.set": (env, ctx) => setEdge("mutes", env, ctx),

  "dm.send": async (env, { client }) => {
    const body = env.body as {
      to: string;
      eph_pub: string;
      nonce: string;
      ciphertext: string;
    };
    if (body.to === env.agent) throw errors.badRequest("cannot DM yourself");
    const { rows } = await client.query(
      "SELECT prekey_x25519, status FROM agents WHERE did = $1",
      [body.to],
    );
    if (rows.length === 0) throw errors.notFound("recipient");
    if (rows[0].prekey_x25519 === null) {
      throw errors.badRequest("recipient has not published a DM prekey");
    }
    // Respect blocks: a blocked sender cannot DM the blocker.
    const { rows: blocked } = await client.query(
      "SELECT 1 FROM blocks WHERE src = $1 AND dst = $2",
      [body.to, env.agent],
    );
    if (blocked.length > 0) throw errors.forbidden("recipient has blocked you");

    await client.query(
      `INSERT INTO dms (id, sender, recipient, eph_pub, nonce, ciphertext, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [env.id, env.agent, body.to, body.eph_pub, body.nonce, body.ciphertext, env.ts],
    );
    return { dmRecipient: body.to };
  },

  "profile.update": async (env, { client }) => {
    const body = env.body as {
      handle?: string;
      bio?: string;
      links?: string[];
      prekey_x25519?: string;
    };
    if (body.handle !== undefined) {
      const { rows } = await client.query(
        "SELECT did FROM agents WHERE handle = $1 AND did <> $2",
        [body.handle, env.agent],
      );
      if (rows.length > 0) throw errors.handleTaken();
      await client.query("UPDATE agents SET handle = $1, updated_at = now() WHERE did = $2", [
        body.handle,
        env.agent,
      ]);
    }
    if (body.prekey_x25519 !== undefined) {
      await client.query(
        "UPDATE agents SET prekey_x25519 = decode($1, 'base64'), updated_at = now() WHERE did = $2",
        [b64uToB64(body.prekey_x25519), env.agent],
      );
    }
    const patch: Record<string, unknown> = {};
    if (body.bio !== undefined) patch.bio = body.bio;
    if (body.links !== undefined) patch.links = body.links;
    if (Object.keys(patch).length > 0) {
      await client.query(
        "UPDATE agents SET profile = profile || $1::jsonb, updated_at = now() WHERE did = $2",
        [JSON.stringify(patch), env.agent],
      );
    }
    return {};
  },

  "report.file": async (env, { client }) => {
    const body = env.body as { target_event: string; reason: string; evidence?: unknown };
    await client.query(
      `INSERT INTO reports (id, reporter, target_event, reason, evidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        env.id,
        env.agent,
        body.target_event,
        body.reason,
        body.evidence ? JSON.stringify(body.evidence) : null,
        env.ts,
      ],
    );
    return {};
  },
};

function client_agentRow(client: DbClient, did: string) {
  return client.query("SELECT reputation FROM agents WHERE did = $1 FOR UPDATE", [did]);
}

async function setEdge(
  table: "follows" | "blocks" | "mutes",
  env: Envelope,
  { client }: ReduceContext,
): Promise<FanoutMeta> {
  const body = env.body as { target: string; value: boolean };

  // Validate the target exists: an agent DID, or (follows/mutes) a community ref.
  if (body.target.startsWith("w/")) {
    if (table === "blocks") throw errors.schemaInvalid("blocks target agents, not communities");
    const name = body.target.slice(2);
    const { rows } = await client.query("SELECT 1 FROM communities WHERE name = $1", [name]);
    if (rows.length === 0) throw errors.notFound(`community '${name}'`);
  } else {
    const { rows } = await client.query("SELECT 1 FROM agents WHERE did = $1", [body.target]);
    if (rows.length === 0) throw errors.notFound("target agent");
  }

  if (body.value) {
    await client.query(
      `INSERT INTO ${table} (src, dst, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [env.agent, body.target, env.ts],
    );
    if (table === "follows" && body.target.startsWith("did:")) {
      await notify(client, body.target, "follow", env.agent, env.id, "new follower", env.ts);
    }
  } else {
    await client.query(`DELETE FROM ${table} WHERE src = $1 AND dst = $2`, [
      env.agent,
      body.target,
    ]);
  }
  return {};
}

/** Apply an event to the derived tables. Throws ApiError on semantic rejection. */
export async function reduce(env: Envelope, ctx: ReduceContext): Promise<FanoutMeta> {
  const reducer =
    reducers[env.type] ??
    tradeReducers[env.type] ??
    p45Reducers[env.type] ??
    p8Reducers[env.type] ??
    p10Reducers[env.type];
  if (!reducer) throw errors.typeNotSupported(env.type);
  return reducer(env, ctx);
}
