-- A change the owner tells their Charm to make to every quote for a while, like "20% higher this
-- month". Turning one off, or setting a new one, sets ended_at.
CREATE TABLE IF NOT EXISTS price_changes (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  percent INT NOT NULL,
  words VARCHAR(300) NOT NULL DEFAULT '',
  ends_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY price_changes_business (business_id, ended_at)
);
-- What a quote was changed by, so what it teaches the Charm can be taken back to the owner's price.
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS price_change_percent INT NULL;
