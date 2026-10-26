ALTER TABLE attachments ADD COLUMN training_message_id CHAR(36) NULL;
ALTER TABLE attachments ADD COLUMN training_scene_json JSON NULL;

CREATE TABLE IF NOT EXISTS training_photo_requests (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  training_session_id CHAR(36) NOT NULL,
  message_id CHAR(36) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  scenes_json JSON NOT NULL,
  asset_ids_json JSON NOT NULL,
  job_id CHAR(36) NULL,
  attempts INT NOT NULL DEFAULT 1,
  generation_started_at DATETIME(3) NULL,
  failure_code VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (training_session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  INDEX training_photos_tenant (business_id, training_session_id)
) ENGINE=InnoDB;
