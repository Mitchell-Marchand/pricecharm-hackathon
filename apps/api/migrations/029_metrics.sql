-- Milestones and activity for the funnel report: what happened and when, never names, contact
-- details or anything anyone typed. Each business gets a random tag used only here. The tag is
-- deleted with the business, so its rows can't be traced back to it afterwards.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS metrics_subject CHAR(36) NULL;
UPDATE businesses SET metrics_subject=UUID() WHERE metrics_subject IS NULL;
CREATE TABLE IF NOT EXISTS product_events (
  id CHAR(36) PRIMARY KEY,
  subject CHAR(36) NOT NULL,
  name VARCHAR(40) NOT NULL,
  detail VARCHAR(40) NOT NULL DEFAULT '',
  ref CHAR(36) NULL,
  value BIGINT NULL,
  dedupe_key VARCHAR(160) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX product_event_name (name, created_at),
  INDEX product_event_subject (subject, name)
) ENGINE=InnoDB;
-- Visits to the public pages, counted without cookies: one row per page, day and visitor. The
-- visitor is a keyed hash of the address and browser that changes every day. Kept 400 days.
CREATE TABLE IF NOT EXISTS page_visits (
  day DATE NOT NULL,
  path VARCHAR(40) NOT NULL,
  visitor CHAR(64) NOT NULL,
  referrer VARCHAR(100) NOT NULL DEFAULT '',
  campaign VARCHAR(60) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (day, path, visitor)
) ENGINE=InnoDB
