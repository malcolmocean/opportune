#!/bin/bash
# Usage: deploy/deploy.sh <host-ip> [host-name]   e.g. deploy/deploy.sh 157.230.169.110 157.230.169.110.sslip.io
# Rsyncs this checkout to /opt/opportune on the box, installs deps, (re)starts the service, configures Caddy for HTTPS.
set -eu
IP=${1:?ip}; HOST=${2:-$IP.sslip.io}
cd "$(dirname "$0")/.."
rsync -az --delete \
  --exclude node_modules --exclude 'data/' --exclude '.venv' --exclude '__pycache__' --exclude '.git' \
  --exclude 'apps/android/app/build' --exclude 'apps/android/.gradle' --exclude 'apps/android/build' \
  ./ root@$IP:/opt/opportune/
ssh root@$IP bash -s <<REMOTE
set -eu
cd /opt/opportune
chown -R opportune:opportune /opt/opportune
sudo -u opportune pnpm install --frozen-lockfile --prod=false >/dev/null
[ -d sources/mapsSharing/.venv ] || sudo -u opportune sh sources/mapsSharing/setup.sh >/dev/null 2>&1 || true
cp deploy/opportune.service /etc/systemd/system/opportune.service
printf 'OPPORTUNE_HOST=$HOST\n' > /etc/caddy/env
cp deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/env\n' > /etc/systemd/system/caddy.service.d/env.conf
systemctl daemon-reload
systemctl enable --now opportune
systemctl restart opportune
systemctl restart caddy
sleep 2
systemctl is-active opportune caddy
REMOTE
echo "deployed → https://$HOST"
