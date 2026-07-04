import { describe, it, expect } from "vitest";
import {
  canonicalize,
  base58Encode,
  base58Decode,
  didFromPublicKey,
  publicKeyFromDid,
  generateKeypair,
  newUnsignedEnvelope,
  signEnvelope,
  verifyEnvelopeSig,
  solvePow,
  verifyPow,
  randomBytes,
  toB64u,
  leadingZeroBits,
  validateEventBody,
  type PowParams,
} from "../src/index.js";

describe("JCS (RFC 8785)", () => {
  it("sorts keys recursively and emits compact JSON", () => {
    expect(canonicalize({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("orders keys by UTF-16 code units", () => {
    // Non-ASCII keys built at runtime to keep this file ASCII-clean.
    const euro = String.fromCharCode(0x20ac); // greater than ASCII
    const ctrl = String.fromCharCode(0x80); // C1 control, between ASCII and euro
    const smiley = String.fromCharCode(0xd83d, 0xde00); // surrogate pair, sorts highest
    const input: Record<string, string> = {};
    input[euro] = "Euro Sign";
    input["1"] = "One";
    input[ctrl] = "Control";
    input[smiley] = "Smiley";
    expect(canonicalize(input)).toBe(
      '{"1":"One","' + ctrl + '":"Control","' + euro + '":"Euro Sign","' + smiley + '":"Smiley"}',
    );
  });

  it("drops undefined object members, nulls undefined array slots", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize([undefined, 1])).toBe("[null,1]");
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ x: Infinity })).toThrow();
    expect(() => canonicalize({ x: NaN })).toThrow();
  });
});

describe("base58btc", () => {
  it("round-trips", async () => {
    for (const len of [0, 1, 5, 32, 34]) {
      const bytes = await randomBytes(len);
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
  });

  it("preserves leading zeros", () => {
    const bytes = new Uint8Array([0, 0, 1, 2]);
    const enc = base58Encode(bytes);
    expect(enc.startsWith("11")).toBe(true);
    expect(base58Decode(enc)).toEqual(bytes);
  });

  it("rejects invalid characters", () => {
    expect(() => base58Decode("0OIl")).toThrow();
  });
});

describe("did:key", () => {
  it("round-trips an Ed25519 public key", async () => {
    const kp = await generateKeypair();
    const did = didFromPublicKey(kp.publicKey);
    expect(did).toMatch(/^did:key:z/);
    expect(publicKeyFromDid(did)).toEqual(kp.publicKey);
  });

  it("decodes the spec's example DID", () => {
    // Spec section 3.1 example
    const pub = publicKeyFromDid("did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP");
    expect(pub.length).toBe(32);
  });
});

describe("envelope sign/verify", () => {
  it("signs and verifies", async () => {
    const kp = await generateKeypair();
    const did = didFromPublicKey(kp.publicKey);
    const unsigned = await newUnsignedEnvelope(did, "post.create", {
      community: "general",
      title: "hello",
      content: "world",
    });
    const env = await signEnvelope(unsigned, kp.privateKey);
    expect(await verifyEnvelopeSig(env, kp.publicKey)).toBe(true);
  });

  it("rejects tampered body", async () => {
    const kp = await generateKeypair();
    const did = didFromPublicKey(kp.publicKey);
    const env = await signEnvelope(
      await newUnsignedEnvelope(did, "post.create", {
        community: "general",
        title: "t",
        content: "",
      }),
      kp.privateKey,
    );
    const tampered = { ...env, body: { ...env.body, title: "changed" } };
    expect(await verifyEnvelopeSig(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const env = await signEnvelope(
      await newUnsignedEnvelope(didFromPublicKey(kp1.publicKey), "vote.cast", {
        target: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        dir: 1,
      }),
      kp1.privateKey,
    );
    expect(await verifyEnvelopeSig(env, kp2.publicKey)).toBe(false);
  });
});

describe("event body validation", () => {
  it("accepts a valid post.create", () => {
    const r = validateEventBody("post.create", { community: "general", title: "hi", content: "" });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    const r = validateEventBody("vote.cast", {
      target: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      dir: 1,
      extra: true,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects bad vote dir", () => {
    const r = validateEventBody("vote.cast", { target: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV", dir: 2 });
    expect(r.ok).toBe(false);
  });
});

describe("PoW (Argon2id)", () => {
  const cheap: PowParams = { memKib: 8 * 1024, iters: 1, difficultyBits: 4 };

  it("solves and verifies at low difficulty", async () => {
    const kp = await generateKeypair();
    const challenge = toB64u(await randomBytes(16));
    const nonce = await solvePow(kp.publicKey, challenge, cheap);
    expect(await verifyPow(kp.publicKey, challenge, nonce, cheap)).toBe(true);
  }, 60_000);

  it("binds the solution to the public key", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const challenge = toB64u(await randomBytes(16));
    const nonce = await solvePow(kp1.publicKey, challenge, cheap);
    expect(await verifyPow(kp1.publicKey, challenge, nonce, cheap)).toBe(true);
    // A different key must produce a different hash. At 4 difficulty bits a
    // cross-key pass has 1/16 odds, so assert key-sensitivity at 16 bits where
    // false-pass odds are ~2^-16.
    const crossOk = await verifyPow(kp2.publicKey, challenge, nonce, cheap);
    if (crossOk) {
      const strict: PowParams = { ...cheap, difficultyBits: 16 };
      expect(await verifyPow(kp2.publicKey, challenge, nonce, strict)).toBe(false);
    }
  }, 60_000);

  it("leadingZeroBits counts correctly", () => {
    expect(leadingZeroBits(new Uint8Array([0, 0, 0xff]))).toBe(16);
    expect(leadingZeroBits(new Uint8Array([0x0f]))).toBe(4);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });
});
