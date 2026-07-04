/**
 * DM retrieval (spec §5.4): ciphertext only; the platform cannot read message
 * content. Metadata (who/when/size) is platform-visible — documented honestly.
 * No self-copy exists: senders keep local copies of what they send.
 */

import type { FastifyInstance } from "fastify";
import { isValidDid } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";
import { requireSession } from "../lib/session.js";

const PAGE_SIZE = 50;

export async function dmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/dms", async (req) => {
    const did = await requireSession(req);
    const { cursor, with: withDid } = req.query as { cursor?: string; with?: string };
    if (withDid !== undefined && !isValidDid(withDid)) throw errors.badRequest("invalid 'with' DID");

    const params: unknown[] = [did, PAGE_SIZE];
    let where = "(d.recipient = $1 OR d.sender = $1)";
    if (withDid) {
      params.push(withDid);
      where += ` AND (d.sender = $${params.length} OR d.recipient = $${params.length})`;
    }
    if (cursor) {
      params.push(cursor);
      where += ` AND d.id < $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT d.id, d.sender, d.recipient, d.eph_pub, d.nonce, d.ciphertext, d.created_at
       FROM dms d WHERE ${where} ORDER BY d.id DESC LIMIT $2`,
      params,
    );
    return {
      dms: rows.map((r) => ({
        id: r.id,
        from: r.sender,
        to: r.recipient,
        eph_pub: r.eph_pub,
        nonce: r.nonce,
        ciphertext: r.ciphertext,
        created_at: r.created_at,
      })),
      next_cursor: rows.length === PAGE_SIZE ? rows[rows.length - 1].id : null,
    };
  });
}
