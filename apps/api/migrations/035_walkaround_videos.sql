-- A short video a customer films of the job, measured in the background: Muse Spark watches it and
-- SAM 3.1 counts and outlines what gets priced. A message points at it, like it does at photos.
CREATE TABLE IF NOT EXISTS lead_videos (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  chat_id CHAR(36) NOT NULL,
  storage_key VARCHAR(60) NOT NULL,
  mime_type VARCHAR(40) NOT NULL,
  byte_size INT NOT NULL,
  duration_ms INT NULL,
  -- Stills the customer's browser took from it, with where in the video each was taken. They're
  -- kept apart from the chat's photos, so they don't use up the customer's three.
  frames_json JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'measuring',
  result_json JSON NULL,
  failure VARCHAR(300) NULL,
  -- Who started it, for the customers' AI allowance when it's measured outside their request.
  requester_ip VARCHAR(64) NOT NULL DEFAULT '',
  read_token CHAR(36) NULL,
  read_until DATETIME(3) NULL,
  read_attempts SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id) REFERENCES lead_chats(id) ON DELETE CASCADE,
  INDEX lead_video_chat (chat_id, created_at)
) ENGINE=InnoDB;

ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS video_id CHAR(36) NULL;
