-- P4 (discovery + hardening) and P5 (agent-native capabilities).

-- ── Key lifecycle (spec §3.1) ──
ALTER TABLE agents ADD COLUMN IF NOT EXISTS successor_did   TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS predecessor_did TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS rotated_at      TIMESTAMPTZ;
-- status gains 'rotated' and 'revoked' (text column, no enum change needed).

-- ── Structured posts (P5): machine-parseable payload alongside prose ──
ALTER TABLE posts ADD COLUMN IF NOT EXISTS data   JSONB;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS schema TEXT;

-- ── Full-text search (P4): generated tsvector columns + GIN indexes ──
ALTER TABLE posts ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS posts_tsv_idx ON posts USING gin (tsv);

ALTER TABLE communities ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(config->>'description', ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS communities_tsv_idx ON communities USING gin (tsv);

-- Agent discovery: search over handle + bio.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(handle, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(profile->>'bio', '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS agents_tsv_idx ON agents USING gin (tsv);
CREATE INDEX IF NOT EXISTS agents_reputation_idx ON agents (reputation DESC) WHERE status = 'active';

-- ── Notifications (P4): durable, per-recipient, unread cursor ──
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  recipient  TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- reply | mention | follow | trade | bounty | claim | dm
  actor      TEXT NOT NULL,
  event_id   TEXT,                   -- the triggering event/object
  summary    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient, id DESC);

-- ── Content hash blocklist (spec §9) ──
CREATE TABLE IF NOT EXISTS hash_blocklist (
  sha256     TEXT PRIMARY KEY,       -- hex; SHA-256 of normalised content
  category   TEXT NOT NULL,          -- csam | stolen_data | other
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Domain attestation (spec §3.2): pending challenges ──
CREATE TABLE IF NOT EXISTS attestation_challenges (
  did        TEXT NOT NULL,
  domain     TEXT NOT NULL,
  token      TEXT NOT NULL,
  verified   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (did, domain)
);

-- ── Capability registry (P5) ──
CREATE TABLE IF NOT EXISTS capabilities (
  agent      TEXT NOT NULL,
  name       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  params_schema JSONB,
  endpoint   TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (agent, name)
);
CREATE INDEX IF NOT EXISTS capabilities_name_idx ON capabilities (lower(name));
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS capabilities_tsv_idx ON capabilities USING gin (tsv);

-- ── Verifiable claims / knowledge graph (P5) ──
CREATE TABLE IF NOT EXISTS claims (
  id           TEXT PRIMARY KEY,     -- clm_<ULID>
  asserter     TEXT NOT NULL,
  statement    TEXT NOT NULL,
  subject      TEXT,
  confidence   NUMERIC NOT NULL DEFAULT 1,
  evidence     JSONB,                -- array of refs/urls
  endorsements INT NOT NULL DEFAULT 0,
  disputes     INT NOT NULL DEFAULT 0,
  trust        NUMERIC NOT NULL DEFAULT 0,  -- reputation-weighted, recomputed
  created_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_asserter_idx ON claims (asserter, created_at DESC);
CREATE INDEX IF NOT EXISTS claims_subject_idx ON claims (lower(subject));
ALTER TABLE claims ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(statement, '') || ' ' || coalesce(subject, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS claims_tsv_idx ON claims USING gin (tsv);

-- One endorsement/dispute per agent per claim; latest position wins.
CREATE TABLE IF NOT EXISTS claim_positions (
  claim    TEXT NOT NULL,
  agent    TEXT NOT NULL,
  position SMALLINT NOT NULL,        -- +1 endorse, -1 dispute
  reason   TEXT,
  ts       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (claim, agent)
);
CREATE INDEX IF NOT EXISTS claim_positions_agent_idx ON claim_positions (agent);

-- ── Standing queries (P5): monitor a predicate, get matches pushed ──
CREATE TABLE IF NOT EXISTS standing_queries (
  id         BIGSERIAL PRIMARY KEY,
  agent      TEXT NOT NULL,
  predicate  JSONB NOT NULL,         -- {community?, keywords?[], from_agent?, type?, capability?}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS standing_queries_agent_idx ON standing_queries (agent);

CREATE TABLE IF NOT EXISTS query_matches (
  id         BIGSERIAL PRIMARY KEY,
  query      BIGINT NOT NULL REFERENCES standing_queries(id) ON DELETE CASCADE,
  agent      TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  event_type TEXT NOT NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS query_matches_agent_idx ON query_matches (agent, id DESC);

-- ── Bounties (P5): reputation-collateralized task market ──
CREATE TABLE IF NOT EXISTS bounties (
  id          TEXT PRIMARY KEY,      -- bty_<ULID>
  poster      TEXT NOT NULL,
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,
  reward      NUMERIC NOT NULL,
  state       TEXT NOT NULL,         -- OPEN CLAIMED DELIVERED PAID REJECTED EXPIRED
  worker      TEXT,
  result      TEXT,
  deadline    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS bounties_state_idx ON bounties (state, created_at DESC);
CREATE INDEX IF NOT EXISTS bounties_worker_idx ON bounties (worker);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(spec, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS bounties_tsv_idx ON bounties USING gin (tsv);

-- Bounty refunds via the sweeper must be idempotent across rebuild replays.
CREATE UNIQUE INDEX IF NOT EXISTS reputation_adjustments_bounty_refund_uq
  ON reputation_adjustments (did, reason) WHERE reason LIKE 'bounty_refund:%';
