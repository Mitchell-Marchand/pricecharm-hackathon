#!/usr/bin/env bash
set -euo pipefail
TASK_WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$HOME/.nvm/versions/node/v24.15.0/bin/node" ]; then
    export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  else
    printf 'Node 24 is required. Install it and run this script again.\n' >&2
    exit 1
  fi
fi
if [ ! -d "$TASK_WORKSPACE/node_modules" ]; then
  printf 'Install dependencies first, from the repository root: npm ci\n' >&2
  exit 1
fi
cleanup() {
  if [ -n "${TASK_API_PID:-}" ]; then kill "$TASK_API_PID" 2>/dev/null || true; fi
  if [ -n "${TASK_WEB_PID:-}" ]; then kill "$TASK_WEB_PID" 2>/dev/null || true; fi
  if [ -n "${TASK_WORKER_PID:-}" ]; then kill "$TASK_WORKER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM
# WEB_PORT and API_PORT pick other ports when something else holds 3100 and 4100.
web_port=${WEB_PORT:-3100}
api_port=${API_PORT:-4100}
if [ "$web_port" != 3100 ]; then
  export APP_ORIGIN="http://localhost:$web_port,http://127.0.0.1:$web_port"
fi
(cd "$TASK_WORKSPACE/apps/api" && PORT=$api_port exec node --import tsx src/server.ts) &
TASK_API_PID=$!
(cd "$TASK_WORKSPACE/apps/api" && exec node --import tsx src/worker.ts) &
TASK_WORKER_PID=$!
(cd "$TASK_WORKSPACE/apps/web" && API_BASE_URL="http://127.0.0.1:$api_port" exec "$TASK_WORKSPACE/node_modules/.bin/next" dev --port "$web_port" --hostname 127.0.0.1) &
TASK_WEB_PID=$!
printf 'Quotefolk web: http://localhost:%s\nQuotefolk API: http://localhost:%s\nBackground worker: local jobs, email, billing, and cleanup.\nCtrl-C stops these three processes.\n' "$web_port" "$api_port"
wait "$TASK_API_PID" "$TASK_WEB_PID" "$TASK_WORKER_PID"
