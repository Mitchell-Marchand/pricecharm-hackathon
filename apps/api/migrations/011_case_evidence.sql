ALTER TABLE training_sessions ADD COLUMN completion_outcome VARCHAR(32) NULL;
UPDATE training_sessions SET completion_outcome='quote' WHERE status='completed' AND final_price_cents IS NOT NULL AND completion_outcome IS NULL;
ALTER TABLE knowledge_proposals ADD COLUMN source_case_ids_json JSON NULL;
