#!/usr/bin/env bash
# Idempotent deploy script — runs on the EC2, manually or via CI.
# Pulls latest main, installs deps, builds, fixes Next.js standalone static, reloads PM2.
#
# First-time setup: see docs/deploy-ec2.md
# Manual trigger:
#   ssh -i ~/.ssh/xpert_ec2_ads ubuntu@43.204.145.72 \
#     'bash /var/www/vhosts/xpert.chat/rma.xpert.chat/scripts/deploy.sh'

set -euo pipefail

APP_DIR="/opt/rma-ai"
NODE_BIN="/opt/plesk/node/22/bin"
LOG_DIR="/var/log/rma-ai"
ENV_FILE="/etc/rma-ai/env"

export PATH="${NODE_BIN}:${PATH}"

echo "[deploy] sourcing ${ENV_FILE}"
if [ ! -r "${ENV_FILE}" ]; then
  echo "[deploy] ERROR: ${ENV_FILE} not readable by $(whoami)." >&2
  echo "[deploy] Fix: sudo mkdir -p /etc/rma-ai && sudo chown ubuntu:ubuntu /etc/rma-ai && sudo touch ${ENV_FILE} && sudo chown ubuntu:ubuntu ${ENV_FILE} && sudo chmod 600 ${ENV_FILE}" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

echo "[deploy] cd ${APP_DIR}"
cd "${APP_DIR}"

echo "[deploy] git pull"
git fetch origin main
git reset --hard origin/main

echo "[deploy] npm ci (includes dev deps for next build + tsx)"
npm ci --include=dev

echo "[deploy] npm run build"
npm run build

echo "[deploy] copy static into standalone (Next.js standalone fixup)"
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static
cp -R .next/static .next/standalone/.next/static
if [ -d public ]; then
  rm -rf .next/standalone/public
  cp -R public .next/standalone/public
fi

echo "[deploy] ensure log dir"
sudo mkdir -p "${LOG_DIR}"
sudo chown ubuntu:ubuntu "${LOG_DIR}"

echo "[deploy] pm2 reload (or start if first run)"
if pm2 describe rma-ai >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save

echo "[deploy] done"
pm2 status
