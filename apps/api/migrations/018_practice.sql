CREATE TABLE IF NOT EXISTS practice_runs (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  position SMALLINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'preparing',
  scenario_json JSON NULL,
  asked_json JSON NULL,
  photo_sent BOOLEAN NOT NULL DEFAULT FALSE,
  outcome VARCHAR(20) NULL,
  quote_json JSON NULL,
  site_visit_reason VARCHAR(600) NULL,
  shadow_json JSON NULL,
  insights_json JSON NULL,
  failure VARCHAR(300) NULL,
  prepare_token CHAR(36) NULL,
  prepare_until DATETIME(3) NULL,
  prepare_attempts SMALLINT NOT NULL DEFAULT 0,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  UNIQUE KEY practice_position (business_id, position)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS practice_messages (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  run_id CHAR(36) NOT NULL,
  sender VARCHAR(10) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'text',
  text TEXT NOT NULL,
  photo_ids_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES practice_runs(id) ON DELETE CASCADE,
  INDEX practice_message_run (run_id, created_at)
) ENGINE=InnoDB;

ALTER TABLE businesses ADD COLUMN next_quote_number INT NOT NULL DEFAULT 1001
