ALTER TABLE examples ADD COLUMN unit_label VARCHAR(60) NULL;
ALTER TABLE import_drafts ADD COLUMN unit_label VARCHAR(60) NULL;
ALTER TABLE training_sessions ADD COLUMN unit_label VARCHAR(60) NULL;
UPDATE examples e JOIN services s ON s.id=e.service_id AND s.business_id=e.business_id SET e.unit_label=s.unit_label WHERE e.unit_label IS NULL;
UPDATE import_drafts d JOIN services s ON s.id=d.service_id AND s.business_id=d.business_id SET d.unit_label=s.unit_label WHERE d.unit_label IS NULL;
UPDATE training_sessions t JOIN services s ON s.id=t.service_id AND s.business_id=t.business_id SET t.unit_label=s.unit_label WHERE t.unit_label IS NULL;
