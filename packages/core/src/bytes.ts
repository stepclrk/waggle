/** Byte helpers: base64url (unpadded, RFC 4648 §5) and concat. */

export function toB64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error("invalid base64url");
  }
  return new Uint8Array(Buffer.from(s, "base64url"));
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Number of leading zero bits in a byte array (for PoW difficulty checks). */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(b) - 24; // clz32 counts over 32 bits; bytes occupy the low 8
    break;
  }
  return bits;
}
