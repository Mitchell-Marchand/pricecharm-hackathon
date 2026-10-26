CREATE TABLE IF NOT EXISTS lead_chats (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  email_token_hash CHAR(64) NULL UNIQUE,
  email_token_expires_at DATETIME(3) NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'link',
  status VARCHAR(20) NOT NULL DEFAULT 'chatting',
  service_name VARCHAR(80) NOT NULL DEFAULT '',
  ready BOOLEAN NOT NULL DEFAULT FALSE,
  out_of_scope VARCHAR(300) NOT NULL DEFAULT '',
  summary VARCHAR(600) NOT NULL DEFAULT '',
  customer_name VARCHAR(160) NOT NULL DEFAULT '',
  customer_email VARCHAR(254) NULL,
  contact_verified_at DATETIME(3) NULL,
  human_handoff BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  INDEX lead_chat_business (business_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lead_messages (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  chat_id CHAR(36) NOT NULL,
  sender VARCHAR(12) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'text',
  text TEXT NOT NULL,
  photo_ids_json JSON NULL,
  chips_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id) REFERENCES lead_chats(id) ON DELETE CASCADE,
  INDEX lead_message_chat (chat_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS live_quotes (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  chat_id CHAR(36) NOT NULL UNIQUE,
  number INT NOT NULL,
  status VARCHAR(20) NOT NULL,
  quote_json JSON NOT NULL,
  draft_json JSON NOT NULL,
  checks_json JSON NOT NULL,
  review_reason VARCHAR(600) NOT NULL DEFAULT '',
  total_cents BIGINT NOT NULL,
  sent_by VARCHAR(10) NULL,
  sent_at DATETIME(3) NULL,
  decided_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id) REFERENCES lead_chats(id) ON DELETE CASCADE,
  INDEX live_quote_business (business_id, status, created_at)
) ENGINE=InnoDB;

-- Live quotes are recorded in the existing ledgers, which pointed at the old flow's tables.
-- Generated key names differ between MariaDB versions (quote_usage_ibfk_2 on 11.4, 2 on 12),
-- so each key is found by what it links. A rerun finds nothing left to drop.
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'quote_usage' AND COLUMN_NAME = 'quote_id' AND REFERENCED_TABLE_NAME = 'quotes' LIMIT 1);
SET @drop_fk = IF(@fk IS NULL, 'DO 0', CONCAT('ALTER TABLE quote_usage DROP FOREIGN KEY `', @fk, '`'));
PREPARE drop_fk FROM @drop_fk;
EXECUTE drop_fk;
DEALLOCATE PREPARE drop_fk;
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'usage_events' AND COLUMN_NAME = 'quote_id' AND REFERENCED_TABLE_NAME = 'quotes' LIMIT 1);
SET @drop_fk = IF(@fk IS NULL, 'DO 0', CONCAT('ALTER TABLE usage_events DROP FOREIGN KEY `', @fk, '`'));
PREPARE drop_fk FROM @drop_fk;
EXECUTE drop_fk;
DEALLOCATE PREPARE drop_fk;
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'contact_verifications' AND COLUMN_NAME = 'session_id' AND REFERENCED_TABLE_NAME = 'public_sessions' LIMIT 1);
SET @drop_fk = IF(@fk IS NULL, 'DO 0', CONCAT('ALTER TABLE contact_verifications DROP FOREIGN KEY `', @fk, '`'));
PREPARE drop_fk FROM @drop_fk;
EXECUTE drop_fk;
DEALLOCATE PREPARE drop_fk
