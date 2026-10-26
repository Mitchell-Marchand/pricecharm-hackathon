CREATE TABLE IF NOT EXISTS attachments (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  conversation_id CHAR(36) NULL,
  example_id CHAR(36) NULL,
  filename VARCHAR(180) NOT NULL,
  mime_type VARCHAR(80) NOT NULL,
  storage_key VARCHAR(120) NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  byte_size INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  INDEX attachments_tenant (business_id, created_at),
  INDEX attachments_conversation (business_id, conversation_id)
) ENGINE=InnoDB;
