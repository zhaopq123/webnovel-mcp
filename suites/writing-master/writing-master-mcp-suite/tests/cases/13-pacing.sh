#!/usr/bin/env bash
# case 13 · wm-pacing：三线占比/断档/修复建议/赛道换算 + strand 解析 + 边界
CASE=13-pacing
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 13-pacing — 三线节奏体检"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 节奏测试 --target-words 80000 --dir "$SBX/pj" --no-outline-gate

echo "### 无摘要时报错"
ck_run 1 bash "$S/wm-pacing.sh" --dir "$SBX/pj"
out_has "尚无章摘要"

echo "### 铺 8 章：3 quest / 3 fire / 1 constellation / 1 未标记（ch8 用中文别名「主线」测归一化）"
commit_ch() {
  local ch="$1" strand="$2" one="$3"
  cat > "$SBX/c.json" <<J
{"summary":{"chapter":$ch,"one_line":"$one","hook_type":"悬念","strand":"$strand"},"words_count":2000}
J
  ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/c.json"
}
commit_ch 1 quest "祖宅拾剑"
commit_ch 2 quest "山道遇袭"
commit_ch 3 fire "渡口重逢"
commit_ch 4 fire "灯下谈心"
commit_ch 5 constellation "窥见宗门格局"
commit_ch 6 fire "雨夜并肩"
commit_ch 7 "" "多线混合章"
commit_ch 8 主线 "赶往京城的路上"

echo "### 窗口 8 体检（novel 赛道）"
ck_run 0 bash "$S/wm-pacing.sh" --dir "$SBX/pj" --window 8
out_has "三线节奏体检"
out_has "赛道换算: novel"
out_has "网文行业基线"
# quest: ch1,2,8（ch8 由「主线」归一化为 quest）→ 3/8=37%；fire: 3/8=37%；constellation: 1/8=12%；未标记 1/8=13%
out_has "主线剧情  38%"
out_has "感情线  38%"
out_has "世界观  13%"
out_has "未标记  13%"
# 断档：quest ch2→ch8 间隔 6 章 ≥ 阈值 5 → 报警；fire ch6 末次，尾部断档 2 章（阈值内）
out_has "主线剧情 断档 5 章"
out_has "感情线 最长断档"
# 修复建议区：主线断档触发
out_has "修复建议"
out_has "主线断档（最严重）"
out_has "优先补断档最久的线"
# strand 归一化落盘核验
grep -q "strand: quest" "$SBX/pj/.wm/summaries/ch-008.md" && pass "中文别名「主线」归一化为 quest 落盘" || fail "strand 归一化失败"

echo "### 赛道换算（言情模式理想配比 40:40:20）"
ck_run 0 bash "$S/wm-init.sh" --track novel --genre romance --title 言情节奏 --target-words 60000 --dir "$SBX/pj2" --no-outline-gate
commit2() {
  cat > "$SBX/c2.json" <<J
{"summary":{"chapter":$1,"one_line":"$2","hook_type":"心动","strand":"$3"},"words_count":2000}
J
  ck_run 0 bash "$S/wm-commit.sh" --dir "$SBX/pj2" --file "$SBX/c2.json"
}
commit2 1 "初遇心动" fire
commit2 2 "误会渐生" fire
commit2 3 "家宴交锋" quest
commit2 4 "雨夜告白" fire
ck_run 0 bash "$S/wm-pacing.sh" --dir "$SBX/pj2" --window 4
out_has "赛道换算: novel·言情模式"
out_has "言情模式感情线提至 40%"

echo "### strand 非法值被 commit 拒绝"
cat > "$SBX/bad.json" <<'J'
{"summary":{"chapter":9,"one_line":"坏strand","hook_type":"悬念","strand":"情感线"}}
J
ck_run 1 bash "$S/wm-commit.sh" --dir "$SBX/pj" --file "$SBX/bad.json"
out_has "无效值"

echo "### 边界"
ck_run 1 bash "$S/wm-pacing.sh" --dir "$SBX/pj" --window 2
out_has "≥3"
ck_run 1 bash "$S/wm-pacing.sh" --dir "$SBX/none"
ck_run 0 bash "$S/wm-pacing.sh" --help
out_has "用法"
