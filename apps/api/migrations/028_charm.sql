-- The Charm quotes on its own from the start, with no price limit unless the owner sets one.
-- Owners choose how trained a service has to be for firm prices, and what goes out before then.
ALTER TABLE businesses ALTER COLUMN auto_send SET DEFAULT TRUE;
ALTER TABLE businesses MODIFY COLUMN auto_send_limit_cents INT NULL DEFAULT NULL;
ALTER TABLE businesses ADD COLUMN trained_percent TINYINT UNSIGNED NOT NULL DEFAULT 60;
ALTER TABLE businesses ADD COLUMN learning_style VARCHAR(12) NOT NULL DEFAULT 'range';
-- Setups still in progress get the new defaults. Live businesses keep what they have.
UPDATE businesses SET auto_send=TRUE,auto_send_limit_cents=NULL WHERE status='draft'
