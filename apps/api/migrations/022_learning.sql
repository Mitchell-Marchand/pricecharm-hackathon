-- What the customer chat learned about the job, as fields: size, condition, access, extras, timing.
ALTER TABLE lead_chats ADD COLUMN spec_json JSON NULL;
-- Which model and prompt drafted each quote, and what the server priced it from.
ALTER TABLE live_quotes ADD COLUMN engine_json JSON NULL;
-- Why a customer didn't go ahead, in their own tap or words.
ALTER TABLE live_quotes ADD COLUMN outcome_reason VARCHAR(40) NOT NULL DEFAULT '';
ALTER TABLE live_quotes ADD COLUMN outcome_note VARCHAR(600) NOT NULL DEFAULT '';
ALTER TABLE live_quotes ADD COLUMN followup_sent_at DATETIME(3) NULL;
CREATE INDEX live_quote_followup ON live_quotes(status, sent_at)
