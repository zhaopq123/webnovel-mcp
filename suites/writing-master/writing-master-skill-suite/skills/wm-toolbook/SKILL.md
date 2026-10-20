---
name: wm-toolbook
description: 工具书/非虚构长文赛道技能（原创引擎，基于19节通用机制适配）。适用：方法书、实操手册、行业指南、教程型长文档、系列专栏。触发词：写工具书、写手册、写教程、写指南、非虚构、写书、大纲、章节、术语表、事实核查、修订书稿。用户要创作或续写工具书/非虚构长文时使用本技能（由主路由 writing-master 转入，也可直接触发）。
---

# wm-toolbook · 工具书/非虚构长文赛道 SKILL

## 一、用途

完成工具书/非虚构长文从选题到书稿的全流程：选题定位（读者画像+承诺一句话）→ 大纲驱动（MECE+依赖排序）→ 逐章写作（六段制章节模板+术语纪律）→ 修订交付（事实核查+全书一致性自检）。产出物是**读者能照着做出来的成品书稿**——不是散文，不是观点集。

## 二、前置条件

- 已执行 `bash scripts/wm-init.sh --track toolbook --title <名> --target-words <N> [--dir <目录>]`（--dir 缺省当前目录）。
- 续写项目：先 `bash scripts/wm-restore.sh --dir <目录>`。
- 切片（原创知识）位于 `knowledge/slices/toolbook-*.md`；模板位于 `templates/toolbook-*.md`。
- `bash scripts/wm-context.sh --dir <目录> [--task <plan|write|review|report>] [--chapter N]`（chapter=章号）输出推荐切片清单，读取预算≤3000字/次。

## 三、阶段流程与切片装配表

### 阶段0 negotiate（开场确认）

装配：`slices/toolbook-negotiate-general.md`。
动作：开场确认五问——①主题与读者（谁/什么水平/卡在哪）②交付形态 ③体量与章数 ④**来源清单**（用户提供的权威来源；无来源的子话题整块标"待确认"）⑤边界声明（不写什么）。防幻觉三铁律（术语锁定/事实不确定必标"待确认"/前文依据查台账）全程生效。

### 阶段1 stage1（选题定位）

装配：`slices/toolbook-stage1-positioning.md`。
产出：选题定位表（模板 `templates/toolbook-选题定位表.md`）——读者画像三问、承诺一句话、差异化三空缺、定位声明、边界声明；删块测试预演。

### 阶段2 stage2（大纲驱动）

装配：`slices/toolbook-stage2-outline.md`。
产出：全书大纲（模板 `templates/toolbook-全书大纲.md`）——每级一句话功能声明、章间依赖图（防倒挂防环）、"你在这里"导航规划、章数换算、附录规划；大纲自检六项。

### 阶段3 stage3（逐章写作，每章循环）

1. `bash scripts/wm-context.sh --dir <目录> --task plan --chapter N` → 装配该章大纲行+依赖章摘要
2. `bash scripts/wm-context.sh --dir <目录> --task write --chapter N` → 装配 `slices/toolbook-stage3-chapter.md`（六段制章节模板）+ `slices/toolbook-stage3-terms.md`（术语纪律+口径）；预算允许时加读 novel 原文切片 `slices/novel-stage6-writing.md`（15.5可读性/15.6格式洁净度原文细则）
3. 写章节草稿（模板 `templates/toolbook-章节模板.md`；单章2500-6000字按大纲口径）
4. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 机器体检（专名/术语/时间基准交叉引用）
5. 每章核查清单六项（见第五节）+ 术语自检（模板 `templates/toolbook-术语表.md`、`templates/toolbook-事实核查清单.md`）
6. `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>`：names=新术语；foreshadow=前向引用（"将在第X章详述"）；suspense=读者问题清单；plotlines=论证线归属；summary{chapter,one_line,hook_type=本章钩子类型,changes=新增数据点/交叉引用}；words_count

### 阶段4 stage4（修订与交付）

装配：`slices/toolbook-stage4-factcheck.md`。
- 每章交付前：两遍交付制+六项核查（事实/引用/案例/交叉引用/结论证据/立场区分）。
- 完稿后全书级自检七项顺序执行（术语全扫→数字全扫→交叉引用全扫→承诺对齐→重复检测→依赖复查→"待确认"清零核销）。
- 分部定稿：定稿前 `bash scripts/wm-status.sh --dir <目录>` 核对进度与台账，然后 `bash scripts/wm-archive.sh --dir <目录> --part N`；此后修改已归档部分=新修订轮，须重跑核查清单。

### record（台账，全程）

装配：`slices/toolbook-record-ledger.md`（台账语义映射+一致性三不）。

## 四、台账语义映射（wm-commit.sh JSON 字段 ↔ 非虚构概念）

| commit 字段 | 工具书概念 |
|---|---|
| names | 术语表（主名/别名/首现章）+口径表（数字/日期/单位） |
| characters | 案例人物/机构档案（同一案例人物跨章细节一致） |
| timeline | 版本与时间基准（数据年份/产品版本/政策时效——全书事实的时间坐标） |
| foreshadow | 前向引用与交叉引用清单（"见第X章"——悬空引用=待办） |
| suspense | 读者问题清单（每章抛出的问题+在哪章解答） |
| info_gap | 前置知识依赖（本章假设读者已知什么/来自哪章） |
| plotlines | 论证线依赖图（论点-论据-案例归属章，防重复展开） |
| summary{chapter,one_line,hook_type,changes} | 每章摘要（功能+要点+数据点） |
| words_count | 本章字数 |

## 五、交付自检要求（每章硬性，全过才输出）

1. **两遍交付制**：第二遍以事实核查编辑身份逐段重扫（第一扫事实与引用，第二扫术语与结构）；禁止标注问题但照常交稿。
2. 六项核查逐条勾销（模板 `templates/toolbook-事实核查清单.md`）：数字一致性/引用可溯（来源不在清单内→标"待确认"交用户裁决）/案例真实性标注/交叉引用核对/结论-证据匹配/立场区分。
3. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 报告问题已处理。
4. 已 commit（新术语/数据点/交叉引用/前向引用）；章末"待确认"逐条归属明确。
5. 立场红线：观点与事实显式区分；医疗/法律/投资类边界声明在位。

## 六、常见故障（卡文了→诊断路径）

按层定位（禁用空话填充蒙混）：
- **素材层**：论据不足/来源缺失 → 标"待确认"继续写骨架，同时列问题清单问用户或补调研；**禁止停下编造，也禁止空话填充**
- **结构层**：依赖倒挂/该章写不出一句话功能 → 回大纲修（调序或合并）
- **颗粒度层**：操作步骤写不细 → 缺一线素材，列具体缺失项问用户，禁"熟悉相关功能"式含混
- **一致性层**：术语漂移/数字口径不一 → 对照术语表与口径表全文扫描修正
- **工具故障**：`bash scripts/wm-doctor.sh --dir <目录>` 体检（重点名词表交叉引用与悬空前向引用）→ 修复后 `bash scripts/wm-restore.sh --dir <目录>`

## 七、与其他技能的自动协作

- 由 `skills/writing-master/SKILL.md` 路由进入；用户改写小说/剧本/剧本杀 → 回读主路由重路由。
- 可读性强化可加读 novel 原文切片：`slices/novel-stage6-writing.md`（15.5可读性/15.6格式原文细则）——预算允许时。
- 新会话续作：任何技能 `bash scripts/wm-restore.sh --dir <目录>` 无损续接。

下一步建议：执行开场确认五问（重点确认来源清单与边界）后进入阶段1选题定位。
