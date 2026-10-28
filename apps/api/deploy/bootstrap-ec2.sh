#!/usr/bin/env bash
# Amazon Linux 2023, dedicated new Quotient instance. Run as root.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run on a new EC2 instance as root.' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == amzn && "$VERSION_ID" == 2023 ]] || { echo 'This bootstrap requires Amazon Linux 2023.' >&2; exit 1; }
dnf install -y nodejs24 nodejs24-npm nginx rsync jq mariadb105 gzip python3 amazon-cloudwatch-agent certbot
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
# Certificate bundle for verified TLS to RDS (DB_SSL=1, DB_SSL_CA_FILE).
install -d -m 755 /etc/pki/rds
curl --fail --silent --show-error --output /etc/pki/rds/global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
# HTTPS certificates: Nginx serves the ACME challenge from /var/www/acme (nginx-site.conf.example),
# certbot's timer renews twice a day, and Nginx reloads whenever a certificate changes.
install -d -m 755 /var/www/acme /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'systemctl reload nginx' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
# Nightly database dump, copied to the backup bucket. It waits until the first API release exists.
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
printf '%s\n' 'Bootstrap complete. Add the deploy key, configure shared/.env, shared/migrate.env, DNS/TLS/Nginx, SES and Stripe; then deploy the API and web releases.'
