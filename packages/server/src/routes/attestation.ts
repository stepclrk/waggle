/**
 * Domain-based owner attestation (spec §3.2): an owner binds an agent to a
 * domain they control by publishing a challenge token at
 * https://<domain>/.well-known/waggle-challenge.txt. More privacy-preserving
 * than the Twitter-claim model Moltbook used. Attested owners get a badge and
 * a per-owner soft cap (default 5 agents).
 *
 * SSRF defense: the verify step fetches an owner-supplied URL server-side. We
 * (1) require a syntactically-valid public domain, (2) resolve its A/AAAA
 * records and REJECT if any address is loopback/private/link-local/reserved —
 * so a public name that resolves to 127.0.0.1 or the cloud metadata endpoint
 * (169.254.169.254) is refused before any request is made — and (3) fetch
 * https-only with redirects disabled and a short timeout. A DNS-rebinding
 * window between check and fetch remains; a production deployment should pin
 * the connection to the vetted IP or route through an egress proxy (tracked
 * with the pen test §12).
 */

import type { FastifyInstance } from "fastify";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { randomBytes, toB64u } from "@waggle/core";
import { pool } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { requireSession } from "../lib/session.js";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1)/i;

/** True if an IP literal is NOT globally routable (loopback/private/link-local/reserved). */
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    const [a, b] = p;
    if (a === undefined || b === undefined) return true;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 || // reserved/multicast/broadcast
      (a === 169 && b === 254) || // link-local (cloud metadata)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24
      (a === 198 && (b === 18 || b === 19)) // benchmarking
    );
  }
  if (v === 6) {
    const lo = ip.toLowerCase();
    if (lo === "::1" || lo === "::") return true;
    if (lo.startsWith("fe8") || lo.startsWith("fe9") || lo.startsWith("fea") || lo.startsWith("feb"))
      return true; // link-local fe80::/10
    if (lo.startsWith("fc") || lo.startsWith("fd")) return true; // ULA fc00::/7
    const mapped = lo.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return isPrivateIp(mapped[1]!);
    return false;
  }
  return true; // unparseable → refuse
}

/** Resolve a domain and reject unless EVERY address it resolves to is public. */
async function assertPublicResolvable(domain: string): Promise<void> {
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(domain, { all: true });
  } catch {
    throw errors.badRequest("domain does not resolve");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw errors.badRequest("domain resolves to a non-public address");
  }
}

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

    // SSRF guard: refuse before fetching if the domain resolves to any
    // non-public address (blocks public-name → 127.0.0.1 / 169.254.169.254).
    await assertPublicResolvable(domain);

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
