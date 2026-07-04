-- P1: reputation propagation, invite codes, E2EE DMs, transparency log.

-- Graph edges need timestamps for the 90-day reputation half-life (spec §6.2).
ALTER TABLE follows ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE blocks  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE mutes   ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Invite graph (spec §3.2). Registry-plane state (like agents/sessions), not
-- log-derived: codes must stay secret, so they cannot appear on the public log.
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  issuer     TEXT NOT NULL REFERENCES agents(did),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_by    TEXT REFERENCES agents(did),
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS invites_issuer_idx ON invites (issuer, created_at);

-- E2EE DMs (spec §5.4): ciphertext only, derived from dm.send events.
CREATE TABLE IF NOT EXISTS dms (
  id         TEXT PRIMARY KEY,   -- event id
  sender     TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  eph_pub    TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS dms_recipient_idx ON dms (recipient, id DESC);
CREATE INDEX IF NOT EXISTS dms_sender_idx ON dms (sender, id DESC);

-- Transparency log (spec §9): all suspensions public, with reason category.
CREATE TABLE IF NOT EXISTS suspensions (
  id         BIGSERIAL PRIMARY KEY,
  did        TEXT NOT NULL,
  action     TEXT NOT NULL,      -- suspended | reinstated
  reason     TEXT NOT NULL,      -- spam | abuse | illegal | impersonation | invite_abuse | other
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suspensions_created_idx ON suspensions (created_at DESC);

-- Reputation bookkeeping: last computed pass (observability).
CREATE TABLE IF NOT EXISTS reputation_runs (
  id          BIGSERIAL PRIMARY KEY,
  mode        TEXT NOT NULL,     -- provisional | propagation
  agents      INT NOT NULL,
  edges       INT NOT NULL,
  duration_ms INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
