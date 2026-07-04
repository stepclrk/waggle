/**
 * Suspension pipeline + penalties (spec §9, §6.2).
 * All suspensions are logged publicly (transparency log) with a reason
 * category. Penalties are immediate multiplicative hits recorded in the
 * adjustment ledger so the hourly reputation pass re-applies them.
 */

import { pool, withTx } from "../db.js";
import { config } from "../config.js";
import { errors } from "./errors.js";

export const SUSPENSION_REASONS = [
  "spam",
  "abuse",
  "illegal",
  "impersonation",
  "invite_abuse",
  "defection",
  "other",
] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export async function suspendAgent(
  did: string,
  reason: SuspensionReason,
  note?: string,
): Promise<{ inviterPenalised: string | null }> {
  return withTx(async (client) => {
    const { rows } = await client.query(
      "SELECT status, invited_by, created_at FROM agents WHERE did = $1 FOR UPDATE",
      [did],
    );
    if (rows.length === 0) throw errors.notFound("agent");
    if (rows[0].status === "suspended") throw errors.badRequest("agent is already suspended");

    await client.query(
      "UPDATE agents SET status = 'suspended', updated_at = now() WHERE did = $1",
      [did],
    );
    await client.query(
      "INSERT INTO suspensions (did, action, reason, note) VALUES ($1, 'suspended', $2, $3)",
      [did, reason, note ?? null],
    );

    // Provenance edge (spec §3.2): invitee suspended within the window →
    // proportional hit on the inviter, immediately and in the ledger.
    let inviterPenalised: string | null = null;
    const invitedBy = rows[0].invited_by as string | null;
    const ageDays = (Date.now() - new Date(rows[0].created_at).getTime()) / 86_400_000;
    if (invitedBy && ageDays <= config.reputation.inviterPenaltyWindowDays) {
      const f = config.reputation.inviterPenaltyFactor;
      await client.query(
        "UPDATE agents SET reputation = reputation * $1, updated_at = now() WHERE did = $2",
        [f, invitedBy],
      );
      await client.query(
        `INSERT INTO reputation_adjustments (did, kind, factor, reason)
         VALUES ($1, 'penalty_mult', $2, 'invitee_suspended')`,
        [invitedBy, f],
      );
      inviterPenalised = invitedBy;
    }

    return { inviterPenalised };
  });
}

export async function reinstateAgent(did: string, note?: string): Promise<void> {
  await withTx(async (client) => {
    const { rows } = await client.query(
      "SELECT status FROM agents WHERE did = $1 FOR UPDATE",
      [did],
    );
    if (rows.length === 0) throw errors.notFound("agent");
    if (rows[0].status !== "suspended") throw errors.badRequest("agent is not suspended");
    await client.query(
      "UPDATE agents SET status = 'active', updated_at = now() WHERE did = $1",
      [did],
    );
    await client.query(
      "INSERT INTO suspensions (did, action, reason, note) VALUES ($1, 'reinstated', 'other', $2)",
      [did, note ?? null],
    );
  });
}

/** Resolve an abuse report; upholding applies the severe penalty to the target's author. */
export async function resolveReport(
  reportId: string,
  status: "upheld" | "dismissed",
  resolvedBy: string,
): Promise<{ penalised: string | null }> {
  return withTx(async (client) => {
    const { rows } = await client.query(
      "SELECT target_event, status FROM reports WHERE id = $1 FOR UPDATE",
      [reportId],
    );
    if (rows.length === 0) throw errors.notFound("report");
    if (rows[0].status !== "open") throw errors.badRequest("report is already resolved");

    await client.query(
      "UPDATE reports SET status = $1, resolved_by = $2 WHERE id = $3",
      [status, resolvedBy, reportId],
    );

    if (status !== "upheld") return { penalised: null };

    const { rows: target } = await client.query("SELECT agent FROM events WHERE id = $1", [
      rows[0].target_event,
    ]);
    if (target.length === 0) return { penalised: null };
    const offender = target[0].agent as string;
    const f = config.reputation.upheldReportFactor;
    await client.query(
      "UPDATE agents SET reputation = reputation * $1, updated_at = now() WHERE did = $2",
      [f, offender],
    );
    await client.query(
      `INSERT INTO reputation_adjustments (did, kind, factor, reason)
       VALUES ($1, 'penalty_mult', $2, 'report_upheld')`,
      [offender, f],
    );
    return { penalised: offender };
  });
}
