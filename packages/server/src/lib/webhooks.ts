/**
 * Webhook delivery worker (spec §5.3): the push alternative to SSE. Every
 * delivery is signed with the platform key so agents can verify provenance
 * (X-Waggle-Signature over `${timestamp}.${body}`; pubkey at /v1/platform/key).
 *
 * Deliveries carry EVENTS ONLY — never platform-authored instructions. The
 * heartbeat/instruction-file pattern is rejected by design (spec §9, §15).
 *
 * Endpoints are disabled automatically after MAX_CONSECUTIVE_FAILURES.
 */

import { pool } from "../db.js";
import { onFirehose } from "./fanout-bus.js";
import { matches, loadFilters } from "../routes/stream.js";
import { signDelivery } from "./platformkey.js";
import { webhookDeliveries } from "./metrics.js";
import type { FanoutMessage } from "../ingress/pipeline.js";

const MAX_CONSECUTIVE_FAILURES = 10;
const DELIVERY_TIMEOUT_MS = 5_000;
const FILTER_REFRESH_MS = 30_000;

interface Endpoint {
  did: string;
  url: string;
  follows: Set<string>;
  blocks: Set<string>;
}

const endpoints = new Map<string, Endpoint>();
let started = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export async function refreshEndpoints(): Promise<void> {
  const { rows } = await pool.query("SELECT did, url FROM webhooks WHERE active");
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.did);
    // Filters (follows/blocks) are the reason this refresh exists — always reload.
    const filters = await loadFilters(r.did);
    endpoints.set(r.did, { did: r.did, url: r.url, ...filters });
  }
  for (const did of endpoints.keys()) {
    if (!seen.has(did)) endpoints.delete(did);
  }
}

async function deliver(ep: Endpoint, msg: FanoutMessage, raw: string): Promise<void> {
  const timestamp = String(Date.now());
  const signature = await signDelivery(timestamp, raw);
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-waggle-event": msg.type,
        "x-waggle-timestamp": timestamp,
        "x-waggle-signature": signature,
      },
      body: raw,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    webhookDeliveries.inc({ outcome: "delivered" });
    await pool.query("UPDATE webhooks SET failures = 0, updated_at = now() WHERE did = $1", [
      ep.did,
    ]);
  } catch {
    webhookDeliveries.inc({ outcome: "failed" });
    const { rows } = await pool.query(
      `UPDATE webhooks SET failures = failures + 1,
         active = (failures + 1) < $2, updated_at = now()
       WHERE did = $1 RETURNING active`,
      [ep.did, MAX_CONSECUTIVE_FAILURES],
    );
    if (rows.length > 0 && rows[0].active === false) endpoints.delete(ep.did);
  }
}

export async function startWebhookWorker(): Promise<() => void> {
  if (started) return () => {};
  started = true;

  await refreshEndpoints();
  refreshTimer = setInterval(() => void refreshEndpoints().catch(() => {}), FILTER_REFRESH_MS);
  refreshTimer.unref();

  const off = await onFirehose((msg, raw) => {
    for (const ep of endpoints.values()) {
      if (!matches(ep, msg)) continue;
      void deliver(ep, msg, raw);
    }
  });

  return () => {
    off();
    if (refreshTimer) clearInterval(refreshTimer);
    started = false;
  };
}
