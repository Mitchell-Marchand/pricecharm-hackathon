-- A WhatsApp number a business connects, so its Charm answers customers there. The token is the
-- one Meta gave for that business. While the number is our own test number it's left empty, and
-- the platform's token from the environment is used.
CREATE TABLE IF NOT EXISTS channel_accounts (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  -- WhatsApp's phone number ID.
  platform_id VARCHAR(64) NOT NULL,
  -- What the owner sees: the number as customers dial it.
  display_name VARCHAR(120) NOT NULL DEFAULT '',
  token_ciphertext TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'connected',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY channel_account_platform (kind, platform_id),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- What customers send, kept until it's been answered, so a restart doesn't lose a message and a
-- webhook Meta delivers twice is handled once.
CREATE TABLE IF NOT EXISTS channel_inbox (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  -- Who sent it: Meta's ID for them on this business's number.
  sender VARCHAR(128) NOT NULL,
  platform_message_id VARCHAR(160) NOT NULL UNIQUE,
  payload_json JSON NOT NULL,
  sent_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE,
  INDEX channel_inbox_waiting (status, account_id, sender, sent_at)
) ENGINE=InnoDB;

-- Who's answering each sender right now, so their messages are handled one at a time and in order
-- by the API and the worker. A lease that outlives a crash simply runs out.
CREATE TABLE IF NOT EXISTS channel_senders (
  account_id CHAR(36) NOT NULL,
  sender VARCHAR(128) NOT NULL,
  lease_token CHAR(36) NULL,
  lease_until DATETIME(3) NULL,
  PRIMARY KEY (account_id, sender),
  FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A chat that lives on WhatsApp: whose it is there, and when they last wrote, since a business may
-- only reply freely for 24 hours after that.
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS channel_account_id CHAR(36) NULL;
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS channel_user_id VARCHAR(128) NULL;
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS last_inbound_at DATETIME(3) NULL;
CREATE INDEX IF NOT EXISTS lead_chat_channel ON lead_chats(channel_account_id, channel_user_id, created_at);
CREATE INDEX IF NOT EXISTS lead_chat_inbound ON lead_chats(last_inbound_at);
ALTER TABLE lead_chats ADD CONSTRAINT lead_chat_channel_account FOREIGN KEY (channel_account_id) REFERENCES channel_accounts(id) ON DELETE SET NULL;

-- WhatsApp's ID for each message, and for what we sent, when it went and what became of it.
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS channel_message_id VARCHAR(160) NULL;
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS channel_sent_at DATETIME(3) NULL;
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS channel_status VARCHAR(20) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lead_message_channel ON lead_messages(channel_message_id);

-- The quote as a WhatsApp message, and its after picture, once each has gone.
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS channel_message_id VARCHAR(160) NULL;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS channel_sent_at DATETIME(3) NULL;
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS channel_preview_sent_at DATETIME(3) NULL;
CREATE INDEX IF NOT EXISTS live_quote_channel_message ON live_quotes(channel_message_id);
