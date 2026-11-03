-- What the Charm read in a practice customer's photos (src/practice/photos.ts), kept the way a
-- customer's chat keeps it: what it saw and counted, the photos that covers, and the owner's
-- fixes. It's read outside the request, held by a lease like lead_chats.photo_read_until, so only
-- one reading runs per customer and the chat can show how far it has got.
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS photo_reading_json JSON NULL;
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS photo_read_token CHAR(36) NULL;
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS photo_read_until DATETIME(3) NULL;
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS photo_progress_json JSON NULL;

-- A photo the owner asked the practice customer for, while it's being taken: what it's of, and
-- the lease on making it. photo_asks counts the photos sent on request, two at most.
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS photo_ask_json JSON NULL;
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS photo_ask_token CHAR(36) NULL;
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS photo_ask_until DATETIME(3) NULL;
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS photo_asks TINYINT UNSIGNED NOT NULL DEFAULT 0;

-- An owner's fix to what the Charm read in photos: a count, a size or a note, what was read and
-- what the owner says is right, and the photos it's about. Labeled photo data for that trade.
CREATE TABLE IF NOT EXISTS photo_labels (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  run_id CHAR(36) NULL,
  trade_id VARCHAR(60) NULL,
  service_name VARCHAR(120) NOT NULL,
  photo_ids_json JSON NOT NULL,
  kind VARCHAR(10) NOT NULL,
  name VARCHAR(80) NOT NULL DEFAULT '',
  unit VARCHAR(20) NOT NULL DEFAULT '',
  read_value DECIMAL(12,2) NULL,
  fixed_value DECIMAL(12,2) NULL,
  read_text VARCHAR(600) NOT NULL DEFAULT '',
  fixed_text VARCHAR(600) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES practice_runs(id) ON DELETE CASCADE,
  INDEX photo_label_trade (trade_id, kind, created_at)
) ENGINE=InnoDB;

-- Setup's first practice customers for each trade, written, photographed, read and reconciled
-- once by `npm run practice-library`, then shared by every new owner of that trade
-- (src/practice/library.ts). Generic places and no business names, so any owner can have them.
-- photos_json holds the storage keys, copied to each owner's own photos when it's used.
CREATE TABLE IF NOT EXISTS practice_library (
  id CHAR(36) PRIMARY KEY,
  trade_id VARCHAR(60) NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  service_name VARCHAR(120) NOT NULL,
  situation TEXT NOT NULL,
  scenario_json JSON NOT NULL,
  photos_json JSON NOT NULL,
  reading_json JSON NOT NULL,
  checked_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY practice_library_slot (trade_id, position)
) ENGINE=InnoDB;
