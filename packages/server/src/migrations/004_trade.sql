-- P2: trade sub-protocol (spec §7, §8).

CREATE TABLE IF NOT EXISTS trades (
  id                    TEXT PRIMARY KEY,      -- trd_<ULID>, client-generated
  initiator             TEXT NOT NULL,
  counterparty          TEXT NOT NULL,
  state                 TEXT NOT NULL,         -- PROPOSED ACCEPTED COMMITTED REVEALED CLOSED
                                               -- DECLINED ABORTED EXPIRED CANCELLED
  offer_summary         TEXT NOT NULL,
  want_summary          TEXT NOT NULL,
  timeouts              JSONB NOT NULL,        -- resolved {accept_secs, commit_secs, reveal_secs, rating_secs}
  deadline              TIMESTAMPTZ,           -- next timeout (null in terminal states)
  initiator_commit      TEXT,                  -- sha256 hex of escrow blob
  counterparty_commit   TEXT,
  initiator_revealed    BOOLEAN NOT NULL DEFAULT FALSE,
  counterparty_revealed BOOLEAN NOT NULL DEFAULT FALSE,
  defector              TEXT,                  -- set on CANCELLED (spec §8.3)
  closed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_initiator_idx ON trades (initiator, state);
CREATE INDEX IF NOT EXISTS trades_counterparty_idx ON trades (counterparty, state);
CREATE INDEX IF NOT EXISTS trades_deadline_idx ON trades (deadline) WHERE deadline IS NOT NULL;

-- Audit trail of every step (log events + system timeout transitions).
CREATE TABLE IF NOT EXISTS trade_events (
  id           TEXT PRIMARY KEY,               -- event id or sys_<ULID>
  trade        TEXT NOT NULL,
  agent        TEXT NOT NULL,                  -- DID or 'system'
  type         TEXT NOT NULL,
  payload_hash TEXT,
  ts           TIMESTAMPTZ NOT NULL,
  sig          TEXT
);
CREATE INDEX IF NOT EXISTS trade_events_trade_idx ON trade_events (trade, ts);

-- Escrow blob registry (registry-plane: uploads are not log events).
-- Ciphertext bytes live in the blob store; row deleted with the blob (§8.6).
CREATE TABLE IF NOT EXISTS escrow_blobs (
  trade        TEXT NOT NULL,
  agent        TEXT NOT NULL,
  hash         TEXT NOT NULL,
  size         INT NOT NULL,
  storage_ref  TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trade, agent)
);

CREATE TABLE IF NOT EXISTS ratings (
  trade   TEXT NOT NULL,
  rater   TEXT NOT NULL,
  ratee   TEXT NOT NULL,
  score   SMALLINT NOT NULL,
  comment TEXT,
  ts      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (trade, rater)
);
CREATE INDEX IF NOT EXISTS ratings_ratee_idx ON ratings (ratee);

-- Defection penalties must be idempotent across rebuild-time sweeps.
CREATE UNIQUE INDEX IF NOT EXISTS reputation_adjustments_defection_uq
  ON reputation_adjustments (did, reason) WHERE reason LIKE 'defection:%';
