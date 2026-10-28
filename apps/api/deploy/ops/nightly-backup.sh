#!/usr/bin/env bash
# Run nightly by the quotient-backup timer (bootstrap-ec2.sh) as the quotient user. Dumps the
# database with backup.py, copies the dump to BACKUP_BUCKET, and keeps a week of local copies.
set -euo pipefail

app_root=/srv/quotient-api
env_file=$app_root/shared/.env
backup_dir=$app_root/shared/backups
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

dump=$(python3 "$here/backup.py" --env "$env_file" --output "$backup_dir")
bucket=$(sed -n 's/^BACKUP_BUCKET=//p' "$env_file" | tail -n 1 | tr -d "\"' ")
if [[ -n "$bucket" ]]; then
  [[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { echo 'BACKUP_BUCKET is not a bucket name.' >&2; exit 1; }
  # The bucket deletes dumps after 28 days, inside the 30 days the privacy policy promises.
  aws s3 cp "$dump" "s3://$bucket/database/$(basename "$dump")" --only-show-errors
else
  echo 'BACKUP_BUCKET is not set, so this dump stays on this server only.' >&2
fi
find "$backup_dir" -maxdepth 1 -name '*.sql.gz' -mtime +7 -delete
echo "Backed up $(basename "$dump")."
