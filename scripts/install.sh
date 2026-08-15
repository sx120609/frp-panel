#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${FRP_PANEL_DIR:-/opt/frp-panel}"
REPO_URL="${FRP_PANEL_REPO:-https://github.com/sx120609/frp-panel.git}"
REPO_MIRRORS="${FRP_PANEL_REPO_MIRRORS:-https://gh-proxy.com/https://github.com/sx120609/frp-panel.git,https://ghproxy.net/https://github.com/sx120609/frp-panel.git}"
if [ -d "$APP_DIR/.git" ]; then
  echo "已有安装：$APP_DIR（请执行 scripts/update.sh 更新）"
  exit 0
fi
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "请使用 root 执行，或设置 FRP_PANEL_DIR 到当前用户可写目录。" >&2
  exit 1
fi
command -v git >/dev/null || { apt-get update && apt-get install -y git; }
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; }
mkdir -p "$(dirname "$APP_DIR")"
CLONE_DIR="${APP_DIR}.clone.$$"
CLONED=0
IFS=',' read -r -a REPOS <<< "$REPO_URL,$REPO_MIRRORS"
for REPO in "${REPOS[@]}"; do
  [ -z "$REPO" ] && continue
  rm -rf "$CLONE_DIR"
  echo "正在尝试拉取：$REPO"
  if git clone --depth 1 "$REPO" "$CLONE_DIR"; then
    mv "$CLONE_DIR" "$APP_DIR"
    CLONED=1
    break
  fi
done
if [ "$CLONED" -ne 1 ]; then
  rm -rf "$CLONE_DIR"
  echo "所有代码仓库地址均拉取失败，请设置 FRP_PANEL_REPO 或 FRP_PANEL_REPO_MIRRORS 后重试。" >&2
  exit 2
fi
cd "$APP_DIR"
cp -n .env.example .env || true
if grep -q '请替换' .env; then
  echo "已完成代码安装。请编辑 $APP_DIR/.env 设置 ADMIN_PASSWORD、SESSION_SECRET、PUBLIC_BASE_URL，然后执行："
else
  echo "已完成代码安装。执行："
fi
echo "  cd $APP_DIR && docker compose up -d --build"
