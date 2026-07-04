import { describe, it, expect } from "vitest";
import {
  generateDmPrekey,
  encryptTradePayload,
  decryptTradePayload,
  deriveTradeKey,
  openTradeBlobWithKey,
  tradeBlobHash,
  randomBytes,
} from "../src/index.js";

describe("trade payload crypto (spec §8.5)", () => {
  it("round-trips a payload to the counterparty's prekey", async () => {
    const bob = await generateDmPrekey();
    const blob = await encryptTradePayload("vLLM NVFP4 config: kv_cache=0.85, tp=2", bob.publicKey);
    const plain = await decryptTradePayload(blob, bob);
    expect(new TextDecoder().decode(plain)).toBe("vLLM NVFP4 config: kv_cache=0.85, tp=2");
  });

  it("hash-of-ciphertext commitment is stable and hex", async () => {
    const bob = await generateDmPrekey();
    const blob = await encryptTradePayload("payload", bob.publicKey);
    const h1 = await tradeBlobHash(blob);
    const h2 = await tradeBlobHash(blob);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("any blob tamper changes the hash and breaks decryption", async () => {
    const bob = await generateDmPrekey();
    const blob = await encryptTradePayload("payload", bob.publicKey);
    const tampered = Uint8Array.from(blob);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(await tradeBlobHash(tampered)).not.toBe(await tradeBlobHash(blob));
    await expect(decryptTradePayload(tampered, bob)).rejects.toThrow();
  });

  it("wrong prekey cannot decrypt", async () => {
    const bob = await generateDmPrekey();
    const eve = await generateDmPrekey();
    const blob = await encryptTradePayload("secret", bob.publicKey);
    await expect(decryptTradePayload(blob, eve)).rejects.toThrow();
  });

  it("verifiable disclosure: recipient-derived key opens the blob platform-side", async () => {
    const bob = await generateDmPrekey();
    const blob = await encryptTradePayload("disputed content", bob.publicKey);
    // Recipient derives the symmetric key and hands it to the platform.
    const key = await deriveTradeKey(blob, bob);
    const opened = await openTradeBlobWithKey(blob, key);
    expect(new TextDecoder().decode(opened)).toBe("disputed content");
    // A random key fails — false disclosures are impossible to fabricate.
    await expect(openTradeBlobWithKey(blob, await randomBytes(32))).rejects.toThrow();
  });

  it("handles binary payloads", async () => {
    const bob = await generateDmPrekey();
    const payload = await randomBytes(4096);
    const blob = await encryptTradePayload(payload, bob.publicKey);
    expect(await decryptTradePayload(blob, bob)).toEqual(payload);
  });
});
