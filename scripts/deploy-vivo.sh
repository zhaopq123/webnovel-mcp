#!/usr/bin/env bash
# ============================================================
# deploy-vivo.sh —— 把 webnovel-mcp 部署到 vivo 手机（Termux 层，不进 proot）
#
# 用法（Git Bash）：
#   VIVO_HOST=<手机IP> VIVO_USER=<ssh 用户> bash scripts/deploy-vivo.sh
#   VIVO_HOST=<手机IP> VIVO_USER=<ssh 用户> VIVO_PORT=8022 bash scripts/deploy-vivo.sh
#
# 做的事：
#   1. 打包项目（排除 test/ books/ node_modules/）
#   2. 经 ssh 传到手机 ~/webnovel-mcp 并解包
#   3. 生成 config.env（含新 token，权限 600）
#   4. 安装 webnovel-mcp-guard / webnovel-mcp-ctl 到 $PREFIX/bin
#   5. 跑守护脚本启动服务并做健康检查
#   6. 幂等登记进 ubuntu-autostart（重启后自动拉起）
#   7. 打印 WorkBuddy 侧要用的连接器配置
# ============================================================
set -euo pipefail

# 主机与用户**不给默认值**：写死内网 IP / 个人用户名既泄漏作者环境，又会把
# 「你忘了配目标」伪装成一句看不懂的 ssh 超时。缺了就 exit 2 并点名缺哪个。
VIVO_HOST="${VIVO_HOST:-}"
VIVO_USER="${VIVO_USER:-}"
VIVO_PORT="${VIVO_PORT:-8022}"
VIVO_KEY="${VIVO_KEY:-$HOME/.ssh/id_ed25519}"
PORT="${WEBNOVEL_PORT:-8600}"

if [ -z "$VIVO_HOST" ] || [ -z "$VIVO_USER" ]; then
  echo "缺少部署目标（$([ -z "$VIVO_HOST" ] && echo -n 'VIVO_HOST ')$([ -z "$VIVO_USER" ] && echo -n 'VIVO_USER')）：" >&2
  echo "  VIVO_HOST=<手机IP> VIVO_USER=<ssh 用户> bash scripts/deploy-vivo.sh" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10
     -p "$VIVO_PORT" -i "$VIVO_KEY" "$VIVO_USER@$VIVO_HOST")
say() { printf '\n=== %s ===\n' "$1"; }

say "0/6 连通性与前置检查"
"${SSH[@]}" 'set -e; uname -o; node --version; command -v tmux >/dev/null && echo tmux-ok
if ! command -v tar >/dev/null 2>&1; then echo "缺少 tar，尝试安装…"; pkg install -y tar >/dev/null 2>&1 || true; fi
command -v tar >/dev/null && echo tar-ok
if ! command -v netstat >/dev/null 2>&1; then pkg install -y net-tools >/dev/null 2>&1 || true; fi
command -v netstat >/dev/null && echo netstat-ok
if ! command -v curl >/dev/null 2>&1; then pkg install -y curl >/dev/null 2>&1 || true; fi
command -v curl >/dev/null && echo curl-ok'

say "1/6 打包并传输"
# 注意 1：Windows 的 tar 会把 `C:/...` 当远程主机 → 用相对路径 + --force-local
# 注意 2：包必须放在被归档目录之外，否则 tar 报 "file changed as we read it"
TARBALL="../.webnovel-mcp-deploy.tgz"
rm -f "$TARBALL"
tar --force-local -czf "$TARBALL" --exclude=./test --exclude=./books --exclude=./node_modules --exclude=./.git --exclude=./logs .
echo "包大小：$(wc -c < "$TARBALL") 字节"
# 直接覆盖式解包：保留 books/ 与 config.env（书库数据绝不能被部署动作清掉）
"${SSH[@]}" 'mkdir -p ~/webnovel-mcp && cat > ~/webnovel-mcp.tgz' < "$TARBALL"
rm -f "$TARBALL"
"${SSH[@]}" 'cd ~/webnovel-mcp && tar xzf ~/webnovel-mcp.tgz && rm -f ~/webnovel-mcp.tgz && ls | head -20'

