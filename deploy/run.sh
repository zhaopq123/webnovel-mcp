#!/data/data/com.termux/files/usr/bin/bash
# 手机侧启动器：读 config.env → exec node server.mjs
# 由 webnovel-mcp-guard 用 `bash run.sh` 调用（不依赖执行位）。
set -e
APP="$HOME/webnovel-mcp"
if [ ! -f "$APP/config.env" ]; then
  echo "[run] 缺少 $APP/config.env —— 拒绝启动" >&2
  exit 2
fi
set -a
. "$APP/config.env"
set +a
exec node "$APP/server.mjs"
