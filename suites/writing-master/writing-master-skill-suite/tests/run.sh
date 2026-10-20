#!/usr/bin/env bash
# tests/run.sh — WritingMaster 测试运行器
# 用法: bash tests/run.sh [包根目录]（缺省为本测试套所在包根）
# 产出: 终端 TAP 结果 + tests/REPORT.md；退出码 0=全绿 1=有失败

set -u
PKG="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PKG
mkdir -p /tmp/wm-sbx

START=$(date +%s)
TAP="$TESTS/.tap.txt"; : > "$TAP"
LOG="$TESTS/.run.log"; : > "$LOG"
declare -A CASE_OK CASE_NO

echo "WritingMaster 测试运行  $(date '+%Y-%m-%d %H:%M:%S')"
echo "包根: $PKG"
echo "=================================================================="

for case_file in "$TESTS"/cases/*.sh; do
  [ -e "$case_file" ] || continue
  name=$(basename "$case_file" .sh)
  echo "── $name ──"
  OUT_C=$(bash "$case_file" 2>>"$LOG")
  echo "$OUT_C"
  { echo "── $name ──"; echo "$OUT_C"; echo ""; } >> "$TAP"
  c_ok=$(grep -c '^ok ' <<<"$OUT_C");  c_ok=${c_ok:-0}
  c_no=$(grep -c '^not ok ' <<<"$OUT_C"); c_no=${c_no:-0}
  CASE_OK[$name]=$c_ok; CASE_NO[$name]=$c_no
  echo "[$name] ok=$c_ok not_ok=$c_no"
done

TOTAL_OK=$(grep -c '^ok ' "$TAP"); TOTAL_OK=${TOTAL_OK:-0}
TOTAL_NO=$(grep -c '^not ok ' "$TAP"); TOTAL_NO=${TOTAL_NO:-0}
TOTAL=$((TOTAL_OK + TOTAL_NO))
DUR=$(($(date +%s) - START))

echo "=================================================================="
echo "总计: $TOTAL 项 | 通过: $TOTAL_OK | 失败: $TOTAL_NO | 耗时 ${DUR}s"

PCT=0; [ "$TOTAL" -gt 0 ] && PCT=$((TOTAL_OK * 100 / TOTAL))
{
  echo "# WritingMaster 测试报告"
  echo ""
  echo "- 运行时间: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "- 包根: \`$PKG\`"
  echo "- 环境: $(bash --version | head -1 | grep -oE '\(.*\)' | tr -d '()') / Node $(node --version)"
  echo "- 结论: **$([ "$TOTAL_NO" = "0" ] && echo 全绿 ✅ || echo 存在失败 ❌)**（$TOTAL_OK/$TOTAL 通过，通过率 ${PCT}%，耗时 ${DUR}s）"
  echo ""
  echo "## 一、用例统计"
  echo ""
  echo "| case | 覆盖范围 | 通过 | 失败 |"
  echo "|---|---|---|---|"
  for case_file in "$TESTS"/cases/*.sh; do
    name=$(basename "$case_file" .sh)
    case "$name" in
      01-init) scope="init 正常路径+四大赛道与言情模式+非法赛道/genre/模式/参数/重复初始化+章纲门禁开关";;
      02-context) scope="context 四任务装配+章纲门禁BLOCKER+记忆注入+预算压缩+边界";;
      03-commit) scope="commit 名词锁/别名锁/原子性/字段校验/strand标记+边界";;
      04-review) scope="review 黑名单/英文/繁体/标点/句长/笔误/钩子/伏笔超期+边界";;
      05-status) scope="status 进度面板+台账健康+摘要缺失告警";;
      06-archive) scope="archive 活跃区压缩+归档区落盘+重复/空部拒绝";;
      07-restore) scope="restore 恢复包+完整性拦截（坏JSON/缺字段/部断裂）";;
      08-doctor) scope="doctor D01–D08 逐项故障注入+修复回绿";;
      09-fullchain) scope="全链路一条龙 init→outline→context→5章review/commit→status→archive→restore→续写→doctor";;
      10-consistency) scope="SKILL↔实现一致性/引用完整性/通用装机/技能互调接力";;
      11-outline) scope="outline 四级大纲存取+章纲门禁启停+非法类型/缺num/缺文件+回溯警告";;
      12-query) scope="query 七类台账+全文检索+归档区感知+--name/--id/--keyword+错误路径";;
      13-pacing) scope="pacing 三线占比/断档/修复建议/赛道换算+strand解析+窗口校验";;
      14-memory) scope="memory 五类沉淀/list过滤/search/context自动注入+模式隔离+坏JSON";;
      15-verify) scope="verify 四道门禁+sha锁动态生成/篡改检出/新增切片纳入+CLI↔MCP一致性";;
      16-mcp) scope="MCP stdio JSON-RPC 握手/13工具清单/工具调用闭环/未知工具与方法";;
      17-romance-mode) scope="言情模式全链路：init 新口径/废弃别名映射/genre 校验/切片与记忆按模式过滤/doctor 旧项目迁移/言情 pacing 配比";;
      *) scope="";;
    esac
    echo "| $name | $scope | ${CASE_OK[$name]:-0} | ${CASE_NO[$name]:-0} |"
  done
  echo ""
  echo "## 二、失败明细"
  echo ""
  if [ "$TOTAL_NO" = "0" ]; then
    echo "无。"
  else
    grep '^not ok ' "$TAP" | sed 's/^not ok [0-9]* - /- /'
  fi
  echo ""
  echo "## 三、说明"
  echo ""
  echo "- 断言协议: TAP 风格（ok/not ok），由 tests/run.sh 统计。"
  echo "- 每条用例在独立沙箱（/tmp/wm-sbx/）运行，互不污染，结束自动清理。"
  echo "- 重跑: \`bash tests/run.sh\`（可指定包根: \`bash tests/run.sh /path/to/writing-master\`）。"
} > "$TESTS/REPORT.md"

rm -rf /tmp/wm-sbx
[ "$TOTAL_NO" = "0" ] && exit 0 || exit 1
