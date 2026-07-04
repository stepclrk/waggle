/**
 * Registration proof-of-work (spec §3.2): memory-hard Argon2id, bound to the
 * candidate public key. hash = argon2id(password = pubkey ‖ nonce, salt = challenge).
 * Valid iff the hash has ≥ difficultyBits leading zero bits.
 *
 * Parameters are server-issued so difficulty can auto-scale with registration
 * velocity. Dev/test defaults are deliberately cheap; production calibration
 * is spec §14 open decision 2.
 */

import { getSodium } from "./keys.js";
import { concatBytes, fromB64u, toB64u, leadingZeroBits } from "./bytes.js";

export interface PowParams {
  /** Argon2id memory, KiB. */
  memKib: number;
  /** Argon2id iterations (opslimit). */
  iters: number;
  /** Required leading zero bits of the output hash. */
  difficultyBits: number;
}

const HASH_BYTES = 32;
const NONCE_BYTES = 8;

async function powHash(
  pubkey: Uint8Array,
  challenge: Uint8Array,
  nonce: Uint8Array,
  params: PowParams,
): Promise<Uint8Array> {
  const s = await getSodium();
  if (challenge.length !== s.crypto_pwhash_SALTBYTES) {
    throw new Error(`PoW challenge must be ${s.crypto_pwhash_SALTBYTES} bytes`);
  }
  return s.crypto_pwhash(
    HASH_BYTES,
    concatBytes(pubkey, nonce),
    challenge,
    params.iters,
    params.memKib * 1024,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Iterate nonces until the difficulty target is met. CPU/memory-bound by design. */
export async function solvePow(
  pubkey: Uint8Array,
  challengeB64u: string,
  params: PowParams,
  onAttempt?: (attempts: number) => void,
): Promise<string> {
  const challenge = fromB64u(challengeB64u);
  const nonce = new Uint8Array(NONCE_BYTES);
  const view = new DataView(nonce.buffer);
  for (let attempt = 0; ; attempt++) {
    view.setUint32(0, attempt >>> 0, true);
    view.setUint32(4, Math.floor(attempt / 0x1_0000_0000), true);
    const hash = await powHash(pubkey, challenge, nonce, params);
    if (leadingZeroBits(hash) >= params.difficultyBits) {
      return toB64u(nonce);
    }
    if (onAttempt && attempt % 8 === 0) onAttempt(attempt + 1);
  }
}

/** Server-side check: one Argon2id computation. */
export async function verifyPow(
  pubkey: Uint8Array,
  challengeB64u: string,
  nonceB64u: string,
  params: PowParams,
): Promise<boolean> {
  let challenge: Uint8Array;
  let nonce: Uint8Array;
  try {
    challenge = fromB64u(challengeB64u);
    nonce = fromB64u(nonceB64u);
  } catch {
    return false;
  }
  if (nonce.length !== NONCE_BYTES) return false;
  try {
    const hash = await powHash(pubkey, challenge, nonce, params);
    return leadingZeroBits(hash) >= params.difficultyBits;
  } catch {
    return false;
  }
}
