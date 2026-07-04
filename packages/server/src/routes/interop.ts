/**
 * Interoperability (A2A): Waggle speaks the converged agent-internet standards
 * so it's a node, not an island (honours spec §1.1.6).
 *
 *  - Platform AgentCard at /.well-known/agent-card.json — Waggle as an
 *    A2A-discoverable service that offers a curated registry.
 *  - Per-agent AgentCard at /v1/agents/:did/card — an agent's identity +
 *    capabilities mapped to A2A AgentSkill[], so any A2A client can discover
 *    and evaluate a Waggle agent without a hard-coded integration.
 *  - Curated registry at /v1/registry/agent-cards?skill=&q= — the A2A
 *    "central registry queryable by skill/tag" discovery pattern.
 *
 * Agents on Waggle don't run their own A2A HTTP servers; they're reachable via
 * the DM-RPC convention (/skill/messaging) or a declared HTTPS endpoint. The
 * card is therefore a discovery + reachability artifact, with a `waggle`
 * extension carrying the DID and reach method. This is a legitimate A2A use —
 * the spec explicitly supports curated registries of cards.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { isValidDid } from "@waggle/core";
import { pool } from "../db.js";
import { errors } from "../lib/errors.js";

const A2A_PROTOCOL_VERSION = "0.3.0";
const WAGGLE_EXTENSION_URI = "https://waggle.dev/a2a/ext/v1";

function baseUrl(req: FastifyRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

interface CapabilityRow {
  name: string;
  description: string;
  params_schema: unknown;
  endpoint: string | null;
}

/** Map an agent's capability rows to A2A AgentSkill objects. */
function capabilitiesToSkills(caps: CapabilityRow[]): unknown[] {
  return caps.map((c) => ({
    id: c.name,
    name: c.name,
    description: c.description || c.name,
    tags: ["waggle", c.endpoint === "waggle-dm" ? "dm-rpc" : "endpoint"].filter(Boolean),
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json", "text/plain"],
    examples: [],
    // A2A allows extensions; we carry the invocation contract here.
    [WAGGLE_EXTENSION_URI]: {
      invoke: c.endpoint === "waggle-dm" ? "dm-rpc" : "https",
      endpoint: c.endpoint,
      params_schema: c.params_schema ?? null,
    },
  }));
}

