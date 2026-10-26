ALTER TABLE ai_daily_budgets ADD COLUMN guest_reserved INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS guest_preview_sessions (
  id CHAR(36) PRIMARY KEY,
  proof_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX guest_session_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS guest_previews (
  id CHAR(36) PRIMARY KEY,
  session_id CHAR(36) NULL,
  request_id CHAR(36) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  source_text TEXT NULL,
  result_json JSON NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'processing',
  version INT NOT NULL DEFAULT 1,
  processing_token CHAR(36) NULL,
  processing_until DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  reserved_at DATETIME(3) NULL,
  reservation_day DATE NULL,
  usage_json JSON NULL,
  error_json JSON NULL,
  claimed_business_id CHAR(36) NULL,
  claimed_user_id CHAR(36) NULL,
  claimed_service_id CHAR(36) NULL,
  claimed_setup_id CHAR(36) NULL,
  claimed_proposal_id CHAR(36) NULL,
  claim_receipt_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (session_id) REFERENCES guest_preview_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (claimed_business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (claimed_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (claimed_service_id) REFERENCES services(id) ON DELETE SET NULL,
  FOREIGN KEY (claimed_setup_id) REFERENCES service_setup_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (claimed_proposal_id) REFERENCES knowledge_proposals(id) ON DELETE SET NULL,
  UNIQUE KEY guest_request (session_id,request_id),
  INDEX guest_expiry (status,expires_at),
  INDEX guest_owner (claimed_business_id,claimed_user_id)
) ENGINE=InnoDB;
