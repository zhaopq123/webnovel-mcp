#!/usr/bin/env bash
# case 06 · wm-archive：部归档/活跃区压缩 + 边界
CASE=06-archive
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 06-archive — 部归档与活跃区压缩"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 归档书 --target-words 200000 --dir "$SBX/pj"
WM="$SBX/pj/.wm"

# 造 3 章数据 + 两类伏笔（开/收）+ 时间线 + 出场/离场人物 + 情节线完结
cat > "$SBX/u1.json" <<'J'
{
  "names": [
    {"name": "甲", "new": true, "type": "person"}, {"name": "乙", "new": true, "type": "person"},
    {"name": "丙", "new": true, "type": "person"}, {"name": "秘窟", "new": true, "type": "place"}
  ],
  "characters": [{"name": "甲", "first_ch": 1}, {"name": "乙", "first_ch": 1}, {"name": "丙", "first_ch": 1}],
  "foreshadow": [{"name": "古图残片", "planted_ch": 1}, {"name": "守门人身份", "planted_ch": 1}],
  "timeline": [{"chapter": 1, "event": "三人进入秘窟"}],
  "suspense": [{"name": "窟中黑影"}],
  "info_gap": [{"gap": "甲不知乙是卧底"}],
  "plotlines": [{"name": "夺图线"}, {"name": "旧怨线"}],
  "summary": {"chapter": 1, "one_line": "三人入窟。", "hook_type": "悬念", "changes": ""},
  "words_count": 3000
}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u1.json"
for i in 2 3; do
  cat > "$SBX/u$i.json" <<J
{"timeline": [{"chapter": $i, "event": "第${i}日推进"}], "summary": {"chapter": $i, "one_line": "第${i}章。", "hook_type": "悬念", "changes": ""}, "words_count": 2000}
J
  ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u$i.json"
done
cat > "$SBX/u3b.json" <<'J'
{"foreshadow": [{"id": "F-002", "status": "resolved", "resolved_ch": 3}],
 "characters": [{"name": "丙", "status": "offline", "last_ch": 3}],
 "plotlines": [{"id": "P-002", "status": "ended", "end_ch": 3}]}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u3b.json"

echo "### 边界（先测拒绝路径，再真归档）"
ck_run 2 bash "$S/wm-archive.sh" --dir "$SBX/pj"
out_has "--part"
ck_run 1 bash "$S/wm-archive.sh" --dir "$SBX/pj" --part abc
ck_run 1 bash "$S/wm-archive.sh" --dir "$SBX/pj" --part 0
ck_run 1 bash "$S/wm-archive.sh" --dir "$SBX/pj" --part 9
out_has "第 9 部不存在"

echo "### 正常归档与活跃区压缩断言"
ck_run 0 bash "$S/wm-archive.sh" --dir "$SBX/pj" --part 1
out_has "归档完成"
file_is "$WM/archive/part-1/summaries/ch-001.md"     # 章摘要迁移
file_is "$WM/archive/part-1/summaries/ch-003.md"
file_not "$WM/summaries/ch-001.md"                  # 活跃区已清空
jget "$WM/ledger/timeline.json" "o.events.length===0" "时间线压缩：部内事件迁出活跃区"
jget "$WM/archive/part-1/timeline.json" "o.events.length===3" "时间线 3 条全部迁入归档区"
jget "$WM/archive/part-1/foreshadow.json" "o.items.length===1 && o.items[0].id==='F-002'" "已回收伏笔迁入归档区"
jget "$WM/archive/part-1/characters.json" "o.items.length===1 && o.items[0].name==='丙'" "离场人物迁入归档区"
jget "$WM/archive/part-1/plotlines.json" "o.items.length===1 && o.items[0].name==='旧怨线'" "已完结情节线迁入归档区"
jget "$WM/ledger/foreshadow.json" "o.items.length===1 && o.items[0].id==='F-001'" "已回收伏笔移出活跃区，未回收保留"
jget "$WM/ledger/characters.json" "o.items.filter(c=>c.status==='active'||c.status===undefined).length===2" "离场人物移出活跃区"
jget "$WM/ledger/plotlines.json" "o.items.length===1" "已完结情节线移出活跃区"
jget "$WM/state.json" "o.part===2 && o.chapter===3" "state 推进至第 2 部"
jget "$WM/parts.json" "o.parts.length===2 && o.parts[0].archived===true && o.parts[0].end_ch===3 && o.parts[1].start_ch===4" "parts.json 部区间接续"
file_is "$WM/summaries/part-1.md"                    # 部摘要模板
out_has "未回收伏笔"
out_has "F-001"

echo "### 重复归档被拒"
ck_run 1 bash "$S/wm-archive.sh" --dir "$SBX/pj" --part 1
out_has "已归档"
ck_run 1 bash "$S/wm-archive.sh" --dir "$SBX/pj" --part 2
out_has "尚无章节"    # 第 2 部还没写，无可归档

echo "### 归档后 status/doctor 正常"
ck_run 0 bash "$S/wm-status.sh" --dir "$SBX/pj"
out_has "第 2 部"
ck_run 0 bash "$S/wm-doctor.sh" --dir "$SBX/pj"
out_has "全部通过"
