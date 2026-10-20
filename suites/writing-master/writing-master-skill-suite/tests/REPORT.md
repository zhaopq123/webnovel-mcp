# WritingMaster 测试报告

- 运行时间: 2026-10-20 15:21:19
- 包根: `/data/data/com.termux/files/home/wmsuites3/writing-master-skill-suite`
- 环境: 1-release aarch64-unknown-linux-android / Node v24.18.0
- 结论: **全绿 ✅**（605/605 通过，通过率 100%，耗时 409s）

## 一、用例统计

| case | 覆盖范围 | 通过 | 失败 |
|---|---|---|---|
| 01-init | init 正常路径+五赛道+非法赛道/模式/参数/重复初始化+章纲门禁开关 | 33 | 0 |
| 02-context | context 四任务装配+章纲门禁BLOCKER+记忆注入+预算压缩+边界 | 35 | 0 |
| 03-commit | commit 名词锁/别名锁/原子性/字段校验/strand标记+边界 | 31 | 0 |
| 04-review | review 黑名单/英文/繁体/标点/句长/笔误/钩子/伏笔超期+边界 | 45 | 0 |
| 05-status | status 进度面板+台账健康+摘要缺失告警 | 14 | 0 |
| 06-archive | archive 活跃区压缩+归档区落盘+重复/空部拒绝 | 37 | 0 |
| 07-restore | restore 恢复包+完整性拦截（坏JSON/缺字段/部断裂） | 24 | 0 |
| 08-doctor | doctor D01–D08 逐项故障注入+修复回绿 | 38 | 0 |
| 09-fullchain | 全链路一条龙 init→outline→context→5章review/commit→status→archive→restore→续写→doctor | 24 | 0 |
| 10-consistency | SKILL↔实现一致性/引用完整性/通用装机/技能互调接力 | 48 | 0 |
| 11-outline | outline 四级大纲存取+章纲门禁启停+非法类型/缺num/缺文件+回溯警告 | 57 | 0 |
| 12-query | query 七类台账+全文检索+归档区感知+--name/--id/--keyword+错误路径 | 55 | 0 |
| 13-pacing | pacing 三线占比/断档/修复建议/赛道换算+strand解析+窗口校验 | 40 | 0 |
| 14-memory | memory 五类沉淀/list过滤/search/context自动注入+track隔离+坏JSON | 52 | 0 |
| 15-verify | verify 四道门禁+sha锁动态生成/篡改检出/新增切片纳入+CLI↔MCP一致性 | 38 | 0 |
| 16-mcp | MCP stdio JSON-RPC 握手/13工具清单/工具调用闭环/未知工具与方法 | 34 | 0 |

## 二、失败明细

无。

## 三、说明

- 断言协议: TAP 风格（ok/not ok），由 tests/run.sh 统计。
- 每条用例在独立沙箱（/data/data/com.termux/files/usr/tmp/wm-sbx.NsjXYi/）运行，互不污染，结束自动清理。
- 重跑: `bash tests/run.sh`（可指定包根: `bash tests/run.sh /path/to/writing-master`）。
