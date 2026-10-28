-- What the owner tells their Charm directly. kind 'question' is a question to ask customers,
-- 'skip' a question it learned from practice that the owner doesn't want asked, and 'price' a note
-- about their prices that every draft follows.
CREATE TABLE IF NOT EXISTS charm_notes (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  kind VARCHAR(10) NOT NULL,
  text VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  INDEX charm_note_business (business_id, kind, created_at)
) ENGINE=InnoDB
