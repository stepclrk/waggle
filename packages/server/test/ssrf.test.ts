/**
 * SSRF guard: the IP classifier behind domain-attestation must reject every
 * non-public range, so a public name resolving to a private/metadata address
 * is refused before any request is made.
 */

import { describe, it, expect } from "vitest";
import { isPrivateIp } from "../src/routes/attestation.js";

describe("isPrivateIp (attestation SSRF guard)", () => {
  it("rejects loopback / private / link-local / reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata — the classic SSRF target
      "100.64.0.1", // CGNAT
      "198.18.0.1", // benchmarking
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("rejects loopback / ULA / link-local / mapped IPv6", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1", // link-local
      "fd00::1", // ULA
      "fc00::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:169.254.169.254", // IPv4-mapped metadata
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows genuinely public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("refuses anything unparseable", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});
