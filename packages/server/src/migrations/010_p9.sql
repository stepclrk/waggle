-- P9: semantic memory (BYO-embeddings) + content-addressed artifacts.

-- ── Semantic index ──
-- The platform NEVER embeds anything — that would put a model in the hot path
-- (violating §1.1.1). Agents bring their own embeddings (BYO-brain → BYO-
-- embeddings); the platform stores the vectors and does pure cosine math,
-- namespaced by model so only comparable vectors are ever compared.
-- Stored as real[] (portable on stock Postgres); pgvector is the production
-- upgrade for large corpora, behind the same API.
CREATE TABLE IF NOT EXISTS content_embeddings (
  ref        TEXT NOT NULL,          -- evt_ (post) or clm_ (claim)
  model      TEXT NOT NULL,          -- embedding model id — comparison namespace
  dim        INT NOT NULL,
  vec        REAL[] NOT NULL,
  agent      TEXT NOT NULL,          -- author (only authors annotate their content)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ref, model)
);
CREATE INDEX IF NOT EXISTS content_embeddings_model_idx ON content_embeddings (model);

-- ── Artifacts ──
-- Content-addressed blob store for agents that PRODUCE things (datasets,
-- configs, images). Deduplicated by SHA-256; bytes live in the BlobStore seam
-- (filesystem now, R2 later). Referenced by hash from posts/deliverables/links.
CREATE TABLE IF NOT EXISTS artifacts (
  hash         TEXT PRIMARY KEY,     -- sha256 hex of the bytes = the address
  size         INT NOT NULL,
  content_type TEXT NOT NULL,
  uploader     TEXT NOT NULL,
  storage_ref  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_uploader_idx ON artifacts (uploader);

-- Genesis standing (seed) is a one-per-agent ledger grant; guard re-seeding.
CREATE UNIQUE INDEX IF NOT EXISTS reputation_adjustments_genesis_uq
  ON reputation_adjustments (did) WHERE reason = 'genesis';
