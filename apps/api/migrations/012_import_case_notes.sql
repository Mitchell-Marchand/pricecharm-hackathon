ALTER TABLE import_drafts ADD COLUMN source_text MEDIUMTEXT NULL;
ALTER TABLE import_drafts ADD COLUMN source_basis VARCHAR(32) NULL;
ALTER TABLE import_drafts ADD COLUMN confirmation_hash CHAR(64) NULL;
ALTER TABLE import_drafts ADD COLUMN confirmation_result_json JSON NULL;
ALTER TABLE examples ADD COLUMN source_import_id CHAR(36) NULL;
ALTER TABLE examples ADD COLUMN source_project_id CHAR(36) NULL;
ALTER TABLE examples ADD CONSTRAINT examples_import_source FOREIGN KEY (source_import_id) REFERENCES import_drafts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS owner_case_notes (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  import_draft_id CHAR(36) NOT NULL,
  source_project_id CHAR(36) NOT NULL,
  reviewed_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  FOREIGN KEY (import_draft_id) REFERENCES import_drafts(id) ON DELETE CASCADE,
  UNIQUE KEY case_import_project (import_draft_id,source_project_id),
  INDEX cases_tenant_service (business_id,service_id,created_at)
) ENGINE=InnoDB;
