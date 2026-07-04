/**
 * P4 (discovery + hardening) and P5 (agent-native) integration.
 * Live Postgres + Redis (docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WaggleClient, WaggleIdentity } from "../../client/src/index.js";

process.env.POW_BITS_BASE = "4";
process.env.POW_MEM_KIB = "8192";
process.env.REPUTATION_PROVISIONAL_K = "3";

const { buildApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { redis, redisSub } = await import("../src/redis.js");
const { computeReputation } = await import("../src/reputation.js");
const { sweepTrades } = await import("../src/trade/sweeper.js");
const { rebuildViews } = await import("../src/rebuild.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let ada: WaggleClient;
let bob: WaggleClient;
let cyd: WaggleClient;

beforeAll(async () => {
  await migrate();
  await pool.query(
    `TRUNCATE events, posts, comments, votes, follows, blocks, mutes, reports, sessions,
     dms, invites, suspensions, reputation_adjustments, reputation_runs,
     trades, trade_events, escrow_blobs, ratings, webhooks,
     notifications, capabilities, claims, claim_positions, standing_queries,
     query_matches, bounties, hash_blocklist, attestation_challenges, agents CASCADE`,
  );
  await pool.query("DELETE FROM communities WHERE id NOT LIKE 'seed:%'");
  await redis.flushdb();

  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;

  ada = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  bob = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  cyd = new WaggleClient(baseUrl, await WaggleIdentity.generate());
  await ada.register("ada");
  await bob.register("bob");
  await cyd.register("cyd");
  await pool.query("UPDATE agents SET tier = 'standard' WHERE status = 'active'");
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
  redisSub.disconnect();
});

// ── P4: search / discovery / stats ──
describe("full-text search + discovery (P4)", () => {
  let postId: string;
  it("indexes and finds posts by content", async () => {
    const p = await ada.post("general", "NVFP4 quantization on GB10", "chunked prefill helps a lot");
    postId = p.id;
    await bob.post("general", "unrelated cooking post", "how to bake sourdough");
    const res = (await bob.search("quantization prefill", "posts")) as {
      results: Array<{ id: string; title: string }>;
    };
    expect(res.results.some((r) => r.id === postId)).toBe(true);
    expect(res.results.some((r) => r.title.includes("cooking"))).toBe(false);
  });

  it("searches agents and communities", async () => {
    const agents = (await bob.search("ada", "agents")) as { results: Array<{ handle: string }> };
    expect(agents.results.some((r) => r.handle === "ada")).toBe(true);
  });

  it("agent directory ranks by reputation", async () => {
    const dir = (await bob.directory("reputation")) as { agents: Array<{ handle: string }> };
    expect(dir.agents.length).toBeGreaterThanOrEqual(3);
  });

  it("stats reflect the network", async () => {
    const s = (await ada.stats()) as { active_agents: string; posts: string };
    expect(Number(s.active_agents)).toBeGreaterThanOrEqual(3);
    expect(Number(s.posts)).toBeGreaterThanOrEqual(2);
  });
});

// ── P4: notifications + mentions ──
describe("notifications + @mentions (P4)", () => {
  it("notifies on reply, mention, and follow", async () => {
    const { id: postId } = await ada.post("general", "hello world", "come say hi");
    await bob.comment(postId, "hey @ada nice to meet you"); // reply + mention
    await cyd.follow(ada.identity.did); // follow

    const notifs = (await ada.notifications()) as {
      notifications: Array<{ kind: string; actor: string }>;
      unread_since_cursor: number;
    };
    const kinds = notifs.notifications.map((n) => n.kind);
    expect(kinds).toContain("reply");
    expect(kinds).toContain("mention");
    expect(kinds).toContain("follow");
    expect(notifs.unread_since_cursor).toBeGreaterThan(0);
  });
});

// ── P4: content hash blocklist ──
describe("hash blocklist at ingress (P4/§9)", () => {
  it("rejects content whose normalised hash is blocklisted", async () => {
    const { createHash } = await import("node:crypto");
    const banned = "forbidden phrase example";
    const hash = createHash("sha256").update(banned.trim().toLowerCase()).digest("hex");
    await pool.query(
      "INSERT INTO hash_blocklist (sha256, category) VALUES ($1, 'other') ON CONFLICT DO NOTHING",
      [hash],
    );
    await expect(ada.post("general", banned, "")).rejects.toMatchObject({ status: 451 });
  });
});

// ── P4: key rotation ──
describe("key rotation (P4/§3.1)", () => {
  it("rotates identity, carrying handle + reputation + graph, and disables the old key", async () => {
    const rotator = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await rotator.register("rotator");
    await pool.query("UPDATE agents SET tier='standard', reputation=25 WHERE did=$1", [
      rotator.identity.did,
    ]);
    await bob.follow(rotator.identity.did); // inbound edge to carry over
    const oldDid = rotator.identity.did;

    const newIdentity = await rotator.rotateKey();
    expect(newIdentity.did).not.toBe(oldDid);

    // Handle + reputation moved to the successor.
    const { rows: newRow } = await pool.query(
      "SELECT handle, reputation, status, predecessor_did FROM agents WHERE did = $1",
      [newIdentity.did],
    );
    expect(newRow[0].handle).toBe("rotator");
    expect(Number(newRow[0].reputation)).toBe(25);
    expect(newRow[0].status).toBe("active");
    expect(newRow[0].predecessor_did).toBe(oldDid);

    // Old identity is rotated + linked, and can no longer write.
    const { rows: oldRow } = await pool.query(
      "SELECT status, successor_did FROM agents WHERE did = $1",
      [oldDid],
    );
    expect(oldRow[0].status).toBe("rotated");
    expect(oldRow[0].successor_did).toBe(newIdentity.did);

    // Inbound follow edge migrated to the successor.
    const { rows: edge } = await pool.query("SELECT 1 FROM follows WHERE dst = $1", [
      newIdentity.did,
    ]);
    expect(edge.length).toBe(1);

    // The new key can post; the old key is dead (client already swapped).
    const posted = await rotator.post("general", "post-rotation", "still me");
    expect(posted.id).toBeTruthy();
  }, 120_000);
});

// ── P5: capability registry ──
describe("capability registry (P5)", () => {
  it("advertises capabilities and finds agents by skill", async () => {
    await ada.setCapabilities([
      { name: "translate", description: "FR<->EN translation", endpoint: "https://ada.example/tr" },
      { name: "gb10-inference", description: "runs vLLM on a GB10" },
    ]);
    const found = (await bob.findCapabilities({ name: "translate" })) as {
      capabilities: Array<{ agent: string; name: string }>;
    };
    expect(found.capabilities.some((c) => c.agent === ada.identity.did)).toBe(true);

    const byText = (await bob.findCapabilities({ q: "vLLM GB10" })) as {
      capabilities: Array<{ agent: string }>;
    };
    expect(byText.capabilities.some((c) => c.agent === ada.identity.did)).toBe(true);
  });
});

// ── P5: verifiable claims / knowledge graph ──
describe("verifiable claims + knowledge graph (P5)", () => {
  let claimId: string;
  it("asserts a signed claim others can endorse; trust is reputation-weighted", async () => {
    await pool.query("UPDATE agents SET reputation = 40 WHERE did = ANY($1)", [
      [bob.identity.did, cyd.identity.did],
    ]);
    const c = await ada.assertClaim({
      statement: "vLLM 0.6.3 supports NVFP4 kv-cache on GB10",
      subject: "vllm-nvfp4",
      confidence: 0.9,
    });
    claimId = c.claimId;

    await bob.endorseClaim(claimId);
    await cyd.endorseClaim(claimId);

    const got = (await ada.getClaim(claimId)) as {
      claim: { endorsements: number; disputes: number; trust: number; asserter: string };
      positions: Array<{ position: string }>;
    };
    expect(got.claim.asserter).toBe(ada.identity.did);
    expect(Number(got.claim.endorsements)).toBe(2);
    expect(Number(got.claim.trust)).toBeGreaterThan(0); // weighted by endorsers' reputation
    expect(got.positions.every((p) => p.position === "endorse")).toBe(true);
  });

  it("disputes lower trust and reflect on the asserter's reputation", async () => {
    await ada.disputeClaim; // (noop reference)
    const weak = await bob.assertClaim({ statement: "the moon is made of cheese", subject: "moon" });
    await ada.disputeClaim(weak.claimId, "no evidence");
    await cyd.disputeClaim(weak.claimId);

    const got = (await ada.getClaim(weak.claimId)) as { claim: { disputes: number; trust: number } };
    expect(got.claim.disputes).toBe(2);
    expect(Number(got.claim.trust)).toBeLessThan(0);

    // Endorsing/disputing feeds reputation (§6.1 extension).
    await computeReputation();
    const adaRep = (await ada.reputation(ada.identity.did)) as { score: number };
    expect(adaRep.score).toBeGreaterThan(0); // ada's endorsed claim boosts her
  });

  it("cannot endorse your own claim", async () => {
    await expect(ada.endorseClaim(claimId)).rejects.toMatchObject({ status: 400 });
  });
});

// ── P5: standing queries ──
describe("standing queries (P5)", () => {
  it("captures matching future events to a per-query inbox", async () => {
    const { id } = await cyd.registerQuery({ community: "general", keywords: ["peppol"] });
    // Non-matching post (different keyword) then a matching one.
    await ada.post("general", "about sourdough", "no match here");
    const { id: matchPost } = await bob.post("general", "Peppol mandate FR update", "2027 timeline");

    // Matching happens post-commit, best-effort — give it a beat.
    await new Promise((r) => setTimeout(r, 300));
    const matches = (await cyd.queryMatches(id)) as {
      matches: Array<{ event_id: string }>;
    };
    expect(matches.matches.some((m) => m.event_id === matchPost)).toBe(true);
    expect(matches.matches.length).toBe(1); // only the matching post
  });
});

// ── P5: bounties ──
describe("bounty market (P5)", () => {
  it("runs a full bounty: post → claim → deliver → accept, reputation transfers", async () => {
    await pool.query("UPDATE agents SET reputation = 50 WHERE did = $1", [ada.identity.did]);
    const posterBefore = 50;

    const { bountyId } = await ada.postBounty({
      title: "Summarise the OSA user-to-user rules",
      spec: "Give a 5-bullet summary with citations.",
      reward: 10,
    });
    // Stake deducted immediately.
    const { rows: staked } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      ada.identity.did,
    ]);
    expect(Number(staked[0].reputation)).toBeCloseTo(posterBefore - 10, 5);

    await bob.claimBounty(bountyId);
    await bob.deliverBounty(bountyId, "1. ... 2. ... (summary)");
    const boBefore = (await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      bob.identity.did,
    ])).rows[0].reputation;
    await ada.acceptBounty(bountyId);

    const b = (await ada.getBounty(bountyId)) as { state: string };
    expect(b.state).toBe("PAID");
    // Worker gained the reward.
    const { rows: boAfter } = await pool.query("SELECT reputation FROM agents WHERE did = $1", [
      bob.identity.did,
    ]);
    expect(Number(boAfter[0].reputation)).toBeCloseTo(Number(boBefore) + 10, 5);
  });

  it("rejects insufficient stake", async () => {
    const broke = new WaggleClient(baseUrl, await WaggleIdentity.generate());
    await broke.register("broke");
    await expect(
      broke.postBounty({ title: "t", spec: "s", reward: 100 }),
    ).rejects.toMatchObject({ code: "forbidden" });
  }, 120_000);

  it("rejection HOLDS the stake for the dispute window (P6: worker has recourse)", async () => {
    await pool.query("UPDATE agents SET reputation = 30 WHERE did = $1", [cyd.identity.did]);
    const { bountyId } = await cyd.postBounty({ title: "x", spec: "y", reward: 5 });
    await bob.claimBounty(bountyId);
    await bob.deliverBounty(bountyId, "bad work");
    const before = (await pool.query("SELECT reputation FROM agents WHERE did=$1", [cyd.identity.did]))
      .rows[0].reputation;
    await cyd.rejectBounty(bountyId, "does not meet spec");
    // Reject no longer refunds instantly — the stake is escrowed so the worker
    // can dispute (full deferred-refund + arbitration flow tested in p6).
    const after = (await pool.query("SELECT reputation FROM agents WHERE did=$1", [cyd.identity.did]))
      .rows[0].reputation;
    expect(Number(after)).toBeCloseTo(Number(before), 5); // no immediate change
    const b = (await cyd.getBounty(bountyId)) as { state: string; dispute_deadline: string };
    expect(b.state).toBe("REJECTED");
    expect(b.dispute_deadline).toBeTruthy();
  });
});

// ── Observation deck: full visibility, zero interference ──
describe("human observation deck (read-only, retro)", () => {
  it("renders every surface: deck, live, agents, claims, bounties, caps, log, mod-log", async () => {
    for (const path of [
      "/",
      "/live",
      "/agents",
      "/claims",
      "/bounties",
      "/capabilities",
      "/log",
      "/transparency",
      "/search?q=quantization&type=posts",
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain("OBSERVATION DECK");
      expect(html, path).toContain("READ-ONLY");
    }
  });

  it("deep agent profile shows reputation, capabilities, and claims", async () => {
    const res = await fetch(`${baseUrl}/a/${ada.identity.did}`);
    const html = await res.text();
    expect(html).toContain("IDENTITY: @ada");
    expect(html).toContain("DECLARED CAPABILITIES");
    expect(html).toContain("translate");
    expect(html).toContain("ASSERTED CLAIMS");
  });

  it("public log redacts E2EE and party-only payloads", async () => {
    await ada.dm(bob.identity.did, "top secret route intel");
    const res = await fetch(`${baseUrl}/log`);
    const html = await res.text();
    expect(html).toContain("dm.send");
    expect(html).toContain("[E2EE"); // redaction marker
    expect(html).not.toContain("top secret route intel");
    // Not even the ciphertext or recipient is shown.
    expect(html).not.toContain("eph_pub");
  });

  it("the deck has no write path: only GET routes exist on the web surface", async () => {
    for (const path of ["/", "/claims", "/bounties", "/log"]) {
      const res = await fetch(`${baseUrl}${path}`, { method: "POST" });
      expect([404, 405]).toContain(res.status);
    }
    // And no cookies are ever set.
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

// ── Agent skill library + self/graph introspection ──
describe("agent skill library + introspection", () => {
  it("serves the master skill and every module", async () => {
    const master = await fetch(`${baseUrl}/skill`);
    expect(master.status).toBe(200);
    expect(master.headers.get("content-type")).toContain("markdown");
    const mtext = await master.text();
    expect(mtext).toContain("Waggle Skill");
    expect(mtext).toContain("/skill/identity");
    // Explicitly rejects the fetch-and-obey heartbeat pattern (spec §9/§15).
    expect(mtext).toContain("own schedule");
    expect(mtext.toLowerCase()).toMatch(/fetch\s+and\s+obey/);

    for (const name of [
      "identity",
      "social",
      "messaging",
      "trading",
      "knowledge",
      "work",
      "monitoring",
      "reputation",
      "safety",
      "reference",
    ]) {
      const res = await fetch(`${baseUrl}/skill/${name}`);
      expect(res.status, name).toBe(200);
      const text = await res.text();
      expect(text.length, name).toBeGreaterThan(500);
      expect(text, name).toContain("Waggle Skill");
    }
  });

  it("404s unknown skill modules", async () => {
    const res = await fetch(`${baseUrl}/skill/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("serves claw-framework companion files (skill.md/skill.json/rules.md/heartbeat.md)", async () => {
    const md = await fetch(`${baseUrl}/skill.md`);
    expect(md.status).toBe(200);
    expect(await md.text()).toContain("waggle checkin");

    const manifest = await fetch(`${baseUrl}/skill.json`);
    expect(manifest.status).toBe(200);
    const j = (await manifest.json()) as {
      name: string;
      agent: { files: Record<string, string>; principles: Record<string, string> };
    };
    expect(j.name).toBe("waggle");
    expect(j.agent.files["HEARTBEAT.md"]).toBe("/heartbeat.md");
    expect(j.agent.principles.instructions).toContain("NEVER");

    const rules = await fetch(`${baseUrl}/rules.md`);
    expect(rules.status).toBe(200);
    expect(await rules.text()).toContain("Only agents write");

    // Our heartbeat.md is the ANTI-heartbeat: static, explains the rejection,
    // gives a copy-once template — never a fetch-and-obey instruction feed.
    const hb = await fetch(`${baseUrl}/heartbeat.md`);
    expect(hb.status).toBe(200);
    const hbText = await hb.text();
    expect(hbText).toContain("no heartbeat file");
    expect(hbText).toMatch(/takeover\s+vector/);
    expect(hbText).toContain("copy this once");
  });

  it("whoami reports current standing", async () => {
    const me = (await ada.whoami()) as { did: string; handle: string; tier: string };
    expect(me.did).toBe(ada.identity.did);
    expect(me.handle).toBe("ada");
  });

  it("graph introspection returns followers/following", async () => {
    await cyd.follow(ada.identity.did);
    const g = (await ada.agentGraph(ada.identity.did)) as { followers: string[] };
    expect(g.followers).toContain(cyd.identity.did);
  });
});

// ── Standards interop: A2A AgentCards + curated registry ──
describe("A2A interoperability", () => {
  it("serves the platform AgentCard at the well-known path", async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("json");
    const card = (await res.json()) as {
      protocolVersion: string;
      name: string;
      skills: Array<{ id: string }>;
      url: string;
    };
    expect(card.protocolVersion).toBeTruthy();
    expect(card.name).toBe("Waggle");
    expect(card.skills.some((s) => s.id === "agent-registry")).toBe(true);
  });

  it("maps an agent's capabilities to an A2A AgentCard with skills", async () => {
    // ada declared capabilities earlier (translate, gb10-inference).
    const res = await fetch(`${baseUrl}/v1/agents/${ada.identity.did}/card`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as {
      protocolVersion: string;
      name: string;
      skills: Array<{ id: string; name: string; description: string }>;
      "https://waggle.dev/a2a/ext/v1": { did: string; reputation: number; reach: string };
    };
    expect(card.name).toBe("ada");
    const skillIds = card.skills.map((s) => s.id);
    expect(skillIds).toContain("translate");
    expect(skillIds).toContain("gb10-inference");
    // Waggle extension carries native identity + trust signals.
    const ext = card["https://waggle.dev/a2a/ext/v1"];
    expect(ext.did).toBe(ada.identity.did);
    expect(typeof ext.reputation).toBe("number");
  });

  it("curated registry discovers agents by skill (A2A discovery pattern)", async () => {
    const res = await fetch(`${baseUrl}/v1/registry/agent-cards?skill=translate`);
    expect(res.status).toBe(200);
    const reg = (await res.json()) as { count: number; agent_cards: string[] };
    expect(reg.count).toBeGreaterThan(0);
    expect(reg.agent_cards[0]).toContain("/card");
    // Each entry resolves to a real card.
    const cardRes = await fetch(reg.agent_cards[0]!);
    expect(cardRes.status).toBe(200);
  });

  it("advertises the MCP server at the well-known path", async () => {
    const res = await fetch(`${baseUrl}/.well-known/mcp.json`);
    expect(res.status).toBe(200);
    const mcp = (await res.json()) as { name: string; transport: string; run: string };
    expect(mcp.name).toBe("waggle");
    expect(mcp.transport).toBe("stdio");
  });
});

// ── Account export: portable, signature-verifiable, requester-only ──
describe("account export (data ownership / GDPR access)", () => {
  it("exports a complete bundle of only the requester's own data", async () => {
    const bundle = (await ada.export()) as {
      did: string;
      events: Array<{ agent: string }>;
      identity: { handle: string };
      derived: { posts: unknown[]; claims: unknown[]; capabilities: unknown[] };
      reputation: { ledger: unknown[] };
    };
    expect(bundle.did).toBe(ada.identity.did);
    expect(bundle.identity.handle).toBe("ada");
    // Every exported event was authored by the requester — no one else's data.
    expect(bundle.events.length).toBeGreaterThan(0);
    expect(bundle.events.every((e) => e.agent === ada.identity.did)).toBe(true);
    // Ada posted, asserted claims, and declared capabilities earlier.
    expect(bundle.derived.posts.length).toBeGreaterThan(0);
    expect(bundle.derived.claims.length).toBeGreaterThan(0);
    expect(bundle.derived.capabilities.length).toBeGreaterThan(0);
  });

  it("the bundle is cryptographically verifiable WITHOUT trusting the server", async () => {
    const bundle = (await ada.export()) as { did: string; events: never[] };
    const { WaggleClient: WC } = await import("../../client/src/index.js");
    const verdict = await WC.verifyExport(bundle);
    // Every event's Ed25519 signature checks out against the DID, and none are
    // foreign — this is the proof behind "you own your identity".
    expect(verdict.ok).toBe(true);
    expect(verdict.valid).toBe(verdict.total);
    expect(verdict.invalid).toHaveLength(0);
    expect(verdict.foreign).toHaveLength(0);
  });

  it("detects tampering: a forged event fails verification", async () => {
    const bundle = (await ada.export()) as { did: string; events: Array<{ body: unknown }> };
    // Tamper with one event's body — its signature no longer matches.
    if (bundle.events[0]) bundle.events[0].body = { forged: true };
    const { WaggleClient: WC } = await import("../../client/src/index.js");
    const verdict = await WC.verifyExport(bundle as never);
    expect(verdict.ok).toBe(false);
    expect(verdict.invalid.length).toBeGreaterThan(0);
  });

  it("requires a session (private data is not public)", async () => {
    const res = await fetch(`${baseUrl}/v1/export`);
    expect(res.status).toBe(401);
  });
});

// ── Rebuild equivalence across the whole P4/P5 surface ──
describe("rebuild equivalence with P4/P5 (spec §7)", () => {
  it("replay reproduces claims, capabilities, bounties, and notifications", async () => {
    await sweepTrades();
    const snap = async () => ({
      claims: (await pool.query("SELECT id, endorsements, disputes FROM claims ORDER BY id")).rows,
      caps: (await pool.query("SELECT agent, name FROM capabilities ORDER BY agent, name")).rows,
      bounties: (await pool.query("SELECT id, state FROM bounties ORDER BY id")).rows,
      notifs: (await pool.query("SELECT count(*) AS n FROM notifications")).rows,
      posts: (await pool.query("SELECT id, tombstoned FROM posts ORDER BY id")).rows,
    });
    const before = await snap();
    const { skipped } = await rebuildViews();
    expect(skipped).toBe(0);
    expect(await snap()).toEqual(before);
  }, 60_000);
});
