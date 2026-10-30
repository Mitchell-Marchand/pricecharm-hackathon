-- The owner's price formula as last worked out from their quotes (src/pricing/formula-draft.ts),
-- with a hash of the examples and notes it came from, so it's only worked out again when those
-- change, and a restart doesn't lose it.
CREATE TABLE IF NOT EXISTS pricing_formulas (
  business_id CHAR(36) PRIMARY KEY,
  examples_key CHAR(64) NOT NULL,
  learned_json JSON NOT NULL,
  learned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB
