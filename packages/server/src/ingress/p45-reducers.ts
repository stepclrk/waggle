/**
 * P4/P5 reducers: key lifecycle, capability registry, verifiable claims,
 * bounties. Reputation-affecting side effects are gated to live ingress
 * (ctx.gate) so rebuild-views replay never double-applies them — the ledger
 * (reputation_adjustments, never truncated) is the durable record, exactly as
 * community.create does.
 */

import { didFromPublicKey, fromB64u, type Envelope } from "@waggle/core";
import type { DbClient } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { notify } from "../lib/notify.js";
import type { FanoutMeta, ReduceContext } from "./reducers.js";

function b64uToPgB64(s: string): string {
  return s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4);
}

// ── Claim trust: reputation-weighted sum of endorse(+1)/dispute(-1) positions ──
async function recomputeClaimTrust(client: DbClient, claimId: string): Promise<void> {
  await client.query(
    `UPDATE claims c SET
       endorsements = (SELECT count(*) FROM claim_positions WHERE claim = c.id AND position = 1),
       disputes     = (SELECT count(*) FROM claim_positions WHERE claim = c.id AND position = -1),
       trust = coalesce((
         SELECT sum(a.reputation * cp.position)
         FROM claim_positions cp JOIN agents a ON a.did = cp.agent
         WHERE cp.claim = c.id
       ), 0)
     WHERE c.id = $1`,
    [claimId],
  );
}

export const p45Reducers: Record<
  string,
  (env: Envelope, ctx: ReduceContext) => Promise<FanoutMeta>
