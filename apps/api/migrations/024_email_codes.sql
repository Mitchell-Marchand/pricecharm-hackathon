-- The confirmation email carries a 6-digit code as well as the link, so owners can confirm on the
-- page they signed up on. Wrong guesses are counted per code.
ALTER TABLE identity_tokens ADD COLUMN code_hash CHAR(64) NULL;
ALTER TABLE identity_tokens ADD COLUMN code_attempts SMALLINT NOT NULL DEFAULT 0
