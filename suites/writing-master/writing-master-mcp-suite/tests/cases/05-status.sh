#!/usr/bin/env bash
# case 05 · wm-status：进度面板 + 台账健康 + 边界
CASE=05-status
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 05-status — 进度面板"

ck_run 1 bash "$S/wm-status.sh" --dir "$SBX/none"
cat > "$SBX/u.json" <<'J'
{"names": [{"name": "甲", "new": true, "type": "person"}], "summary": {"chapter": 1, "one_line": "开局。", "hook_type": "危机"}, "words_count": 3000}
J
ck_run 0 bash "$S/wm-init.sh" --track novel --title 面板书 --target-words 100000 --dir "$SBX/pj"
ck_run 0 bash "$S/wm-status.sh" --dir "$SBX/pj"
out_has "已写 0 章"
out_has "台账健康"
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u.json"
ck_run 0 bash "$S/wm-status.sh" --dir "$SBX/pj"
out_has "已写 1 章"
out_has "3.00%"
out_has "names.tsv"
out_has "summaries"
out_has "下一步"
# 摘要缺失对面板为红
rm "$SBX/pj/.wm/summaries/ch-001.md"
ck_run 0 bash "$S/wm-status.sh" --dir "$SBX/pj"
out_has "缺失"
