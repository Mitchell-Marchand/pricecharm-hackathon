#!/usr/bin/env bash
# Runs the web app's Playwright suite against a real API and test database. CI runs this script
# too. It builds the web app for the test API, assembles the standalone server the way a release
# does, and starts the API, worker and web server on spare ports, so a running dev stack on
# 3100/4100 is left alone.
#
# Locally the database defaults to the throwaway quoting_test database in the PriceCharm container
# (`npm run db:start`). In CI the DB_* variables point at the job's MariaDB service.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

api_port=${E2E_API_PORT:-4200}
web_port=${E2E_WEB_PORT:-3300}
export DOTENV_CONFIG_PATH=/dev/null NODE_ENV=test APP_ENV=test EXPOSE_DEV_TOKENS=1 \
  AI_PROVIDER=demo MAIL_PROVIDER=local BILLING_PROVIDER=local LOCAL_SETUPS_PER_ADDRESS=500 \
  LOCAL_REQUESTS_PER_MINUTE=2000 \
  APP_ORIGIN="http://localhost:$web_port,http://127.0.0.1:$web_port" \
  PUBLIC_APP_URL="http://localhost:$web_port"
export DB_HOST=${DB_HOST:-127.0.0.1} DB_PORT=${DB_PORT:-3307} DB_NAME=${DB_NAME:-quoting_test} \
  DB_USER=${DB_USER:-quoting_engine} DB_PASS=${DB_PASS:-local-dev-only}

# The default local test database is throwaway: reset it so earlier runs never leak into this one.
if [ "$DB_PORT" = 3307 ] && [ "$DB_NAME" = quoting_test ] && [ "${E2E_RESET_DB:-1}" = 1 ]; then
  docker exec quotefolk-db mariadb -uquoting_engine -plocal-dev-only \
    -e "DROP DATABASE IF EXISTS quoting_test; CREATE DATABASE quoting_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
fi
npm run migrate --workspace @pricecharm/api
API_BASE_URL="http://127.0.0.1:$api_port" npm run build --workspace @pricecharm/web

standalone=apps/web/.next/standalone/apps/web
rm -rf "$standalone/.next/static" "$standalone/public"
cp -R apps/web/.next/static "$standalone/.next/static"
cp -R apps/web/public "$standalone/public"

logs=${E2E_LOG_DIR:-$(mktemp -d)}
mkdir -p "$logs"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
(cd apps/api && PORT=$api_port exec node --import tsx src/server.ts) >"$logs/api.log" 2>&1 &
pids+=($!)
(cd apps/api && exec node --import tsx src/worker.ts) >"$logs/worker.log" 2>&1 &
pids+=($!)
PORT=$web_port HOSTNAME=127.0.0.1 node "$standalone/server.js" >"$logs/web.log" 2>&1 &
pids+=($!)

for url in "http://127.0.0.1:$api_port/ready" "http://127.0.0.1:$web_port/"; do
  for attempt in $(seq 1 60); do
    if curl --fail --silent --output /dev/null "$url"; then break; fi
    if [ "$attempt" = 60 ]; then
      echo "Not ready after 60 seconds: $url (logs in $logs)" >&2
      tail -n 40 "$logs"/*.log >&2
      exit 1
    fi
    sleep 1
  done
done

# Extra arguments go to Playwright, e.g. `bash scripts/e2e.sh request-history --repeat-each=5`.
QUOTING_WEB_URL="http://localhost:$web_port" npm run test:e2e --workspace @pricecharm/web -- "$@"
