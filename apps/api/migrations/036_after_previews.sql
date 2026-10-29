-- A picture of the job done, which Muse Image makes from the customer's own photo and which shows
-- with the quote. On unless the owner turns it off.
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS preview_status VARCHAR(20) NULL;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS preview_source_key VARCHAR(60) NULL;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS preview_key VARCHAR(60) NULL;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS preview_at DATETIME(3) NULL;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS after_preview BOOLEAN NOT NULL DEFAULT TRUE;
