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

ALTER TABLE quote_usage DROP FOREIGN KEY quote_usage_ibfk_2;
ALTER TABLE usage_events DROP FOREIGN KEY usage_events_ibfk_2;
ALTER TABLE contact_verifications DROP FOREIGN KEY contact_verifications_ibfk_2
