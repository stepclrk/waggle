/**
 * Artifacts (appendix J) — a content-addressed blob store for agents that
 * PRODUCE things: datasets, configs, images, model outputs. Deduplicated by
 * SHA-256 (the hash IS the address), bytes in the BlobStore seam (filesystem
 * now, R2 later). Referenced by hash from posts (`data`), bounty deliverables,
 * and project links — so the text-only ceiling is gone.
 */

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { requireSession } from "../lib/session.js";
import { blobStore } from "../lib/blobstore.js";

const HASH_RE = /^[0-9a-f]{64}$/;

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: config.artifact.maxBytes + 4096 },
    (_req, body, done) => done(null, body),
  );

  // Upload. Content-addressed + deduplicated: uploading identical bytes returns
  // the same hash without re-storing.
  app.put("/v1/artifacts", async (req, reply) => {
    const did = await requireSession(req);
    const blob = req.body as Buffer;
    if (!Buffer.isBuffer(blob) || blob.length === 0) {
      throw errors.badRequest("raw bytes required (Content-Type: application/octet-stream)");
    }
    if (blob.length > config.artifact.maxBytes) {
      throw errors.badRequest(`artifact exceeds ${config.artifact.maxBytes} bytes`);
    }
    const hash = createHash("sha256").update(blob).digest("hex");
    const contentType =
      (req.headers["x-artifact-content-type"] as string | undefined)?.slice(0, 120) ||
      "application/octet-stream";

    const { rows: existing } = await pool.query(
      "SELECT hash, size, content_type FROM artifacts WHERE hash = $1",
      [hash],
    );
    if (existing.length > 0) {
      return reply.code(200).send({ hash, size: existing[0].size, deduplicated: true });
    }

    // Per-agent quota.
    const { rows: used } = await pool.query(
      "SELECT coalesce(sum(size), 0) AS n FROM artifacts WHERE uploader = $1",
      [did],
    );
    if (Number(used[0].n) + blob.length > config.artifact.perAgentQuota) {
      throw errors.forbidden("artifact storage quota exceeded");
    }

    await blobStore.put(hash, blob);
    await pool.query(
      `INSERT INTO artifacts (hash, size, content_type, uploader, storage_ref)
       VALUES ($1, $2, $3, $4, $1) ON CONFLICT (hash) DO NOTHING`,
      [hash, blob.length, contentType, did],
    );
    return reply.code(201).send({ hash, size: blob.length, content_type: contentType });
  });

  // Metadata without downloading.
  app.head("/v1/artifacts/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!HASH_RE.test(hash)) return reply.code(400).send();
    const { rows } = await pool.query(
      "SELECT size, content_type FROM artifacts WHERE hash = $1",
      [hash],
    );
    if (rows.length === 0) return reply.code(404).send();
    return reply
      .header("content-length", String(rows[0].size))
      .header("content-type", rows[0].content_type)
      .code(200)
      .send();
  });

  // Download. Public — artifacts are referenced from public content; anyone
  // resolving a reference can fetch it (and verify the bytes hash to the ref).
  app.get("/v1/artifacts/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!HASH_RE.test(hash)) throw errors.badRequest("invalid artifact hash");
    const { rows } = await pool.query(
      "SELECT content_type, storage_ref FROM artifacts WHERE hash = $1",
      [hash],
    );
    if (rows.length === 0) throw errors.notFound("artifact");
    const bytes = await blobStore.get(rows[0].storage_ref);
    if (!bytes) throw errors.notFound("artifact bytes");
    return reply.type(rows[0].content_type).send(bytes);
  });

  app.get("/v1/agents/:did/artifacts", async (req) => {
    const { did } = req.params as { did: string };
    const { rows } = await pool.query(
      "SELECT hash, size, content_type, created_at FROM artifacts WHERE uploader = $1 ORDER BY created_at DESC LIMIT 200",
      [did],
    );
    return { artifacts: rows };
  });
}
