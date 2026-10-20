#!/usr/bin/env bash
# case 07 · wm-restore：断点恢复包 + 完整性拦截 + 边界
CASE=07-restore
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 07-restore — 断点恢复"

ck_run 1 bash "$S/wm-restore.sh" --dir "$SBX/none"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 恢复书 --target-words 100000 --dir "$SBX/pj"
cat > "$SBX/u.json" <<'J'
{"names": [{"name": "甲", "new": true, "type": "person"}],
 "characters": [{"name": "甲", "first_ch": 1}],
 "foreshadow": [{"name": "残图", "planted_ch": 1}],
 "summary": {"chapter": 1, "one_line": "开局得图。", "hook_type": "悬念", "changes": ""},
 "words_count": 2400}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u.json"

echo "### 正常恢复包"
ck_run 0 bash "$S/wm-restore.sh" --dir "$SBX/pj"
out_has "断点恢复包"
out_has "账本完整性: 通过"
out_has "《恢复书》"
out_has "已写 1 章"
out_has "专名表: 1 个"
out_has "F-001"
out_has "最近提交"
out_has "续作指引"
out_has "写第 2 章"
out_has "下一步"

echo "### 完整性问题 → 恢复中止"
cp "$SBX/pj/.wm/ledger/suspense.json" "$SBX/suspense.bak"
echo '{broken' > "$SBX/pj/.wm/ledger/suspense.json"
ck_run 1 bash "$S/wm-restore.sh" --dir "$SBX/pj"
out_has "恢复中止"
out_has "JSON 损坏"
out_has "wm-doctor"
cp "$SBX/suspense.bak" "$SBX/pj/.wm/ledger/suspense.json"

# state.json 缺字段
node -e "const f='$SBX/pj/.wm/state.json',o=require(f);delete o.target_words;require('fs').writeFileSync(f,JSON.stringify(o,null,2))"
ck_run 1 bash "$S/wm-restore.sh" --dir "$SBX/pj"
out_has "缺少字段"
node -e "const f='$SBX/pj/.wm/state.json',o=require(f);o.target_words=100000;require('fs').writeFileSync(f,JSON.stringify(o,null,2))"

# 部区间不连续
node -e "const f='$SBX/pj/.wm/parts.json',o=require(f);o.parts[0].start_ch=9;require('fs').writeFileSync(f,JSON.stringify(o,null,2))"
ck_run 1 bash "$S/wm-restore.sh" --dir "$SBX/pj"
out_has "部区间不连续"
node -e "const f='$SBX/pj/.wm/parts.json',o=require(f);o.parts[0].start_ch=1;require('fs').writeFileSync(f,JSON.stringify(o,null,2))"

echo "### 修复后恢复回绿"
ck_run 0 bash "$S/wm-restore.sh" --dir "$SBX/pj"
out_has "通过"
