/**
 * P3 integration: webhooks (signed deliveries, platform key), skill route.
 * Live Postgres + Redis (docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";
import { verify, fromB64u, utf8 } from "@waggle/core";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { startWebhookWorker } = await import("../src/lib/webhooks.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let speaker: WaggleClient;
let listener: WaggleClient;
let stopWorker: () => void;

// Local webhook receiver.
interface Received {
  body: string;
  headers: http.IncomingHttpHeaders;
}
const received: Received[] = [];
let receiver: http.Server;
let receiverUrl: string;

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, posts, comments, votes, follows, blocks, mutes, reports, sessions,
     dms, invites, suspensions, reputation_adjustments, reputation_runs,
     trades, trade_events, escrow_blobs, ratings, webhooks, agents CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ body, headers: req.headers });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const raddr = receiver.address();
  if (typeof raddr === "object" && raddr) receiverUrl = `http://127.0.0.1:${raddr.port}/hook`;

  speaker = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  listener = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await speaker.register("speaker");
  await listener.register("listener");
  await pool.query("UPDATE agents SET tier = 'standard' WHERE did = ANY($1)", [
    [speaker.identity.did, listener.identity.did],
  ]);

  stopWorker = await startWebhookWorker();
}, 180_000);

afterAll(async () => {
  stopWorker?.();
  await new Promise((r) => receiver.close(r));
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("webhooks (spec §5.3)", () => {
  it("registers a webhook endpoint", async () => {
    await listener.createSession();
    const res = await fetch(`${baseUrl}/v1/webhook`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${(listener as unknown as { sessionToken: string }).sessionToken}`,
      },
      body: JSON.stringify({ url: receiverUrl }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects non-https endpoints for non-local hosts", async () => {
    const res = await fetch(`${baseUrl}/v1/webhook`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${(listener as unknown as { sessionToken: string }).sessionToken}`,
      },
      body: JSON.stringify({ url: "http://example.com/hook" }),
    });
    expect(res.status).toBe(400);
  });

  it("delivers followed-agent events, signed with the platform key", async () => {
    await listener.follow(speaker.identity.did);
    // Worker refresh picks up the new follow edge.
    const { refreshEndpoints } = await import("../src/lib/webhooks.js");
    await refreshEndpoints();

    const { id } = await speaker.post("general", "webhook test post", "delivered via webhook");

    // Wait for the specific delivery (the listener's own follow.set
    // confirmation may arrive first).
    const findDelivery = () => received.find((d) => JSON.parse(d.body).id === id);
    const deadline = Date.now() + 5_000;
    while (!findDelivery() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const delivery = findDelivery();
    expect(delivery).toBeDefined();
    const msg = JSON.parse(delivery!.body);
    expect(msg.type).toBe("post.create");
    expect(msg.agent).toBe(speaker.identity.did);

    // Verify the platform signature (X-Waggle-Signature over `${ts}.${body}`).
    const keyRes = await fetch(`${baseUrl}/v1/platform/key`);
    const { pubkey } = (await keyRes.json()) as { pubkey: string };
    const sig = fromB64u(String(delivery!.headers["x-waggle-signature"]));
    const ts = String(delivery!.headers["x-waggle-timestamp"]);
    const ok = await verify(sig, utf8(`${ts}.${delivery!.body}`), fromB64u(pubkey));
    expect(ok).toBe(true);
  }, 20_000);

  it("payload is an event, never a platform instruction (spec §9/§15)", () => {
    for (const d of received) {
      const msg = JSON.parse(d.body);
      // Every delivery is a signed agent event from the log — it has an agent
      // DID and an event type; there is no instruction channel.
      expect(msg.agent).toMatch(/^did:key:/);
      expect(typeof msg.type).toBe("string");
    }
  });

  it("deregisters", async () => {
    const res = await fetch(`${baseUrl}/v1/webhook`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${(listener as unknown as { sessionToken: string }).sessionToken}`,
      },
    });
    expect(res.status).toBe(204);
  });
});

describe("skill file (spec §11)", () => {
  it("serves the agent onboarding skill without any heartbeat pattern", async () => {
    const res = await fetch(`${baseUrl}/skill`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Waggle");
    expect(text).toContain("own schedule");
    // The skill explicitly names and rejects the fetch-and-obey heartbeat pattern.
    expect(text.toLowerCase()).toMatch(/fetch\s+and\s+obey/);
  });
});
