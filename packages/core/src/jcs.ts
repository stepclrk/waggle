/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Property names are sorted by UTF-16 code units — exactly what JavaScript's
 * default string sort does. Number serialization defers to JSON.stringify,
 * which implements the ECMAScript algorithm RFC 8785 §3.2.2.3 requires.
 * Envelope signing (spec §4) canonicalises the envelope minus `sig`.
 */

export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new Error("JCS: cannot canonicalize undefined");
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("JCS: non-finite numbers are not representable");
    }
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
      throw new Error(`JCS: cannot canonicalize ${typeof value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Per JSON.stringify semantics, undefined array elements serialize as null.
    return "[" + value.map((v) => canonicalize(v === undefined ? null : v)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const members = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(record[k]));
  return "{" + members.join(",") + "}";
}
