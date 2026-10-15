#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# webnovel-mcp-guard —— 长篇网文写作 MCP（:8600）守护脚本
#
# 运行位置：Termux 层（原生 node v24），**不进 proot**。
#   与 diagram-mcp-guard / mcp-imagegen-guard 同款模式：
#   tmux 会话 + while 循环 + 端口检测幂等 —— 可反复执行，在跑的自动跳过。
#
# 管理命令：webnovel-mcp-ctl status | restart | stop | logs | token
# ============================================================
export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home
APP="$HOME/webnovel-mcp"
LOGDIR="$HOME/logs"
LOGFILE="$LOGDIR/webnovel-mcp.log"
SESSION=svc-webnovel
PORT="${WEBNOVEL_PORT:-8600}"

port_up() { netstat -tln 2>/dev/null | grep -q ":$1 "; }

echo "===== $(date '+%F %T') 启动 webnovel-mcp ====="
mkdir -p "$LOGDIR"

# 日志超过 5MB 先滚动一次
if [ -f "$LOGFILE" ]; then
  size=$(wc -c < "$LOGFILE" 2>/dev/null || echo 0)
  if [ "$size" -gt 5242880 ]; then
    mv -f "$LOGFILE" "$LOGFILE.1"
    echo "[$SESSION] 日志已滚动到 $LOGFILE.1"
  fi
fi

if port_up "$PORT"; then
  echo "[$SESSION] :$PORT 已在运行，跳过"
  exit 0
fi

if [ ! -f "$APP/config.env" ]; then
  echo "[$SESSION] 缺少 $APP/config.env —— 拒绝启动" >&2
  exit 2
fi
if [ ! -f "$APP/server.mjs" ]; then
  echo "[$SESSION] 缺少 $APP/server.mjs —— 项目未部署完整" >&2
  exit 3
fi

# 用 `bash run.sh` 而不是直接 exec：部署时若执行位被冲掉，
# 直接 exec 会 Permission denied 然后守护循环静默空转。
tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"
tmux new-session -d -s "$SESSION" \
  "while true; do bash $APP/deploy/run.sh >> $LOGFILE 2>&1; echo \"[\$(date '+%F %T')] $SESSION exited, retry in 10s\" >> $LOGFILE; sleep 10; done"

# 轮询等待就绪：手机刚跑完重负载时 node 冷启动会变慢，窗口给 45 秒。
ready=0
for i in $(seq 1 45); do
  if port_up "$PORT"; then ready=1; break; fi
  sleep 1
done

if [ "$ready" -eq 1 ]; then
  echo "[$SESSION] 已启动 (:$PORT 守护中，日志 $LOGFILE)"
  echo "===== 完成 ====="
  exit 0
fi

echo "[$SESSION] 45 秒内未就绪 —— 先跑 webnovel-mcp-ctl status 确认。日志最后 20 行："
tail -n 20 "$LOGFILE" 2>/dev/null
exit 1
