#!/usr/bin/env bash
set -euo pipefail

app_root=${1:?Usage: deploy-remote.sh /srv/quotient-api}
release_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ "$app_root" = /* && "$app_root" != / ]] || { echo 'Deployment root must be an absolute application directory.' >&2; exit 1; }
[[ "$release_dir" == "$app_root/releases/"* ]] || { echo 'Release must be beneath this application root.' >&2; exit 1; }
[[ -f "$app_root/shared/.env" ]] || { echo 'Provision shared/.env on the server before deployment.' >&2; exit 1; }

if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
fi
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo 'Node 24 LTS is required.' >&2; exit 1; }
command -v pm2 >/dev/null
command -v curl >/dev/null

cd "$release_dir"
mkdir -p "$app_root/shared/uploads"
chmod 700 "$app_root/shared/uploads"
ln -s "$app_root/shared/.env" .env
npm ci --omit=dev --no-audit --no-fund
# Only additive, backwards-compatible migrations belong in a normal release.
# MySQL DDL cannot be automatically rolled back; a current tested backup is an operational prerequisite.
node dist/migrate.js
previous_release=$(readlink -f "$app_root/current" 2>/dev/null || true)

rollback() {
  result=$?
  trap - ERR
  echo 'Deployment did not become healthy; restoring the previous application release.' >&2
  if [[ -n "$previous_release" && -d "$previous_release" && -f "$previous_release/deploy/ecosystem.config.cjs" ]]; then
    ln -sfn "$previous_release" "$app_root/.current-rollback"
    mv -Tf "$app_root/.current-rollback" "$app_root/current"
    pm2 startOrReload "$previous_release/deploy/ecosystem.config.cjs" --update-env || true
  else
    pm2 delete quotient-api quotient-worker >/dev/null 2>&1 || true
    [[ -L "$app_root/current" ]] && rm "$app_root/current"
  fi
  exit "$result"
}
trap rollback ERR
ln -sfn "$release_dir" "$app_root/.current-next"
mv -Tf "$app_root/.current-next" "$app_root/current"
pm2 startOrReload "$release_dir/deploy/ecosystem.config.cjs" --update-env
curl --fail --silent --show-error --retry 10 --retry-delay 2 --retry-connrefused --retry-all-errors --max-time 5 http://127.0.0.1:4100/ready >/dev/null
node --input-type=module - "$(basename "$release_dir")" <<'NODE'
try {
  const response = await fetch('http://127.0.0.1:4100/health', { signal: AbortSignal.timeout(5000) });
  const payload = await response.json();
  if (!response.ok || payload?.data?.release !== process.argv[2]) {
    throw new Error('The running API does not match the deployed release.');
  }
} catch {
  console.error('API release identity verification failed.');
  process.exitCode = 1;
}
NODE
pm2 save
trap - ERR
echo 'Quotient API deployment is healthy.'
