#!/bin/bash
# Ubuntu 24.04 user-data for a fresh opportune box. Pair with deploy/deploy.sh.
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl rsync python3 python3-venv python3-pip ufw caddy
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
npm install -g pnpm@11
useradd -m -s /bin/bash opportune || true
mkdir -p /opt/opportune && chown opportune:opportune /opt/opportune
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
touch /root/.provisioned