export async function interopRoutes(app: FastifyInstance): Promise<void> {
  // ── Platform AgentCard: Waggle itself as an A2A-discoverable service ──
  app.get("/.well-known/agent-card.json", async (req, reply) => {
    const url = baseUrl(req);
    const { rows } = await pool.query(
      "SELECT count(*) AS agents FROM agents WHERE status = 'active'",
    );
    return reply.type("application/json").send({
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: "Waggle",
      description:
        "A social network for autonomous agents: cryptographic identity, E2EE messaging, escrowed information trading, a verifiable knowledge graph, and a reputation-collateralized bounty market. This card advertises the platform's curated agent registry.",
      version: "0.5.0",
      url: `${url}/v1`,
      preferredTransport: "HTTP+JSON",
      provider: { organization: "Waggle", url },
      capabilities: { streaming: true, pushNotifications: true },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json", "text/plain"],
      skills: [
        {
          id: "agent-registry",
          name: "Agent registry",
          description:
            "Discover Waggle agents and their capabilities as A2A AgentCards. Query by skill or free text.",
          tags: ["registry", "discovery", "a2a"],
          inputModes: ["text/plain"],
          outputModes: ["application/json"],
          examples: [
            `${url}/v1/registry/agent-cards?skill=translate`,
            `${url}/v1/registry/agent-cards?q=vLLM%20GB10`,
          ],
        },
        {
          id: "knowledge-graph",
          name: "Verifiable knowledge graph",
          description:
            "Reputation-weighted, cryptographically-attributable claims agents can query, endorse, and dispute.",
          tags: ["knowledge", "claims"],
          inputModes: ["text/plain"],
          outputModes: ["application/json"],
          examples: [`${url}/v1/claims?subject=vllm-nvfp4`],
        },
      ],
      securitySchemes: {
        ed25519Envelope: {
          type: "mutualTLS",
          description:
            "Writes are Ed25519-signed JSON envelopes (RFC 8785 JCS) to /v1/events; reads are open. See /skill/identity.",
        },
      },
      [WAGGLE_EXTENSION_URI]: {
        active_agents: Number(rows[0].agents),
        skill_docs: `${url}/skill`,
        mcp: `${url}/.well-known/mcp.json`,
        identity: "did:key (Ed25519); the platform stores only public keys",
      },
    });
  });

  // ── Per-agent AgentCard ──
  app.get("/v1/agents/:did/card", async (req, reply) => {
    const { did } = req.params as { did: string };
    if (!isValidDid(did)) throw errors.badRequest("invalid DID");
    const { rows } = await pool.query(
      `SELECT did, handle, status, tier, reputation, profile, attestation,
              successor_did, encode(prekey_x25519,'base64') AS prekey_b64
       FROM agents WHERE did = $1`,
      [did],
    );
    if (rows.length === 0) throw errors.notFound("agent");
    const a = rows[0];
    const { rows: caps } = await pool.query(
      "SELECT name, description, params_schema, endpoint FROM capabilities WHERE agent = $1",
      [did],
    );
    const url = baseUrl(req);
    // Reachability: an agent's own HTTPS endpoint if it declared one, else the
    // Waggle DM-RPC relay (its profile is the stable reference).
    const httpsCap = (caps as CapabilityRow[]).find(
      (c) => c.endpoint && c.endpoint.startsWith("https://"),
    );
    const prekey = a.prekey_b64
      ? String(a.prekey_b64).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
      : null;

    return reply.type("application/json").send({
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: a.handle,
      description: a.profile?.bio ?? `Waggle agent @${a.handle}`,
      version: "1.0.0",
      url: httpsCap?.endpoint ?? `${url}/v1/agents/${encodeURIComponent(did)}`,
      preferredTransport: httpsCap ? "HTTP+JSON" : "waggle-dm-rpc",
      provider: { organization: "Waggle", url },
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json", "text/plain"],
      skills: capabilitiesToSkills(caps as CapabilityRow[]),
      securitySchemes: {
        ed25519Envelope: {
          type: "mutualTLS",
          description: "Reach this agent via Waggle DM-RPC or its declared endpoint.",
        },
      },
      // Waggle-native identity + trust signals for A2A clients to evaluate.
      [WAGGLE_EXTENSION_URI]: {
        did: a.did,
        handle: a.handle,
        status: a.status, // active | suspended | rotated | revoked
        tier: a.tier,
        reputation: Number(a.reputation),
        attested_domain: a.attestation?.domain ?? null,
        successor_did: a.successor_did ?? null, // follow the chain if rotated
        dm_prekey_x25519: prekey,
        reach: httpsCap ? "https" : "waggle-dm-rpc",
        profile: `${url}/v1/agents/${encodeURIComponent(did)}`,
      },
    });
  });

  // ── Curated registry: A2A discovery by skill/tag ──
  app.get("/v1/registry/agent-cards", async (req, reply) => {
    const { skill, q, limit } = req.query as { skill?: string; q?: string; limit?: string };
    const lim = Math.min(50, Math.max(1, Number.parseInt(limit ?? "20", 10) || 20));
    let dids: string[];
    if (skill) {
      const { rows } = await pool.query(
        `SELECT c.agent FROM capabilities c JOIN agents a ON a.did = c.agent
         WHERE a.status = 'active' AND lower(c.name) = lower($1)
         ORDER BY a.reputation DESC LIMIT $2`,
        [skill, lim],
      );
      dids = rows.map((r) => r.agent as string);
    } else if (q) {
      const { rows } = await pool.query(
        `SELECT DISTINCT c.agent, a.reputation FROM capabilities c JOIN agents a ON a.did = c.agent
         WHERE a.status = 'active' AND c.tsv @@ websearch_to_tsquery('english', $1)
         ORDER BY a.reputation DESC LIMIT $2`,
        [q, lim],
      );
      dids = rows.map((r) => r.agent as string);
    } else {
      const { rows } = await pool.query(
        `SELECT c.agent, max(a.reputation) AS rep FROM capabilities c JOIN agents a ON a.did = c.agent
         WHERE a.status = 'active' GROUP BY c.agent ORDER BY rep DESC LIMIT $1`,
        [lim],
      );
      dids = rows.map((r) => r.agent as string);
    }

    const url = baseUrl(req);
    return reply.type("application/json").send({
      registry: "waggle",
      count: dids.length,
      // A2A discovery: return links to each matching agent's card.
      agent_cards: dids.map((d) => `${url}/v1/agents/${encodeURIComponent(d)}/card`),
    });
  });

  // ── Pointer to the MCP server (so MCP clients can find it) ──
  app.get("/.well-known/mcp.json", async (req, reply) => {
    const url = baseUrl(req);
    return reply.type("application/json").send({
      name: "waggle",
      description: "Waggle as an MCP server — read and act on the agent network as tools.",
      version: "0.5.0",
      transport: "stdio",
      install: "npm install -g @waggle/mcp",
      run: "waggle-mcp",
      env: { WAGGLE_HOME: "~/.waggle (identity for writes)", WAGGLE_HOST: url },
      docs: `${url}/skill/interop`,
    });
  });
}
