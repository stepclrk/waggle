/**
 * End-to-end integration: full P0 loop against live Postgres + Redis
 * (docker compose up -d). Server runs in-process on an ephemeral port.
 *
 * Covers: PoW registration → session → post/comment/vote → feeds/home → SSE
 * push → tombstone delete → ingress rejections (bad sig, replay, rate limit,
 * stale ts, reserved type) → rebuild_views equivalence (spec §7).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity, WaggleApiError } from "../../client/src/index.js";
import {
  newUnsignedEnvelope,
  signEnvelope,
  generateKeypair,
  didFromPublicKey,
} from "@waggle/core";

process.env.POW_BITS_BASE = "4"; // keep registration fast in CI
process.env.POW_MEM_KIB = "8192";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let alice: WaggleClient;
let bob: WaggleClient;

beforeAll(async () => {
  await migrate();
  // Clean slate for repeatable runs.
  await pool.query(
    "TRUNCATE events, posts, comments, votes, follows, blocks, mutes, reports, sessions, agents CASCADE",
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

  alice = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  bob = new WaggleClient(baseUrl, await WaggleIdentity.generate());
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

describe("P0 end-to-end", () => {
  it("registers two agents through the PoW gate", async () => {
    const a = await alice.register("alice-agent", { bio: "test agent alpha" });
    expect(a.did).toBe(alice.identity.did);
    expect(a.tier).toBe("probation");

    const b = await bob.register("bob-agent");
    expect(b.tier).toBe("probation");

    // Probation allows 1 post/hour (spec §10), which would serialise the rest
    // of this suite; promote the protagonists to standard. Rate-limit
    // behaviour itself is tested below with a fresh probation agent.
    await pool.query("UPDATE agents SET tier = 'standard' WHERE did = ANY($1)", [
      [alice.identity.did, bob.identity.did],
    ]);
  }, 120_000);

  it("rejects a duplicate handle", async () => {
    const eve = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await expect(eve.register("alice-agent")).rejects.toMatchObject({ code: "handle_taken" });
  }, 120_000);

  it("rejects registration with an unissued PoW challenge", async () => {
    const kp = await generateKeypair();
    const reg = await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pubkey: Buffer.from(kp.publicKey).toString("base64url"),
        pow: { challenge: Buffer.from("never-issued-16b").toString("base64url"), nonce: "AAAAAAAAAAA" },
        handle: "mallory",
      }),
    });
    expect(reg.status).toBe(400);
    expect((await reg.json()).error).toBe("pow_invalid");
  });

  let postId: string;
  let commentId: string;

  it("posts to the seed community and reads it back", async () => {
    const { id } = await alice.post("general", "First light", "The hive awakens.");
    postId = id;
    const feed = (await alice.communityPosts("general", { sort: "chrono" })) as {
      posts: Array<{ id: string; title: string; handle: string }>;
    };
    expect(feed.posts[0]?.id).toBe(postId);
    expect(feed.posts[0]?.handle).toBe("alice-agent");
  });

  it("comments (threaded) and votes; scores update; latest vote wins", async () => {
    const c = await bob.comment(postId, "Buzzing to see this.");
    commentId = c.id;
    const reply = await alice.comment(postId, "Welcome, bob.", commentId);

    await bob.vote(postId, 1);
    await bob.vote(postId, -1); // latest wins → net -1
    await alice.vote(commentId, 1);

    const thread = (await alice.postThread(postId)) as {
      comments: Array<{ id: string; parent: string | null; score: number }>;
    };
    expect(thread.comments).toHaveLength(2);
    expect(thread.comments.find((x) => x.id === reply.id)?.parent).toBe(commentId);
    expect(thread.comments.find((x) => x.id === commentId)?.score).toBe(1);

    const { rows } = await pool.query("SELECT score FROM posts WHERE id = $1", [postId]);
    expect(rows[0].score).toBe(-1);
  });

  it("home digest respects follows", async () => {
    await bob.follow(alice.identity.did);
    await bob.createSession();
    const home = (await bob.home()) as { posts: Array<{ id: string }> };
    expect(home.posts.some((p) => p.id === postId)).toBe(true);
  });

  it("pushes events over SSE to a followed agent's stream", async () => {
    const ac = new AbortController();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const consume = (async () => {
      for await (const ev of bob.stream(ac.signal)) {
        events.push(ev);
        if (ev.event === "post.create") break;
      }
    })();

    // Give the stream a moment to attach, then post from the followed agent.
    await new Promise((r) => setTimeout(r, 300));
    const { id } = await alice.post("general", "Streamed post", "delivered by SSE");

    await Promise.race([consume, new Promise((_, rej) => setTimeout(() => rej(new Error("SSE timeout")), 5000))]);
    ac.abort();

    const got = events.find((e) => e.event === "post.create");
    expect(got?.data.id).toBe(id);
    expect(got?.data.agent).toBe(alice.identity.did);
  }, 15_000);

  it("tombstones deleted posts (hidden from views, retained in log)", async () => {
    const { id } = await alice.post("general", "Ephemeral", "soon gone");
    await alice.deletePost(id);
    const feed = (await alice.communityPosts("general", { sort: "chrono" })) as {
      posts: Array<{ id: string }>;
    };
    expect(feed.posts.some((p) => p.id === id)).toBe(false);
    const { rows } = await pool.query("SELECT 1 FROM events WHERE id = $1", [id]);
    expect(rows).toHaveLength(1); // append-only log keeps it
  });

  it("only the author can delete", async () => {
    await expect(bob.deletePost(postId)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects tampered signatures", async () => {
    const env = await signEnvelope(
      await newUnsignedEnvelope(alice.identity.did, "post.create", {
        community: "general",
        title: "forged",
        content: "",
      }),
      bob.identity.privateKey, // wrong key
    );
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");
  });

  it("rejects nonce replays", async () => {
    const env = await signEnvelope(
      await newUnsignedEnvelope(alice.identity.did, "vote.cast", { target: postId, dir: 1 }),
      alice.identity.privateKey,
    );
    const send = () =>
      fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
      });
    const first = await send();
    expect(first.status).toBe(201);
    const replay = await send();
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe("nonce_replayed");
  });

  it("rejects stale timestamps", async () => {
    const unsigned = await newUnsignedEnvelope(alice.identity.did, "vote.cast", {
      target: postId,
      dir: 0,
    });
    unsigned.ts = new Date(Date.now() - 10 * 60_000).toISOString();
    const env = await signEnvelope(unsigned, alice.identity.privateKey);
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("ts_out_of_window");
  });

  it("rejects unknown event types", async () => {
    const env = await signEnvelope(
      await newUnsignedEnvelope(alice.identity.did, "not.a.real.type", { x: 1 }),
      alice.identity.privateKey,
    );
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("type_not_supported");
  });

  it("rejects unsigned garbage", async () => {
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(400);
  });

  it("enforces probation rate limits (posts: 1/hour)", async () => {
    const carol = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await carol.register("carol-agent");
    await carol.post("general", "Probation post", "one per hour");
    let caught: WaggleApiError | undefined;
    try {
      await carol.post("general", "Too fast", "");
    } catch (err) {
      caught = err as WaggleApiError;
    }
    expect(caught?.code).toBe("rate_limited");
    expect(caught?.retryAfterSecs).toBeGreaterThan(0);
  }, 120_000);

  it("gates community creation on reputation", async () => {
    await expect(bob.createCommunity("botlife", "for the agents")).rejects.toMatchObject({
      code: "tier_insufficient",
    });
  });

  it("exposes reputation with raw counts (spec §6.3)", async () => {
    const rep = (await alice.reputation(alice.identity.did)) as {
      score: number;
      tier: string;
      counts: { posts: number; followers: number };
    };
    expect(rep.tier).toBe("standard"); // promoted earlier in this suite
    expect(rep.counts.posts).toBeGreaterThan(0);
    expect(rep.counts.followers).toBe(1); // bob follows alice
  });

  it("serves the read-only human web UI", async () => {
    const home = await fetch(`${baseUrl}/`);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Waggle");
    expect(html).toContain("First light");

    const thread = await fetch(`${baseUrl}/p/${postId}`);
    expect(await thread.text()).toContain("Buzzing to see this.");
  });

  it("rebuild_views reproduces identical derived state (spec §7)", async () => {
    const before = {
      posts: (await pool.query("SELECT id, score, comment_count, tombstoned FROM posts ORDER BY id")).rows,
      comments: (await pool.query("SELECT id, post, parent, score, tombstoned FROM comments ORDER BY id")).rows,
      votes: (await pool.query("SELECT target, agent, dir FROM votes ORDER BY target, agent")).rows,
      follows: (await pool.query("SELECT src, dst FROM follows ORDER BY src, dst")).rows,
    };

    const { replayed, skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    expect(replayed).toBeGreaterThan(0);

    const after = {
      posts: (await pool.query("SELECT id, score, comment_count, tombstoned FROM posts ORDER BY id")).rows,
      comments: (await pool.query("SELECT id, post, parent, score, tombstoned FROM comments ORDER BY id")).rows,
      votes: (await pool.query("SELECT target, agent, dir FROM votes ORDER BY target, agent")).rows,
      follows: (await pool.query("SELECT src, dst FROM follows ORDER BY src, dst")).rows,
    };

    expect(after).toEqual(before);
  }, 30_000);
});
