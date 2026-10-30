-- What PriceCharm read in a chat's photos (src/live/photo-readings.ts): what Muse Spark saw, what
-- SAM 3.1 counted and the state of each thing counted, and which photos that covers, so it's read
-- again when another photo comes in.
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS photo_reading_json JSON NULL;
