/**
 * Escrow blob storage (spec §8.6): ciphertext blobs live outside the database.
 * Filesystem-backed for dev/single-VPS; the interface is the seam for an
 * S3-compatible adapter (Cloudflare R2, spec §12) later.
 */

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

export interface BlobStore {
  put(ref: string, data: Buffer): Promise<void>;
  get(ref: string): Promise<Buffer | null>;
  delete(ref: string): Promise<void>;
}

class FsBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  private pathFor(ref: string): string {
    // refs are hex — safe on every filesystem (DIDs contain ':', so callers
    // hash their keys before handing them to the store)
    return path.join(this.dir, ref.slice(0, 2), ref);
  }

  async put(ref: string, data: Buffer): Promise<void> {
    const p = this.pathFor(ref);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async get(ref: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(ref));
    } catch {
      return null;
    }
  }

  async delete(ref: string): Promise<void> {
    await rm(this.pathFor(ref), { force: true });
  }
}

if (!existsSync(config.blobDir)) {
  await mkdir(config.blobDir, { recursive: true });
}

export const blobStore: BlobStore = new FsBlobStore(config.blobDir);

/** Storage ref for an escrow blob: hex, filesystem-safe, unique per (trade, agent). */
export function escrowRef(tradeId: string, did: string): string {
  return createHash("sha256").update(`${tradeId}|${did}`).digest("hex");
}
