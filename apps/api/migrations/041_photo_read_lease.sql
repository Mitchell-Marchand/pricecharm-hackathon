-- Who's reading a chat's photos right now, and until when (src/live/photo-readings.ts). It's held
-- until the Charm has answered from them, so the chat shows it's looking until then, and only one
-- reading runs per chat. A reading a restart cut short runs out and is picked up again.
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS photo_read_token CHAR(36) NULL;
ALTER TABLE lead_chats ADD COLUMN IF NOT EXISTS photo_read_until DATETIME(3) NULL;
