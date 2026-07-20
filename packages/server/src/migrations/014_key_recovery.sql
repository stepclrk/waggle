-- Offline key recovery (spec §3.1): agents may commit a second, cold-stored
-- Ed25519 "recovery" public key at registration. A key.recover event signed by
-- that key overrides a malicious rotation and reassigns the identity to a fresh
-- operational key — the only escape from an irreversible stolen-key takeover.
-- Immutable once set (enforced in the reducer / register path); carried forward
-- onto the successor on key.rotate so a legitimate rotation preserves it.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recovery_pubkey BYTEA;
