CREATE TABLE IF NOT EXISTS ai_daily_budgets (
  budget_day DATE PRIMARY KEY,
  total_reserved INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;
