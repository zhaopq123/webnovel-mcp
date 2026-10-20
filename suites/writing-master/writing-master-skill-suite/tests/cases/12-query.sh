#!/usr/bin/env bash
# case 12 · wm-query：七类台账查询 + 全文检索 + 归档区感知 + 边界
CASE=12-query
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 12-query — 台账查询"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 查询测试 --target-words 80000 --dir "$SBX/pj" --no-outline-gate

echo "### 铺数据（两章 commit）"
cat > "$SBX/c1.json" <<'J'
{"names":[{"name":"林昭","new":true,"type":"person"},{"name":"昭儿","new":true,"type":"person"},{"name":"苏婉","new":true,"type":"person"},{"name":"青冥剑","new":true,"type":"item"},{"name":"青冥山","new":true,"type":"place"}],
 "characters":[{"name":"林昭","aliases":["昭儿"],"traits":["谨慎"]},{"name":"苏婉","goal":"查明父亲死因"}],
 "foreshadow":[{"name":"剑鞘刻字之谜","hint":"刻字在灯下若隐若现"},{"name":"苏父之死另有隐情"}],
 "timeline":[{"chapter":1,"event":"林昭在青冥山发现青冥剑","where":"青冥山"}],
 "suspense":[{"name":"门外脚步声是谁"},{"name":"苏婉的玉佩来历","layer":2}],
 "info_gap":[{"gap":"林昭不知剑中藏有图谱","holders":"读者知道","until":"第 10 章"}],
 "plotlines":[{"name":"寻亲线"},{"name":"护剑线"}],
 "summary":{"chapter":1,"one_line":"林昭于青冥山发现青冥剑。","hook_type":"悬念","changes":"得剑","strand":"quest"},
 "words_count":2400}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/c1.json"
cat > "$SBX/c2.json" <<'J'
{"timeline":[{"chapter":2,"event":"苏婉在渡口等船"}],
 "summary":{"chapter":2,"one_line":"苏婉与林昭在渡口相遇。","hook_type":"渴望","strand":"fire"},
 "words_count":2200}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/c2.json"

echo "### characters"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what characters
out_has "林昭"
out_has "苏婉"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what characters --name 昭儿
out_has "别名"
out_has "出场章"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what characters --name 苏婉
out_has "目标"
out_has "查明父亲死因"
ck_run 1 bash "$S/wm-query.sh" --dir "$SBX/pj" --what characters --name 无此人
out_has "未找到人物"

echo "### foreshadow / suspense / info-gap / plotlines"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what foreshadow
out_has "F-001"
out_has "剑鞘刻字之谜"
out_has "章前"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what foreshadow --id F-002
out_has "苏父之死"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what suspense
out_has "L2"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what info-gap
out_has "读者知道"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what plotlines
out_has "寻亲线"
ck_run 1 bash "$S/wm-query.sh" --dir "$SBX/pj" --what foreshadow --id F-099
out_has "未找到伏笔"

echo "### timeline / names"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what timeline
out_has "青冥山发现青冥剑"
out_has "渡口"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what names
out_has "青冥剑"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what names --keyword 青
out_has "青冥山"

echo "### fulltext 检索（摘要域）"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what fulltext --keyword 渡口
out_has "摘要 ch2"
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what fulltext --keyword 完全不存在的词
out_has "未找到"

echo "### 归档区感知"
ck_run 0 bash "$S/wm-archive.sh" --dir "$SBX/pj" --part 1
out_has "归档完成"
# 归档后 timeline 查询仍能看到归档事件（跨区合并）
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what timeline
out_has "青冥山发现青冥剑"
# 归档后 fulltext 仍能检索到归档章摘要
ck_run 0 bash "$S/wm-query.sh" --dir "$SBX/pj" --what fulltext --keyword 渡口
out_has "ch2"

echo "### 边界"
ck_run 2 bash "$S/wm-query.sh" --dir "$SBX/pj"
out_has "缺少"
ck_run 1 bash "$S/wm-query.sh" --dir "$SBX/pj" --what money
out_has "无效 --what"
ck_run 1 bash "$S/wm-query.sh" --dir "$SBX/pj" --what fulltext
out_has "需要 --keyword"
ck_run 0 bash "$S/wm-query.sh" --help
out_has "用法"
ck_run 1 bash "$S/wm-query.sh" --dir "$SBX/none" --what characters
out_has "目录不存在"
