/**
 * Trade state machine reducers (spec §8.3). One state machine per trade_id;
 * every transition is a signed event; the engine is a deterministic reducer
 * over them (plus the timeout sweeper). Rows are locked (FOR UPDATE) for the
 * duration of each transition. Duplicate commit/reveal by the same party are
 * no-ops returning current state (spec §8.6 idempotency).
 */

import type { Envelope } from "@waggle/core";
import type { DbClient } from "../db.js";
import { errors } from "../lib/errors.js";
import { config, type Tier } from "../config.js";
import type { FanoutMeta, ReduceContext } from "./reducers.js";

interface TradeRow {
  id: string;
  initiator: string;
  counterparty: string;
  state: string;
  timeouts: { accept_secs: number; commit_secs: number; reveal_secs: number; rating_secs: number };
  initiator_commit: string | null;
  counterparty_commit: string | null;
  initiator_revealed: boolean;
  counterparty_revealed: boolean;
}

async function lockTrade(client: DbClient, tradeId: string): Promise<TradeRow> {
  const { rows } = await client.query("SELECT * FROM trades WHERE id = $1 FOR UPDATE", [tradeId]);
  if (rows.length === 0) throw errors.notFound("trade");
  return rows[0] as TradeRow;
}

function requireParty(trade: TradeRow, did: string): "initiator" | "counterparty" {
  if (trade.initiator === did) return "initiator";
  if (trade.counterparty === did) return "counterparty";
  throw errors.forbidden("not a party to this trade");
}

async function recordStep(
  client: DbClient,
  env: Envelope,
  tradeId: string,
  payloadHash?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO trade_events (id, trade, agent, type, payload_hash, ts, sig)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
    [env.id, tradeId, env.agent, env.type, payloadHash ?? null, env.ts, env.sig],
  );
}

async function setState(
  client: DbClient,
  tradeId: string,
  state: string,
  deadline: Date | null,
  extra = "",
): Promise<void> {
  await client.query(
    `UPDATE trades SET state = $1, deadline = $2, updated_at = now() ${extra} WHERE id = $3`,
    [state, deadline, tradeId],
  );
}

/**
 * Concurrent-trade limit (spec §8.7). PROPOSED counts only against the
 * initiator — otherwise unaccepted proposals from strangers would exhaust the
 * counterparty's quota (proposal-spam DoS), and accepting a trade would count
 * the trade being accepted against the acceptor.
 */
async function assertConcurrentLimit(
  client: DbClient,
  did: string,
  tier: Tier,
): Promise<void> {
  const limit = config.trade.concurrent[tier];
  const { rows } = await client.query(
    `SELECT count(*) AS n FROM trades
     WHERE (initiator = $1 AND state IN ('PROPOSED','ACCEPTED','COMMITTED'))
        OR (counterparty = $1 AND state IN ('ACCEPTED','COMMITTED'))`,
    [did],
  );
  if (Number(rows[0].n) >= limit) {
    throw errors.forbidden(`concurrent trade limit for tier (${limit}) reached`);
  }
}

function deadlineFrom(ts: string, secs: number): Date {
  return new Date(Date.parse(ts) + secs * 1000);
}

export const tradeReducers: Record<
  string,
  (env: Envelope, ctx: ReduceContext) => Promise<FanoutMeta>
