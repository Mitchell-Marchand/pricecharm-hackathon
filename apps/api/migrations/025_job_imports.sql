-- Old quotes and invoices an owner dropped in, read in the background. Each waits here until the
-- owner saves it as a past job or drops it. The file is deleted once it has been read.
CREATE TABLE IF NOT EXISTS job_imports (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  filename VARCHAR(180) NOT NULL,
  storage_key VARCHAR(60) NULL,
  kind VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'reading',
  result_json JSON NULL,
  failure VARCHAR(300) NULL,
  read_token CHAR(36) NULL,
  read_until DATETIME(3) NULL,
  read_attempts SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  INDEX job_import_business (business_id, created_at)
) ENGINE=InnoDB
