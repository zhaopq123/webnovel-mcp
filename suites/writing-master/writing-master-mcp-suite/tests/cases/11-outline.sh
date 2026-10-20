#!/usr/bin/env bash
# case 11 · wm-outline：四级大纲存取 + 章纲门禁启停 + 边界
CASE=11-outline
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 11-outline — 大纲管理与章纲门禁"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 大纲测试 --target-words 80000 --dir "$SBX/pj"
out_has "章纲门禁: 已启用"

echo "### 四级大纲存取"
for kind in master part volume; do :; done
cat > "$SBX/master.md" <<'M'
# 总纲
一句话：少年持剑寻亲，揭开身世。
三幕：起（祖宅拾剑）承（江湖寻访）转（身世反转）合（真相大白）。
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save master --file "$SBX/master.md"
out_has "已保存"
file_is "$SBX/pj/.wm/outlines/master.md"

cat > "$SBX/part1.md" <<'M'
# 第 1 部
主悬念：剑鞘刻字之谜。末章目标：抵达青阳镇。
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save part --num 1 --file "$SBX/part1.md"
file_is "$SBX/pj/.wm/outlines/part-1.md"

cat > "$SBX/vol1.md" <<'M'
# 第 1 卷
卷级目标：走出青冥山。卷末钩：通缉令。
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save volume --num 1 --file "$SBX/vol1.md"
file_is "$SBX/pj/.wm/outlines/volume-1.md"

cat > "$SBX/ch1.md" <<'M'
# 第1章
- 场景：祖宅夜
- 事件：发现青冥剑
- 钩子：门外脚步声
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save chapter --num 1 --file "$SBX/ch1.md"
out_has "已解锁"
file_is "$SBX/pj/.wm/outlines/ch-001.md"

echo "### show 与 list"
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --show master
out_has "少年持剑寻亲"
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --show part --num 1
out_has "主悬念"
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --show volume --num 1
out_has "卷末钩"
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --show chapter --num 1
out_has "祖宅夜"
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --list
out_has "master.md"
out_has "共 4 份大纲"

echo "### 章纲门禁与 context 联动"
# 未存 ch2 章纲 → context write 被 BLOCKER
ck_run 1 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 2
out_has "BLOCKER"
# 存章纲后放行
cat > "$SBX/ch2.md" <<'M'
# 第2章
- 场景：山道
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save chapter --num 2 --file "$SBX/ch2.md"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 2
out_has "本章章纲"
out_has "山道"

echo "### 门禁启停开关"
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --disable
jget "$SBX/pj/.wm/state.json" "o.outline_gate===false" "state.json outline_gate=false"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 9
out_has "outline_gate 未启用"
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --enable
jget "$SBX/pj/.wm/state.json" "o.outline_gate===true" "state.json outline_gate=true"
ck_run 1 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 9

echo "### init --no-outline-gate"
ck_run 0 bash "$S/wm-init.sh" --track novel --title 免门禁 --target-words 50000 --dir "$SBX/pj2" --no-outline-gate
out_has "未启用"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj2" --task write --chapter 1
out_has "推荐知识切片"

echo "### 边界"
ck_run 1 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save story --file "$SBX/master.md"
out_has "无效大纲类型"
ck_run 1 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save chapter --file "$SBX/ch1.md"
out_has "num 必须为正整数"
ck_run 1 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save chapter --num 3 --file "$SBX/nope.md"
out_has "不存在"
ck_run 1 bash "$S/wm-outline.sh" --dir "$SBX/pj" --show chapter --num 404
out_has "章纲缺失"
: > "$SBX/empty.md"
ck_run 1 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save chapter --num 3 --file "$SBX/empty.md"
out_has "为空"
ck_run 2 bash "$S/wm-outline.sh" --dir "$SBX/pj"
out_has "用法"
ck_run 0 bash "$S/wm-outline.sh" --help
out_has "用法"

echo "### 已提交章补录警告"
cat > "$SBX/c1.json" <<'J'
{"names":[{"name":"林昭","new":true,"type":"person"}],"summary":{"chapter":1,"one_line":"拾剑","hook_type":"悬念"},"words_count":100}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/c1.json"
cat > "$SBX/ch1b.md" <<'M'
# 第1章（补录）
- 备注：回溯参考
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save chapter --num 1 --file "$SBX/ch1b.md"
out_has "回溯参考"
