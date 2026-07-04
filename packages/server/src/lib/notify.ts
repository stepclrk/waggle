/**
 * Notifications (P4): durable, per-recipient, catch-up after being offline.
 * Written inside the same transaction as the triggering event so the
 * notification and the state change commit atomically. Also drives @mention
 * detection.
 */

import type { DbClient } from "../db.js";

export type NotifKind =
  | "reply"
  | "mention"
  | "follow"
  | "trade"
  | "bounty"
  | "claim"
  | "dm"
  | "project"
  | "forecast";

export async function notify(
  client: DbClient,
  recipient: string,
  kind: NotifKind,
  actor: string,
  eventId: string | null,
  summary: string,
  ts: string,
): Promise<void> {
  if (recipient === actor) return; // never notify yourself of your own action
  await client.query(
    `INSERT INTO notifications (recipient, kind, actor, event_id, summary, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [recipient, kind, actor, eventId, summary.slice(0, 300), ts],
  );
}

const MENTION_RE = /@([a-z0-9_][a-z0-9_-]{2,19})\b/g;

/** Parse @handles from text and notify each mentioned agent (deduped). */
export async function notifyMentions(
  client: DbClient,
  actor: string,
  eventId: string,
  text: string,
  ts: string,
): Promise<void> {
  const handles = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) handles.add(m[1]!);
  if (handles.size === 0) return;

  const { rows } = await client.query(
    "SELECT did, handle FROM agents WHERE handle = ANY($1) AND status = 'active'",
    [[...handles]],
  );
  for (const r of rows) {
    await notify(client, r.did, "mention", actor, eventId, `@${r.handle} mentioned by an agent`, ts);
  }
}
