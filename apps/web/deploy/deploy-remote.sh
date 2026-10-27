#!/usr/bin/env bash
set -euo pipefail

app_root=${1:?Usage: deploy-remote.sh /srv/quotient-web}
release_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ "$app_root" = /* && "$app_root" != / ]] || { echo 'Deployment root must be an absolute application directory.' >&2; exit 1; }
[[ "$release_dir" == "$app_root/releases/"* ]] || { echo 'Release must be beneath this application root.' >&2; exit 1; }
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
fi
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo 'Node 24 LTS is required.' >&2; exit 1; }
command -v pm2 >/dev/null
command -v curl >/dev/null
# Standalone output mirrors the monorepo, so the server is at apps/web/server.js inside it.
[[ -f "$release_dir/.next/standalone/apps/web/server.js" ]]

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
    pm2 delete quotient-web >/dev/null 2>&1 || true
    [[ -L "$app_root/current" ]] && rm "$app_root/current"
  fi
  exit "$result"
}
trap rollback ERR
ln -sfn "$release_dir" "$app_root/.current-next"
mv -Tf "$app_root/.current-next" "$app_root/current"
pm2 startOrReload "$release_dir/deploy/ecosystem.config.cjs" --update-env
curl --fail --silent --show-error --retry 10 --retry-delay 2 --retry-connrefused --retry-all-errors --max-time 5 http://127.0.0.1:3100/ >/dev/null
pm2 save
trap - ERR
echo 'PriceCharm web deployment is healthy.'
