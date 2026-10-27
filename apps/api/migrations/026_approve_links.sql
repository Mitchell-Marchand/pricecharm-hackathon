-- The one-tap link in a "needs your OK" email: a random token, kept only as a hash, that can show
-- and send this one quote until it runs out.
ALTER TABLE live_quotes ADD COLUMN approve_token_hash CHAR(64) NULL;
ALTER TABLE live_quotes ADD COLUMN approve_token_expires_at DATETIME(3) NULL;
CREATE INDEX live_quote_approve_token ON live_quotes(approve_token_hash)
