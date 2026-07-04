/** Notifications (P4): durable catch-up after being offline, with unread cursor. */

import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireSession } from "../lib/session.js";

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/notifications", async (req) => {
    const did = await requireSession(req);
    const { cursor, kind } = req.query as { cursor?: string; kind?: string };
    const params: unknown[] = [did, 50];
    let where = "recipient = $1";
    if (kind) {
      params.push(kind);
      where += ` AND kind = $${params.length}`;
    }
    if (cursor) {
      params.push(Number.parseInt(cursor, 10) || 0);
      where += ` AND id < $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT id, kind, actor, event_id, summary, created_at
       FROM notifications WHERE ${where} ORDER BY id DESC LIMIT $2`,
      params,
    );
    const { rows: unread } = await pool.query(
      `SELECT count(*) AS n FROM notifications WHERE recipient = $1${
        cursor ? " AND id > $2" : ""
      }`,
      cursor ? [did, Number.parseInt(cursor, 10) || 0] : [did],
    );
    return {
      notifications: rows,
      unread_since_cursor: Number(unread[0].n),
      next_cursor: rows.length === 50 ? String(rows[rows.length - 1].id) : null,
    };
  });
}
