#!/usr/bin/env bash
# case 14 · wm-memory：五类沉淀 + list 过滤 + search + context 自动注入 + 边界
CASE=14-memory
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 14-memory — 长期写作记忆"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 记忆测试 --target-words 80000 --dir "$SBX/pj" --no-outline-gate

echo "### 五类记忆逐类沉淀"
mk_mem() { printf '{"kind":"%s","title":"%s","content":"%s","tags":%s,"chapter":%s}' "$1" "$2" "$3" "$4" "$5" > "$SBX/m.json"; }
mk_mem style "短句开场" "每章头两段必有一句≤8字短句" '["节奏"]' 3
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
out_has "M-001"
out_has "文风"
mk_mem technique "打脸三段式" "受辱→蓄力→当众反转，间隔不超过两章" '["爽点","结构"]' 5
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
mk_mem setting "灵石汇率" "一块中品灵石=一百下品，全书统一" '[]' 6
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
mk_mem feedback "读者反馈节奏" "评论区反馈第4章后弃书率高，加快打脸节奏" '["商业"]' 7
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
mk_mem character "反派不降智" "谢无咎每次行动前都做最优解推演" '["人物"]' 8
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
jget "$SBX/pj/.wm/memory.json" "o.entries.length===5" "memory.json 5 条"

echo "### list 与过滤"
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --list
out_has "M-005"
out_has "人物把握"
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --list --kind technique
out_has "打脸三段式"
if grep -q "短句开场" "$OUT"; then fail "--kind 过滤失效（出现其他类别）"; else pass "--kind 过滤排除其他类别"; fi
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --list --tag 爽点
out_has "打脸三段式"

echo "### search"
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --search 灵石
out_has "汇率"
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --search 不存在的关键词
out_has "无匹配记忆"

echo "### context 自动注入（novel 赛道）"
cat > "$SBX/o1.md" <<'M'
# 第1章
- 场景：测试
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save chapter --num 1 --file "$SBX/o1.md"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 1
out_has "写作记忆"
out_has "打脸三段式"
out_has "谢无咎"

echo "### 模式隔离（言情模式记忆不注入通用 novel 书）"
mk_mem technique "言情专用" "心动场景必带一次呼吸描写" '[]' 9
printf '{"kind":"technique","title":"言情专用","content":"心动场景必带呼吸描写","track":"romance"}' > "$SBX/m.json"
ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 1
if grep -q "言情专用" "$OUT"; then fail "言情模式记忆泄漏进通用 novel 书"; else pass "模式隔离生效（言情模式记忆不注入通用 novel 书）"; fi

echo "### 注入上限（最近 5 条）"
for i in 1 2 3 4 5 6; do
  printf '{"kind":"technique","title":"第%s批","content":"批量记忆%s"}' "$i" "$i" > "$SBX/m.json"
  ck_run 0 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
done
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 1
out_has "第6批"
if grep -q "短句开场" "$OUT"; then fail "注入超过 5 条上限（最早记忆仍在）"; else pass "注入上限 5 条生效（最早的被挤出）"; fi

echo "### 边界"
printf '{"kind":"money","title":"x","content":"y"}' > "$SBX/m.json"
ck_run 1 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
out_has "kind 无效值"
printf '{"kind":"style","content":"缺标题"}' > "$SBX/m.json"
ck_run 1 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
out_has "title"
printf 'not json' > "$SBX/m.json"
ck_run 1 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/m.json"
out_has "不是合法 JSON"
ck_run 1 bash "$S/wm-memory.sh" --dir "$SBX/pj" --add "$SBX/nope.json"
out_has "不存在"
printf '{"entries":"不是数组"}' > "$SBX/pj/.wm/memory.json"
ck_run 1 bash "$S/wm-memory.sh" --dir "$SBX/pj" --list
out_has "结构错误"
ck_run 2 bash "$S/wm-memory.sh" --dir "$SBX/pj"
out_has "用法"
ck_run 0 bash "$S/wm-memory.sh" --help
out_has "用法"
