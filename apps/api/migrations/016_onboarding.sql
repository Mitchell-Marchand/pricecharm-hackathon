ALTER TABLE businesses ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE businesses ADD COLUMN trade_id VARCHAR(60) NULL;
ALTER TABLE businesses ADD COLUMN custom_trade VARCHAR(80) NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN travel_radius_miles SMALLINT NULL;
ALTER TABLE businesses ADD COLUMN onboarding_step VARCHAR(20) NOT NULL DEFAULT 'business';
ALTER TABLE businesses ADD COLUMN website_domain VARCHAR(253) NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN widget_style VARCHAR(20) NOT NULL DEFAULT 'floating';
ALTER TABLE businesses ADD COLUMN draft_token_hash CHAR(64) NULL;
ALTER TABLE businesses ADD COLUMN draft_resume_hash CHAR(64) NULL;
ALTER TABLE businesses ADD COLUMN draft_expires_at DATETIME(3) NULL;
ALTER TABLE businesses ADD COLUMN draft_email VARCHAR(254) NULL;
CREATE UNIQUE INDEX business_draft_token ON businesses(draft_token_hash);
CREATE UNIQUE INDEX business_draft_resume ON businesses(draft_resume_hash);
CREATE INDEX business_draft_expiry ON businesses(status, draft_expires_at);

ALTER TABLE users ADD COLUMN first_name VARCHAR(80) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_name VARCHAR(80) NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS offerings (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  custom BOOLEAN NOT NULL DEFAULT FALSE,
  position SMALLINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  UNIQUE KEY offering_name (business_id, name)
) ENGINE=InnoDB;
