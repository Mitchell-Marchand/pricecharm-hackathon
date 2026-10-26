#!/usr/bin/env bash
# Amazon Linux 2023, dedicated new Quotient instance. Run as root.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run on a new EC2 instance as root.' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == amzn && "$VERSION_ID" == 2023 ]] || { echo 'This bootstrap requires Amazon Linux 2023.' >&2; exit 1; }
dnf install -y nodejs24 nodejs24-npm nginx rsync jq mariadb105 gzip python3 amazon-cloudwatch-agent
alternatives --set node /usr/bin/node-24
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]]
npm install --global pm2@6
id quotient >/dev/null 2>&1 || useradd --create-home --shell /bin/bash quotient
install -d -m 700 -o quotient -g quotient /home/quotient/.ssh
install -d -m 755 -o quotient -g quotient /srv/quotient-api/releases /srv/quotient-web/releases
install -d -m 700 -o quotient -g quotient /srv/quotient-api/shared /srv/quotient-api/shared/uploads /srv/quotient-api/shared/backups
# Copy only the provisioned instance admin public key to the unprivileged deployment user.
if [[ -s /home/ec2-user/.ssh/authorized_keys && ! -e /home/quotient/.ssh/authorized_keys ]]; then
  install -m 600 -o quotient -g quotient /home/ec2-user/.ssh/authorized_keys /home/quotient/.ssh/authorized_keys
fi
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
systemctl enable --now nginx amazon-ssm-agent
printf '%s\n' 'Bootstrap complete. Configure shared/.env, DNS/TLS/Nginx, SES and Stripe; then deploy the API and web releases.'
