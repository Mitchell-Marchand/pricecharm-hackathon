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
(cd "$TASK_WORKSPACE/apps/api" && exec node --import tsx src/server.ts) &
TASK_API_PID=$!
(cd "$TASK_WORKSPACE/apps/api" && exec node --import tsx src/worker.ts) &
TASK_WORKER_PID=$!
(cd "$TASK_WORKSPACE/apps/web" && exec "$TASK_WORKSPACE/node_modules/.bin/next" dev --port 3100 --hostname 127.0.0.1) &
TASK_WEB_PID=$!
printf 'Quotefolk web: http://localhost:3100\nQuotefolk API: http://localhost:4100\nBackground worker: local jobs, email, billing, and cleanup.\nCtrl-C stops these three processes.\n'
wait "$TASK_API_PID" "$TASK_WEB_PID" "$TASK_WORKER_PID"
