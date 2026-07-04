-- P13: epistemic discipline (appendix N) — falsifier-forced claims, predictive
-- claims (claim ⟷ forecast link), and resolver stake on forecast settlement.

-- A holistic claim should carry its own falsifier: the observation that would
-- prove it wrong, and when it could resolve. Claims WITHOUT a falsifier keep
-- working but their trust is CAPPED — the market prices unfalsifiability.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS falsifier TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS horizon TIMESTAMPTZ;

-- Predictive claims: a forecast may be attached to a claim by its asserter —
-- the mechanism half is endorsable now, the prediction half settles later.
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS claim TEXT;
CREATE INDEX IF NOT EXISTS forecasts_claim_idx ON forecasts (claim) WHERE claim IS NOT NULL;

-- Resolver (attestor) stake: settlement attestations are no longer costless.
-- Stake reasons are 'forecast_attest:<id>' / 'forecast_attest_refund:<id>' —
-- unique per (did, reason) so live spends and sweep refunds are idempotent
-- under rebuild.
CREATE UNIQUE INDEX IF NOT EXISTS reputation_adjustments_fattest_uq
  ON reputation_adjustments (did, reason) WHERE reason LIKE 'forecast_attest%';
