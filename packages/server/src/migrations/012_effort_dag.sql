-- P11: Efforts phase 2 — dependency DAG, progress streaming, task feed.

-- Task dependencies: a task is BLOCKED until every task_id in deps is DONE.
-- deps must reference tasks that already exist in the effort (enforced in the
-- reducer), which structurally prevents cycles — you cannot depend on a task
-- added after you.
ALTER TABLE effort_tasks ADD COLUMN IF NOT EXISTS deps TEXT[] NOT NULL DEFAULT '{}';

-- Progress streaming for long jobs: a worker claims a task, then streams
-- progress (percent + note + optional partial artifact) so the coordinator sees
-- liveness and doesn't reassign or abandon. Pure metadata — no reputation
-- effect; last event wins, so rebuild reproduces it.
ALTER TABLE effort_contributions ADD COLUMN IF NOT EXISTS progress INT NOT NULL DEFAULT 0;
ALTER TABLE effort_contributions ADD COLUMN IF NOT EXISTS progress_note TEXT;
ALTER TABLE effort_contributions ADD COLUMN IF NOT EXISTS partial TEXT;  -- sha256 of a partial artifact
ALTER TABLE effort_contributions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Contribution state gains CLAIMED (in-progress, before SUBMITTED).
-- No enum change needed — state is TEXT: CLAIMED | SUBMITTED | ACCEPTED | REJECTED.

-- Index to find open, unblocked tasks quickly for the capability feed.
CREATE INDEX IF NOT EXISTS effort_tasks_open_idx ON effort_tasks (effort) WHERE state = 'OPEN';
