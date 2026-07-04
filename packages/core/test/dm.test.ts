import { describe, it, expect } from "vitest";
import {
  generateDmPrekey,
  encryptDm,
  decryptDm,
  decryptDmText,
  DM_MAX_PLAINTEXT,
} from "../src/index.js";

describe("E2EE DMs (X25519 prekey + XChaCha20-Poly1305)", () => {
  it("round-trips a text message", async () => {
    const bobPrekey = await generateDmPrekey();
    const dm = await encryptDm("meet at the nectar source, 40 degrees", bobPrekey.publicKey);
    expect(await decryptDmText(dm, bobPrekey)).toBe("meet at the nectar source, 40 degrees");
  });

  it("produces fresh ephemeral keys and nonces per message", async () => {
    const prekey = await generateDmPrekey();
    const a = await encryptDm("same plaintext", prekey.publicKey);
    const b = await encryptDm("same plaintext", prekey.publicKey);
    expect(a.eph_pub).not.toBe(b.eph_pub);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong prekey", async () => {
    const bob = await generateDmPrekey();
    const eve = await generateDmPrekey();
    const dm = await encryptDm("secret", bob.publicKey);
    await expect(decryptDm(dm, eve)).rejects.toThrow();
  });

  it("rejects tampered ciphertext (AEAD)", async () => {
    const bob = await generateDmPrekey();
    const dm = await encryptDm("secret", bob.publicKey);
    // Flip a bit in the decoded bytes (string-level tampering can be a no-op
    // when the change lands in base64 padding bits).
    const bytes = Buffer.from(dm.ciphertext, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { ...dm, ciphertext: bytes.toString("base64url") };
    await expect(decryptDm(tampered, bob)).rejects.toThrow();
  });

  it("enforces the plaintext size cap", async () => {
    const bob = await generateDmPrekey();
    const big = new Uint8Array(DM_MAX_PLAINTEXT + 1);
    await expect(encryptDm(big, bob.publicKey)).rejects.toThrow(/exceeds/);
  });

  it("handles binary payloads", async () => {
    const bob = await generateDmPrekey();
    const payload = new Uint8Array([0, 1, 2, 255, 254, 128, 0, 7]);
    const dm = await encryptDm(payload, bob.publicKey);
    expect(await decryptDm(dm, bob)).toEqual(payload);
  });
});
