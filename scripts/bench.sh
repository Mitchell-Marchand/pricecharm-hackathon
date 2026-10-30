#!/usr/bin/env bash
# Runs the simulated-owner benchmark (apps/api/src/bench.ts) against a fresh quoting_bench database
# in the local PriceCharm container. It uses the AI keys in apps/api/.env, costs two model calls
# for each job it prices, and never touches your dev data.
set -euo pipefail
# Files named on the command line (--json, --replay, --compare) are found from where you ran this.
export BENCH_CWD="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
docker compose up --detach --wait db
# The app's user can only reach its own databases, so the container's local root makes this one.
docker exec quotefolk-db mariadb -uroot -plocal-root-only \
  -e "DROP DATABASE IF EXISTS quoting_bench; CREATE DATABASE quoting_bench CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON quoting_bench.* TO 'quoting_engine'@'%';"
# Set before .env is read, so these win over its database settings.
export APP_ENV=local MAIL_PROVIDER=local BILLING_PROVIDER=local \
  DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=quoting_bench \
  DB_USER=quoting_engine DB_PASS=local-dev-only DB_CONNECTION_LIMIT=8
npm run migrate --workspace @pricecharm/api >/dev/null
npm run bench --workspace @pricecharm/api -- "$@"
