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
# 沙箱根怎么定（三条都别改回去，改错了要么误删用户目录，要么静默少测）：
#  1) 上层（run.sh）已定好并 export WM_SBX_ROOT → 直接用它；
#  2) 调用方给了 WM_SBX_BASE → 用它下面的 wm-sbx（**基目录本身永不被删**，只删 wm-sbx 子目录）；
#  3) 都没有 → 在可写临时目录下 mktemp -d wm-sbx.XXXXXX（随机名 + 0700，避免被提前占坑）。
# 为什么不能写死 /tmp：Termux（Android）根分区只读、没有 /tmp，mktemp 直接失败，
# 之后每条用例连锁报错，看起来像「套件坏了」而不是「环境不对」。
wm_pkg_dir() { ( cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd ); }

wm_sbx_root() {
  local base
  if [ -n "${WM_SBX_BASE:-}" ]; then
    base="$WM_SBX_BASE/wm-sbx"
    mkdir -p "$base" 2>/dev/null && chmod 700 "$base" 2>/dev/null
    printf '%s' "$base"; return $?
  fi
  base="${TMPDIR:-/tmp}"
  { mkdir -p "$base" && [ -w "$base" ]; } 2>/dev/null || base="$(wm_pkg_dir)/.tmp"
  mktemp -d "$base/wm-sbx.XXXXXX"
}

setup() {
  local root="${WM_SBX_ROOT:-}"
  [ -n "$root" ] || root="$(wm_sbx_root)"
  # mkdir -p 对「已存在但不可写」会返回 0，所以真正的判据是 mktemp 能不能成
  if [ -z "$root" ] || ! mkdir -p "$root" 2>/dev/null; then
    fail "沙箱根不可用: ${root:-<空>}"; exit 2
  fi
  if ! SBX=$(mktemp -d "$root/${CASE}-XXXXXX"); then
    fail "用例沙箱创建失败: $root"; exit 2
  fi
  case "$SBX" in
    "$root"/*) ;;
    *) fail "沙箱路径异常: $SBX"; exit 2 ;;
  esac
  OUT="$SBX/.out"
  : > "$OUT" || { fail "无法写输出文件: $OUT"; exit 2; }
}
