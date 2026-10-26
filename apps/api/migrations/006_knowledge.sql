CREATE TABLE IF NOT EXISTS knowledge_proposals (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  service_version INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  proposal_json JSON NOT NULL,
  source_ids_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  applied_at DATETIME(3) NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  INDEX knowledge_tenant (business_id,service_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS import_drafts (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  filename VARCHAR(180) NOT NULL,
  source_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  draft_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  confirmed_at DATETIME(3) NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  UNIQUE KEY draft_source (business_id,source_hash),
  INDEX draft_tenant (business_id,created_at)
) ENGINE=InnoDB;