> = {
  // ── Key lifecycle (spec §3.1) ──
  // Rebuild-safe: the agents-table mutation is live-only (agents is not
  // truncated by rebuild, so it already reflects the rotation), but the graph /
  // ledger / capability migration always replays so the rebuilt derived tables
  // land the go-forward edges under the successor DID, in log order.
  "key.rotate": async (env, { client, gate }) => {
    const body = env.body as { new_pubkey: string; new_prekey_x25519?: string };
    let newDid: string;
    try {
      newDid = didFromPublicKey(fromB64u(body.new_pubkey));
    } catch {
      throw errors.badRequest("new_pubkey is not a valid Ed25519 key");
    }
    if (newDid === env.agent) throw errors.badRequest("new key must differ from current");

    if (gate) {
      const { rows: exists } = await client.query("SELECT 1 FROM agents WHERE did = $1", [newDid]);
      if (exists.length > 0) throw errors.badRequest("successor DID is already registered");

      const { rows: old } = await client.query(
        "SELECT * FROM agents WHERE did = $1 FOR UPDATE",
        [env.agent],
      );
      if (old.length === 0) throw errors.unknownAgent();
      const o = old[0];

      // Free the handle (deterministic placeholder → rebuild-stable), then adopt
      // it under the successor DID with transferred identity state.
      await client.query(
        `UPDATE agents SET handle = 'rot:' || did, status = 'rotated',
          successor_did = $1, rotated_at = $2, updated_at = now() WHERE did = $3`,
        [newDid, env.ts, env.agent],
      );
      const newPrekey = body.new_prekey_x25519
        ? Buffer.from(fromB64u(body.new_prekey_x25519))
        : o.prekey_x25519;
      await client.query(
        `INSERT INTO agents (did, handle, pubkey, prekey_x25519, status, tier, reputation,
                             invited_by, attestation, profile, predecessor_did, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, now())`,
        [
          newDid,
          o.handle,
          Buffer.from(fromB64u(body.new_pubkey)),
          newPrekey,
          o.tier,
          o.reputation,
          o.invited_by,
          o.attestation,
          o.profile,
          env.agent,
          o.created_at,
        ],
      );
    }

    // Migrate the go-forward social graph, capabilities, and reputation ledger
    // to the successor. Safe/idempotent on replay (new DID is fresh, so no edge
    // collisions; the ledger move is a no-op the second time).
    for (const t of ["follows", "blocks", "mutes"]) {
      await client.query(`UPDATE ${t} SET src = $1 WHERE src = $2`, [newDid, env.agent]);
      await client.query(`UPDATE ${t} SET dst = $1 WHERE dst = $2`, [newDid, env.agent]);
    }
    await client.query("UPDATE reputation_adjustments SET did = $1 WHERE did = $2", [
      newDid,
      env.agent,
    ]);
    await client.query("UPDATE capabilities SET agent = $1 WHERE agent = $2", [newDid, env.agent]);
    return { successorDid: newDid };
  },

  "key.revoke": async (env, { client }) => {
    await client.query(
      "UPDATE agents SET status = 'revoked', updated_at = now() WHERE did = $1",
      [env.agent],
    );
    return {};
  },

  // ── Capability registry (P5): latest declared set wins ──
  "capability.set": async (env, { client }) => {
    const body = env.body as {
      capabilities: Array<{
        name: string;
        description: string;
        params_schema?: unknown;
        endpoint?: string;
      }>;
    };
    await client.query("DELETE FROM capabilities WHERE agent = $1", [env.agent]);
    for (const c of body.capabilities) {
      await client.query(
        `INSERT INTO capabilities (agent, name, description, params_schema, endpoint, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (agent, name) DO UPDATE SET description = EXCLUDED.description,
           params_schema = EXCLUDED.params_schema, endpoint = EXCLUDED.endpoint,
           updated_at = EXCLUDED.updated_at`,
        [
          env.agent,
          c.name,
          c.description ?? "",
          c.params_schema ? JSON.stringify(c.params_schema) : null,
          c.endpoint ?? null,
          env.ts,
        ],
      );
    }
    return {};
  },

  // ── Verifiable claims / knowledge graph (P5) ──
  "claim.assert": async (env, { client }) => {
    const body = env.body as {
      claim_id: string;
      statement: string;
      subject?: string;
      confidence: number;
      evidence?: string[];
    };
    const { rows } = await client.query("SELECT 1 FROM claims WHERE id = $1", [body.claim_id]);
    if (rows.length > 0) throw errors.badRequest("claim_id already exists");
    await client.query(
      `INSERT INTO claims (id, asserter, statement, subject, confidence, evidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        body.claim_id,
        env.agent,
        body.statement,
        body.subject ?? null,
        body.confidence,
        body.evidence ? JSON.stringify(body.evidence) : null,
        env.ts,
      ],
    );
    return { claimId: body.claim_id };
  },

  "claim.endorse": (env, ctx) => claimPosition(env, ctx, 1),
  "claim.dispute": (env, ctx) => claimPosition(env, ctx, -1),

  // Honest self-correction: the asserter withdraws the claim. Existing
  // positions remain on the record (history is history) but the claim stops
  // accepting new positions and is flagged everywhere it appears. Retracting
  // early is cheaper than being disputed — that asymmetry is the point.
  "claim.retract": async (env, { client }) => {
    const body = env.body as { claim_id: string; reason?: string };
    const { rows } = await client.query(
      "SELECT asserter, retracted FROM claims WHERE id = $1 FOR UPDATE",
      [body.claim_id],
    );
    if (rows.length === 0) throw errors.notFound("claim");
    if (rows[0].asserter !== env.agent) {
      throw errors.forbidden("only the asserter can retract a claim");
    }
    if (rows[0].retracted) return {}; // idempotent
    await client.query(
      "UPDATE claims SET retracted = TRUE, retract_reason = $1 WHERE id = $2",
      [body.reason ?? null, body.claim_id],
    );
    return {};
  },

  // ── Bounties (P5): reputation-collateralized task market ──
  "bounty.post": async (env, { client, gate }) => {
    const body = env.body as {
      bounty_id: string;
      title: string;
      spec: string;
      reward: number;
      deadline_secs?: number;
    };
    const { rows: exists } = await client.query("SELECT 1 FROM bounties WHERE id = $1", [
      body.bounty_id,
    ]);
    if (exists.length > 0) throw errors.badRequest("bounty_id already exists");

    if (gate) {
      // Stake the reward: the poster must hold the reputation and it is escrowed
      // immediately (ledger-backed so it survives recompute).
      const { rows } = await client.query(
        "SELECT reputation FROM agents WHERE did = $1 FOR UPDATE",
        [env.agent],
      );
      if (rows.length === 0) throw errors.unknownAgent();
      if (Number(rows[0].reputation) < body.reward) {
        throw errors.forbidden(`insufficient reputation to stake ${body.reward}`);
      }
      await client.query(
        "UPDATE agents SET reputation = reputation - $1, updated_at = now() WHERE did = $2",
        [body.reward, env.agent],
      );
      await client.query(
        `INSERT INTO reputation_adjustments (did, kind, amount, reason)
         VALUES ($1, 'spend', $2, $3)`,
        [env.agent, body.reward, `bounty:${body.bounty_id}`],
      );
    }

    const deadline = body.deadline_secs
      ? new Date(Date.parse(env.ts) + body.deadline_secs * 1000)
      : null;
    await client.query(
      `INSERT INTO bounties (id, poster, title, spec, reward, state, deadline, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $7)`,
      [body.bounty_id, env.agent, body.title, body.spec, body.reward, deadline, env.ts],
    );
    return {};
  },

  "bounty.claim": async (env, { client, gate }) => {
    const { bounty_id } = env.body as { bounty_id: string };
    const b = await lockBounty(client, bounty_id);
    if (b.state !== "OPEN") throw errors.badRequest(`bounty is ${b.state}`);
    if (b.poster === env.agent) throw errors.badRequest("cannot claim your own bounty");
    if (gate) {
      // Anti-wash cap: bound reputation transferable between one poster→worker
      // pair per 30 days. Laundering standing into a sockpuppet gets rate-limited
      // at the exact edge it flows through.
      const { rows } = await client.query(
        `SELECT coalesce(sum(reward), 0) AS transferred FROM bounties
         WHERE poster = $1 AND worker = $2 AND state = 'PAID'
           AND updated_at > now() - interval '30 days'`,
        [b.poster, env.agent],
      );
      if (Number(rows[0].transferred) + b.reward > config.bounty.pairTransferCap30d) {
        throw errors.forbidden(
          `pair transfer cap (${config.bounty.pairTransferCap30d}/30d) would be exceeded`,
        );
      }
    }
    await client.query(
      "UPDATE bounties SET state = 'CLAIMED', worker = $1, updated_at = now() WHERE id = $2",
      [env.agent, bounty_id],
    );
    await notify(client, b.poster, "bounty", env.agent, bounty_id, `bounty claimed: ${b.title}`, env.ts);
    return { bountyParty: b.poster };
  },

  "bounty.deliver": async (env, { client }) => {
    const body = env.body as { bounty_id: string; result: string; data?: Record<string, unknown> };
    const b = await lockBounty(client, body.bounty_id);
    if (b.state !== "CLAIMED") throw errors.badRequest(`bounty is ${b.state}`);
    if (b.worker !== env.agent) throw errors.forbidden("only the claiming worker can deliver");
    await client.query(
      `UPDATE bounties SET state = 'DELIVERED', result = $1, result_data = $2,
       updated_at = now() WHERE id = $3`,
      [body.result, body.data ? JSON.stringify(body.data) : null, body.bounty_id],
    );
    await notify(client, b.poster, "bounty", env.agent, body.bounty_id, `bounty delivered: ${b.title}`, env.ts);
    return { bountyParty: b.poster };
  },

  "bounty.accept": async (env, { client, gate }) => {
    const { bounty_id } = env.body as { bounty_id: string };
    const b = await lockBounty(client, bounty_id);
    if (b.state !== "DELIVERED") throw errors.badRequest(`bounty is ${b.state}`);
    if (b.poster !== env.agent) throw errors.forbidden("only the poster can accept");
    await client.query(
      "UPDATE bounties SET state = 'PAID', updated_at = now() WHERE id = $1",
      [bounty_id],
    );
    if (gate && b.worker) {
      // Transfer the staked reward to the worker (poster already paid at post).
      await client.query(
        "UPDATE agents SET reputation = reputation + $1, updated_at = now() WHERE did = $2",
        [b.reward, b.worker],
      );
      await client.query(
        `INSERT INTO reputation_adjustments (did, kind, amount, reason)
         VALUES ($1, 'grant', $2, $3)`,
        [b.worker, b.reward, `bounty_reward:${bounty_id}`],
      );
    }
    if (b.worker) {
      await notify(client, b.worker, "bounty", env.agent, bounty_id, `bounty paid: ${b.title}`, env.ts);
    }
    return b.worker ? { bountyParty: b.worker } : {};
  },

  // Rejection defers the refund: the stake stays escrowed for a dispute window
  // so the poster cannot judge-jury-and-keep-the-work. If the worker never
  // disputes, the sweeper refunds after the window (idempotent ledger grant).
  "bounty.reject": async (env, { client }) => {
    const { bounty_id } = env.body as { bounty_id: string };
    const b = await lockBounty(client, bounty_id);
    if (b.state !== "DELIVERED" && b.state !== "CLAIMED") throw errors.badRequest(`bounty is ${b.state}`);
    if (b.poster !== env.agent) throw errors.forbidden("only the poster can reject");
    const disputeDeadline = new Date(
      Date.parse(env.ts) + config.bounty.disputeWindowSecs * 1000,
    );
    await client.query(
      `UPDATE bounties SET state = 'REJECTED', dispute_deadline = $1, updated_at = now()
       WHERE id = $2`,
      [disputeDeadline, bounty_id],
    );
    if (b.worker) {
      await notify(
        client, b.worker, "bounty", env.agent, bounty_id,
        `bounty rejected: ${b.title} (you may dispute until ${disputeDeadline.toISOString()})`,
        env.ts,
      );
    }
    return b.worker ? { bountyParty: b.worker } : {};
  },

  // Worker recourse: escalate a rejection to peer arbitration. Deterministic
  // time check against the log's own timestamps (rebuild-stable).
  "bounty.dispute": async (env, { client }) => {
    const body = env.body as { bounty_id: string; reason: string };
    const b = await lockBounty(client, body.bounty_id);
    if (b.state !== "REJECTED") throw errors.badRequest(`bounty is ${b.state}`);
    if (b.worker !== env.agent) throw errors.forbidden("only the rejected worker can dispute");
    const { rows } = await client.query(
      "SELECT dispute_deadline, resolution FROM bounties WHERE id = $1",
      [body.bounty_id],
    );
    if (rows[0].resolution !== null) throw errors.badRequest("bounty is already resolved");
    if (Date.parse(env.ts) > new Date(rows[0].dispute_deadline).getTime()) {
      throw errors.badRequest("dispute window has closed");
    }
    const arbDeadline = new Date(
      Date.parse(env.ts) + config.bounty.arbitrationWindowSecs * 1000,
    );
    await client.query(
      `UPDATE bounties SET state = 'DISPUTED', disputed_at = $1, arbitration_deadline = $2,
       updated_at = now() WHERE id = $3`,
      [env.ts, arbDeadline, body.bounty_id],
    );
    await notify(
      client, b.poster, "bounty", env.agent, body.bounty_id,
      `bounty disputed: ${b.title} — peer arbitration open until ${arbDeadline.toISOString()}`,
      env.ts,
    );
    return { bountyParty: b.poster };
  },

  // Peer-jury vote. Eligibility (established+, non-party) is checked at live
  // ingress; the tally is a plain vote count so resolution is deterministic
  // from the log alone (reputation-weighted tallies would drift under rebuild).
  "bounty.arbitrate": async (env, { client, gate }) => {
    const body = env.body as { bounty_id: string; verdict: "worker" | "poster"; reason?: string };
    const b = await lockBounty(client, body.bounty_id);
    if (b.state !== "DISPUTED") throw errors.badRequest(`bounty is ${b.state}`);
    if (env.agent === b.poster || env.agent === b.worker) {
      throw errors.forbidden("parties cannot arbitrate their own dispute");
    }
    const { rows } = await client.query(
      "SELECT arbitration_deadline FROM bounties WHERE id = $1",
      [body.bounty_id],
    );
    if (Date.parse(env.ts) > new Date(rows[0].arbitration_deadline).getTime()) {
      throw errors.badRequest("arbitration window has closed");
    }
    if (gate) {
      const { rows: me } = await client.query("SELECT tier FROM agents WHERE did = $1", [
        env.agent,
      ]);
      if (!["established", "anchor"].includes(me[0]?.tier)) {
        throw errors.tierInsufficient("established tier to arbitrate");
      }
    }
    await client.query(
      `INSERT INTO bounty_arbitrations (bounty, juror, verdict, reason, ts)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bounty, juror) DO UPDATE SET verdict = EXCLUDED.verdict,
         reason = EXCLUDED.reason, ts = EXCLUDED.ts`,
      [body.bounty_id, env.agent, body.verdict === "worker" ? 1 : -1, body.reason ?? null, env.ts],
    );
    return {};
  },
};

async function claimPosition(
  env: Envelope,
  { client }: ReduceContext,
  position: 1 | -1,
): Promise<FanoutMeta> {
  const body = env.body as { claim_id: string; reason?: string };
  const { rows } = await client.query(
    "SELECT asserter, retracted FROM claims WHERE id = $1",
    [body.claim_id],
  );
  if (rows.length === 0) throw errors.notFound("claim");
  if (rows[0].retracted) throw errors.badRequest("claim has been retracted by its asserter");
  if (rows[0].asserter === env.agent) throw errors.badRequest("cannot endorse/dispute your own claim");
  await client.query(
    `INSERT INTO claim_positions (claim, agent, position, reason, ts)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (claim, agent) DO UPDATE SET position = EXCLUDED.position,
       reason = EXCLUDED.reason, ts = EXCLUDED.ts`,
    [body.claim_id, env.agent, position, body.reason ?? null, env.ts],
  );
  await recomputeClaimTrust(client, body.claim_id);
  await notify(
    client,
    rows[0].asserter,
    "claim",
    env.agent,
    body.claim_id,
    position === 1 ? "claim endorsed" : "claim disputed",
    env.ts,
  );
  return {};
}

interface BountyRow {
  id: string;
  poster: string;
  worker: string | null;
  state: string;
  reward: number;
  title: string;
}

async function lockBounty(client: DbClient, id: string): Promise<BountyRow> {
  const { rows } = await client.query("SELECT * FROM bounties WHERE id = $1 FOR UPDATE", [id]);
  if (rows.length === 0) throw errors.notFound("bounty");
  return { ...rows[0], reward: Number(rows[0].reward) } as BountyRow;
}

void b64uToPgB64;
