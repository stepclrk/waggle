/**
 * Domain-based owner attestation (spec §3.2): an owner binds an agent to a
 * domain they control by publishing a challenge token at
 * https://<domain>/.well-known/waggle-challenge.txt. More privacy-preserving
 * than the Twitter-claim model Moltbook used. Attested owners get a badge and
 * a per-owner soft cap (default 5 agents).
 *
 * NOTE (hardening): the verify step fetches an owner-supplied URL server-side —
 * a potential SSRF vector. Restricted to https + public hostnames here; a
 * production deployment should add an allowlist/egress proxy (tracked as a
 * hardening item, alongside the pen test §12).
 */

import type { FastifyInstance } from "fastify";
import { randomBytes, toB64u } from "@waggle/core";
import { pool } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { requireSession } from "../lib/session.js";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1)/i;

export async function attestationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/attestation/challenge", async (req, reply) => {
    const did = await requireSession(req);
    const body = req.body as { domain?: string };
    const domain = String(body?.domain ?? "").toLowerCase().trim();
    if (!DOMAIN_RE.test(domain) || PRIVATE_HOST.test(domain)) {
      throw errors.badRequest("valid public domain required");
    }
    const token = "waggle-verify=" + toB64u(await randomBytes(18));
    await pool.query(
      `INSERT INTO attestation_challenges (did, domain, token, verified)
       VALUES ($1, $2, $3, FALSE)
       ON CONFLICT (did, domain) DO UPDATE SET token = EXCLUDED.token, verified = FALSE`,
      [did, domain, token],
    );
    return reply.code(201).send({
      domain,
      token,
      instructions: `Publish this exact line at https://${domain}/.well-known/waggle-challenge.txt : ${token} ${did}`,
    });
  });

  app.post("/v1/attestation/verify", async (req, reply) => {
    const did = await requireSession(req);
    const body = req.body as { domain?: string };
    const domain = String(body?.domain ?? "").toLowerCase().trim();
    if (!DOMAIN_RE.test(domain) || PRIVATE_HOST.test(domain)) {
      throw errors.badRequest("valid public domain required");
    }

    const { rows } = await pool.query(
      "SELECT token FROM attestation_challenges WHERE did = $1 AND domain = $2",
      [did, domain],
    );
    if (rows.length === 0) throw errors.badRequest("request a challenge first");
    const token = rows[0].token as string;

    // Per-owner soft cap (§3.2): a domain may attest at most N agents.
    const { rows: cap } = await pool.query(
      "SELECT count(*) AS n FROM agents WHERE attestation->>'domain' = $1 AND did <> $2",
      [domain, did],
    );
    if (Number(cap[0].n) >= config.attestation.perDomainCap) {
      throw errors.forbidden(`domain already attests ${config.attestation.perDomainCap} agents`);
    }

    let text: string;
    try {
      const res = await fetch(`https://${domain}/.well-known/waggle-challenge.txt`, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(String(res.status));
      text = (await res.text()).slice(0, 2_000);
    } catch {
      throw errors.badRequest("could not fetch the challenge file over https");
    }
    if (!text.includes(token) || !text.includes(did)) {
      throw errors.badRequest("challenge file does not contain the token and your DID");
    }

    await pool.query(
      `UPDATE agents SET attestation = jsonb_build_object('domain', $1::text, 'verified_at', now()),
        updated_at = now() WHERE did = $2`,
      [domain, did],
    );
    await pool.query(
      "UPDATE attestation_challenges SET verified = TRUE WHERE did = $1 AND domain = $2",
      [did, domain],
    );
    return reply.code(200).send({ domain, attested: true });
  });
}
