ALTER TABLE services ADD COLUMN approved_version INT NULL;
ALTER TABLE services ADD COLUMN approved_at DATETIME(3) NULL;
ALTER TABLE services ADD COLUMN approved_evaluation_id CHAR(36) NULL;
ALTER TABLE services ADD COLUMN pricing_rules_json JSON NULL;
ALTER TABLE examples ADD COLUMN inputs_json JSON NULL;
ALTER TABLE public_sessions ADD COLUMN facts_json JSON NULL;
ALTER TABLE public_sessions ADD COLUMN analysis_json JSON NULL;
ALTER TABLE public_sessions ADD COLUMN analysis_version INT NOT NULL DEFAULT 0;
ALTER TABLE public_sessions ADD COLUMN human_handoff BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public_sessions ADD COLUMN quote_request_id CHAR(36) NULL;
ALTER TABLE public_sessions ADD COLUMN quote_processing_until DATETIME(3) NULL;
ALTER TABLE public_sessions ADD COLUMN email_token_hash CHAR(64) NULL;
ALTER TABLE public_sessions ADD COLUMN email_token_expires_at DATETIME(3) NULL;
ALTER TABLE public_sessions ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'live';
ALTER TABLE messages ADD COLUMN owner_authored BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE quotes ADD COLUMN review_reason VARCHAR(1000) NULL;
ALTER TABLE quotes ADD COLUMN issued_by VARCHAR(30) NULL;
ALTER TABLE quotes ADD COLUMN automation_json JSON NULL;
ALTER TABLE quotes ADD COLUMN manual_price_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE quotes ADD COLUMN decision_at DATETIME(3) NULL;
CREATE TABLE IF NOT EXISTS service_test_cases (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  quantity DECIMAL(13,3) NOT NULL,
  expected_cents BIGINT NOT NULL,
  inputs_json JSON NOT NULL,
  tolerance_cents BIGINT NOT NULL DEFAULT 100,
  tolerance_percent DECIMAL(5,2) NOT NULL DEFAULT 5,
  expected_outcome VARCHAR(20) NOT NULL DEFAULT 'quote',
  case_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  UNIQUE KEY test_case_fingerprint (service_id, case_fingerprint),
  INDEX test_case_tenant (business_id, service_id)
) ENGINE=InnoDB;
