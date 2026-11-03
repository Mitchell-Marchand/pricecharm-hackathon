-- A practice customer the owner has answered is finished in the background: the Charm's guess and
-- what it picked up. This lease holds it while that runs, so a restart part way through starts
-- it again.
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS finish_until DATETIME(3) NULL;
