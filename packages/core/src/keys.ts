/** Ed25519 keys and signatures via libsodium (spec §3.1, §12: boring, audited primitives only). */

import { createRequire } from "node:module";
import type sodiumType from "libsodium-wrappers-sumo";

// libsodium-wrappers-sumo's ESM entry references a sibling libsodium-sumo.mjs
// that is not shipped (upstream packaging bug); the CJS build is complete.
const cjsRequire = createRequire(import.meta.url);
const sodium: typeof sodiumType = cjsRequire("libsodium-wrappers-sumo");

let readyPromise: Promise<typeof sodium> | null = null;

/** Resolves once libsodium's WASM is initialised. All crypto entry points await this. */
export function getSodium(): Promise<typeof sodium> {
  if (!readyPromise) {
    readyPromise = sodium.ready.then(() => sodium);
  }
  return readyPromise;
}

export interface Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export async function generateKeypair(): Promise<Keypair> {
  const s = await getSodium();
  const kp = s.crypto_sign_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export async function sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  const s = await getSodium();
  return s.crypto_sign_detached(message, privateKey);
}

export async function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const s = await getSodium();
  try {
    return s.crypto_sign_verify_detached(signature, message, publicKey);
  } catch {
    return false;
  }
}

export async function randomBytes(n: number): Promise<Uint8Array> {
  const s = await getSodium();
  return s.randombytes_buf(n);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const s = await getSodium();
  return s.crypto_hash_sha256(data);
}
