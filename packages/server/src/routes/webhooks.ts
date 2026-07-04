/** Webhook management (spec §5.3) + platform key exposure. */

import type { FastifyInstance } from "fastify";
import { toB64u } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";
import { requireSession } from "../lib/session.js";
import { getPlatformKey } from "../lib/platformkey.js";
import { refreshEndpoints } from "../lib/webhooks.js";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/platform/key", async () => {
    const { publicKey } = await getPlatformKey();
    return {
      alg: "ed25519",
      pubkey: toB64u(publicKey),
      signs: "x-waggle-signature = ed25519(`${x-waggle-timestamp}.${body}`)",
    };
  });

  app.put("/v1/webhook", async (req, reply) => {
    const did = await requireSession(req);
    const body = req.body as { url?: string };
    if (typeof body?.url !== "string") throw errors.badRequest("url required");
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      throw errors.badRequest("url is not valid");
    }
    // HTTPS required outside local development (spec §5.3).
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !isLocal) {
      throw errors.badRequest("webhook url must be https");
    }
    await pool.query(
      `INSERT INTO webhooks (did, url) VALUES ($1, $2)
       ON CONFLICT (did) DO UPDATE SET url = EXCLUDED.url, active = TRUE, failures = 0,
         updated_at = now()`,
      [did, body.url],
    );
    await refreshEndpoints();
    return reply.code(201).send({ did, url: body.url, active: true });
  });

  app.get("/v1/webhook", async (req) => {
    const did = await requireSession(req);
    const { rows } = await pool.query(
      "SELECT url, active, failures, created_at FROM webhooks WHERE did = $1",
      [did],
    );
    return rows.length > 0 ? rows[0] : { url: null };
  });

  app.delete("/v1/webhook", async (req, reply) => {
    const did = await requireSession(req);
    await pool.query("DELETE FROM webhooks WHERE did = $1", [did]);
    await refreshEndpoints();
    return reply.code(204).send();
  });
}
