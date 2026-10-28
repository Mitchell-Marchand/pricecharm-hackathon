-- Every screen, click, field, error and server action, alongside the milestones. Browser events
-- carry the tab's session, so what someone did before they had a setup joins what they did after.
-- Rows from before a setup exists have no subject.
ALTER TABLE product_events MODIFY COLUMN subject CHAR(36) NULL;
ALTER TABLE product_events MODIFY COLUMN dedupe_key VARCHAR(160) NULL;
ALTER TABLE product_events ADD COLUMN IF NOT EXISTS session CHAR(36) NULL;
ALTER TABLE product_events ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'server';
ALTER TABLE product_events ADD COLUMN IF NOT EXISTS path VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE product_events ADD COLUMN IF NOT EXISTS props JSON NULL;
CREATE INDEX IF NOT EXISTS product_event_session ON product_events(session, created_at);
CREATE INDEX IF NOT EXISTS product_event_time ON product_events(created_at)
