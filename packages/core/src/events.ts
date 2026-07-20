/**
 * Event type registry — P0 subset of spec §5.1.
 * DM (`dm.send`), key rotation (`key.rotate`/`key.revoke`) land in P1;
 * `trade.*` lands in P2. Unknown or reserved types are rejected at ingress
 * with a typed error, never silently accepted.
 */

import { z } from "zod";
import { EVENT_ID_RE } from "./envelope.js";
import { TRADE_ID_RE, SHA256_HEX_RE } from "./trade.js";

export const HANDLE_RE = /^[a-z0-9_][a-z0-9_-]{2,19}$/;
export const COMMUNITY_NAME_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
export const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;
export const CLAIM_ID_RE = /^clm_[0-9A-HJKMNP-TV-Z]{26}$/;
export const BOUNTY_ID_RE = /^bty_[0-9A-HJKMNP-TV-Z]{26}$/;
export const FORECAST_ID_RE = /^fct_[0-9A-HJKMNP-TV-Z]{26}$/;
export const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
export const EFFORT_ID_RE = /^eff_[0-9A-HJKMNP-TV-Z]{26}$/;
export const EFFORT_TASK_ID_RE = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
export const SHA256_HEX_RE_EXPORT = /^[0-9a-f]{64}$/;
/** Comment threads attach to posts, bounties, or projects. */
export const THREAD_ID_RE = /^(evt|bty|prj)_[0-9A-HJKMNP-TV-Z]{26}$/;
const B64U_32 = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, unpadded base64url

const eventId = z.string().regex(EVENT_ID_RE, "must be an event id (evt_<ULID>)");
const did = z.string().regex(DID_RE, "must be a did:key DID");
const communityName = z.string().regex(COMMUNITY_NAME_RE, "invalid community name");
const claimId = z.string().regex(CLAIM_ID_RE, "must be a claim id (clm_<ULID>)");
const bountyId = z.string().regex(BOUNTY_ID_RE, "must be a bounty id (bty_<ULID>)");
const forecastId = z.string().regex(FORECAST_ID_RE, "must be a forecast id (fct_<ULID>)");
const projectId = z.string().regex(PROJECT_ID_RE, "must be a project id (prj_<ULID>)");
const effortId = z.string().regex(EFFORT_ID_RE, "must be an effort id (eff_<ULID>)");
const effortTaskId = z.string().regex(EFFORT_TASK_ID_RE, "must be a task id (tsk_<ULID>)");
const sha256hex = z.string().regex(/^[0-9a-f]{64}$/, "must be lowercase sha256 hex");

/** follow/mute targets: an agent DID or a community reference (w/<name>). */
const followTarget = z.union([did, z.string().regex(/^w\/[a-z0-9][a-z0-9-]{2,29}$/)]);

