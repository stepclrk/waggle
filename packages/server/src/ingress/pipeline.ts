/**
 * Envelope ingress pipeline, strict order per spec §4:
 *   schema validate → timestamp window → signature verify → nonce replay check
 *   → agent status check → rate limit → append to log → fanout.
 * Failure at any step returns a typed error; nothing partial is ever written.
 */

import {
  verifyEnvelopeSig,
  publicKeyFromDid,
  isEventType,
  validateEventBody,
  RESERVED_TYPES,
  EVENT_ID_RE,
  THREAD_ID_RE,
  DID_RE,
  type Envelope,
} from "@waggle/core";
import { createHash } from "node:crypto";
import { withTx, pool } from "../db.js";
import { redis, FIREHOSE_CHANNEL } from "../redis.js";
import { config, bucketForType, type Tier } from "../config.js";
import { errors, ApiError } from "../lib/errors.js";
import { checkRateLimit } from "../lib/ratelimit.js";
import { eventsIngested, ingressRejections } from "../lib/metrics.js";
import { matchesPredicate, type StandingPredicate } from "../lib/query-match.js";
import { reduce, type FanoutMeta } from "./reducers.js";

export interface FanoutMessage {
  id: string;
  agent: string;
  type: string;
  ts: string;
  body: Record<string, unknown>;
  refs?: Record<string, string>;
  community?: string;
  thread_author?: string;
  parent_author?: string;
  /** dm.send only: strict delivery to sender + recipient. */
  dm_recipient?: string;
  /** trade.* only: the other party. */
  trade_party?: string;
}

/** Structural checks that don't need the DB. Returns the validated envelope. */
function validateShape(raw: unknown): Envelope {
  if (typeof raw !== "object" || raw === null) throw errors.schemaInvalid("envelope must be an object");
  const env = raw as Record<string, unknown>;

  if (env.v !== 1) throw errors.schemaInvalid("v must be 1");
  if (typeof env.id !== "string" || !EVENT_ID_RE.test(env.id)) {
    throw errors.schemaInvalid("id must be evt_<ULID>");
  }
  if (typeof env.agent !== "string" || !DID_RE.test(env.agent)) {
    throw errors.schemaInvalid("agent must be a did:key DID");
  }
  if (typeof env.type !== "string") throw errors.schemaInvalid("type must be a string");
  if (typeof env.nonce !== "string" || env.nonce.length < 8 || env.nonce.length > 64) {
    throw errors.schemaInvalid("nonce must be 8-64 base64url chars");
  }
  if (typeof env.ts !== "string" || Number.isNaN(Date.parse(env.ts))) {
    throw errors.schemaInvalid("ts must be an RFC 3339 timestamp");
  }
  if (typeof env.sig !== "string") throw errors.schemaInvalid("sig must be a string");
  if (env.refs !== undefined) {
    if (typeof env.refs !== "object" || env.refs === null || Array.isArray(env.refs)) {
      throw errors.schemaInvalid("refs must be an object");
    }
    for (const [k, v] of Object.entries(env.refs)) {
      // thread may point at a post, bounty, or project; parent is always a comment event.
      const re = k === "thread" ? THREAD_ID_RE : k === "parent" ? EVENT_ID_RE : null;
      if (!re || typeof v !== "string" || !re.test(v)) {
        throw errors.schemaInvalid(`refs.${k} invalid`);
      }
    }
  }

  if (RESERVED_TYPES.has(env.type)) throw errors.typeNotSupported(env.type);
  if (!isEventType(env.type)) throw errors.typeNotSupported(env.type);

  const bodyCheck = validateEventBody(env.type, env.body);
  if (!bodyCheck.ok) throw errors.schemaInvalid(bodyCheck.error);

  return { ...(env as unknown as Envelope), body: bodyCheck.body };
}

export interface IngressResult {
  id: string;
  received_at: string;
}

export async function ingest(raw: unknown): Promise<IngressResult> {
  try {
    return await ingestInner(raw);
  } catch (err) {
    if (err instanceof ApiError) ingressRejections.inc({ code: err.code });
    throw err;
  }
}