> = {
  "trade.propose": async (env, { client, gate }) => {
    const body = env.body as {
      trade_id: string;
      counterparty: string;
      offer_summary: string;
      want_summary: string;
      timeouts?: Partial<TradeRow["timeouts"]>;
    };
    if (body.counterparty === env.agent) throw errors.badRequest("cannot trade with yourself");

    const { rows: cp } = await client.query(
      "SELECT status, tier FROM agents WHERE did = $1",
      [body.counterparty],
    );
    if (cp.length === 0) throw errors.notFound("counterparty");
    if (gate && cp[0].status === "suspended") throw errors.badRequest("counterparty is suspended");

    if (gate) {
      const { rows: me } = await client.query("SELECT tier FROM agents WHERE did = $1", [
        env.agent,
      ]);
      await assertConcurrentLimit(client, env.agent, me[0].tier as Tier);
    }

    const timeouts = {
      accept_secs: body.timeouts?.accept_secs ?? config.trade.acceptSecs,
      commit_secs: body.timeouts?.commit_secs ?? config.trade.commitSecs,
      reveal_secs: body.timeouts?.reveal_secs ?? config.trade.revealSecs,
      rating_secs: body.timeouts?.rating_secs ?? config.trade.ratingSecs,
    };

    const { rows: existing } = await client.query("SELECT 1 FROM trades WHERE id = $1", [
      body.trade_id,
    ]);
    if (existing.length > 0) throw errors.badRequest("trade_id already exists");

    await client.query(
      `INSERT INTO trades (id, initiator, counterparty, state, offer_summary, want_summary,
                           timeouts, deadline, created_at, updated_at)
       VALUES ($1, $2, $3, 'PROPOSED', $4, $5, $6, $7, $8, $8)`,
      [
        body.trade_id,
        env.agent,
        body.counterparty,
        body.offer_summary,
        body.want_summary,
        JSON.stringify(timeouts),
        deadlineFrom(env.ts, timeouts.accept_secs),
        env.ts,
      ],
    );
    await recordStep(client, env, body.trade_id);
    return { tradeParty: body.counterparty };
  },

  "trade.accept": async (env, { client, gate }) => {
    const { trade_id } = env.body as { trade_id: string };
    const trade = await lockTrade(client, trade_id);
    if (trade.counterparty !== env.agent) {
      throw errors.forbidden("only the counterparty can accept");
    }
    if (trade.state !== "PROPOSED") throw errors.badRequest(`cannot accept in ${trade.state}`);

    if (gate) {
      const { rows: me } = await client.query("SELECT tier FROM agents WHERE did = $1", [
        env.agent,
      ]);
      await assertConcurrentLimit(client, env.agent, me[0].tier as Tier);
    }

    await setState(client, trade_id, "ACCEPTED", deadlineFrom(env.ts, trade.timeouts.commit_secs));
    await recordStep(client, env, trade_id);
    return { tradeParty: trade.initiator };
  },

  "trade.decline": async (env, { client }) => {
    const { trade_id } = env.body as { trade_id: string };
    const trade = await lockTrade(client, trade_id);
    if (trade.counterparty !== env.agent) {
      throw errors.forbidden("only the counterparty can decline");
    }
    if (trade.state !== "PROPOSED") throw errors.badRequest(`cannot decline in ${trade.state}`);
    await setState(client, trade_id, "DECLINED", null);
    await recordStep(client, env, trade_id);
    return { tradeParty: trade.initiator };
  },

  "trade.abort": async (env, { client }) => {
    const { trade_id } = env.body as { trade_id: string };
    const trade = await lockTrade(client, trade_id);
    const role = requireParty(trade, env.agent);
    // Pre-commit only (spec §8.2): once COMMITTED, the machine runs to reveal/timeout.
    if (trade.state === "PROPOSED") {
      if (role !== "initiator") throw errors.forbidden("only the initiator can abort a proposal");
    } else if (trade.state !== "ACCEPTED") {
      throw errors.badRequest(`cannot abort in ${trade.state} (pre-commit only)`);
    }
    await setState(client, trade_id, "ABORTED", null);
    await recordStep(client, env, trade_id);
    return { tradeParty: role === "initiator" ? trade.counterparty : trade.initiator };
  },

  "trade.commit": async (env, { client }) => {
    const body = env.body as { trade_id: string; payload_hash: string };
    const trade = await lockTrade(client, body.trade_id);
    const role = requireParty(trade, env.agent);
    if (trade.state !== "ACCEPTED") throw errors.badRequest(`cannot commit in ${trade.state}`);

    const col = role === "initiator" ? "initiator_commit" : "counterparty_commit";
    const existing = role === "initiator" ? trade.initiator_commit : trade.counterparty_commit;
    if (existing !== null) {
      if (existing === body.payload_hash) return {}; // idempotent no-op (§8.6)
      throw errors.badRequest("commit already recorded with a different hash");
    }

    await client.query(`UPDATE trades SET ${col} = $1, updated_at = now() WHERE id = $2`, [
      body.payload_hash,
      body.trade_id,
    ]);
    await recordStep(client, env, body.trade_id, body.payload_hash);

    const other = role === "initiator" ? trade.counterparty_commit : trade.initiator_commit;
    if (other !== null) {
      // Both committed → COMMITTED; reveal window opens (spec §8.3).
      await setState(
        client,
        body.trade_id,
        "COMMITTED",
        deadlineFrom(env.ts, trade.timeouts.reveal_secs),
      );
    }
    return { tradeParty: role === "initiator" ? trade.counterparty : trade.initiator };
  },

  "trade.reveal": async (env, { client, gate }) => {
    const body = env.body as { trade_id: string; ciphertext_ref: string };
    const trade = await lockTrade(client, body.trade_id);
    const role = requireParty(trade, env.agent);
    if (trade.state !== "COMMITTED") throw errors.badRequest(`cannot reveal in ${trade.state}`);

    const committed = role === "initiator" ? trade.initiator_commit : trade.counterparty_commit;
    if (body.ciphertext_ref !== committed) {
      // Binding (spec §8.4.2): reveal must reference the committed hash.
      throw errors.badRequest("ciphertext_ref does not match the committed payload_hash");
    }

    const revealedCol = role === "initiator" ? "initiator_revealed" : "counterparty_revealed";
    const already = role === "initiator" ? trade.initiator_revealed : trade.counterparty_revealed;
    if (already) return {}; // idempotent no-op (§8.6)

    if (gate) {
      // The escrow blob must be on deposit and hash-verified (upload route).
      const { rows: blob } = await client.query(
        "SELECT hash FROM escrow_blobs WHERE trade = $1 AND agent = $2",
        [body.trade_id, env.agent],
      );
      if (blob.length === 0 || blob[0].hash !== committed) {
        throw errors.badRequest("escrow blob not deposited (upload it first)");
      }
    }

    await client.query(
      `UPDATE trades SET ${revealedCol} = TRUE, updated_at = now() WHERE id = $1`,
      [body.trade_id],
    );
    await recordStep(client, env, body.trade_id, body.ciphertext_ref);

    const otherRevealed =
      role === "initiator" ? trade.counterparty_revealed : trade.initiator_revealed;
    if (otherRevealed) {
      // Atomic release (spec §8.4.1): both present → REVEALED; rating window opens.
      await setState(
        client,
        body.trade_id,
        "REVEALED",
        deadlineFrom(env.ts, trade.timeouts.rating_secs),
      );
    }
    return { tradeParty: role === "initiator" ? trade.counterparty : trade.initiator };
  },

  "trade.rate": async (env, { client }) => {
    const body = env.body as { trade_id: string; score: number; comment?: string };
    const trade = await lockTrade(client, body.trade_id);
    const role = requireParty(trade, env.agent);
    if (trade.state !== "REVEALED" && trade.state !== "CLOSED") {
      throw errors.badRequest("rating opens after both reveals");
    }
    if (trade.state === "CLOSED") throw errors.badRequest("rating window has closed");

    const ratee = role === "initiator" ? trade.counterparty : trade.initiator;
    await client.query(
      `INSERT INTO ratings (trade, rater, ratee, score, comment, ts)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (trade, rater) DO NOTHING`,
      [body.trade_id, env.agent, ratee, body.score, body.comment ?? null, env.ts],
    );
    await recordStep(client, env, body.trade_id);
    return { tradeParty: ratee };
  },
};
