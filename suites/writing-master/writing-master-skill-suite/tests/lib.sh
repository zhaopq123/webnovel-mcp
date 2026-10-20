#!/usr/bin/env bash
# tests/lib.sh — WritingMaster 测试断言助手
# 输出协议（TAP 风格）: "ok N - 描述" / "not ok N - 描述"，由 run.sh 统计。
# 约定: case 脚本须先设置 CASE=<名>，再 source 本文件并调用 setup。

set -u

_T_N=${_T_N:-0}
__tn() { _T_N=$((_T_N + 1)); printf '%s' "$_T_N"; }
pass() { printf 'ok %s - %s\n' "$(__tn)" "$*"; }
fail() { printf 'not ok %s - %s\n' "$(__tn)" "$*"; }

# 执行命令: run <期望退出码> <命令...> → 输出捕获到 $OUT，返回实际比较结果
run() {
  local expect="$1"; shift
  "$@" >"$OUT" 2>&1
  RUN_EXIT=$?
  LAST_CMD="$*"
  [ "$RUN_EXIT" = "$expect" ]
}
ck_run() {  # run + 断言退出码
  local expect="$1"; shift
  if run "$expect" "$@"; then
    pass "exit=$expect ← $LAST_CMD"
  else
    fail "期望 exit=$expect 实得 exit=$RUN_EXIT ← $LAST_CMD"
    sed 's/^/    | /' "$OUT" >&2
  fi
}
out_has()   { if grep -qF -- "$*" "$OUT"; then pass "输出含「$*」"; else fail "输出不含「$*」（${LAST_CMD:-?}）"; fi }
out_lacks() { if grep -qF -- "$*" "$OUT"; then fail "输出不应含「$*」"; else pass "输出不含「$*」"; fi }
file_has()  { local f="$1" s="$2"; if grep -qF -- "$s" "$f" 2>/dev/null; then pass "$f 含「$s」"; else fail "$f 不含「$s」"; fi }
file_lacks(){ local f="$1" s="$2"; if grep -qF -- "$s" "$f" 2>/dev/null; then fail "$f 不应含「$s」"; else pass "$f 不含「$s」"; fi }
file_is()  { if [ -e "$1" ]; then pass "存在: $1"; else fail "不存在: $1"; fi }
file_not() { if [ -e "$1" ]; then fail "不应存在: $1"; else pass "不存在: $1"; fi }

# JSON 断言: jget <file> <js表达式(o为解析对象)> [描述]
jget() {
  local f="$1" expr="$2" desc="${3:-$f 满足 $expr}"
  if node -e "const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.exit(($expr)?0:1)" "$f" 2>/dev/null; then
    pass "$desc"
  else
    fail "$desc"
  fi
}

# 沙箱: setup 后 SBX=独立空目录, OUT=输出捕获文件
setup() {
  SBX=$(mktemp -d "/tmp/wm-sbx/${CASE}-XXXXXX")
  OUT="$SBX/.out"
  : > "$OUT"
}
