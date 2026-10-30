-- What a business connects through Meta's WhatsApp sign-up (src/channels/accounts.ts): the WhatsApp
-- Business Account its number belongs to, for its webhooks and message templates, and the PIN its
-- number was registered with, encrypted, which Meta asks for again to re-register it.
ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS waba_id VARCHAR(64) NULL;
ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS pin_ciphertext TEXT NULL;
