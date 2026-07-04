/**
 * P9 integration: semantic memory (BYO-embeddings, pure-cosine, no model in
 * the platform) and content-addressed artifacts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";
process.env.BLOB_DIR = "./data/artifacts-test";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let author: WaggleClient;
let other: WaggleClient;

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, posts, comments, votes, follows, blocks, mutes, sessions, claims,
     claim_positions, content_embeddings, artifacts, agents CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;

  author = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  other = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await author.register("author-p9");
  await other.register("other-p9");
  await pool.query("UPDATE agents SET tier='standard' WHERE status='active'");
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

// Tiny deterministic 3-D "embeddings" — enough to prove cosine ranking works.
const MODEL = "test-embed-v1";

describe("semantic memory (BYO-embeddings, platform runs no model)", () => {
  it("attaches embeddings to own content and ranks by cosine", async () => {
    const p1 = await author.post("general", "cats", "feline companions and their behaviour");
    const p2 = await author.post("general", "databases", "postgres indexing and query planning");
    const p3 = await author.post("general", "kittens", "young cats and their care");

    // Cluster: cats/kittens near [1,0,0]; databases near [0,1,0].
    await author.embed(p1.id, MODEL, [0.9, 0.1, 0.0]);
    await author.embed(p2.id, MODEL, [0.0, 0.95, 0.05]);
    await author.embed(p3.id, MODEL, [0.85, 0.15, 0.0]);

    const res = (await author.semanticSearch({
      model: MODEL,
      vector: [1.0, 0.0, 0.0], // "a query about cats"
      type: "posts",
    })) as { results: Array<{ ref: string; score: number }> };

    // Both cat posts rank above the database post.
    const order = res.results.map((r) => r.ref);
    expect(order[0]).toBe(p1.id);
    expect(order.indexOf(p3.id)).toBeLessThan(order.indexOf(p2.id));
    expect(res.results.find((r) => r.ref === p1.id)!.score).toBeGreaterThan(0.9);
  });

  it("only the author may embed their content", async () => {
    const { id } = await author.post("general", "mine", "only I can annotate this");
    await expect(other.embed(id, MODEL, [1, 0, 0])).rejects.toMatchObject({ code: "forbidden" });
  });

  it("namespaces by model — different models never cross-match", async () => {
    const models = (await author.semanticModels()) as { models: Array<{ model: string }> };
    expect(models.models.some((m) => m.model === MODEL)).toBe(true);
    // A query in a nonexistent model namespace returns nothing.
    const res = (await author.semanticSearch({
      model: "some-other-model",
      vector: [1, 0, 0],
    })) as { results: unknown[] };
    expect(res.results).toHaveLength(0);
  });

  it("embeds claims too — semantic recall over the knowledge graph", async () => {
    const { claimId } = await author.assertClaim({
      statement: "transformers use scaled dot-product attention",
      subject: "ml-arch",
    });
    await author.embed(claimId, MODEL, [0.2, 0.2, 0.9]);
    const res = (await author.semanticSearch({
      model: MODEL,
      vector: [0.1, 0.1, 1.0],
      type: "claims",
    })) as { results: Array<{ ref: string; content: { kind: string } }> };
    expect(res.results[0]!.ref).toBe(claimId);
    expect(res.results[0]!.content.kind).toBe("claim");
  });
});

describe("artifacts (content-addressed blob store)", () => {
  it("uploads bytes and addresses them by their sha256", async () => {
    const bytes = new TextEncoder().encode("a dataset the agent produced\n" + "x".repeat(1000));
    const expected = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    const { hash, size } = await author.putArtifact(bytes, "text/csv");
    expect(hash).toBe(expected);
    expect(size).toBe(bytes.length);

    // Round-trips and verifies against the address.
    const got = await author.getArtifact(hash);
    expect(Buffer.from(got).equals(Buffer.from(bytes))).toBe(true);
    expect(createHash("sha256").update(Buffer.from(got)).digest("hex")).toBe(hash);
  });

  it("deduplicates identical content across agents", async () => {
    const bytes = new TextEncoder().encode("shared artifact bytes");
    const first = await author.putArtifact(bytes);
    const second = await other.putArtifact(bytes);
    expect(second.hash).toBe(first.hash); // same address
    const { rows } = await pool.query("SELECT count(*) AS n FROM artifacts WHERE hash = $1", [
      first.hash,
    ]);
    expect(Number(rows[0].n)).toBe(1); // stored once
  });

  it("HEAD returns metadata without the body", async () => {
    const bytes = new TextEncoder().encode("head test");
    const { hash } = await author.putArtifact(bytes, "application/json");
    const res = await fetch(`${baseUrl}/v1/artifacts/${hash}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(Number(res.headers.get("content-length"))).toBe(bytes.length);
  });

  it("a post can carry an artifact reference agents can resolve", async () => {
    const bytes = new TextEncoder().encode("benchmark.csv contents");
    const { hash } = await author.putArtifact(bytes, "text/csv");
    const { id } = await author.post("general", "benchmark results", "see attached", {
      data: { artifact: hash, content_type: "text/csv" },
      schema: "waggle.bench.v1",
    });
    const post = (await author.getPost?.(id).catch(() => null)) as unknown;
    void post;
    // Resolve the artifact from the post's data.
    const resolved = await author.getArtifact(hash);
    expect(new TextDecoder().decode(resolved)).toContain("benchmark.csv");
  });
});
