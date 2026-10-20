#!/usr/bin/env bash
# case 08 · wm-doctor：D01–D08 对账 + 故障注入逐项验证
CASE=08-doctor
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 08-doctor — 账本体检对账"

ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/none"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 体检书 --target-words 100000 --dir "$SBX/pj"
cat > "$SBX/u.json" <<'J'
{"names": [{"name": "甲", "new": true, "type": "person"}],
 "characters": [{"name": "甲", "first_ch": 1}],
 "foreshadow": [{"name": "残图", "planted_ch": 1}],
 "summary": {"chapter": 1, "one_line": "开局。", "hook_type": "悬念", "changes": ""},
 "words_count": 2400}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u.json"
echo "### 健康项目全绿"
ck_run 0 bash "$S/wm-doctor.sh" --dir "$SBX/pj"
out_has "D01"
out_has "全部通过"
out_has "下一步建议"

bak() { cp "$SBX/pj/.wm/$1" "$SBX/bak-$(echo "$1" | tr / -)"; }
res() { cp "$SBX/bak-$(echo "$1" | tr / -)" "$SBX/pj/.wm/$1"; }

echo "### D01 state 字段缺失"
bak state.json
node -e "const f='$SBX/pj/.wm/state.json',o=require(f);delete o.title;require('fs').writeFileSync(f,JSON.stringify(o))"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj"
out_has "D01"
res state.json

echo "### D02 账本文件缺失"
bak ledger/timeline.json
rm "$SBX/pj/.wm/ledger/timeline.json"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj"
out_has "D02"
res ledger/timeline.json

echo "### D03 JSON 损坏"
bak ledger/foreshadow.json
echo '{oops' > "$SBX/pj/.wm/ledger/foreshadow.json"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj"
out_has "D03"
res ledger/foreshadow.json

echo "### D04 名词表重名 / 人物别名不在表"
printf '甲\tperson\t1\t\n甲\tperson\t1\t\n' >> "$SBX/pj/.wm/ledger/names.tsv"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj"
out_has "重复名词"          # D04 实现文案为「存在重复名词」
ck_run 0 bash "$S/wm-status.sh" --dir "$SBX/pj"   # status 视角也应见红
out_has "红"
# 注入别名（不在表内）后重置为干净单行专名表，测 D04 交叉引用
node -e "const f='$SBX/pj/.wm/ledger/characters.json',o=require(f);o.items[0].aliases=['小甲'];require('fs').writeFileSync(f,JSON.stringify(o,null,2))"
printf '# WritingMaster 专名表（列: name\ttype\tfirst_chapter\tnote）\n甲\tperson\t1\t\n' > "$SBX/pj/.wm/ledger/names.tsv"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj"
out_has "别名"
out_has "小甲"
out_has "不在专名表"
# 重建健康项目继续后续对账项
rm -rf "$SBX/pj2"; ck_run 0 bash "$S/wm-init.sh" --track novel --title 体检二 --target-words 100000 --dir "$SBX/pj2"
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj2" --file "$SBX/u.json"

echo "### D05 悬空伏笔（埋点超进度）"
node -e "const f='$SBX/pj2/.wm/ledger/foreshadow.json',o=require(f);o.items[0].planted_ch=99;require('fs').writeFileSync(f,JSON.stringify(o,null,2))"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj2"
out_has "D05"
out_has "超出当前进度"

echo "### D06 摘要缺失"
rm "$SBX/pj2/.wm/summaries/ch-001.md"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj2"
out_has "D06"
out_has "摘要"

echo "### D07 部区间不连续 / 已归档缺目录"
node -e "const f='$SBX/pj2/.wm/parts.json',o=require(f);o.parts[0].start_ch=5;require('fs').writeFileSync(f,JSON.stringify(o,null,2))"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj2"
out_has "D07"
node -e "const f='$SBX/pj2/.wm/parts.json',o=require(f);o.parts[0].start_ch=1;o.parts[0].archived=true;require('fs').writeFileSync(f,JSON.stringify(o,null,2))"
ck_run 1 bash "$S/wm-doctor.sh" --dir "$SBX/pj2"
out_has "archive/part-1"

echo "### D08 commits.log 清空"
: > "$SBX/pj2/.wm/commits.log"
run 0 bash "$S/wm-doctor.sh" --dir "$SBX/pj2"; out_has "D08"

echo "### 修复路径回绿"
rm -rf "$SBX/pj3"
ck_run 0 bash "$S/wm-init.sh" --track novel --title 体检三 --target-words 100000 --dir "$SBX/pj3"
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj3" --file "$SBX/u.json"
ck_run 0 bash "$S/wm-doctor.sh" --dir "$SBX/pj3"
out_has "全部通过"
