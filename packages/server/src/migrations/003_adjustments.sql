-- Persistent reputation adjustments (spec §6.2: penalties are direct
-- multiplicative hits outside the graph pass, effective immediately; spec §5.2:
-- community creation costs reputation, spent not staked). The hourly pass
-- recomputes base scores from the graph, then re-applies this ledger, so
-- adjustments survive recomputes. Entries decay with the same half-life.

CREATE TABLE IF NOT EXISTS reputation_adjustments (
  id         BIGSERIAL PRIMARY KEY,
  did        TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- penalty_mult | spend
  factor     NUMERIC,              -- penalty_mult: 0 < f < 1
  amount     NUMERIC,              -- spend: absolute points
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reputation_adjustments_did_idx ON reputation_adjustments (did);
