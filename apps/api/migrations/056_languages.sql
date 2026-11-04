-- The language a business's Charm talks to customers in, and any others customers can pick.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS language VARCHAR(8) NOT NULL DEFAULT 'en';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS languages_json JSON NULL;
-- The language a customer's chat is in: the one they picked, or the one they write in.
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS language VARCHAR(8) NULL;
-- Words a customer reads that aren't fixed, like a quote's lines, each translated once.
CREATE TABLE IF NOT EXISTS text_translations (
  business_id CHAR(36) NOT NULL,
  language VARCHAR(8) NOT NULL,
  text_hash CHAR(64) NOT NULL,
  translated TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, language, text_hash)
);
-- The assistant asked for a photo, which the chat can't tell from the words in every language.
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS asks_photo BOOLEAN NOT NULL DEFAULT FALSE;
