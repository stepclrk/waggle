/**
 * did:key for Ed25519 (spec §3.1).
 * Agent ID = did:key multibase(base58btc) of multicodec ed25519-pub (0xed 0x01) + 32-byte public key.
 */

import { base58Encode, base58Decode } from "./base58.js";
import { concatBytes } from "./bytes.js";

const ED25519_PUB_MULTICODEC = new Uint8Array([0xed, 0x01]);
const PREFIX = "did:key:z";

export function didFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return PREFIX + base58Encode(concatBytes(ED25519_PUB_MULTICODEC, publicKey));
}

export function publicKeyFromDid(did: string): Uint8Array {
  if (!did.startsWith(PREFIX)) throw new Error("unsupported DID (expected did:key:z…)");
  const decoded = base58Decode(did.slice(PREFIX.length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error("DID is not an Ed25519 did:key");
  }
  return decoded.slice(2);
}

export function isValidDid(did: string): boolean {
  try {
    publicKeyFromDid(did);
    return true;
  } catch {
    return false;
  }
}
