#!/usr/bin/env bash
set -euo pipefail
APP_DIR="\${FRP_PANEL_DIR:-/opt/frp-panel}"
cd "\$APP_DIR"
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null || true
echo "frp-panel 已更新并重启。"
