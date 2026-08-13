#!/usr/bin/env bash
set -euo pipefail

APP_DIR="\${FRP_PANEL_DIR:-/opt/frp-panel}"
REPO_URL="\${FRP_PANEL_REPO:-https://github.com/sx120609/frp-panel.git}"
if [ -d "\$APP_DIR/.git" ]; then
  echo "已有安装：\$APP_DIR（请执行 scripts/update.sh 更新）"
  exit 0
fi
if [ "\${EUID:-\$(id -u)}" -ne 0 ]; then
  echo "请使用 root 执行，或设置 FRP_PANEL_DIR 到当前用户可写目录。" >&2
  exit 1
fi
command -v git >/dev/null || { apt-get update && apt-get install -y git; }
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; }
mkdir -p "\$(dirname "\$APP_DIR")"
git clone "\$REPO_URL" "\$APP_DIR"
cd "\$APP_DIR"
cp -n .env.example .env || true
if grep -q '请替换' .env; then
  echo "已完成代码安装。请编辑 \$APP_DIR/.env 设置 ADMIN_PASSWORD、SESSION_SECRET、PUBLIC_BASE_URL，然后执行："
else
  echo "已完成代码安装。执行："
fi
echo "  cd \$APP_DIR && docker compose up -d --build"
