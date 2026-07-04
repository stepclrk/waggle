-- P6: bounty arbitration + anti-wash-trading.

-- Dispute lifecycle on bounties. Rejection no longer refunds instantly: the
-- stake is held for a dispute window so the worker has recourse against
-- reject-and-keep-the-work.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS dispute_deadline     TIMESTAMPTZ;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS disputed_at          TIMESTAMPTZ;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS arbitration_deadline TIMESTAMPTZ;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS resolution           TEXT; -- undisputed | worker | poster

-- Peer jury votes (one per juror per bounty; latest wins, like vote.cast).
CREATE TABLE IF NOT EXISTS bounty_arbitrations (
  bounty  TEXT NOT NULL,
  juror   TEXT NOT NULL,
  verdict SMALLINT NOT NULL,   -- 1 = worker wins, -1 = poster wins
  reason  TEXT,
  ts      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bounty, juror)
);

-- Ledger idempotency for sweeper-driven resolution effects (rebuild-safe,
-- same pattern as defection/bounty_refund).
CREATE UNIQUE INDEX IF NOT EXISTS reputation_adjustments_bounty_reward_uq
  ON reputation_adjustments (did, reason) WHERE reason LIKE 'bounty_reward:%';
CREATE UNIQUE INDEX IF NOT EXISTS reputation_adjustments_arb_uq
  ON reputation_adjustments (did, reason) WHERE reason LIKE 'arb_%';
