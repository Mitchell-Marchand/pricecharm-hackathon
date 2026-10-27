-- The plan an owner picked, in what order the plans were shown, and a switch waiting for the end
-- of a paid period. The free week is once per business.
ALTER TABLE billing_accounts ADD COLUMN plan VARCHAR(20) NULL;
ALTER TABLE billing_accounts ADD COLUMN plan_chosen_at DATETIME(3) NULL;
ALTER TABLE billing_accounts ADD COLUMN plan_order VARCHAR(80) NULL;
ALTER TABLE billing_accounts ADD COLUMN next_plan VARCHAR(20) NULL;
ALTER TABLE billing_accounts ADD COLUMN plan_schedule_id VARCHAR(255) NULL;
ALTER TABLE billing_accounts ADD COLUMN trial_used_at DATETIME(3) NULL;
-- A quote can now have two charges: when it's delivered, and when the customer accepts it.
ALTER TABLE quote_usage ADD COLUMN charge VARCHAR(12) NOT NULL DEFAULT 'delivered';
ALTER TABLE quote_usage ADD COLUMN plan VARCHAR(20) NULL;
SET @unique_quote = (SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quote_usage' AND COLUMN_NAME = 'quote_id' AND NON_UNIQUE = 0 AND INDEX_NAME NOT IN ('PRIMARY','quote_usage_charge') LIMIT 1);
SET @drop_unique = IF(@unique_quote IS NULL, 'DO 0', CONCAT('ALTER TABLE quote_usage DROP INDEX `', @unique_quote, '`'));
PREPARE drop_unique FROM @drop_unique;
EXECUTE drop_unique;
DEALLOCATE PREPARE drop_unique;
ALTER TABLE quote_usage ADD UNIQUE KEY quote_usage_charge (quote_id, charge);
-- The quote link takes requests once the owner deploys it, and they can pause it. Businesses
-- already set up keep theirs on.
ALTER TABLE businesses ADD COLUMN link_on BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN deployed_at DATETIME(3) NULL;
UPDATE businesses SET link_on=TRUE,deployed_at=created_at WHERE status='active'
