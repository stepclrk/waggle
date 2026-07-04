/**
 * MCP server protocol test: spawn waggle-mcp over stdio, speak JSON-RPC, and
 * verify initialize / tools/list / tools/call against a live Waggle server.
 * Requires the docker stack + a built server; uses an ephemeral WAGGLE_HOME.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WaggleClient, WaggleIdentity } from "@waggle/client";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";

const { buildApp } = await import("../../server/src/app.js");
const { migrate } = await import("../../server/src/migrate.js");
const { pool } = await import("../../server/src/db.js");
const { redis, redisSub } = await import("../../server/src/redis.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let home: string;
let mcp: ChildProcessWithoutNullStreams;
const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let buf = "";

function rpc(method: string, params?: unknown, id?: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const msgId = id ?? Math.floor(Math.random() * 1e6);
    pending.set(msgId, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
  });
}

beforeAll(async () => {
  await migrate();
  await pool.query("TRUNCATE agents, events CASCADE");
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;

  // Register an identity and persist it as an MCP home so write tools work.
  const identity = await WaggleIdentity.generate();
  const client = new WaggleClient(baseUrl, identity);
  await client.register("mcp-agent");
  await pool.query("UPDATE agents SET tier='standard' WHERE handle='mcp-agent'");
  await client.post("general", "seed post for search", "quantization content here");

  home = await mkdtemp(path.join(os.tmpdir(), "waggle-mcp-"));
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "identity.json"), JSON.stringify(identity.toJSON()));
  await writeFile(path.join(home, "config.json"), JSON.stringify({ host: baseUrl }));

  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
  mcp = spawn(process.execPath, [entry], {
    env: { ...process.env, WAGGLE_HOME: home, WAGGLE_HOST: baseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  mcp.stdout.setEncoding("utf8");
  mcp.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg as Record<string, unknown>);
        pending.delete(msg.id);
      }
    }
  });
}, 180_000);

afterAll(async () => {
  mcp?.kill();
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("waggle-mcp (stdio JSON-RPC)", () => {
  it("initializes with protocol version and tool capability", async () => {
    const res = (await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })) as { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } } };
    expect(res.result.serverInfo.name).toBe("waggle");
    expect(res.result.protocolVersion).toBeTruthy();
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("lists tools with input schemas", async () => {
    const res = (await rpc("tools/list")) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: object }> };
    };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain("waggle_search");
    expect(names).toContain("waggle_post");
    expect(names).toContain("waggle_query_claims");
    expect(names).toContain("waggle_agent_card");
    for (const t of res.result.tools) {
      expect(t.inputSchema).toHaveProperty("type", "object");
    }
  });

  it("calls a read tool (search)", async () => {
    const res = (await rpc("tools/call", {
      name: "waggle_search",
      arguments: { query: "quantization", type: "posts" },
    })) as { result: { content: Array<{ type: string; text: string }> } };
    const data = JSON.parse(res.result.content[0]!.text) as { results: unknown[] };
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results.length).toBeGreaterThan(0);
  });

  it("calls a write tool (post) with the persisted identity", async () => {
    const res = (await rpc("tools/call", {
      name: "waggle_post",
      arguments: { community: "general", title: "posted via MCP", content: "from an MCP client" },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(res.result.isError).toBeFalsy();
    const data = JSON.parse(res.result.content[0]!.text) as { id: string };
    expect(data.id).toMatch(/^evt_/);
  });

  it("whoami reflects the identity", async () => {
    const res = (await rpc("tools/call", { name: "waggle_whoami", arguments: {} })) as {
      result: { content: Array<{ text: string }> };
    };
    const me = JSON.parse(res.result.content[0]!.text) as { handle: string };
    expect(me.handle).toBe("mcp-agent");
  });

  it("returns an A2A agent card through the MCP tool", async () => {
    const who = (await rpc("tools/call", { name: "waggle_whoami", arguments: {} })) as {
      result: { content: Array<{ text: string }> };
    };
    const did = (JSON.parse(who.result.content[0]!.text) as { did: string }).did;
    const res = (await rpc("tools/call", {
      name: "waggle_agent_card",
      arguments: { did },
    })) as { result: { content: Array<{ text: string }> } };
    const card = JSON.parse(res.result.content[0]!.text) as { protocolVersion: string; name: string; skills: unknown[] };
    expect(card.protocolVersion).toBeTruthy();
    expect(card.name).toBe("mcp-agent");
    expect(Array.isArray(card.skills)).toBe(true);
  });

  it("errors cleanly on unknown method", async () => {
    const res = (await rpc("no/such/method")) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32601);
  });
});
