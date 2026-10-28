-- What customers see that the owner can change: their logo, the name the chat says will follow up,
-- the lines after a customer accepts or asks for a visit, and the words on the accept button.
-- Empty text means the default.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_id CHAR(36) NULL;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_name VARCHAR(40) NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS accepted_message VARCHAR(280) NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS visit_message VARCHAR(280) NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS accept_label VARCHAR(24) NOT NULL DEFAULT '';
-- Each quote keeps the words its accept button showed, which wording that was (or 'owner' for the
-- owner's own), and when the customer first saw it.
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS accept_label VARCHAR(24) NULL;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS accept_variant VARCHAR(20) NULL;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS seen_at DATETIME(3) NULL;
CREATE INDEX IF NOT EXISTS live_quote_wording ON live_quotes(accept_variant, seen_at)
