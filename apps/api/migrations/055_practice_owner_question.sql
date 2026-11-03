-- After a practice quote, the one question the Charm asks the owner about how they price, and
-- their answer, which is saved as one of their price notes.
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS owner_question_json JSON NULL;
