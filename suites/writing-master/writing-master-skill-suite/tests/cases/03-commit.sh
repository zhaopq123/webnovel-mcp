#!/usr/bin/env bash
# case 03 · wm-commit：名词锁/字段校验/原子性 + 边界
CASE=03-commit
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 03-commit — 事实增量提交"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 提交台 --target-words 200000 --dir "$SBX/pj"
WM="$SBX/pj/.wm"

echo "### 正常提交"
cat > "$SBX/u1.json" <<'J'
{
  "names": [
    {"name": "林昭", "new": true, "type": "person"},
    {"name": "昭儿", "new": true, "type": "person"},
    {"name": "青冥剑", "new": true, "type": "item"}
  ],
  "characters": [{"name": "林昭", "aliases": ["昭儿"], "first_ch": 1}],
  "foreshadow": [{"name": "剑鞘刻字之谜", "planted_ch": 1}],
  "timeline": [{"chapter": 1, "event": "林昭发现青冥剑"}],
  "suspense": [{"name": "刻字人是谁"}],
  "info_gap": [{"gap": "林昭不知剑中藏图谱"}],
  "plotlines": [{"name": "寻亲线"}],
  "summary": {"chapter": 1, "one_line": "林昭得剑，引出身世疑云。", "hook_type": "悬念", "changes": "得剑；开寻亲线"},
  "words_count": 3200
}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u1.json"
out_has "提交完成"
file_has "$WM/ledger/names.tsv" "林昭"
jget "$WM/state.json" "o.chapter===1 && o.total_words===3200" "state 推进到 ch1/累计3200"
file_is "$WM/summaries/ch-001.md"
jget "$WM/ledger/foreshadow.json" "o.items[0].last_seen_ch===1" "伏笔自动补 last_seen_ch"
[ "$(wc -l < "$WM/commits.log")" = "1" ] && pass "commits.log 记 1 条" || fail "commits.log 行数异常"

echo "### 名词锁（防幻觉）专项"
# 1) 未声明的既有名词直接使用 → 拒绝
cat > "$SBX/u-lock1.json" <<'J'
{"names": [{"name": "玄岳宗"}], "summary": {"chapter": 2, "one_line": "x"}, "words_count": 10}
J
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u-lock1.json"
out_has "不在专名表中"
out_has "new\":true"
file_lacks "$WM/ledger/names.tsv" "玄岳宗"
jget "$WM/state.json" "o.chapter===1" "拒绝后 state 未推进（原子性）"
# 2) 别名未入表 → 拒绝（别名同受名词锁约束）
cat > "$SBX/u-lock2.json" <<'J'
{"characters": [{"name": "林昭", "aliases": ["小林子"], "first_ch": 2}], "summary": {"chapter": 2, "one_line": "x"}, "words_count": 10}
J
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u-lock2.json"
out_has "别名"
out_has "小林子"
# 3) 重复 new:true 已存在名词 → 优雅去重不重复添加
cat > "$SBX/u-dup.json" <<'J'
{"names": [{"name": "林昭", "new": true, "type": "person"}], "summary": {"chapter": 2, "one_line": "重复名词"}, "words_count": 10}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u-dup.json"
out_has "未重复添加"
[ "$(grep -c '林昭' "$WM/ledger/names.tsv")" = "1" ] && pass "专名表无重复行" || fail "专名表出现重复行"
# 4) 引用不存在 id → 拒绝
cat > "$SBX/u-id.json" <<'J'
{"foreshadow": [{"id": "F-999", "status": "resolved", "resolved_ch": 2}], "summary": {"chapter": 2, "one_line": "x"}, "words_count": 10}
J
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u-id.json"
out_has "不存在"

echo "### 边界与非法输入"
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/nope.json"
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file /dev/null
echo '[1,2]' > "$SBX/arr.json"
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/arr.json"
echo '{"foo": 1}' > "$SBX/unknown.json"
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/unknown.json"
out_has "无法识别的字段"
cat > "$SBX/u-neg.json" <<'J'
{"summary": {"chapter": 2, "one_line": "x"}, "words_count": -100}
J
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u-neg.json"
cat > "$SBX/u-ch0.json" <<'J'
{"summary": {"chapter": 0, "one_line": "x"}, "words_count": 100}
J
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u-ch0.json"
cat > "$SBX/u-badtl.json" <<'J'
{"timeline": "not-array"}
J
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u-badtl.json"
ck_run 2 bash "$S/wm-commit.sh" --dir "$SBX/pj"
out_has "--file"
