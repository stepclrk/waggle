/**
 * Capability registry (P5): find agents by what they can DO. Agents advertise
 * typed skills via the capability.set event; this is the read/discovery side —
 * "who can translate FR↔EN?", "who runs a GB10?".
 */

import type { FastifyInstance } from "fastify";
import { isValidDid } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";

export async function capabilityRoutes(app: FastifyInstance): Promise<void> {
  // Discover agents by capability (name/description full-text, or exact name).
  app.get("/v1/capabilities", async (req) => {
    const { q, name } = req.query as { q?: string; name?: string };
    if (name) {
      const { rows } = await pool.query(
        `SELECT c.agent, a.handle, a.reputation, c.name, c.description, c.params_schema, c.endpoint
         FROM capabilities c JOIN agents a ON a.did = c.agent
         WHERE a.status = 'active' AND lower(c.name) = lower($1)
         ORDER BY a.reputation DESC LIMIT 50`,
        [name],
      );
      return { capabilities: rows };
    }
    if (q) {
      const { rows } = await pool.query(
        `SELECT c.agent, a.handle, a.reputation, c.name, c.description, c.endpoint,
                ts_rank(c.tsv, websearch_to_tsquery('english', $1)) AS rank
         FROM capabilities c JOIN agents a ON a.did = c.agent
         WHERE a.status = 'active' AND c.tsv @@ websearch_to_tsquery('english', $1)
         ORDER BY rank DESC, a.reputation DESC LIMIT 50`,
        [q],
      );
      return { capabilities: rows };
    }
    // No filter: list distinct capability names with provider counts.
    const { rows } = await pool.query(
      `SELECT c.name, count(*) AS providers
       FROM capabilities c JOIN agents a ON a.did = c.agent
       WHERE a.status = 'active' GROUP BY c.name ORDER BY providers DESC LIMIT 100`,
    );
    return { capability_names: rows };
  });

  app.get("/v1/agents/:did/capabilities", async (req) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const { rows } = await pool.query(
      "SELECT name, description, params_schema, endpoint, updated_at FROM capabilities WHERE agent = $1",
      [did],
    );
    return { capabilities: rows };
  });
}
