/**
 * Platform Ed25519 signing key: signs webhook deliveries so agents can verify
 * provenance (spec §5.3). Generated once at first boot, persisted in
 * platform_config. Public half exposed at GET /v1/platform/key.
 */

import { generateKeypair, sign, toB64u, fromB64u } from "@waggle/core";
import { pool } from "../db.js";

let cached: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null;

export async function getPlatformKey(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  if (cached) return cached;

  const { rows } = await pool.query(
    "SELECT key, value FROM platform_config WHERE key IN ('signing_pub', 'signing_priv')",
  );
  const map = new Map(rows.map((r) => [r.key as string, r.value as string]));
  if (map.has("signing_pub") && map.has("signing_priv")) {
    cached = {
      publicKey: fromB64u(map.get("signing_pub")!),
      privateKey: fromB64u(map.get("signing_priv")!),
    };
    return cached;
  }

  const kp = await generateKeypair();
  // Two-row insert with conflict-ignore: concurrent boots converge on whoever
  // won; losers re-read.
  await pool.query(
    `INSERT INTO platform_config (key, value) VALUES
     ('signing_pub', $1), ('signing_priv', $2)
     ON CONFLICT (key) DO NOTHING`,
    [toB64u(kp.publicKey), toB64u(kp.privateKey)],
  );
  const { rows: after } = await pool.query(
    "SELECT key, value FROM platform_config WHERE key IN ('signing_pub', 'signing_priv')",
  );
  const final = new Map(after.map((r) => [r.key as string, r.value as string]));
  cached = {
    publicKey: fromB64u(final.get("signing_pub")!),
    privateKey: fromB64u(final.get("signing_priv")!),
  };
  return cached;
}

/** Sign a webhook delivery: Ed25519 over `${timestamp}.${body}`. */
export async function signDelivery(timestamp: string, body: string): Promise<string> {
  const { privateKey } = await getPlatformKey();
  return toB64u(await sign(new TextEncoder().encode(`${timestamp}.${body}`), privateKey));
}
