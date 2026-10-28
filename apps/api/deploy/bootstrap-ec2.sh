#!/usr/bin/env bash
# Amazon Linux 2023, a new instance just for PriceCharm. Run as root, or paste it in as the
# instance's user data at launch.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run on a new EC2 instance as root.' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == amzn && "$VERSION_ID" == 2023 ]] || { echo 'This bootstrap requires Amazon Linux 2023.' >&2; exit 1; }
dnf install -y nodejs24 nodejs24-npm nginx rsync jq mariadb105 gzip python3 amazon-cloudwatch-agent certbot docker openssl nano
alternatives --set node /usr/bin/node-24
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]]
npm install --global pm2@6
id quotient >/dev/null 2>&1 || useradd --create-home --shell /bin/bash quotient
install -d -m 700 -o quotient -g quotient /home/quotient/.ssh
install -d -m 755 -o quotient -g quotient /srv/quotient-api/releases /srv/quotient-web/releases
install -d -m 700 -o quotient -g quotient /srv/quotient-api/shared /srv/quotient-api/shared/uploads /srv/quotient-api/shared/backups
# The deployment user gets its own key, added after launch (LAUNCH.md). The instance admin key
# stays with ec2-user, which can sudo, so it never needs to be stored in GitHub.
touch /home/quotient/.ssh/authorized_keys
chown quotient:quotient /home/quotient/.ssh/authorized_keys
chmod 600 /home/quotient/.ssh/authorized_keys
pm2 startup systemd -u quotient --hp /home/quotient
cat > /etc/logrotate.d/quotient <<'ROTATE'
/home/quotient/.pm2/logs/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
    su quotient quotient
}
ROTATE
# PriceCharm's database: MariaDB 11.4, the version CI tests against, in Docker on this host and
# reachable only from it. The root password stays in /root/pricecharm/mariadb.env.
systemctl enable --now docker
install -d -m 700 /srv/mariadb /root/pricecharm
if [[ ! -s /root/pricecharm/mariadb.env ]]; then
  (umask 077 && printf 'MARIADB_ROOT_PASSWORD=%s\nMARIADB_ROOT_HOST=localhost\nMARIADB_AUTO_UPGRADE=1\n' "$(openssl rand -hex 24)" > /root/pricecharm/mariadb.env)
fi
docker container inspect pricecharm-db >/dev/null 2>&1 || docker run --detach --name pricecharm-db \
  --restart unless-stopped --env-file /root/pricecharm/mariadb.env \
  --publish 127.0.0.1:3306:3306 --volume /srv/mariadb:/var/lib/mysql mariadb:11.4
for attempt in $(seq 1 60); do
  docker exec pricecharm-db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1 && break
  [[ $attempt -lt 60 ]] || { echo 'MariaDB did not start; see docker logs pricecharm-db.' >&2; exit 1; }
  sleep 2
done
# The first run makes the database, a rows-only app user and a migration user, and writes their
# settings into shared/migrate.env and the top of shared/.env. Later runs leave both alone.
if [[ ! -f /srv/quotient-api/shared/.env ]]; then
  app_password=$(openssl rand -hex 24)
  migrate_password=$(openssl rand -hex 24)
  docker exec -i pricecharm-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot' <<SQL
CREATE DATABASE IF NOT EXISTS quotient_production CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE OR REPLACE USER 'quotefolk_app'@'%' IDENTIFIED BY '$app_password' WITH MAX_USER_CONNECTIONS 20;
GRANT SELECT, INSERT, UPDATE, DELETE ON quotient_production.* TO 'quotefolk_app'@'%';
CREATE OR REPLACE USER 'quotefolk_migrate'@'%' IDENTIFIED BY '$migrate_password' WITH MAX_USER_CONNECTIONS 2;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP ON quotient_production.* TO 'quotefolk_migrate'@'%';
SQL
  install -m 600 -o quotient -g quotient /dev/null /srv/quotient-api/shared/migrate.env
  printf 'MIGRATION_DB_USER=quotefolk_migrate\nMIGRATION_DB_PASS=%s\n' "$migrate_password" > /srv/quotient-api/shared/migrate.env
  install -m 600 -o quotient -g quotient /dev/null /srv/quotient-api/shared/.env
  cat > /srv/quotient-api/shared/.env <<ENV
# PriceCharm's database on this server, written by bootstrap-ec2.sh.
# Add everything from apps/api/deploy/env.production.example below these lines.
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=quotient_production
DB_USER=quotefolk_app
DB_PASS=$app_password
DB_CONNECTION_LIMIT=5

ENV
fi
# HTTPS certificates: Nginx serves the ACME challenge from /var/www/acme (nginx-site.conf.example),
# certbot's timer renews twice a day, and Nginx reloads whenever a certificate changes.
install -d -m 755 /var/www/acme /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'systemctl reload nginx' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
# Nightly database dump, kept on this server for a week and copied to BACKUP_BUCKET when that's
# set. It waits until the first API release exists.
cat > /etc/systemd/system/quotient-backup.service <<'UNIT'
[Unit]
Description=PriceCharm database backup
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=quotient
Group=quotient
ExecCondition=/usr/bin/test -f /srv/quotient-api/current/apps/api/deploy/ops/nightly-backup.sh
ExecStart=/bin/bash /srv/quotient-api/current/apps/api/deploy/ops/nightly-backup.sh
UNIT
cat > /etc/systemd/system/quotient-backup.timer <<'UNIT'
[Unit]
Description=Nightly PriceCharm database backup

[Timer]
OnCalendar=*-*-* 08:00:00 UTC
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now nginx amazon-ssm-agent certbot-renew.timer quotient-backup.timer
printf '%s\n' 'Bootstrap complete. Add the deploy key, finish shared/.env (the database lines are already in it), set up DNS and HTTPS; then deploy the API and web releases.'
