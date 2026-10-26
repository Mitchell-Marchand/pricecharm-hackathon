CREATE TABLE IF NOT EXISTS businesses (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(180) NOT NULL UNIQUE,
  industry VARCHAR(160) NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  service_area VARCHAR(500) NOT NULL DEFAULT '',
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
  auto_quote_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(256) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  INDEX users_business (business_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS owner_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX owner_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS services (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  unit_label VARCHAR(60) NOT NULL DEFAULT 'unit',
  unit_price_cents BIGINT NOT NULL DEFAULT 0,
  minimum_charge_cents BIGINT NOT NULL DEFAULT 0,
  base_price_cents BIGINT NOT NULL DEFAULT 0,
  max_auto_quote_cents BIGINT NOT NULL DEFAULT 500000,
  required_inputs_json JSON NOT NULL,
  exclusions_json JSON NOT NULL,
  mode VARCHAR(20) NOT NULL DEFAULT 'review',
  published_at DATETIME(3) NULL,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  INDEX services_business (business_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS examples (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  quantity DECIMAL(13,3) NOT NULL,
  final_price_cents BIGINT NOT NULL,
  rationale TEXT NOT NULL,
  source VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (service_id) REFERENCES services(id),
  INDEX examples_tenant_service (business_id, service_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS training_sessions (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  service_version INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  scenario_json JSON NOT NULL,
  final_price_cents BIGINT NULL,
  rationale TEXT NULL,
  saved_example_id CHAR(36) NULL,
  pricing_proposal_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (service_id) REFERENCES services(id),
  INDEX training_tenant (business_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages (
  id CHAR(36) PRIMARY KEY,
  position BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  business_id CHAR(36) NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  conversation_type VARCHAR(20) NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  INDEX messages_conversation (business_id, conversation_type, conversation_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS evaluations (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  service_version INT NOT NULL,
  passed BOOLEAN NOT NULL,
  result_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (service_id) REFERENCES services(id),
  INDEX evaluation_version (business_id, service_id, service_version, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS public_sessions (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  service_version INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  contact_consent_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (service_id) REFERENCES services(id),
  INDEX public_expiry (expires_at),
  INDEX public_tenant (business_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS quotes (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  public_session_id CHAR(36) NULL UNIQUE,
  service_version INT NOT NULL,
  customer_name VARCHAR(160) NOT NULL,
  customer_email VARCHAR(254) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'review',
  description TEXT NOT NULL,
  quantity DECIMAL(13,3) NOT NULL,
  total_cents BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  assumptions_json JSON NOT NULL,
  line_items_json JSON NOT NULL,
  calculation_json JSON NOT NULL,
  source VARCHAR(20) NOT NULL,
  verified_contact BOOLEAN NOT NULL DEFAULT FALSE,
  approved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (service_id) REFERENCES services(id),
  FOREIGN KEY (public_session_id) REFERENCES public_sessions(id),
  INDEX quotes_tenant (business_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS usage_events (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  quote_id CHAR(36) NULL,
  dedupe_key VARCHAR(160) NULL UNIQUE,
  metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (quote_id) REFERENCES quotes(id),
  INDEX usage_tenant (business_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS jobs (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NULL,
  type VARCHAR(80) NOT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_at DATETIME(3) NULL,
  locked_by VARCHAR(160) NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX jobs_ready (status, available_at)
) ENGINE=InnoDB;
