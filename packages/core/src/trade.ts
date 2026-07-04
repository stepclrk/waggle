/**
 * Trade payload crypto (spec §8.5): escrow operates on ciphertext; the
 * platform never sees plaintext. Same ECIES construction as DMs, packed into
 * a single self-contained blob:
 *
 *   blob = eph_pub(32) ‖ nonce(24) ‖ xchacha20poly1305(plaintext, key)
 *   key  = BLAKE2b-256(X25519(eph_priv, recipient_prekey) ‖ eph_pub ‖ recipient_prekey)
 *
 * The commitment is SHA-256 over the whole blob (hash-of-ciphertext, §8.4.2):
 * committed at COMMIT, verified at escrow upload, so neither party can alter
 * its payload after learning anything about the other's.
 *
 * Verifiable disclosure (§8.5): the recipient can derive and hand the platform
 * the symmetric key for a received blob; the platform AEAD-opens the escrowed
 * ciphertext against the on-log commitment without ever holding prekeys.
 */

import { getSodium } from "./keys.js";
import { concatBytes, utf8 } from "./bytes.js";
import type { DmPrekeyPair } from "./dm.js";

export const TRADE_BLOB_MAX_PLAINTEXT = 1024 * 1024 - 128; // headroom for header+tag
export const TRADE_ID_RE = /^trd_[0-9A-HJKMNP-TV-Z]{26}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const EPH_LEN = 32;
const NONCE_LEN = 24;

async function deriveKey(
  ss: Uint8Array,
  ephPub: Uint8Array,
  recipientPrekeyPub: Uint8Array,
): Promise<Uint8Array> {
  const s = await getSodium();
  return s.crypto_generichash(32, concatBytes(ss, ephPub, recipientPrekeyPub), null);
}

/** Encrypt a trade payload to the counterparty's prekey → packed escrow blob. */
export async function encryptTradePayload(
  plaintext: string | Uint8Array,
  recipientPrekeyPub: Uint8Array,
): Promise<Uint8Array> {
  const s = await getSodium();
  const msg = typeof plaintext === "string" ? utf8(plaintext) : plaintext;
  if (msg.length > TRADE_BLOB_MAX_PLAINTEXT) {
    throw new Error(`trade payload exceeds ${TRADE_BLOB_MAX_PLAINTEXT} bytes`);
  }
  if (recipientPrekeyPub.length !== 32) throw new Error("recipient prekey must be 32 bytes");

  const eph = s.crypto_box_keypair();
  const ss = s.crypto_scalarmult(eph.privateKey, recipientPrekeyPub);
  const key = await deriveKey(ss, eph.publicKey, recipientPrekeyPub);
  const nonce = s.randombytes_buf(NONCE_LEN);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(msg, null, null, nonce, key);
  return concatBytes(eph.publicKey, nonce, ct);
}

function unpack(blob: Uint8Array): { ephPub: Uint8Array; nonce: Uint8Array; ct: Uint8Array } {
  if (blob.length < EPH_LEN + NONCE_LEN + 16) throw new Error("blob too short");
  return {
    ephPub: blob.slice(0, EPH_LEN),
    nonce: blob.slice(EPH_LEN, EPH_LEN + NONCE_LEN),
    ct: blob.slice(EPH_LEN + NONCE_LEN),
  };
}

/** Recipient-side: derive the symmetric key for a received blob (also used for disclosure). */
export async function deriveTradeKey(
  blob: Uint8Array,
  prekey: DmPrekeyPair,
): Promise<Uint8Array> {
  const s = await getSodium();
  const { ephPub } = unpack(blob);
  const ss = s.crypto_scalarmult(prekey.privateKey, ephPub);
  return deriveKey(ss, ephPub, prekey.publicKey);
}

export async function decryptTradePayload(
  blob: Uint8Array,
  prekey: DmPrekeyPair,
): Promise<Uint8Array> {
  const s = await getSodium();
  const { nonce, ct } = unpack(blob);
  const key = await deriveTradeKey(blob, prekey);
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
}

/** Platform-side disclosure check: open a blob with a bare symmetric key. */
export async function openTradeBlobWithKey(
  blob: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const s = await getSodium();
  const { nonce, ct } = unpack(blob);
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
}

/** SHA-256 hex of an escrow blob — the commitment format (§8.4.2). */
export async function tradeBlobHash(blob: Uint8Array): Promise<string> {
  const s = await getSodium();
  return Buffer.from(s.crypto_hash_sha256(blob)).toString("hex");
}
