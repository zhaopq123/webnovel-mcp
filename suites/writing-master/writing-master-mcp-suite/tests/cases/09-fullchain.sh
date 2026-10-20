#!/usr/bin/env bash
# case 09 · 全链路一条龙：init→context→多章(review+commit)→status→archive→restore→doctor
CASE=09-fullchain
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 09-fullchain — 全链路模拟（模拟真实创作闭环）"

PJ="$SBX/novel-project"
echo "### 1) init（含 mode）"
ck_run 0 bash "$S/wm-init.sh" --track novel --title 《长夜余晖》 --target-words 120000 --mode auto --dir "$PJ"

echo "### 2) context plan"
ck_run 0 bash "$S/wm-context.sh" --dir "$PJ" --task plan
out_has "推荐知识切片"

echo "### 3) 第 1 章：context write → 写稿 → review → commit"
cat > "$SBX/o1.md" <<'M'
# 第1章
- 场景：祖宅夜
- 事件：发现青冥剑，剑鞘刻字引出身世疑云
- 钩子：门外脚步声
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$PJ" --save chapter --num 1 --file "$SBX/o1.md"
ck_run 0 bash "$S/wm-context.sh" --dir "$PJ" --task write --chapter 1
cat > "$SBX/ch1.md" <<'M'
# 第一章 旧宅拾剑

林昭推开祖宅的大门，尘埃在光柱里浮沉。他伸手取下墙上那柄青冥剑。

“昭儿，这剑你要保管好。”他想起母亲临别时的话，心底发沉。

剑鞘上的刻字在昏暗中依稀可辨。旧宅外传来脚步声，由远及近，他吹熄了灯。
M
ck_run 0 bash "$S/wm-review.sh" --dir "$PJ" --file "$SBX/ch1.md" --chapter 1
cat > "$SBX/c1.json" <<'J'
{
  "names": [
    {"name": "林昭", "new": true, "type": "person"}, {"name": "昭儿", "new": true, "type": "person"},
    {"name": "青冥剑", "new": true, "type": "item"}, {"name": "祖宅", "new": true, "type": "place"}
  ],
  "characters": [{"name": "林昭", "aliases": ["昭儿"], "first_ch": 1, "traits": ["谨慎", "念旧"]}],
  "foreshadow": [
    {"name": "剑鞘刻字之谜", "planted_ch": 1},
    {"name": "母亲临别赠言", "planted_ch": 1}
  ],
  "timeline": [{"chapter": 1, "event": "林昭在祖宅发现青冥剑"}],
  "suspense": [{"name": "门外脚步声是谁"}],
  "info_gap": [{"gap": "林昭不知剑中藏有图谱"}],
  "plotlines": [{"name": "寻亲线"}, {"name": "护剑线"}],
  "summary": {"chapter": 1, "one_line": "林昭于祖宅发现青冥剑，剑鞘刻字引出身世疑云。", "hook_type": "悬念", "changes": "得青冥剑；开寻亲线"},
  "words_count": 3200
}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$PJ" --file "$SBX/c1.json"

echo "### 4) 第 2–5 章：逐章 review+commit（含伏笔推进/回收）"
declare -a CHBODY=(
""
"林昭握着青冥剑继续赶路。夜色渐深，山道上的灯火若隐若现。他没有回头，只把剑鞘上的刻字又摸了一遍。"
"翌日清晨，山雾未散。林昭在驿亭歇脚，听两个货郎闲谈北边的战事。他摸出干粮，就着冷水吞下，心里盘算着路程。"
"入夜后，他宿在破庙。神像缺了半边脸，香案上积灰三寸。林昭闭目养神，忽然听见远处有马蹄声碾过碎石路。"
"翌日翻过山脊，官道渐宽。路边茶棚的老者看了眼他的剑，欲言又止。林昭付了茶钱，加快了脚步。"
"傍晚他抵达青阳镇。镇口告示栏前围着一群人，通缉画像上眉眼依稀与他自己有七分像。他压低了斗笠。"
)
for i in 2 3 4 5; do
  cat > "$SBX/ch$i.md" <<M
