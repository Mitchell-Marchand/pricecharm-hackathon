CREATE TABLE IF NOT EXISTS past_jobs (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_name VARCHAR(80) NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  price_cents INT NOT NULL,
  size VARCHAR(80) NOT NULL DEFAULT '',
  duration VARCHAR(80) NOT NULL DEFAULT '',
  performed VARCHAR(80) NOT NULL DEFAULT '',
  materials_cents INT NULL,
  discount_kind VARCHAR(10) NULL,
  discount_value INT NULL,
  discount_reason VARCHAR(160) NOT NULL DEFAULT '',
  notes TEXT NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  INDEX past_job_business (business_id, created_at)
) ENGINE=InnoDB;

ALTER TABLE attachments ADD COLUMN past_job_id CHAR(36) NULL;
ALTER TABLE attachments ADD COLUMN purpose VARCHAR(20) NULL;
CREATE INDEX attachment_purpose ON attachments(business_id, purpose, past_job_id);
ALTER TABLE attachments ADD CONSTRAINT attachment_past_job FOREIGN KEY (past_job_id) REFERENCES past_jobs(id) ON DELETE SET NULL;

ALTER TABLE ai_daily_budgets ADD COLUMN draft_reserved INT NOT NULL DEFAULT 0
