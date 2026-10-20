#!/usr/bin/env bash
# case 04 · wm-review：审查门禁（黑名单/句长/英文/繁体/标点/名词笔误）+ 伏笔超期 + 边界
CASE=04-review
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 04-review — 审查门禁"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 审查门 --target-words 200000 --dir "$SBX/pj"
cat > "$SBX/u0.json" <<'J'
{
  "names": [
    {"name": "林昭", "new": true, "type": "person"},
    {"name": "昭儿", "new": true, "type": "person"},
    {"name": "青冥剑", "new": true, "type": "item"}
  ],
  "characters": [{"name": "林昭", "aliases": ["昭儿"], "first_ch": 1}],
  "foreshadow": [{"name": "剑鞘刻字之谜", "planted_ch": 1}],
  "summary": {"chapter": 1, "one_line": "林昭得剑。", "hook_type": "悬念", "changes": ""},
  "words_count": 3000
}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/u0.json"

echo "### 干净稿件 → 通过"
cat > "$SBX/clean.md" <<'M'
# 第二章 夜行

林昭推开祖宅的大门，尘埃在光柱里浮沉。他伸手取下墙上那柄青冥剑。

“昭儿，这剑你要保管好。”他想起母亲临别时的话，心底发沉。

旧宅外传来脚步声，由远及近。他吹熄了灯。
M
ck_run 0 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/clean.md" --chapter 2
out_has "通过"
out_has "下一步"

echo "### 黑名单（AI味/书面腔）拦截"
cat > "$SBX/black.md" <<'M'
# 稿

空气里弥漫着一丝不易察觉的紧张。他毅然决然地转身离去，命运齿轮缓缓转动。
M
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/black.md" --chapter 2
out_has "黑名单"
out_has "弥漫着一丝"
out_has "打回"
# 自定义黑名单追加生效（.wm/review-blacklist.txt）
echo "光柱里浮沉" > "$SBX/pj/.wm/review-blacklist.txt"
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/clean.md" --chapter 2
out_has "光柱里浮沉"
rm "$SBX/pj/.wm/review-blacklist.txt"

echo "### 英文/繁体/标点拦截"
cat > "$SBX/en.md" <<'M'
# 稿

林昭看了看 sky，转身离开。
M
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/en.md" --chapter 2
out_has "英文字母"
cat > "$SBX/trad.md" <<'M'
# 稿

林昭看著那柄劍，心裡想著母親說過的話。
M
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/trad.md" --chapter 2
out_has "繁体"
cat > "$SBX/punc.md" <<'M'
# 稿

他说完了。。。然后一切归于寂静....
M
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/punc.md" --chapter 2
out_has "省略号不规范"
cat > "$SBX/dash.md" <<'M'
# 稿

夜色渐深—他独自前行。
M
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/dash.md" --chapter 2
out_has "破折号"
cat > "$SBX/quote.md" <<'M'
# 稿

“林昭抬头，望向远处的灯火。
M
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/quote.md" --chapter 2
out_has "不配对"

echo "### 句长（黄色提醒，不拦截）"
python3 -c "print('# 稿\n\n'+'林昭走在路上心里想着母亲留下的那句话手里握着剑鞘上的刻字依旧清晰可辨但他始终不敢拆开剑鞘去看个究竟然后再想一想母亲的临别赠言到底隐藏着什么样的深意呢'+'。')" > "$SBX/long.md"
ck_run 0 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/long.md" --chapter 2
out_has "句长"

echo "### 名词笔误：真笔误报红，正常延伸不误报"
cat > "$SBX/typo.md" <<'M'
# 稿

林绍推门而入，手里握着那柄青冥俭。
M
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/typo.md" --chapter 2
out_has "林绍"
out_has "青冥俭"
out_lacks "林昭推"       # 名词+动词不应误报
out_lacks "现昭"         # 跨标点拼接不应误报
out_lacks "昭推"         # 名词尾字+后继字不应误报

echo "### 引号新名词提醒（黄）"
cat > "$SBX/newn.md" <<'M'
# 稿

“玄岳宗”的旗号在山下飘扬。
M
ck_run 0 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/newn.md" --chapter 2
out_has "不在专名表"
out_has "黄"

echo "### 前章钩子承接提醒"
ck_run 0 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/clean.md" --chapter 2
out_has "前章(ch1) hook_type=悬念"

echo "### 边界"
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/none.md"
ck_run 2 bash "$S/wm-review.sh" --dir "$SBX/pj"
out_has "--file"
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/clean.md" --chapter 0

echo "### 伏笔超期（>12 章未露）拦截"
for i in $(seq 2 13); do
  cat > "$SBX/loop.json" <<J
{"summary": {"chapter": $i, "one_line": "第${i}章推进。", "hook_type": "悬念", "changes": ""}, "words_count": 2000}
J
  if ! bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/loop.json" >"$OUT" 2>&1; then
    fail "循环提交 ch$i 失败"; sed 's/^/    | /' "$OUT" >&2
  fi
done
jget "$SBX/pj/.wm/state.json" "o.chapter===13" "循环提交后进度到 ch13"
cat > "$SBX/ch14.md" <<'M'
# 稿

林昭继续赶路，夜色深沉。
M
ck_run 1 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/ch14.md" --chapter 14
out_has "伏笔超期"
out_has "阈值 12 章"
# 提交露出后不再拦截
cat > "$SBX/seen.json" <<'J'
{"foreshadow": [{"id": "F-001", "last_seen_ch": 14}], "summary": {"chapter": 14, "one_line": "露出了。", "hook_type": "悬念", "changes": ""}, "words_count": 2000}
J
ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/seen.json"
ck_run 0 bash "$S/wm-review.sh" --dir "$SBX/pj" --file "$SBX/ch14.md" --chapter 15
out_lacks "伏笔超期"