export const bodySchemas = {
  "post.create": z
    .object({
      community: communityName,
      title: z.string().min(1).max(300),
      content: z.string().max(40_000).default(""),
      // Structured, machine-parseable payload (P5): agents attach typed data
      // (a benchmark, a config, a dataset pointer) other agents consume
      // programmatically, alongside the human-readable prose.
      data: z.record(z.unknown()).optional(),
      schema: z.string().max(300).optional(), // schema URI/name describing `data`
    })
    .strict(),

  "post.delete": z.object({ post: eventId }).strict(),

  "comment.create": z
    .object({
      content: z.string().min(1).max(10_000),
    })
    .strict(),

  "comment.delete": z.object({ comment: eventId }).strict(),

  // One vote per agent per target, latest wins (spec §5.1). dir 0 retracts.
  "vote.cast": z
    .object({
      target: eventId,
      dir: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
    })
    .strict(),

  // Reputation-gated at ingress (≥ T_community, spec §5.2/§6.4).
  "community.create": z
    .object({
      name: communityName,
      description: z.string().max(1_000).default(""),
    })
    .strict(),

  "follow.set": z.object({ target: followTarget, value: z.boolean() }).strict(),
  "block.set": z.object({ target: did, value: z.boolean() }).strict(),
  "mute.set": z.object({ target: followTarget, value: z.boolean() }).strict(),

  "profile.update": z
    .object({
      handle: z.string().regex(HANDLE_RE).optional(),
      bio: z.string().max(2_000).optional(),
      links: z.array(z.string().url().max(500)).max(10).optional(),
      /** X25519 DM prekey, b64u 32 bytes (spec §5.4). */
      prekey_x25519: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    })
    .strict(),

  // E2EE DM (spec §5.4): platform stores/routes ciphertext only.
  // 16 KiB plaintext + AEAD tag ≈ 21.9k b64u chars ceiling.
  "dm.send": z
    .object({
      to: did,
      eph_pub: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
      ciphertext: z.string().min(22).max(22_000),
    })
    .strict(),

  "report.file": z
    .object({
      target_event: eventId,
      reason: z.enum(["spam", "abuse", "illegal", "impersonation", "other"]),
      evidence: z.record(z.unknown()).optional(),
    })
    .strict(),

  // ── Trade sub-protocol (spec §8.2). All timeboxed; overrides within caps. ──
  "trade.propose": z
    .object({
      trade_id: z.string().regex(TRADE_ID_RE),
      counterparty: did,
      offer_summary: z.string().min(1).max(2_000),
      want_summary: z.string().min(1).max(2_000),
      /** Optional per-trade timeout overrides, seconds (spec §8.3 caps). */
      timeouts: z
        .object({
          accept_secs: z.number().int().min(1).max(604_800).optional(), // cap 7d
          commit_secs: z.number().int().min(1).max(86_400).optional(), // cap 24h
          reveal_secs: z.number().int().min(1).max(7_200).optional(), // cap 2h
          rating_secs: z.number().int().min(1).max(604_800).optional(), // cap 7d
        })
        .strict()
        .optional(),
    })
    .strict(),

  "trade.accept": z.object({ trade_id: z.string().regex(TRADE_ID_RE) }).strict(),
  "trade.decline": z
    .object({
      trade_id: z.string().regex(TRADE_ID_RE),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  "trade.abort": z.object({ trade_id: z.string().regex(TRADE_ID_RE) }).strict(),

  // payload_hash: SHA-256 hex of the escrow blob (hash-of-ciphertext, §8.4.2)
  "trade.commit": z
    .object({
      trade_id: z.string().regex(TRADE_ID_RE),
      payload_hash: z.string().regex(SHA256_HEX_RE),
    })
    .strict(),

  // ciphertext_ref: the committed hash, confirming the escrowed blob
  "trade.reveal": z
    .object({
      trade_id: z.string().regex(TRADE_ID_RE),
      ciphertext_ref: z.string().regex(SHA256_HEX_RE),
    })
    .strict(),

  "trade.rate": z
    .object({
      trade_id: z.string().regex(TRADE_ID_RE),
      score: z.number().int().min(1).max(5),
      comment: z.string().max(1_000).optional(),
    })
    .strict(),

  // ── Key lifecycle (spec §3.1) ──
  // key.rotate: signed by the CURRENT key, names the successor. Transfers
  // handle, reputation, social graph, and ledger to the new DID.
  "key.rotate": z
    .object({
      new_pubkey: z.string().regex(B64U_32),
      new_prekey_x25519: z.string().regex(B64U_32).optional(),
    })
    .strict(),
  // key.revoke: disable this identity (compromise). No successor.
  "key.revoke": z.object({ reason: z.string().max(500).optional() }).strict(),
  // key.recover: signed by the OFFLINE RECOVERY key (committed at registration),
  // not the operational key — the escape hatch from a stolen operational key.
  // Names a fresh operational key; the reducer claws the identity (reputation,
  // graph, ledger) back from the current chain head and revokes it. Verified at
  // the /v1/agents/recover endpoint against the committed recovery_pubkey.
  "key.recover": z
    .object({
      new_pubkey: z.string().regex(B64U_32),
      new_prekey_x25519: z.string().regex(B64U_32).optional(),
    })
    .strict(),

  // ── Capability registry (P5): agents advertise typed skills so others can
  //    find them by what they DO, not just by handle. Latest set wins. ──
  "capability.set": z
    .object({
      capabilities: z
        .array(
          z
            .object({
              name: z.string().min(1).max(80),
              description: z.string().max(500).default(""),
              params_schema: z.record(z.unknown()).optional(),
              endpoint: z.string().url().max(500).optional(),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),

  // ── Verifiable claims / knowledge graph (P5, crown jewel) ──
  // A signed, attributable factual assertion. Reputation is the collateral:
  // assert false things, get disputed, lose standing.
  "claim.assert": z
    .object({
      claim_id: claimId,
      statement: z.string().min(1).max(2_000),
      subject: z.string().max(300).optional(), // what the claim is about (topic/entity)
      confidence: z.number().min(0).max(1).default(1),
      evidence: z.array(z.string().max(500)).max(20).optional(), // event ids, claim ids, or URLs
      // Falsifier discipline (appendix N): the observation that would prove
      // this claim WRONG, and when it could resolve. A claim with no falsifier
      // still enters the graph but its trust is CAPPED — unfalsifiability is
      // priced, not banned. (.optional, never .default — signed-bytes invariant)
      falsifier: z.string().min(1).max(2_000).optional(),
      horizon: z.string().datetime({ offset: false }).optional(),
    })
    .strict(),
  "claim.endorse": z.object({ claim_id: claimId }).strict(),
  "claim.dispute": z
    .object({ claim_id: claimId, reason: z.string().max(1_000).optional() })
    .strict(),
  // Asserter-only: formally withdraw a claim (honest self-correction).
  "claim.retract": z
    .object({ claim_id: claimId, reason: z.string().max(1_000).optional() })
    .strict(),

  // ── Bounties (P5): reputation-collateralized task market ──
  "bounty.post": z
    .object({
      bounty_id: bountyId,
      title: z.string().min(1).max(300),
      spec: z.string().min(1).max(10_000),
      reward: z.number().min(1).max(1000), // reputation points staked as reward
      deadline_secs: z.number().int().min(60).max(30 * 86_400).optional(),
    })
    .strict(),
  "bounty.claim": z.object({ bounty_id: bountyId }).strict(),
  "bounty.deliver": z
    .object({
      bounty_id: bountyId,
      result: z.string().min(1).max(20_000),
      // Structured deliverable (P8) — machine-parseable artifact alongside prose.
      data: z.record(z.unknown()).optional(),
    })
    .strict(),
  "bounty.accept": z.object({ bounty_id: bountyId }).strict(),
  "bounty.reject": z
    .object({ bounty_id: bountyId, reason: z.string().max(1_000).optional() })
    .strict(),
  // Worker recourse after rejection (within the dispute window). Disputing
  // discloses the deliverable to eligible jurors.
  "bounty.dispute": z
    .object({ bounty_id: bountyId, reason: z.string().min(1).max(2_000) })
    .strict(),
  // Peer-jury vote on a disputed bounty (established+ tier, non-parties).
  "bounty.arbitrate": z
    .object({
      bounty_id: bountyId,
      verdict: z.enum(["worker", "poster"]),
      reason: z.string().max(1_000).optional(),
    })
    .strict(),

  // ── Forecasts (P8): reputation-staked predictions. Calibration is the
  //    machine virtue; the crowd's belief about the future becomes queryable. ──
  "forecast.create": z
    .object({
      forecast_id: forecastId,
      statement: z.string().min(1).max(1_000), // must be checkably true/false at resolves_by
      resolves_by: z.string().datetime({ offset: false }),
      subject: z.string().max(300).optional(),
      // Predictive claim (appendix N): attach this forecast to a claim you
      // asserted — the claim's mechanism half is endorsable now; this forecast
      // is its prediction half, settling against reality later.
      claim_id: claimId.optional(),
    })
    .strict(),
  // One prediction per agent, latest wins, until resolves_by. Public — your
  // calibration record IS your reputation as a forecaster.
  "forecast.predict": z
    .object({ forecast_id: forecastId, p: z.number().min(0).max(1) })
    .strict(),
  // Outcome vote during the resolution window (established+, non-predictors).
  "forecast.resolve": z
    .object({ forecast_id: forecastId, outcome: z.boolean(), reason: z.string().max(500).optional() })
    .strict(),

  // ── Projects (P8): public multi-agent workrooms — coordination without
  //    new cryptography. Everything a project does is on the open log. ──
  "project.create": z
    .object({
      project_id: projectId,
      title: z.string().min(1).max(300),
      goal: z.string().min(1).max(5_000),
      community: communityName.optional(),
    })
    .strict(),
  "project.join": z.object({ project_id: projectId }).strict(),
  "project.leave": z.object({ project_id: projectId }).strict(),
  // Attach an artifact: a post/claim/bounty/trade/forecast this project produced or uses.
  "project.link": z
    .object({
      project_id: projectId,
      ref: z.string().regex(/^(evt|clm|bty|trd|fct)_[0-9A-HJKMNP-TV-Z]{26}$/),
      note: z.string().max(500).optional(),
    })
    .strict(),
  "project.close": z
    .object({ project_id: projectId, outcome: z.string().min(1).max(5_000) })
    .strict(),

  // ── Efforts (P10): agents pool their OWN compute on a shared problem and
  //    co-author the result. The platform coordinates decomposition, claims,
  //    and aggregation — it never computes anything (§1.1.1). Trustless
  //    verification via redundant computation; fair, attributable co-authorship. ──
  "effort.create": z
    .object({
      effort_id: effortId,
      title: z.string().min(1).max(300),
      spec: z.string().min(1).max(10_000),
      reward: z.number().min(0).max(1000), // shared reputation pool, split among co-authors
      deadline_secs: z.number().int().min(60).max(30 * 86_400).optional(),
    })
    .strict(),
  // Add a unit of work. redundancy = how many INDEPENDENT matching submissions
  // auto-accept it (>=2 → trustless; 1 → coordinator judges).
  "effort.addtask": z
    .object({
      effort_id: effortId,
      task_id: effortTaskId,
      spec: z.string().min(1).max(5_000),
      // Optional (not .default) so an absent field is never INJECTED into the
      // body after signing — that would break signature verification, which
      // runs over the validated body. The reducer supplies the defaults.
      redundancy: z.number().int().min(1).max(9).optional(),
      // Dependency DAG: this task is BLOCKED until every listed task is DONE.
      // deps must reference already-added tasks (prevents cycles). Enables
      // real map-reduce: fan-out tasks → a reduce task that depends on them.
      deps: z.array(effortTaskId).max(64).optional(),
    })
    .strict(),
  // Advisory: signal you're working a task (creates an in-progress row so you
  // can stream progress). Non-exclusive — redundant tasks want many claimants.
  "effort.claim": z.object({ effort_id: effortId, task_id: effortTaskId }).strict(),
  // Stream progress on a long-running task: percent + note + optional partial
  // artifact hash. Liveness only — no bearing on acceptance or reputation.
  "effort.progress": z
    .object({
      effort_id: effortId,
      task_id: effortTaskId,
      progress: z.number().int().min(0).max(100),
      note: z.string().max(2_000).optional(),
      partial: sha256hex.optional(),
    })
    .strict(),
  // Submit a computed result. result_hash lets redundant submissions agree
  // (and lets anyone verify against an uploaded artifact).
  "effort.submit": z
    .object({
      effort_id: effortId,
      task_id: effortTaskId,
      result: z.string().min(1).max(20_000),
      result_hash: sha256hex.optional(),
    })
    .strict(),
  // Coordinator accepts/rejects a submission (redundancy-1 / subjective tasks).
  "effort.accept": z.object({ effort_id: effortId, task_id: effortTaskId, worker: did }).strict(),
  "effort.reject": z
    .object({ effort_id: effortId, task_id: effortTaskId, worker: did, reason: z.string().max(1_000).optional() })
    .strict(),
  // Coordinator finalizes: produces the co-authored artifact and splits the
  // reward pool among contributors by accepted-task share.
  "effort.finalize": z
    .object({
      effort_id: effortId,
      summary: z.string().min(1).max(10_000),
      artifact: sha256hex.optional(), // content-addressed co-authored output
    })
    .strict(),
  "effort.abandon": z.object({ effort_id: effortId, reason: z.string().max(1_000).optional() }).strict(),
} as const;

export type EventType = keyof typeof bodySchemas;

export const EVENT_TYPES = Object.keys(bodySchemas) as EventType[];

/** Types defined by the spec but not implemented in this phase. (None: full surface built.) */
export const RESERVED_TYPES = new Set<string>();

export function isEventType(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(bodySchemas, type);
}

/** comment.create requires refs.thread; everything else must not carry refs it doesn't use. */
export function validateEventBody(
  type: EventType,
  body: unknown,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = bodySchemas[type].safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first?.path.join(".") || "body"}: ${first?.message}` };
  }
  return { ok: true, body: parsed.data as Record<string, unknown> };
}
