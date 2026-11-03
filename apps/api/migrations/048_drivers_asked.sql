-- When the chat asked the customer about something the price depends on that they hadn't settled,
-- like how heavy the stains are. It asks once. After that the quote shows what each would add
-- (prepareLiveQuote in src/live/chat.ts).
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS drivers_asked_at DATETIME(3) NULL;