say "2/6 生成/沿用 config.env"
# 令牌只在首次部署时生成；重复部署沿用旧 token，否则会打断已配好的客户端
TOKEN="$("${SSH[@]}" 'grep -m1 "^WEBNOVEL_TOKEN=" ~/webnovel-mcp/config.env 2>/dev/null | cut -d= -f2-')"
if [ -z "$TOKEN" ]; then
  TOKEN="$("${SSH[@]}" 'head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n"')"
  echo "首次部署，生成新 token"
else
  echo "沿用已有 token（不改动客户端配置）"
fi
"${SSH[@]}" "cat > ~/webnovel-mcp/config.env && chmod 600 ~/webnovel-mcp/config.env" <<EOF
WEBNOVEL_ROOT=/data/data/com.termux/files/home/webnovel-mcp/books
WEBNOVEL_PORT=$PORT
WEBNOVEL_BIND=0.0.0.0
WEBNOVEL_TOKEN=$TOKEN
WEBNOVEL_MAX_BODY=33554432
EOF
"${SSH[@]}" 'grep -c . ~/webnovel-mcp/config.env; ls -l ~/webnovel-mcp/config.env'

say "3/6 安装守护与运维脚本"
"${SSH[@]}" 'cat > $PREFIX/bin/webnovel-mcp-guard && chmod 755 $PREFIX/bin/webnovel-mcp-guard' < scripts/vivo-guard.sh
"${SSH[@]}" 'cat > $PREFIX/bin/webnovel-mcp-ctl && chmod 755 $PREFIX/bin/webnovel-mcp-ctl' < scripts/vivo-ctl.sh
"${SSH[@]}" 'ls -l $PREFIX/bin/webnovel-mcp-guard $PREFIX/bin/webnovel-mcp-ctl'

say "4/6 启动/重启服务"
# 守护是幂等的：端口在就不拉起。所以**已在运行时必须显式 restart**，否则新代码解包了
# 却还在跑旧进程，部署看起来成功、实际没生效（1.0.1 那次就这么被骗过一次）。
if "${SSH[@]}" "netstat -tln 2>/dev/null | grep -q ':$PORT '"; then
  echo "$PORT 已在监听 -> restart"
  "${SSH[@]}" '$PREFIX/bin/webnovel-mcp-ctl restart' || true
else
  "${SSH[@]}" '$PREFIX/bin/webnovel-mcp-guard' || true
fi

say "5/6 健康检查 + MCP 握手"
"${SSH[@]}" "curl -s -m 5 http://127.0.0.1:$PORT/health; echo
printf '%s\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"deploy\",\"version\":\"1\"}}}' | curl -s -m 10 -X POST http://127.0.0.1:$PORT/mcp -H 'content-type: application/json' -H 'Authorization: Bearer $TOKEN' -d @- | head -c 400; echo"

say "6/6 登记开机自启（幂等）"
"${SSH[@]}" 'A=$PREFIX/bin/ubuntu-autostart
if grep -q webnovel-mcp-guard "$A" 2>/dev/null; then
  echo "已登记，跳过"
else
  cp "$A" /tmp/ubuntu-autostart.bak 2>/dev/null || true
  cat >> "$A" <<'"'"'EOS'"'"'

# 2h) 长篇网文写作 MCP（:8600）—— WorkBuddy 网文写作助手
#     运行在 Termux 层（原生 node），不进 proot
if [ -x "$PREFIX/bin/webnovel-mcp-guard" ]; then
  $PREFIX/bin/webnovel-mcp-guard
fi
EOS
  echo "已追加登记（备份在 /tmp/ubuntu-autostart.bak）"
fi
grep -n -A3 "webnovel-mcp-guard" "$A" | head -12'

cat <<EOF

================================================================
部署完成

  WorkBuddy 连接器配置（写进 mcp.json 的 mcpServers）：

  "webnovel": {
    "type": "streamableHttp",
    "url": "http://$VIVO_HOST:$PORT/mcp",
    "headers": { "Authorization": "Bearer $TOKEN" },
    "timeout": 240000
  }

  运维：ssh $VIVO_USER@$VIVO_HOST -p $VIVO_PORT
        webnovel-mcp-ctl status|restart|stop|logs|token|books|clean
================================================================
EOF
