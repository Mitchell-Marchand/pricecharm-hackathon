-- How far a video or photo reading has got: the step it's on and what it has seen so far, so the
-- customer's chat can show it while they wait (src/live/videos.ts, src/live/photo-readings.ts).
ALTER TABLE lead_videos ADD COLUMN IF NOT EXISTS progress_json JSON NULL;
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS photo_progress_json JSON NULL;
