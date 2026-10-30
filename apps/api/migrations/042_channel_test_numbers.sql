-- Numbers the owner tries their own WhatsApp line from, digits only and comma separated. A chat
-- from one is the owner's test, like trying their own quote link: never billed or emailed.
ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS test_numbers VARCHAR(255) NOT NULL DEFAULT '';
