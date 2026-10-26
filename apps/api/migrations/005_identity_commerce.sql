ALTER TABLE users ADD COLUMN email_verified_at DATETIME(3) NULL;
ALTER TABLE businesses ADD COLUMN deletion_requested_at DATETIME(3) NULL;
ALTER TABLE public_sessions ADD COLUMN verified_email VARCHAR(254) NULL;
ALTER TABLE public_sessions ADD COLUMN contact_verified_at DATETIME(3) NULL;
ALTER TABLE jobs ADD COLUMN dedupe_key VARCHAR(180) NULL UNIQUE;

CREATE TABLE IF NOT EXISTS identity_tokens (
  id CHAR(36) PRIMARY KEY, business_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
  purpose VARCHAR(30) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL, used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX identity_user (user_id,purpose,created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contact_verifications (
  id CHAR(36) PRIMARY KEY, business_id CHAR(36) NOT NULL, session_id CHAR(36) NOT NULL,
  email VARCHAR(254) NOT NULL, code_hash CHAR(64) NOT NULL, attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL, used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES public_sessions(id) ON DELETE CASCADE,
  INDEX contact_session (business_id,session_id,created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS email_outbox (
  id CHAR(36) PRIMARY KEY, business_id CHAR(36) NULL,
  dedupe_key VARCHAR(180) NOT NULL UNIQUE, payload_encrypted MEDIUMTEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending', provider_message_id VARCHAR(255) NULL,
  last_error VARCHAR(500) NULL, sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  INDEX email_tenant (business_id,created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS billing_accounts (
  business_id CHAR(36) PRIMARY KEY,
  stripe_customer_id VARCHAR(255) NULL UNIQUE, stripe_subscription_id VARCHAR(255) NULL UNIQUE,
  checkout_session_id VARCHAR(255) NULL, subscription_status VARCHAR(40) NOT NULL DEFAULT 'trial',
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE, period_end DATETIME(3) NULL,
  trial_ends_at DATETIME(3) NOT NULL, trial_quote_limit INT NOT NULL,
  spending_cap_cents BIGINT NOT NULL DEFAULT 10000,
  fee_basis_points INT NOT NULL, minimum_fee_cents BIGINT NOT NULL, maximum_fee_cents BIGINT NOT NULL,
  tariff_version VARCHAR(100) NOT NULL, last_reconciled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS quote_usage (
  id CHAR(36) PRIMARY KEY, business_id CHAR(36) NOT NULL, quote_id CHAR(36) NOT NULL UNIQUE,
  source VARCHAR(30) NOT NULL, verified_contact BOOLEAN NOT NULL, trial_covered BOOLEAN NOT NULL,
  quote_value_cents BIGINT NOT NULL, currency CHAR(3) NOT NULL, fee_cents BIGINT NOT NULL,
  fee_basis_points INT NOT NULL, minimum_fee_cents BIGINT NOT NULL, maximum_fee_cents BIGINT NOT NULL,
  tariff_version VARCHAR(100) NOT NULL,
  stripe_reported_at DATETIME(3) NULL, dispatch_started_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE,
  INDEX quote_usage_tenant (business_id,created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stripe_events (
  id VARCHAR(255) PRIMARY KEY, type VARCHAR(120) NOT NULL,
  customer_id VARCHAR(255) NULL, status VARCHAR(30) NOT NULL DEFAULT 'pending',
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), processed_at DATETIME(3) NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS account_deletion_audits (
  id CHAR(36) PRIMARY KEY, business_id CHAR(36) NOT NULL, status VARCHAR(30) NOT NULL,
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), completed_at DATETIME(3) NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key CHAR(64) PRIMARY KEY, attempts INT NOT NULL DEFAULT 0,
  window_started_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
