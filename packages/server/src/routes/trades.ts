/**
 * Trade registry-plane routes (spec §8.5-§8.6, §11):
 *  - escrow blob upload (hash-verified against the on-log commitment)
 *  - payload download (released only in REVEALED/CLOSED — both or neither)
 *  - verifiable disclosure (recipient proves what the accused party committed)
 *  - trade reads (parties only)
 */

import type { FastifyInstance } from "fastify";
import { openTradeBlobWithKey, tradeBlobHash, fromB64u, sha256, toB64u } from "@waggle/core";
import { ulid } from "ulid";
import { pool } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { requireSession } from "../lib/session.js";
import { blobStore, escrowRef } from "../lib/blobstore.js";

const TRADE_ID_PARAM_RE = /^trd_[0-9A-HJKMNP-TV-Z]{26}$/;

interface TradeRow {
  id: string;
  initiator: string;
  counterparty: string;
  state: string;
  initiator_commit: string | null;
  counterparty_commit: string | null;
}

async function loadTradeFor(did: string, tradeId: string): Promise<TradeRow> {
  if (!TRADE_ID_PARAM_RE.test(tradeId)) throw errors.badRequest("invalid trade id");
  const { rows } = await pool.query("SELECT * FROM trades WHERE id = $1", [tradeId]);
  if (rows.length === 0) throw errors.notFound("trade");
  const trade = rows[0] as TradeRow;
  if (trade.initiator !== did && trade.counterparty !== did) {
    // Parties only (spec §11): outsiders can't even confirm existence.
    throw errors.notFound("trade");
  }
  return trade;
}

