#!/usr/bin/env bash
# case 16 · mcp-server：stdio JSON-RPC 握手/13 工具清单/调用闭环/未知工具与方法
CASE=16-mcp
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"
MCP="$S/mcp-server.mjs"
PJ="$SBX/pj"

echo "## 16-mcp — MCP 服务器（stdio JSON-RPC）"

ck_run 0 bash "$S/wm-init.sh" --track novel --title MCP测试 --target-words 80000 --dir "$PJ"

rpc() { printf '%s\n' "$1" | node "$MCP" --root "$SBX" 2>/dev/null; }
LAST=''

echo "### initialize 握手"
R=$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}')
echo "$R" | grep -q '"protocolVersion"' && pass "initialize 返回 protocolVersion" || fail "initialize 无 protocolVersion: $R"
echo "$R" | grep -q '"name":"writing-master"' && pass "serverInfo.name=writing-master" || fail "serverInfo 异常"
echo "$R" | grep -q '"tools"' && pass "capabilities.tools 声明" || fail "capabilities 缺 tools"

echo "### ping"
R=$(rpc '{"jsonrpc":"2.0","id":2,"method":"ping"}')
echo "$R" | grep -q '"id":2' && pass "ping 响应" || fail "ping 无响应"

echo "### tools/list：13 个工具与 CLI 一一对应"
R=$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/list"}')
N=$(echo "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s.trim());console.log(o.result.tools.length)})")
[ "$N" = "13" ] && pass "工具数=13（CLI 13 命令双形态一致）" || fail "工具数=$N 应为 13"
for t in wm_init wm_context wm_commit wm_review wm_status wm_archive wm_restore wm_doctor wm_outline wm_query wm_pacing wm_memory wm_verify; do
  echo "$R" | grep -q "\"$t\"" && pass "工具存在: $t" || fail "工具缺失: $t"
done

echo "### tools/call 调用闭环"
call() { printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | node "$MCP" --root "$SBX" 2>/dev/null; }
R=$(call wm_init '{"track":"novel","genre":"romance","title":"MCP言情","target_words":60000,"dir":"'"$SBX"'/pj2"}')
echo "$R" | grep -q '"isError":false' && pass "wm_init 经 MCP 执行成功" || fail "wm_init 失败: $R"
echo "$R" | grep -q "初始化完成" && pass "wm_init 输出回传" || fail "输出未回传"
jget "$SBX/pj2/.wm/state.json" "o.title==='MCP言情'&&o.track==='novel'&&o.genre==='romance'" "MCP init 落盘正确"

printf '# 第1章\n- 场景：夜市初遇\n' > "$SBX/o1.md"
R=$(call wm_outline '{"dir":"'"$SBX"'/pj2","save":"chapter","num":1,"file":"'"$SBX"'/o1.md"}')
echo "$R" | grep -q "已保存" && pass "wm_outline 经 MCP 存章纲" || fail "outline 失败: $R"

R=$(call wm_context '{"dir":"'"$SBX"'/pj2","task":"write","chapter":1}')
echo "$R" | grep -q '"isError":false' && pass "wm_context 经 MCP 过门禁" || fail "context 失败: $R"
echo "$R" | grep -q "本章章纲" && pass "装配含章纲段" || fail "装配缺章纲段"

printf '{"kind":"technique","title":"MCP记忆","content":"开篇即冲突"}' > "$SBX/m.json"
R=$(call wm_memory '{"dir":"'"$SBX"'/pj2","add":"'"$SBX"'/m.json"}')
echo "$R" | grep -q "M-001" && pass "wm_memory 经 MCP 沉淀" || fail "memory 失败: $R"

R=$(call wm_status '{"dir":"'"$SBX"'/pj2"}')
echo "$R" | grep -q "进度面板" && pass "wm_status 经 MCP 输出面板" || fail "status 失败: $R"

R=$(call wm_query '{"dir":"'"$SBX"'/pj2","what":"names"}')
echo "$R" | grep -q "下一步建议" && pass "wm_query 经 MCP 可用" || fail "query 失败: $R"

echo "### 校验失败经 MCP 传递（BLOCKER → isError）"
R=$(call wm_context '{"dir":"'"$SBX"'/pj2","task":"write","chapter":7}')
echo "$R" | grep -q '"isError":true' && pass "无章纲 BLOCKER 经 MCP 报 isError" || fail "错误未传递: $R"
echo "$R" | grep -q "BLOCKER" && pass "BLOCKER 文案回传" || fail "BLOCKER 文案缺失"

echo "### 未知工具 / 未知方法"
R=$(call wm_teleport '{}')
echo "$R" | grep -q '未知工具' && pass "未知工具报错" || fail "未知工具未报错"
R=$(rpc '{"jsonrpc":"2.0","id":5,"method":"resources/list"}')
echo "$R" | grep -q '\-32601' && pass "未知方法 -32601" || fail "未知方法未按协议报错"

echo "### 协议健壮性：坏 JSON 不崩溃且按协议应答"
R=$(printf 'not-json\n' | node "$MCP" --root "$SBX" 2>/dev/null; echo "exit=$?")
echo "$R" | grep -q 'Parse error' && pass "坏 JSON 返回 Parse error" || fail "坏 JSON 无协议应答: $R"
echo "$R" | grep -q 'exit=0' && pass "坏 JSON 后进程正常退出" || fail "坏 JSON 导致进程异常退出"
