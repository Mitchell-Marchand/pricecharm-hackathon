-- Which size of job the owner meant to add for a service: a small one, a usual one or a big one.
ALTER TABLE past_jobs ADD COLUMN size_slot VARCHAR(8) NULL;
-- The service a practice customer is for, when the owner asked to practice that one.
ALTER TABLE practice_runs ADD COLUMN focus_service VARCHAR(80) NULL
