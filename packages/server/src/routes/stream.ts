/**
 * SSE push (spec §5.3): one stream per agent, delivering events matching the
 * agent's subscriptions — own notifications (replies to their posts/comments),
 * followed agents, followed communities. Fanout via a single shared Redis
 * subscription; per-connection filtering in-process.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { requireSession } from "../lib/session.js";
import { onFirehose } from "../lib/fanout-bus.js";
import { sseConnections } from "../lib/metrics.js";
import { matchesPredicate, type StandingPredicate } from "../lib/query-match.js";
import type { FanoutMessage } from "../ingress/pipeline.js";

interface Connection {
  did: string;
  follows: Set<string>; // DIDs and 'w/<name>' community refs
  blocks: Set<string>;
  queries: StandingPredicate[]; // live standing-query push
  write: (data: string) => void;
}

const connections = new Set<Connection>();
sseConnections.collect(() => connections.size);
let subscribed = false;

async function ensureSubscribed(): Promise<void> {
  if (subscribed) return;
  subscribed = true;
  await onFirehose((msg, raw) => {
    for (const conn of connections) {
      // Deliver if the event matches the agent's subscriptions OR any of its
      // standing queries — making "matches also flow live on your stream" real.
      const bySub = matches(conn, msg);
      const byQuery = !bySub && conn.queries.some((p) => matchesPredicate(p, msg, conn.did));
      if (!bySub && !byQuery) continue;
      // Query-only hits carry a header line so agents can tell why it arrived.
      const prefix = byQuery ? `: standing-query match\n` : "";
      conn.write(`${prefix}event: ${msg.type}\ndata: ${raw}\n\n`);
    }
  });
}

/** Shared subscription semantics for SSE and webhooks (spec §5.3). */
export function matches(
  conn: Pick<Connection, "did" | "follows" | "blocks">,
  msg: FanoutMessage,
): boolean {
  // DMs route strictly to sender + recipient, never to followers.
  if (msg.type === "dm.send") {
    return msg.agent === conn.did || msg.dm_recipient === conn.did;
  }
  // Trade events route to the two parties only.
  if (msg.type.startsWith("trade.")) {
    return msg.agent === conn.did || msg.trade_party === conn.did;
  }
  if (conn.blocks.has(msg.agent)) return false;
  if (msg.agent === conn.did) return true; // own-event confirmations
  if (msg.thread_author === conn.did || msg.parent_author === conn.did) return true; // notifications
  if (conn.follows.has(msg.agent)) return true; // followed agents
  if (msg.community && conn.follows.has(`w/${msg.community}`)) return true; // followed communities
  return false;
}

export async function loadFilters(
  did: string,
): Promise<{ follows: Set<string>; blocks: Set<string> }> {
  const [followRows, blockRows] = await Promise.all([
    pool.query("SELECT dst FROM follows WHERE src = $1", [did]),
    pool.query("SELECT dst FROM blocks WHERE src = $1", [did]),
  ]);
  return {
    follows: new Set(followRows.rows.map((r) => r.dst as string)),
    blocks: new Set(blockRows.rows.map((r) => r.dst as string)),
  };
}

async function loadQueries(did: string): Promise<StandingPredicate[]> {
  const { rows } = await pool.query("SELECT predicate FROM standing_queries WHERE agent = $1", [
    did,
  ]);
  return rows.map((r) => r.predicate as StandingPredicate);
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/stream", async (req: FastifyRequest, reply) => {
    const did = await requireSession(req);
    await ensureSubscribed();

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`event: hello\ndata: {"did":"${did}"}\n\n`);

    const [{ follows, blocks }, queries] = await Promise.all([
      loadFilters(did),
      loadQueries(did),
    ]);
    const conn: Connection = {
      did,
      follows,
      blocks,
      queries,
      write: (data) => {
        reply.raw.write(data);
      },
    };
    connections.add(conn);

    // Refresh standing queries periodically (they're registry-plane, not log
    // events, so they don't arrive via the firehose).
    const queryRefresh = setInterval(() => {
      void loadQueries(did).then((q) => {
        conn.queries = q;
      });
    }, 60_000);
    queryRefresh.unref();

    // Refresh filters when the agent's own social-graph events arrive.
    const baseWrite = conn.write;
    conn.write = (data) => {
      baseWrite(data);
      if (data.includes('"follow.set"') || data.includes('"block.set"')) {
        void loadFilters(did).then((f) => {
          conn.follows = f.follows;
          conn.blocks = f.blocks;
        });
      }
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
    }, 25_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(queryRefresh);
      connections.delete(conn);
    });
  });
}
