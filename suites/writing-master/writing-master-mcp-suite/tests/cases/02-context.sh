#!/usr/bin/env bash
# case 02 · wm-context：四任务装配 + 预算压缩 + 章纲门禁 + 边界
# v1.2 行为变更: outline_gate 默认启用，task=write 须先存章纲（本用例同步更新，含门禁正向/负向覆盖）
CASE=02-context
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 02-context — 上下文装配"

ck_run 0 bash "$S/wm-init.sh" --track novel --title 上下文 --target-words 200000 --dir "$SBX/pj"
out_has "章纲门禁: 已启用"

echo "### 正常路径（四任务；write 前先存章纲）"
for tsk in plan review report; do
  ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task "$tsk"
  out_has "推荐知识切片"
done

echo "### 章纲门禁（v1.2）"
# 未存章纲 → BLOCKER 拦截
ck_run 1 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write
out_has "BLOCKER"
out_has "下一步建议"
# 存章纲后放行
cat > "$SBX/o1.md" <<'M'
# 第1章
- 场景：祖宅夜
- 事件：发现青冥剑
- 钩子：门外脚步声
M
ck_run 0 bash "$S/wm-outline.sh" --dir "$SBX/pj" --save chapter --num 1 --file "$SBX/o1.md"
out_has "已保存"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write
out_has "推荐知识切片"
out_has "本章章纲"
out_has "祖宅夜"
out_has "写作记忆"
out_has "[state]"
# 关闭门禁后不再拦截
bash "$S/wm-outline.sh" --dir "$SBX/pj" --disable >/dev/null
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 2
out_has "焦点章节"
bash "$S/wm-outline.sh" --dir "$SBX/pj" --enable >/dev/null
ck_run 1 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 3
out_has "BLOCKER"
# 无 task 时给默认（第1章已有章纲）
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj"
out_has "任务: write"
# 状态尾锚点
out_has "[state]"

echo "### 预算压缩"
ck_run 0 bash "$S/wm-context.sh" --dir "$SBX/pj" --task plan --budget 300
if grep -qE "已压缩|超预算" "$OUT"; then pass "低预算触发压缩提示"; else fail "低预算未压缩"; fi

echo "### 边界"
ck_run 1 bash "$S/wm-context.sh" --dir "$SBX/none"
out_has "目录不存在"
ck_run 1 bash "$S/wm-context.sh" --dir "$SBX/pj" --task sleep
out_has "无效 --task"
ck_run 1 bash "$S/wm-context.sh" --dir "$SBX/pj" --task write --chapter 0
ck_run 0 bash "$S/wm-context.sh" --help
out_has "用法"
