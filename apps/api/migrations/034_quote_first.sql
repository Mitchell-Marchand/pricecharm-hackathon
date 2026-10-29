-- Customers see their quote before giving any contact details, and leave them when they say yes,
-- ask for a visit or want a copy emailed. A phone number works as well as an email. Owners can
-- still ask for contact details before the price shows.
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(40) NULL;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_first BOOLEAN NOT NULL DEFAULT FALSE
