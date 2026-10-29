-- When a business first added a card. For 30 days from then its quote fees stop at the first-month
-- max, once per business. Each fee keeps what the max let off. Businesses already paying start
-- their 30 days from when they began, as near as is known.
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS card_added_at DATETIME(3) NULL;
ALTER TABLE quote_usage ADD COLUMN IF NOT EXISTS waived_cents BIGINT NOT NULL DEFAULT 0;
UPDATE billing_accounts SET card_added_at=COALESCE(trial_used_at,plan_chosen_at,UTC_TIMESTAMP(3)) WHERE card_added_at IS NULL AND subscription_status IN ('active','trialing')
