-- Jobs an owner turns down, from a practice customer or from Settings. The reason is a code
-- (too_small, too_big, not_offered, too_far, lead_time, other) and the one value that says where
-- the line is: a size and its unit, a price, a distance, a number of days or a sentence. The live
-- chat reads each one (src/turn-downs.ts).
CREATE TABLE IF NOT EXISTS turn_down_rules (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  size DECIMAL(12,2) NULL,
  size_unit VARCHAR(20) NULL,
  price_cents BIGINT NULL,
  distance DECIMAL(7,1) NULL,
  distance_unit VARCHAR(2) NULL,
  days SMALLINT UNSIGNED NULL,
  text VARCHAR(200) NULL,
  created_from_run_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX turn_down_business (business_id, created_at),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (created_from_run_id) REFERENCES practice_runs(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- The least the owner charges for any job. Every draft, live or practice, is raised to it.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS minimum_cents BIGINT NULL;
-- The contact form asks for the job's street address at the yes. On unless the owner turns it off.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ask_job_address BOOLEAN NOT NULL DEFAULT TRUE;

-- The job's street address, from the contact form or WhatsApp. Owner-only, never sent to the AI.
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS job_address VARCHAR(200) NULL;
-- When WhatsApp asked for the address after a yes, so the next message is read as the address.
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS address_asked_at DATETIME(3) NULL;
-- A request the Charm turned down by one of the owner's rules: the rule's code and its id.
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS turned_down VARCHAR(20) NULL;
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS turned_down_rule_id CHAR(36) NULL;

-- A practice customer the owner turned down: the reason's code, and the rule or minimum it saved.
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS turn_down_json JSON NULL