# 第${i}章 推进

${CHBODY[$i]}
M
  ck_run 0 bash "$S/wm-review.sh" --dir "$PJ" --file "$SBX/ch$i.md" --chapter $i
  cat > "$SBX/c$i.json" <<J
{"timeline": [{"chapter": $i, "event": "第${i}章赶路"}],
 "foreshadow": [{"id": "F-001", "last_seen_ch": $i}],
 "summary": {"chapter": $i, "one_line": "第${i}章：赶路推进，刻字之谜未解。", "hook_type": "悬念", "changes": ""},
 "words_count": 2600}
J
  ck_run 0 bash "$S/wm-commit.sh" --dir "$PJ" --file "$SBX/c$i.json"
done
# 第 5 章回收第二个伏笔、闭合信息差、完结护剑线
cat > "$SBX/c5b.json" <<'J'
{"foreshadow": [{"id": "F-002", "status": "resolved", "resolved_ch": 5}],
 "info_gap": [{"id": "G-001", "status": "closed", "closed_ch": 5}],
 "plotlines": [{"id": "P-002", "status": "ended", "end_ch": 5}]}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$PJ" --file "$SBX/c5b.json"

echo "### 5) status（中期）"
ck_run 0 bash "$S/wm-status.sh" --dir "$PJ"
out_has "已写 5 章"
out_has "字数: 13,600"
out_has "summaries/ 摘要"
out_has "章摘要 5 份"

echo "### 6) context report（连载报告装配）"
ck_run 0 bash "$S/wm-context.sh" --dir "$PJ" --task report

echo "### 7) archive 第 1 部"
ck_run 0 bash "$S/wm-archive.sh" --dir "$PJ" --part 1
out_has "归档完成"
jget "$PJ/.wm/state.json" "o.part===2"
[ "$(ls "$PJ/.wm/archive/part-1/summaries" | wc -l)" = "5" ] && pass "5 份章摘要全部迁移" || fail "章摘要迁移数量不对"
jget "$PJ/.wm/ledger/timeline.json" "o.events.length===0" "活跃区时间线已清空"
jget "$PJ/.wm/ledger/foreshadow.json" "o.items.length===1 && o.items[0].status==='open'" "未回收伏笔带入第 2 部"

echo "### 8) 新会话 restore（断点恢复）"
ck_run 0 bash "$S/wm-restore.sh" --dir "$PJ"
out_has "第 2 部"
out_has "写第 6 章"
out_has "F-001"    # 恢复包中可见带入的未回收伏笔

echo "### 9) 第 2 部续写第 6 章（恢复后接续能力）"
cat > "$SBX/ch6.md" <<'M'
# 第六章 新程

林昭到了山下的镇子，把剑重新裹进包袱。他没有停留，径直往渡口去了。
M
ck_run 0 bash "$S/wm-review.sh" --dir "$PJ" --file "$SBX/ch6.md" --chapter 6
out_has "前章(ch5)"
cat > "$SBX/c6.json" <<'J'
{"names": [{"name": "渡口", "new": true, "type": "place"}],
 "timeline": [{"chapter": 6, "event": "抵达镇子前往渡口"}],
 "summary": {"chapter": 6, "one_line": "林昭抵达镇子，前往渡口。", "hook_type": "危机", "changes": ""},
 "words_count": 2500}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$PJ" --file "$SBX/c6.json"

echo "### 10) doctor 终检"
ck_run 0 bash "$S/wm-doctor.sh" --dir "$PJ"
out_has "全部通过"

echo "### 11) 各命令输出均含「下一步」（互调接力工程基础）"
for c in status restore doctor; do
  bash "$S/wm-$c.sh" --dir "$PJ" > "$OUT" 2>&1
  if grep -q "下一步" "$OUT"; then pass "wm-$c 输出含下一步建议"; else fail "wm-$c 输出缺下一步建议"; fi
done
