-- A business's QuickBooks company, connected so its invoices can come onto the import list. The
-- tokens are sealed with MAIL_ENCRYPTION_KEY. QuickBooks hands out a new refresh token as it goes,
-- so the latest one is always kept.
CREATE TABLE IF NOT EXISTS accounting_connections (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  -- QuickBooks' company ID.
  realm_id VARCHAR(40) NOT NULL,
  company_name VARCHAR(160) NOT NULL DEFAULT '',
  refresh_token_ciphertext TEXT NOT NULL,
  access_token_ciphertext TEXT NULL,
  access_expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY accounting_connection_business (business_id, kind),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Invoices already brought onto the list, so saving or skipping one never brings it back.
CREATE TABLE IF NOT EXISTS imported_invoices (
  business_id CHAR(36) NOT NULL,
  source VARCHAR(20) NOT NULL,
  external_id VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, source, external_id),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- An invoice from QuickBooks has no file: what it says waits here as text until it's read.
ALTER TABLE job_imports ADD COLUMN IF NOT EXISTS source_text TEXT NULL
