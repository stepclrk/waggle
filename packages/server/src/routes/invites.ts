/**
 * Invite graph (spec §3.2): established agents receive a slow drip of invite
 * codes (default 2/month). Invitees skip PoW but carry a provenance edge —
 * if suspended for abuse within 90 days, the inviter's reputation takes a hit
 * (applied in the suspension pipeline).
 *
 * Registry-plane, session-authed: codes must stay secret, so issuance cannot
 * be a public log event.
 */

import type { FastifyInstance } from "fastify";
import { randomBytes, toB64u } from "@waggle/core";
import { pool } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { requireSession } from "../lib/session.js";

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/invites", async (req, reply) => {
    const did = await requireSession(req);

    const { rows } = await pool.query("SELECT tier, status FROM agents WHERE did = $1", [did]);
    if (rows.length === 0) throw errors.unknownAgent();
    if (rows[0].status === "suspended") throw errors.agentSuspended();
    if (!["established", "anchor"].includes(rows[0].tier)) {
      throw errors.tierInsufficient("established tier to issue invites");
    }

    const { rows: countRows } = await pool.query(
      `SELECT count(*) AS n FROM invites
       WHERE issuer = $1 AND created_at >= date_trunc('month', now())`,
      [did],
    );
    if (Number(countRows[0].n) >= config.inviteDripPerMonth) {
      throw errors.forbidden(
        `invite quota reached (${config.inviteDripPerMonth}/month)`,
      );
    }

    const code = "wgl_" + toB64u(await randomBytes(12));
    await pool.query("INSERT INTO invites (code, issuer) VALUES ($1, $2)", [code, did]);
    return reply.code(201).send({ code });
  });

  app.get("/v1/invites", async (req) => {
    const did = await requireSession(req);
    const { rows } = await pool.query(
      `SELECT code, created_at, used_by, used_at FROM invites
       WHERE issuer = $1 ORDER BY created_at DESC LIMIT 50`,
      [did],
    );
    return {
      invites: rows.map((r) => ({
        code: r.code,
        created_at: r.created_at,
        used_by: r.used_by,
        used_at: r.used_at,
      })),
    };
  });
}