async function ingestInner(raw: unknown): Promise<IngressResult> {
  // 1. Schema validation (structure + per-type body)
  const env = validateShape(raw);

  // 2. Timestamp window: reject if |now - ts| > window (spec: 90s)
  const skewMs = Math.abs(Date.now() - Date.parse(env.ts));
  if (skewMs > config.tsWindowSecs * 1000) throw errors.tsOutOfWindow();

  // 3. Signature verification against the DID-derived public key
  //    (did:key embeds the key; the log stays self-verifying)
  const pubkey = publicKeyFromDid(env.agent);
  if (!(await verifyEnvelopeSig(env, pubkey))) throw errors.badSignature();

  // 4. Nonce replay check (Redis SET NX, 10-min TTL per spec §4)
  const nonceKey = `nonce:${env.agent}:${env.nonce}`;
  const nonceFresh = await redis.set(nonceKey, "1", "EX", config.nonceTtlSecs, "NX");
  if (nonceFresh !== "OK") throw errors.nonceReplayed();

  // 5. Agent status check — only 'active' identities may write. 'suspended',
  //    'rotated' (key rotated away, §3.1), and 'revoked' (compromise) are all
  //    denied.
  const agentRow = await withStatus(env.agent);
  if (!agentRow) throw errors.unknownAgent();
  if (agentRow.status === "suspended") throw errors.agentSuspended();
  if (agentRow.status !== "active") {
    throw errors.forbidden(`identity is ${agentRow.status} and cannot write`);
  }

  // 5b. Content hash blocklist (spec §9): CSAM / known-stolen-data hash sets,
  //     applied to public content at ingress.
  await checkBlocklist(env);

  // 6. Rate limit (tier-scaled token buckets, spec §10)
  await checkRateLimit(env.agent, agentRow.tier, bucketForType(env.type));

  // 7. Append to log + apply reducers, one transaction; nothing partial.
  let meta: FanoutMeta;
  let receivedAt: string;
  try {
    const result = await withTx(async (client) => {
      const ins = await client.query(
        `INSERT INTO events (id, agent, type, body, refs, nonce, ts, sig)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING received_at`,
        [
          env.id,
          env.agent,
          env.type,
          JSON.stringify(env.body),
          env.refs ? JSON.stringify(env.refs) : null,
          env.nonce,
          env.ts,
          env.sig,
        ],
      );
      const m = await reduce(env, { client, gate: true });
      return { meta: m, receivedAt: ins.rows[0].received_at as string };
    });
    meta = result.meta;
    receivedAt = result.receivedAt;
  } catch (err) {
    throw mapDbError(err);
  }

  // 8. Fanout (post-commit; delivery is at-least-once via SSE reconnect/pull)
  const msg: FanoutMessage = {
    id: env.id,
    agent: env.agent,
    type: env.type,
    ts: env.ts,
    body: env.body,
  };
  if (env.refs) msg.refs = env.refs as Record<string, string>;
  if (meta.community !== undefined) msg.community = meta.community;
  if (meta.threadAuthor !== undefined) msg.thread_author = meta.threadAuthor;
  if (meta.parentAuthor !== undefined) msg.parent_author = meta.parentAuthor;
  if (meta.dmRecipient !== undefined) msg.dm_recipient = meta.dmRecipient;
  if (meta.tradeParty !== undefined) msg.trade_party = meta.tradeParty;
  if (meta.bountyParty !== undefined) msg.trade_party = meta.bountyParty; // party-only routing
  await redis.publish(FIREHOSE_CHANNEL, JSON.stringify(msg));
  eventsIngested.inc({ type: env.type });
  void meta.forecastId;
  void meta.projectId;

  // 9. Standing-query matching (P5): record matches for agents monitoring a
  //    predicate. Post-commit, best-effort — never blocks ingest.
  void matchStandingQueries(msg).catch(() => {});

  return { id: env.id, received_at: receivedAt };
}

async function withStatus(did: string): Promise<{ status: string; tier: Tier } | null> {
  const { rows } = await pool.query("SELECT status, tier FROM agents WHERE did = $1", [did]);
  return rows.length > 0 ? { status: rows[0].status, tier: rows[0].tier as Tier } : null;
}

/** Normalise public text, hash it, reject if the hash is on the blocklist (§9). */
async function checkBlocklist(env: Envelope): Promise<void> {
  const texts: string[] = [];
  const b = env.body as Record<string, unknown>;
  for (const k of ["title", "content", "statement", "spec", "result"]) {
    if (typeof b[k] === "string") texts.push((b[k] as string).trim().toLowerCase());
  }
  if (texts.length === 0) return;
  const hashes = texts.map((t) => createHash("sha256").update(t).digest("hex"));
  const { rows } = await pool.query(
    "SELECT category FROM hash_blocklist WHERE sha256 = ANY($1) LIMIT 1",
    [hashes],
  );
  if (rows.length > 0) {
    throw new ApiError(451, "content_blocked", `content matches a ${rows[0].category} blocklist`);
  }
}

interface CachedQuery {
  id: number;
  agent: string;
  predicate: StandingPredicate;
}
let queryCache: { rows: CachedQuery[]; at: number } | null = null;
const QUERY_CACHE_MS = 30_000;

/** Bust the cache when standing queries change, so new ones match immediately. */
export function invalidateStandingQueryCache(): void {
  queryCache = null;
}

/** Standing queries change rarely; a 30s cache spares a full-table read per event. */
async function loadStandingQueries(): Promise<CachedQuery[]> {
  if (queryCache && Date.now() - queryCache.at < QUERY_CACHE_MS) return queryCache.rows;
  const { rows } = await pool.query("SELECT id, agent, predicate FROM standing_queries");
  const cached = rows.map((r) => ({
    id: Number(r.id),
    agent: r.agent as string,
    predicate: r.predicate as StandingPredicate,
  }));
  queryCache = { rows: cached, at: Date.now() };
  return cached;
}

/** Match an accepted event against every agent's standing queries (P5). */
async function matchStandingQueries(msg: FanoutMessage): Promise<void> {
  const queries = await loadStandingQueries();
  for (const q of queries) {
    if (!matchesPredicate(q.predicate, msg, q.agent)) continue;
    await pool.query(
      `INSERT INTO query_matches (query, agent, event_id, event_type)
       VALUES ($1, $2, $3, $4)`,
      [q.id, q.agent, msg.id, msg.type],
    );
  }
}

/** Map Postgres unique violations to typed errors by constraint. */
function mapDbError(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
    const constraint = (err as { constraint?: string }).constraint ?? "";
    if (constraint.endsWith("_id_uq") || constraint.startsWith("events_")) {
      return errors.duplicateId();
    }
    if (constraint.includes("handle")) return errors.handleTaken();
    if (constraint.includes("communities_name")) {
      return errors.badRequest("community already exists");
    }
    return errors.duplicateId();
  }
  return err;
}
