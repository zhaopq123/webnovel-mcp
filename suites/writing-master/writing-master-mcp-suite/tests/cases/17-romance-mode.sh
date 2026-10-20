#!/usr/bin/env bash
# case 17 · 言情模式（v2.0：wm-romance 并入 novel 赛道）——init 新口径/废弃别名/genre 校验/
# 切片与记忆的 genre 过滤/doctor 旧项目迁移/赛道口径显示
CASE=17-romance-mode
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 17-romance-mode — 言情模式全链路（novel 赛道子模式）"

echo "### init 新口径与输出口径"
ck_run 0 bash "$S/wm-init.sh" --track novel --genre romance --title 言情新书 --target-words 200000 --dir "$SBX/pj" --no-outline-gate
out_has "赛道=novel·言情模式"
out_has "引擎=言情v8.1"
jget "$SBX/pj/.wm/state.json" "o.track==='novel' && o.genre==='romance'" "言情模式 state 落盘"
ck_run 0 bash "$S/wm-status.sh" --dir "$SBX/pj"
out_has "赛道: novel·言情模式"

echo "### 废弃别名：--track romance 自动映射 novel+genre=romance（exit 0 + 迁移提示）"
ck_run 0 bash "$S/wm-init.sh" --track romance --title 旧口径书 --target-words 100000 --dir "$SBX/legacy" --no-outline-gate
out_has "已废弃"
jget "$SBX/legacy/.wm/state.json" "o.track==='novel' && o.genre==='romance'" "别名映射后 state 正确"
ck_run 0 bash "$S/wm-status.sh" --dir "$SBX/legacy"
out_has "赛道: novel·言情模式"

echo "### genre 边界"
ck_run 1 bash "$S/wm-init.sh" --track novel --genre wuxia --title x --target-words 50000 --dir "$SBX/bad-g"
out_has "无效子模式 --genre"
ck_run 1 bash "$S/wm-init.sh" --track screenplay --genre romance --title x --target-words 50000 --dir "$SBX/bad-t"
out_has "仅支持 novel 赛道"
ck_run 0 bash "$S/wm-init.sh" --track novel --title 默认通用 --target-words 80000 --dir "$SBX/gen" --no-outline-gate
jget "$SBX/gen/.wm/state.json" "o.track==='novel' && o.genre==='general'" "不传 --genre 默认 general（通用模式）"

echo "### context 切片按 genre 过滤：言情书推荐 romance-*，通用书不推荐"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 1
out_has "romance-pov"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/gen" --task write --chapter 1
if grep -q "romance-pov" "$OUT"; then fail "言情切片泄漏进通用 novel 书推荐列表"; else pass "通用 novel 书不推荐言情专用切片"; fi

echo "### 记忆按 genre 注入：言情记忆只进言情书"
printf '{"kind":"technique","title":"糖虐配比","content":"三章一循环，虐不超糖","track":"novel","genre":"romance"}' > "$SBX/m1.json"
printf '{"kind":"technique","title":"打脸三段式","content":"压→扬→反转"}' > "$SBX/m2.json"
printf '{"kind":"technique","title":"旧版言情标记","content":"v1.x 旧条目 track=romance","track":"romance"}' > "$SBX/m3.json"
for f in m1 m2 m3; do ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/$f.json"; done
for f in m1 m2 m3; do ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/gen" --add "$SBX/$f.json"; done
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 1
out_has "糖虐配比"
out_has "旧版言情标记"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/gen" --task write --chapter 1
out_has "打脸三段式"
if grep -q "糖虐配比" "$OUT"; then fail "言情记忆泄漏进通用书"; else pass "genre:romance 记忆不注入通用书"; fi
if grep -q "旧版言情标记" "$OUT"; then fail "旧 romance 条目泄漏进通用书"; else pass "旧 romance 条目不注入通用书（自动归一为言情专属）"; fi

echo "### doctor：v1.x 旧项目（track=romance）自动按言情模式处理并提示迁移"
node -e "
const f = process.argv[1] + '/.wm/state.json';
const o = JSON.parse(require('fs').readFileSync(f, 'utf8'));
o.track = 'romance'; delete o.genre;
require('fs').writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
" "$SBX/legacy"
ck_run 0 bash "$S/wm-doctor.sh" --dir "$SBX/legacy"
out_has "已并入 novel"
out_has "言情模式"
ck_run 0 bash "$S/wm-restore.sh" --dir "$SBX/legacy"
out_has "novel·言情模式"
jget "$SBX/legacy/.wm/state.json" "o.track==='romance'" "doctor/restore 不回写用户文件（迁移交由用户决策）"

echo "### 言情模式 pacing 换算走专用配比"
commit2() {
  cat > "$SBX/c2.json" <<J
{"summary":{"chapter":$1,"one_line":"$2","hook_type":"心动","strand":"$3"},"words_count":2000}
J
  ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/c2.json"
}
commit2 1 "雨夜初遇" fire
commit2 2 "被迫同行" fire
commit2 3 "身份疑云" quest
commit2 4 "灯下试探" fire
ck_run 0 bash "$S/wm-pacing.sh" --dir "$SBX/pj" --window 4
out_has "赛道换算: novel·言情模式 → 言情模式感情线提至 40% 起"
out_has "感情线  75%"
