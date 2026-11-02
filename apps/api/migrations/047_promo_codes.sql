-- Codes that make a new owner's first days free, made with src/promo.ts. A code can stop after a
-- number of uses or on a date, and its note says what it was for, like which outreach.
CREATE TABLE IF NOT EXISTS promo_codes (
  code VARCHAR(40) PRIMARY KEY,
  free_days INT NOT NULL,
  max_uses INT NULL,
  ends_at DATETIME(3) NULL,
  note VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
-- The code a business used, once, before its first card. The free days are kept with it, so
-- changing a code later never changes what it gave. They start when the card is added.
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS promo_code VARCHAR(40) NULL;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS promo_days INT NULL;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS promo_redeemed_at DATETIME(3) NULL;
CREATE INDEX IF NOT EXISTS billing_promo_code ON billing_accounts(promo_code)
