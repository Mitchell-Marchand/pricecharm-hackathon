-- Other businesses' combined rate for a practice job's service, next to the owner's own, kept when
-- the owner answers so the practice card can say when they charge less than most
-- (src/practice/engine.ts). Only written while MARKET_PRICES=on.
ALTER TABLE practice_runs ADD COLUMN IF NOT EXISTS market_json JSON NULL;
