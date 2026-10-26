ALTER TABLE services ADD COLUMN teaching_revision INT NOT NULL DEFAULT 0;
ALTER TABLE knowledge_proposals ADD COLUMN teaching_revision INT NOT NULL DEFAULT 0;
ALTER TABLE knowledge_proposals ADD COLUMN parent_proposal_id CHAR(36) NULL;

CREATE TABLE IF NOT EXISTS service_teaching_notes (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  revision INT NOT NULL,
  content TEXT NOT NULL,
  pricing_snapshot_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  UNIQUE KEY teaching_note_revision (service_id, revision),
  INDEX teaching_notes_tenant (business_id, service_id)
) ENGINE=InnoDB;
