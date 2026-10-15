#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# webnovel-mcp-ctl —— 长篇网文写作 MCP 运维入口
#
#   webnovel-mcp-ctl status    端口 + 会话 + 健康检查 + 最近日志
#   webnovel-mcp-ctl restart   重启服务
#   webnovel-mcp-ctl stop      停服务（含守护循环）
#   webnovel-mcp-ctl logs      跟踪日志
#   webnovel-mcp-ctl token     打印访问 token（给 WorkBuddy 配置用）
#   webnovel-mcp-ctl books     列出书库里的书
#   webnovel-mcp-ctl clean [--force] <bookId>...   删掉指定书（验收脚本留下的测试书）
# ============================================================
export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home
APP="$HOME/webnovel-mcp"
SESSION=svc-webnovel
PORT="${WEBNOVEL_PORT:-8600}"
LOGFILE="$HOME/logs/webnovel-mcp.log"

port_up() { netstat -tln 2>/dev/null | grep -q ":$1 "; }
token() { grep -m1 '^WEBNOVEL_TOKEN=' "$APP/config.env" 2>/dev/null | cut -d= -f2-; }

case "$1" in
  status)
    echo "端口 :$PORT  -> $(port_up "$PORT" && echo 在监听 || echo 未监听)"
    echo "tmux 会话    -> $(tmux has-session -t "$SESSION" 2>/dev/null && echo 存在 || echo 不存在)"
    t=$(token)
    if [ -n "$t" ]; then
      echo -n "健康检查     -> "
      curl -s -m 5 "http://127.0.0.1:$PORT/health" || echo "(无响应)"
      echo
    fi
    echo "--- 最近 15 行日志 ---"
    tail -n 15 "$LOGFILE" 2>/dev/null || echo "(无日志)"
    ;;
  restart)
    tmux kill-session -t "$SESSION" 2>/dev/null
    for p in $(pgrep -f "node .*webnovel-mcp/server.mjs" 2>/dev/null); do kill "$p" 2>/dev/null; done
    sleep 2
    "$PREFIX/bin/webnovel-mcp-guard"
    ;;
  stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "守护会话已停" || echo "守护会话本来就不在"
    for p in $(pgrep -f "node .*webnovel-mcp/server.mjs" 2>/dev/null); do kill "$p" 2>/dev/null; done
    sleep 1
    port_up "$PORT" && echo "警告：:$PORT 仍在监听" || echo "端口已释放"
    ;;
  logs)
    tail -f "$LOGFILE"
    ;;
  token)
    token
    ;;
  books)
    ls -1 "$APP/books" 2>/dev/null || echo "(书库为空)"
    ;;
  clean)
    shift
    force=""
    for a in "$@"; do [ "$a" = "--force" ] && force=1; done
    [ $# -gt 0 ] || { echo "用法: webnovel-mcp-ctl clean [--force] <bookId>..."; exit 2; }
    rc=0
    for id in "$@"; do
      [ "$id" = "--force" ] && continue
      case "$id" in ''|*/*|*\\*|.|..|.*) echo "拒绝：bookId 不合法 -> ${id:-(空)}"; rc=1; continue;; esac
      d="$APP/books/$id"
      [ -d "$d" ] || { echo "跳过：书库里没有这本 -> $id"; continue; }
      rp=$(cd "$d" && pwd -P)
      case "$rp" in "$APP/books/"*) ;; *) echo "拒绝：真实路径不在书库内 -> $id"; rc=1; continue;; esac
      ch=$(sed -n 's/.*"currentChapter": *\([0-9][0-9]*\).*/\1/p' "$d/.webnovel/state.json" 2>/dev/null | head -1)
      if [ "${ch:-0}" != "0" ] && [ -z "$force" ]; then
        echo "跳过：$id 已写 $ch 章，确定要删再加 --force"
        continue
      fi
      rm -rf "$rp" && echo "已删除 -> $id（$([ -n "$ch" ] && echo "$ch 章" || echo "无正文")）"
    done
    exit $rc
    ;;
  *)
    echo "用法: webnovel-mcp-ctl {status|restart|stop|logs|token|books|clean}"
    ;;
esac
