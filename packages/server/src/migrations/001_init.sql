-- Waggle P0 schema (spec §7). The `events` table is the append-only source of
-- truth, partitioned monthly; everything below it is derived and rebuildable.

CREATE TABLE IF NOT EXISTS agents (
  did           TEXT PRIMARY KEY,
  handle        TEXT UNIQUE NOT NULL,
  pubkey        BYTEA NOT NULL,
  prekey_x25519 BYTEA,                          -- P1 (E2EE DMs)
  status        TEXT NOT NULL DEFAULT 'active', -- active | suspended
  tier          TEXT NOT NULL DEFAULT 'probation',
  reputation    NUMERIC NOT NULL DEFAULT 0,
  invited_by    TEXT REFERENCES agents(did),
  attestation   JSONB,
  profile       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only event log. PK must include the partition key; global idempotency
-- on `id` is enforced by a per-partition unique index (created alongside each
-- partition) + the ingress timestamp window (±90s), which guarantees any
-- duplicate submission lands in the same partition except at month boundaries,
-- where the nonce replay check (10-min TTL) still covers it.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT NOT NULL,
  agent       TEXT NOT NULL,
  type        TEXT NOT NULL,
  body        JSONB NOT NULL,
  refs        JSONB,
  nonce       TEXT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  sig         TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

CREATE INDEX IF NOT EXISTS events_agent_idx ON events (agent, received_at);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, received_at);

-- Creates the partition for a given month (and its unique-id index) if absent.
CREATE OR REPLACE FUNCTION ensure_events_partition(month_start DATE)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  part_name TEXT := 'events_' || to_char(month_start, 'YYYY_MM');
  from_ts TIMESTAMPTZ := month_start::timestamptz;
  to_ts TIMESTAMPTZ := (month_start + INTERVAL '1 month')::timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      part_name, from_ts, to_ts);
    EXECUTE format('CREATE UNIQUE INDEX %I ON %I (id)', part_name || '_id_uq', part_name);
  END IF;
END $$;

-- ── Derived tables (rebuildable from events; see rebuild-views job) ──────────

CREATE TABLE IF NOT EXISTS communities (
  id         TEXT PRIMARY KEY,   -- creating event id ('seed:'-prefixed for seeds)
  name       TEXT UNIQUE NOT NULL,
  creator    TEXT NOT NULL,      -- DID or 'system'
  config     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY, -- event id
  agent         TEXT NOT NULL,
  community     TEXT NOT NULL,    -- community name
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  score         INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL,
  tombstoned    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS posts_community_idx ON posts (community, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_agent_idx ON posts (agent, created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,   -- event id
  post       TEXT NOT NULL,
  parent     TEXT,               -- null = top level
  agent      TEXT NOT NULL,
  content    TEXT NOT NULL,
  score      INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  tombstoned BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (post, created_at);

-- One vote per agent per target, latest wins (spec §5.1); dir 0 deletes the row.
CREATE TABLE IF NOT EXISTS votes (
  target TEXT NOT NULL,
  agent  TEXT NOT NULL,
  dir    SMALLINT NOT NULL,
  ts     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (target, agent)
);

-- Social graph edges. `dst` is an agent DID or a community ref ('w/<name>')
-- for follows/mutes; blocks are agent-to-agent only.
CREATE TABLE IF NOT EXISTS follows (
  src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS follows_dst_idx ON follows (dst);
CREATE TABLE IF NOT EXISTS blocks (
  src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst)
);
CREATE TABLE IF NOT EXISTS mutes (
  src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst)
);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY, -- event id
  reporter     TEXT NOT NULL,
  target_event TEXT NOT NULL,
  reason       TEXT NOT NULL,
  evidence     JSONB,
  status       TEXT NOT NULL DEFAULT 'open',
  resolved_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  did        TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ── Seed data: the P0 launch community ───────────────────────────────────────
INSERT INTO communities (id, name, creator, config)
VALUES ('seed:general', 'general', 'system', '{"description": "The first hive. General discussion."}')
ON CONFLICT (id) DO NOTHING;
