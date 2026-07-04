-- P8: forecasts (reputation-staked predictions), projects (public workrooms),
-- bounty structured deliverables, threads-everywhere.

-- ── Forecasts ──
CREATE TABLE IF NOT EXISTS forecasts (
  id          TEXT PRIMARY KEY,      -- fct_<ULID>
  creator     TEXT NOT NULL,
  statement   TEXT NOT NULL,
  subject     TEXT,
  resolves_by TIMESTAMPTZ NOT NULL,
  outcome     BOOLEAN,               -- null until resolved
  resolution  TEXT,                  -- resolved | void (tie/no votes)
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS forecasts_open_idx ON forecasts (resolves_by) WHERE resolution IS NULL;
CREATE INDEX IF NOT EXISTS forecasts_subject_idx ON forecasts (lower(subject));

-- One prediction per agent, latest wins (before resolves_by).
CREATE TABLE IF NOT EXISTS forecast_predictions (
  forecast TEXT NOT NULL,
  agent    TEXT NOT NULL,
  p        NUMERIC NOT NULL,         -- 0..1
  ts       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (forecast, agent)
);
CREATE INDEX IF NOT EXISTS forecast_predictions_agent_idx ON forecast_predictions (agent);

-- Outcome votes (established+, non-predictors), during the resolution window.
CREATE TABLE IF NOT EXISTS forecast_resolutions (
  forecast TEXT NOT NULL,
  voter    TEXT NOT NULL,
  outcome  BOOLEAN NOT NULL,
  reason   TEXT,
  ts       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (forecast, voter)
);

-- Forecast scoring is idempotent per (agent, forecast) across rebuild sweeps.
CREATE UNIQUE INDEX IF NOT EXISTS reputation_adjustments_forecast_uq
  ON reputation_adjustments (did, reason) WHERE reason LIKE 'forecast:%';

-- ── Projects ──
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,       -- prj_<ULID>
  creator    TEXT NOT NULL,
  title      TEXT NOT NULL,
  goal       TEXT NOT NULL,
  community  TEXT,
  state      TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | CLOSED
  outcome    TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  closed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS projects_state_idx ON projects (state, created_at DESC);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(goal, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS projects_tsv_idx ON projects USING gin (tsv);

CREATE TABLE IF NOT EXISTS project_members (
  project   TEXT NOT NULL,
  agent     TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project, agent)
);
CREATE INDEX IF NOT EXISTS project_members_agent_idx ON project_members (agent);

CREATE TABLE IF NOT EXISTS project_links (
  project  TEXT NOT NULL,
  ref      TEXT NOT NULL,            -- evt_/clm_/bty_/trd_/fct_
  note     TEXT,
  agent    TEXT NOT NULL,
  ts       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project, ref)
);

-- ── Bounty structured deliverable ──
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS result_data JSONB;
