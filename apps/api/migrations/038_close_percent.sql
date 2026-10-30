-- How close the Charm's price has to come to the owner's to count as a match while it learns.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS close_percent TINYINT UNSIGNED NOT NULL DEFAULT 15;
