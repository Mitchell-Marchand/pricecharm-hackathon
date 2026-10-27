#!/usr/bin/env bash
# Runs the API tests, including the database tests, against the throwaway quoting_test database
# in the local PriceCharm container. It never reads apps/api/.env or touches your dev data.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
docker compose up --detach --wait db
# Start from an empty throwaway database so rate-limit counters and fixtures from earlier runs
# never leak into this one.
docker exec quotefolk-db mariadb -uquoting_engine -plocal-dev-only \
  -e "DROP DATABASE IF EXISTS quoting_test; CREATE DATABASE quoting_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
export DOTENV_CONFIG_PATH=/dev/null NODE_ENV=test APP_ENV=test RUN_DB_TESTS=1 \
  AI_PROVIDER=demo MAIL_PROVIDER=local BILLING_PROVIDER=local \
  APP_ORIGIN=http://localhost:3100 DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=quoting_test \
  DB_USER=quoting_engine DB_PASS=local-dev-only DB_CONNECTION_LIMIT=5
npm run migrate --workspace @pricecharm/api
npm test --workspace @pricecharm/api
