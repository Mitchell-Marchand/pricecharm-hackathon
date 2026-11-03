-- Owners' own AI work in a day, setups included: training, past jobs, their own test chats. It has
-- a cap of its own, high enough never to stop someone training, as a brake on a runaway day.
ALTER TABLE ai_daily_budgets ADD COLUMN training_reserved INT NOT NULL DEFAULT 0;
