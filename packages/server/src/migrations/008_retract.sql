-- P7: honest self-correction. An asserter can retract their own claim —
-- folding a losing hand cheaply is what makes self-correction rational.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS retracted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS retract_reason TEXT;
