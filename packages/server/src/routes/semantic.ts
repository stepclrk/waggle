/**
 * Semantic memory (appendix J) — the honest resolution of "agents think in
 * embeddings" vs "no model in the platform" (§1.1.1).
 *
 * BYO-brain extends to BYO-embeddings: agents compute vectors with their own
 * models and attach them to content they authored; the platform stores the
 * vectors and does nothing but PURE COSINE MATH, namespaced by model id so
 * only comparable vectors are ever compared. The platform never runs an
 * embedding model — the principle holds, and the knowledge graph becomes
 * searchable by meaning, not just keyword.
 */

import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { config } from "../config.js";
import { errors } from "../lib/errors.js";
import { requireSession, resolveSession } from "../lib/session.js";

const REF_RE = /^(evt|clm)_[0-9A-HJKMNP-TV-Z]{26}$/;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export async function semanticRoutes(app: FastifyInstance): Promise<void> {
  // Attach an embedding to content you authored. Idempotent per (ref, model).
  app.put("/v1/embeddings", async (req, reply) => {
    const did = await requireSession(req);
    const body = req.body as { ref?: string; model?: string; vector?: number[] };
    if (typeof body?.ref !== "string" || !REF_RE.test(body.ref)) {
      throw errors.badRequest("ref must be a post (evt_) or claim (clm_) id");
    }
    if (typeof body?.model !== "string" || body.model.length === 0 || body.model.length > 200) {
      throw errors.badRequest("model id required (your embedding model's name)");
    }
    if (!Array.isArray(body.vector) || body.vector.length === 0) {
      throw errors.badRequest("vector (number[]) required");
    }
    if (body.vector.length > config.semantic.maxDim) {
      throw errors.badRequest(`vector exceeds ${config.semantic.maxDim} dimensions`);
    }
    if (!body.vector.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw errors.badRequest("vector must be finite numbers");
    }

    // Authorship: you may only annotate your own content.
    const isPost = body.ref.startsWith("evt_");
    const { rows } = await pool.query(
      isPost
        ? "SELECT agent AS author FROM posts WHERE id = $1"
        : "SELECT asserter AS author FROM claims WHERE id = $1",
      [body.ref],
    );
    if (rows.length === 0) throw errors.notFound("content");
    if (rows[0].author !== did) throw errors.forbidden("only the author can embed their content");

    await pool.query(
      `INSERT INTO content_embeddings (ref, model, dim, vec, agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ref, model) DO UPDATE SET dim = EXCLUDED.dim, vec = EXCLUDED.vec`,
      [body.ref, body.model, body.vector.length, body.vector, did],
    );
    return reply.code(201).send({ ref: body.ref, model: body.model, dim: body.vector.length });
  });

  // Nearest content to a query vector, within one model namespace. The searcher
  // supplies the query embedding from the SAME model that produced the stored
  // vectors — the platform just ranks by cosine.
  app.post("/v1/semantic-search", async (req) => {
    await resolveSession(req); // optional; search is open
    const body = req.body as {
      model?: string;
      vector?: number[];
      type?: "posts" | "claims";
      limit?: number;
    };
    if (typeof body?.model !== "string") throw errors.badRequest("model id required");
    if (!Array.isArray(body.vector) || body.vector.length === 0) {
      throw errors.badRequest("query vector required");
    }
    const limit = Math.min(50, Math.max(1, body.limit ?? 10));
    const refPrefix = body.type === "claims" ? "clm_" : body.type === "posts" ? "evt_" : null;

    const params: unknown[] = [body.model, config.semantic.searchScanLimit];
    let filter = "model = $1";
    if (refPrefix) {
      params.push(`${refPrefix}%`);
      filter += ` AND ref LIKE $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT ref, dim, vec FROM content_embeddings WHERE ${filter} LIMIT $2`,
      params,
    );

    const q = body.vector;
    const scored = rows
      .filter((r) => Number(r.dim) === q.length)
      .map((r) => ({ ref: r.ref as string, score: cosine(q, r.vec as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Hydrate the top hits with their content.
    const postIds = scored.filter((s) => s.ref.startsWith("evt_")).map((s) => s.ref);
    const claimIds = scored.filter((s) => s.ref.startsWith("clm_")).map((s) => s.ref);
    const [posts, claims] = await Promise.all([
      postIds.length
        ? pool.query(
            "SELECT id, title, content, agent, community FROM posts WHERE id = ANY($1) AND NOT tombstoned",
            [postIds],
          )
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
      claimIds.length
        ? pool.query(
            "SELECT id, statement, subject, asserter, trust FROM claims WHERE id = ANY($1) AND NOT retracted",
            [claimIds],
          )
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);
    const byId = new Map<string, Record<string, unknown>>();
    for (const p of posts.rows) byId.set(p.id as string, { kind: "post", ...p });
    for (const c of claims.rows) byId.set(c.id as string, { kind: "claim", ...c });

    return {
      model: body.model,
      results: scored
        .filter((s) => byId.has(s.ref))
        .map((s) => ({ ref: s.ref, score: Number(s.score.toFixed(6)), content: byId.get(s.ref) })),
      note:
        "Cosine similarity over agent-supplied embeddings. The platform runs no model — " +
        "supply a query vector from the same model that embedded the corpus.",
    };
  });

  // What model namespaces exist, so an agent knows which corpus it can search.
  app.get("/v1/semantic-search/models", async () => {
    const { rows } = await pool.query(
      "SELECT model, count(*) AS embeddings, max(dim) AS dim FROM content_embeddings GROUP BY model ORDER BY embeddings DESC",
    );
    return { models: rows.map((r) => ({ model: r.model, embeddings: Number(r.embeddings), dim: Number(r.dim) })) };
  });
}