export async function tradeRoutes(app: FastifyInstance): Promise<void> {
  // Escrow deposit: raw ciphertext blob, verified against the committed hash.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: config.trade.blobMaxBytes + 4096 },
    (_req, body, done) => done(null, body),
  );

  app.put("/v1/trades/:id/escrow", async (req, reply) => {
    const did = await requireSession(req);
    const { id } = req.params as { id: string };
    const trade = await loadTradeFor(did, id);

    if (trade.state !== "COMMITTED" && trade.state !== "ACCEPTED") {
      throw errors.badRequest(`cannot deposit escrow in ${trade.state}`);
    }
    const committed = trade.initiator === did ? trade.initiator_commit : trade.counterparty_commit;
    if (!committed) throw errors.badRequest("commit your payload_hash before depositing");

    const blob = req.body as Buffer;
    if (!Buffer.isBuffer(blob) || blob.length === 0) {
      throw errors.badRequest("raw blob body required (application/octet-stream)");
    }
    if (blob.length > config.trade.blobMaxBytes) {
      throw errors.badRequest(`blob exceeds ${config.trade.blobMaxBytes} bytes`);
    }

    // Binding (spec §8.4.2): hash-of-ciphertext must equal the commitment.
    const hash = await tradeBlobHash(new Uint8Array(blob));
    if (hash !== committed) {
      throw errors.badRequest("blob hash does not match the committed payload_hash");
    }

    const ref = escrowRef(id, did);
    await blobStore.put(ref, blob);
    await pool.query(
      `INSERT INTO escrow_blobs (trade, agent, hash, size, storage_ref)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trade, agent) DO UPDATE SET hash = EXCLUDED.hash, size = EXCLUDED.size,
         storage_ref = EXCLUDED.storage_ref, submitted_at = now()`,
      [id, did, hash, blob.length, ref],
    );
    return reply.code(201).send({ trade: id, hash, size: blob.length });
  });

  // Payload release: the counterparty's blob, only after both revealed (§8.4.1).
  app.get("/v1/trades/:id/payload", async (req, reply) => {
    const did = await requireSession(req);
    const { id } = req.params as { id: string };
    const trade = await loadTradeFor(did, id);

    if (trade.state !== "REVEALED" && trade.state !== "CLOSED") {
      throw errors.forbidden("payloads release only when both parties have revealed");
    }
    const other = trade.initiator === did ? trade.counterparty : trade.initiator;
    const { rows } = await pool.query(
      "SELECT storage_ref FROM escrow_blobs WHERE trade = $1 AND agent = $2",
      [id, other],
    );
    if (rows.length === 0) throw errors.notFound("payload (retention window has passed)");
    const blob = await blobStore.get(rows[0].storage_ref);
    if (!blob) throw errors.notFound("payload (retention window has passed)");
    return reply.type("application/octet-stream").send(blob);
  });

  // Verifiable disclosure (spec §8.5): a recipient reveals the symmetric key;
  // the platform opens the escrowed ciphertext against the on-log commitment.
  // False reports are cryptographically impossible to fabricate.
  app.post("/v1/trades/:id/disclose", async (req, reply) => {
    const did = await requireSession(req);
    const { id } = req.params as { id: string };
    const trade = await loadTradeFor(did, id);
    const body = req.body as { key?: string; reason?: string };
    if (typeof body?.key !== "string") throw errors.badRequest("key (base64url) required");

    const other = trade.initiator === did ? trade.counterparty : trade.initiator;
    const { rows } = await pool.query(
      "SELECT storage_ref, hash FROM escrow_blobs WHERE trade = $1 AND agent = $2",
      [id, other],
    );
    if (rows.length === 0) throw errors.notFound("escrowed payload (retention window has passed)");
    const blob = await blobStore.get(rows[0].storage_ref);
    if (!blob) throw errors.notFound("escrowed payload (retention window has passed)");

    // Recompute the commitment, then open with the disclosed key.
    const blobBytes = new Uint8Array(blob);
    const hash = await tradeBlobHash(blobBytes);
    const committed = trade.initiator === other ? trade.initiator_commit : trade.counterparty_commit;
    if (hash !== committed) throw errors.badRequest("escrow does not match commitment");

    let plaintext: Uint8Array;
    try {
      plaintext = await openTradeBlobWithKey(blobBytes, fromB64u(body.key));
    } catch {
      throw errors.badRequest("key does not open the escrowed ciphertext");
    }

    // Verified: what the accused party committed is exactly this content.
    // File a report for the operator console; plaintext itself is not stored —
    // only its hash and the key, so an operator can reproduce the check.
    const reportId = `evt_${ulid()}`;
    const plaintextHash = toB64u(await sha256(plaintext));
    await pool.query(
      `INSERT INTO reports (id, reporter, target_event, reason, evidence, created_at)
       VALUES ($1, $2, $3, 'illegal', $4, now())`,
      [
        reportId,
        did,
        id, // trade id as the target reference
        JSON.stringify({
          kind: "trade_disclosure",
          trade: id,
          accused: other,
          disclosed_key: body.key,
          plaintext_sha256_b64u: plaintextHash,
          plaintext_bytes: plaintext.length,
          note: body.reason ?? null,
        }),
      ],
    );
    return reply.code(201).send({
      verified: true,
      report_id: reportId,
      accused: other,
      plaintext_sha256_b64u: plaintextHash,
    });
  });

  app.get("/v1/trades/:id", async (req) => {
    const did = await requireSession(req);
    const { id } = req.params as { id: string };
    const t = (await loadTradeFor(did, id)) as TradeRow & Record<string, unknown>;
    const { rows: steps } = await pool.query(
      "SELECT id, agent, type, payload_hash, ts FROM trade_events WHERE trade = $1 ORDER BY ts",
      [id],
    );
    const { rows: myRatings } = await pool.query(
      "SELECT rater, score, comment, ts FROM ratings WHERE trade = $1",
      [id],
    );
    return {
      id: t.id,
      initiator: t.initiator,
      counterparty: t.counterparty,
      state: t.state,
      offer_summary: t.offer_summary,
      want_summary: t.want_summary,
      timeouts: t.timeouts,
      deadline: t.deadline,
      commits: {
        initiator: t.initiator_commit,
        counterparty: t.counterparty_commit,
      },
      revealed: {
        initiator: t.initiator_revealed,
        counterparty: t.counterparty_revealed,
      },
      defector: t.defector,
      created_at: t.created_at,
      steps,
      ratings: myRatings,
    };
  });

  app.get("/v1/trades", async (req) => {
    const did = await requireSession(req);
    const { state } = req.query as { state?: string };
    const params: unknown[] = [did];
    let where = "(initiator = $1 OR counterparty = $1)";
    if (state) {
      params.push(state.toUpperCase());
      where += ` AND state = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT id, initiator, counterparty, state, offer_summary, want_summary, deadline, created_at
       FROM trades WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
      params,
    );
    return { trades: rows };
  });
}
