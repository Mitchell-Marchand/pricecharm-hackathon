-- What the after picture was drawn from, a customer's "photo" or a still from their "video", so its
-- caption says which (src/live/previews.ts).
ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS preview_from VARCHAR(10) NULL;
