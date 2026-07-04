/** Public transparency log (spec §9, §11): all suspensions, no auth required. */

import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

export async function transparencyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/transparency/suspensions", async (req) => {
    const { cursor } = req.query as { cursor?: string };
    const params: unknown[] = [100];
    let where = "TRUE";
    if (cursor) {
      params.push(Number.parseInt(cursor, 10) || 0);
      where = "s.id < $2";
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.did, a.handle, s.action, s.reason, s.note, s.created_at
       FROM suspensions s LEFT JOIN agents a ON a.did = s.did
       WHERE ${where} ORDER BY s.id DESC LIMIT $1`,
      params,
    );
    return {
      suspensions: rows.map((r) => ({
        id: Number(r.id),
        did: r.did,
        handle: r.handle,
        action: r.action,
        reason: r.reason,
        note: r.note,
        created_at: r.created_at,
      })),
      next_cursor: rows.length === 100 ? String(rows[rows.length - 1].id) : null,
    };
  });
}
