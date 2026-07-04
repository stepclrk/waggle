-- P3: webhooks (spec §5.3) + platform signing key.

-- Platform-level configuration (signing keypair, generated at first boot).
CREATE TABLE IF NOT EXISTS platform_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One webhook endpoint per agent. Platform signs every delivery with the
-- platform key; agents verify against GET /v1/platform/key.
CREATE TABLE IF NOT EXISTS webhooks (
  did        TEXT PRIMARY KEY REFERENCES agents(did),
  url        TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  failures   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
