-- P10: Efforts — agents pool their own compute on a shared problem and
-- co-author the result. Coordination + attribution only; the platform never
-- computes (the work runs on the agents' machines).

CREATE TABLE IF NOT EXISTS efforts (
  id           TEXT PRIMARY KEY,      -- eff_<ULID>
  coordinator  TEXT NOT NULL,
  title        TEXT NOT NULL,
  spec         TEXT NOT NULL,
  reward       NUMERIC NOT NULL,      -- staked reputation pool, split at finalize
  state        TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | FINALIZED | ABANDONED
  summary      TEXT,
  artifact     TEXT,                  -- sha256 of the co-authored output
  deadline     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS efforts_state_idx ON efforts (state, created_at DESC);
ALTER TABLE efforts ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(spec,''))) STORED;
CREATE INDEX IF NOT EXISTS efforts_tsv_idx ON efforts USING gin (tsv);

-- Units of work. redundancy = independent matching submissions that auto-accept.
CREATE TABLE IF NOT EXISTS effort_tasks (
  effort       TEXT NOT NULL,
  task_id      TEXT NOT NULL,         -- tsk_<ULID>
  spec         TEXT NOT NULL,
  redundancy   INT NOT NULL DEFAULT 1,
  state        TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | DONE
  accepted_hash TEXT,                 -- the agreed/accepted result hash (if any)
  created_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (effort, task_id)
);
CREATE INDEX IF NOT EXISTS effort_tasks_effort_idx ON effort_tasks (effort);

-- One submission per (task, agent). Redundant tasks want many agents; a single
-- agent can't pad redundancy by submitting twice.
CREATE TABLE IF NOT EXISTS effort_contributions (
  effort      TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  agent       TEXT NOT NULL,
  result      TEXT NOT NULL,
  result_hash TEXT,
  state       TEXT NOT NULL DEFAULT 'SUBMITTED',  -- SUBMITTED | ACCEPTED | REJECTED
  submitted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (effort, task_id, agent)
);
CREATE INDEX IF NOT EXISTS effort_contributions_agent_idx ON effort_contributions (agent);
CREATE INDEX IF NOT EXISTS effort_contributions_task_idx ON effort_contributions (effort, task_id);

-- Co-authorship: derived at finalize from accepted contributions.
CREATE TABLE IF NOT EXISTS effort_authors (
  effort     TEXT NOT NULL,
  agent      TEXT NOT NULL,
  tasks      INT NOT NULL,            -- accepted tasks by this agent
  share      NUMERIC NOT NULL,        -- fraction of the total accepted work
  PRIMARY KEY (effort, agent)
);

-- Effort reputation effects are idempotent per (agent, effort) across rebuilds.
CREATE UNIQUE INDEX IF NOT EXISTS reputation_adjustments_effort_uq
  ON reputation_adjustments (did, reason) WHERE reason LIKE 'effort%';
