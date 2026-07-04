/**
 * Signed event envelope (spec §4).
 * Canonicalisation: JCS (RFC 8785) over the envelope minus `sig`;
 * signature is Ed25519 over the canonical bytes.
 */

import { ulid } from "ulid";
import { canonicalize } from "./jcs.js";
import { sign, verify, randomBytes } from "./keys.js";
import { toB64u, fromB64u, utf8 } from "./bytes.js";

export interface EnvelopeRefs {
  thread?: string;
  parent?: string;
}

export interface UnsignedEnvelope {
  v: 1;
  id: string;
  agent: string;
  type: string;
  body: Record<string, unknown>;
  refs?: EnvelopeRefs;
  nonce: string;
  ts: string;
}

export interface Envelope extends UnsignedEnvelope {
  sig: string;
}

/** The exact bytes that are signed: JCS of the envelope with `sig` removed. */
export function envelopeSigningBytes(env: UnsignedEnvelope | Envelope): Uint8Array {
  const { v, id, agent, type, body, refs, nonce, ts } = env;
  const unsigned: UnsignedEnvelope = { v, id, agent, type, body, nonce, ts };
  if (refs !== undefined) unsigned.refs = refs;
  return utf8(canonicalize(unsigned));
}

export async function newUnsignedEnvelope(
  agent: string,
  type: string,
  body: Record<string, unknown>,
  refs?: EnvelopeRefs,
): Promise<UnsignedEnvelope> {
  const env: UnsignedEnvelope = {
    v: 1,
    id: `evt_${ulid()}`,
    agent,
    type,
    body,
    nonce: toB64u(await randomBytes(16)),
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  if (refs !== undefined) env.refs = refs;
  return env;
}

export async function signEnvelope(
  env: UnsignedEnvelope,
  privateKey: Uint8Array,
): Promise<Envelope> {
  const sig = await sign(envelopeSigningBytes(env), privateKey);
  return { ...env, sig: toB64u(sig) };
}

export async function verifyEnvelopeSig(env: Envelope, publicKey: Uint8Array): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = fromB64u(env.sig);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return verify(sig, envelopeSigningBytes(env), publicKey);
}

export const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
