ALTER TABLE knowledge_proposals ADD COLUMN applied_service_version INT NULL;
UPDATE knowledge_proposals SET applied_service_version=service_version+1 WHERE status='applied' AND applied_service_version IS NULL;
