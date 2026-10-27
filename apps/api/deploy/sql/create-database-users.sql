-- Run once against the dedicated PriceCharm database, as the RDS admin user. The admin password is
-- in the Secrets Manager secret named by the stack's DatabaseAdminSecretArn output.
--
-- Before running, replace both passwords with fresh values, for example from `openssl rand -base64 32`.
-- Put the app user's password in shared/.env (DB_USER, DB_PASS) and the migration user's in
-- shared/migrate.env (MIGRATION_DB_USER, MIGRATION_DB_PASS). Never commit the filled-in copy.

CREATE DATABASE IF NOT EXISTS quotient_production CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The running API and worker: rows only, TLS only, and a connection cap.
CREATE USER IF NOT EXISTS 'quotefolk_app'@'%'
  IDENTIFIED BY 'REPLACE_WITH_APP_PASSWORD'
  REQUIRE SSL
  WITH MAX_USER_CONNECTIONS 20;
GRANT SELECT, INSERT, UPDATE, DELETE ON quotient_production.* TO 'quotefolk_app'@'%';

-- Deployments only: may change the schema, never used by the running app.
CREATE USER IF NOT EXISTS 'quotefolk_migrate'@'%'
  IDENTIFIED BY 'REPLACE_WITH_MIGRATION_PASSWORD'
  REQUIRE SSL
  WITH MAX_USER_CONNECTIONS 2;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP
  ON quotient_production.* TO 'quotefolk_migrate'@'%';
