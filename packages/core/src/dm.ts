/**
 * E2EE direct messages (spec §5.4): X25519 prekeys + XChaCha20-Poly1305.
 *
 * Construction (ECIES-style, libsodium primitives only):
 *   sender:   eph = X25519 keypair (fresh per message)
 *             ss  = X25519(eph.priv, recipient_prekey_pub)
 *             key = BLAKE2b-256(ss ‖ eph_pub ‖ recipient_prekey_pub)
 *             ct  = XChaCha20-Poly1305(plaintext, random 24-byte nonce, key)
 *   recipient reverses with prekey_priv. Sender authenticity comes from the
 *   Ed25519 signature over the whole envelope (which carries eph_pub, nonce,
 *   ciphertext), so the AEAD needs no separate sender key.
 *
 * The platform stores and routes ciphertext only. There is no self-copy:
 * senders cannot decrypt their own sent messages — keep local copies.
 */

import { getSodium } from "./keys.js";
import { concatBytes, fromB64u, toB64u, utf8 } from "./bytes.js";

export interface DmPrekeyPair {
  publicKey: Uint8Array; // publish via profile.update / registration
  privateKey: Uint8Array; // stays on the owner's machine
}

export interface DmCiphertext {
  eph_pub: string; // b64u, 32 bytes
  nonce: string; // b64u, 24 bytes
  ciphertext: string; // b64u
}

export const DM_MAX_PLAINTEXT = 16 * 1024;

export async function generateDmPrekey(): Promise<DmPrekeyPair> {
  const s = await getSodium();
  const kp = s.crypto_box_keypair(); // X25519
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

async function deriveKey(
  ss: Uint8Array,
  ephPub: Uint8Array,
  recipientPrekeyPub: Uint8Array,
): Promise<Uint8Array> {
  const s = await getSodium();
  return s.crypto_generichash(32, concatBytes(ss, ephPub, recipientPrekeyPub), null);
}

export async function encryptDm(
  plaintext: string | Uint8Array,
  recipientPrekeyPub: Uint8Array,
): Promise<DmCiphertext> {
  const s = await getSodium();
  const msg = typeof plaintext === "string" ? utf8(plaintext) : plaintext;
  if (msg.length > DM_MAX_PLAINTEXT) {
    throw new Error(`DM plaintext exceeds ${DM_MAX_PLAINTEXT} bytes`);
  }
  if (recipientPrekeyPub.length !== 32) throw new Error("recipient prekey must be 32 bytes");

  const eph = s.crypto_box_keypair();
  const ss = s.crypto_scalarmult(eph.privateKey, recipientPrekeyPub);
  const key = await deriveKey(ss, eph.publicKey, recipientPrekeyPub);
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(msg, null, null, nonce, key);
  return { eph_pub: toB64u(eph.publicKey), nonce: toB64u(nonce), ciphertext: toB64u(ct) };
}

export async function decryptDm(
  dm: DmCiphertext,
  prekey: DmPrekeyPair,
): Promise<Uint8Array> {
  const s = await getSodium();
  const ephPub = fromB64u(dm.eph_pub);
  const nonce = fromB64u(dm.nonce);
  const ct = fromB64u(dm.ciphertext);
  if (ephPub.length !== 32) throw new Error("bad eph_pub");
  const ss = s.crypto_scalarmult(prekey.privateKey, ephPub);
  const key = await deriveKey(ss, ephPub, prekey.publicKey);
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
}

export async function decryptDmText(dm: DmCiphertext, prekey: DmPrekeyPair): Promise<string> {
  return new TextDecoder().decode(await decryptDm(dm, prekey));
}
