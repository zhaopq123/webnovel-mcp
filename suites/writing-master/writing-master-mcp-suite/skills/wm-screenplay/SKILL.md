---
name: wm-screenplay
description: 影视/舞台剧本赛道技能（原创引擎，基于19节通用机制适配）。适用：电视剧/网剧/微短剧/电影/话剧/音乐剧。触发词：写剧本、写剧、分集大纲、分场、场次表、写第N集、台词、logline、季终、剧集、舞台剧、电影剧本。用户要创作或续写剧本时使用本技能（由主路由 writing-master 转入，也可直接触发）。
---

# wm-screenplay · 影视/舞台剧本赛道 SKILL

## 一、用途

完成影视/舞台剧本从立项到剧本正文的全流程：开场确认 → 核心设定（logline/三维人物/体量换算）→ 故事大纲（季/三幕结构）→ 分集大纲（集纲8行）→ 分场大纲（场次表）→ 剧本正文（场次+对白）→ 自检修订。产出物是**可被拍摄/排演的剧本**，不是小说：一切以"可被看见、可被听见"为唯一标准。

## 二、前置条件

- 已执行 `bash scripts/wm-init.sh --track screenplay --title <名> --target-words <N> [--dir <目录>]`（--dir 缺省当前目录；target-words=预计总页数×250或按平台口径，用于进度统计）。
- 续写项目：先 `bash scripts/wm-restore.sh --dir <目录>`。
- 切片（原创知识，复用19节机制）位于 `knowledge/slices/screenplay-*.md`；模板位于 `templates/screenplay-*.md`。
- `bash scripts/wm-context.sh --dir <目录> [--task <plan|write|review|report>] [--chapter N]`（此处 chapter=集号）输出推荐切片清单，读取预算≤3000字/次。

## 三、阶段流程与切片装配表

### 阶段0 negotiate（开场确认）

装配：`slices/screenplay-negotiate-general.md`。
动作：开场确认五问（体裁平台/体量/类型受众/制作边界/审查基调）——逐项确认后进入阶段1；防幻觉三铁律与合规红线全程生效。

### 阶段1 stage1（核心设定与人物）

装配：`slices/screenplay-stage1-setup.md`。
产出：核心设定表（模板 `templates/screenplay-核心设定表.md`）：logline≤35字、主题论断、主角三维+动机三段、关系功能位、反派洋葱层+计划线、俗套声明3条、体量换算（场→序列→集→季）。

### 阶段2 stage2（故事大纲）

装配：`slices/screenplay-stage2-story.md`。
产出：全剧/全季大纲——三幕或季结构、中点大反转（三选一）、低谷三连跌、悬念账户四层（场/集/季/剧级）、支票管理、A/B线咬合、信息差模式分布；大纲自检五项全过。

### 阶段3 stage3（分集大纲）

装配：`slices/screenplay-stage3-episodes.md`。
产出：每集集纲8行+附加两行（模板 `templates/screenplay-分集大纲8行.md`）；删集测试（注水集上限0）；黄金前三集专项核对。

### 阶段4 stage4（分场大纲）

装配：`slices/screenplay-stage4-scenes.md`。
产出：每集场次表+序列检查（模板 `templates/screenplay-分场场次表.md`）；删场测试、人物出场三笔、场景经济性、页数预算核对。

### 阶段5 stage5（剧本正文，每集循环）

1. `bash scripts/wm-context.sh --dir <目录> --task plan --chapter N` → 装配该集集纲+场次表（plan 产物）
2. `bash scripts/wm-context.sh --dir <目录> --task write --chapter N` → 装配 `slices/screenplay-stage5-format.md`（slug line/动作行/台词块/转场/洁净度）+ `slices/screenplay-stage5-dialogue.md`（对白三铁律/语言指纹/口语档位/信息纪律）；预算允许时加读 novel 原文切片 `slices/novel-stage6-writing.md`（15.3对话活人化细则）与 `slices/novel-stage3-characters.md`（6.5语言指纹/6.13口语档位原文）
3. 按场次表写正文（1页≈1分钟；对白页:动作页≈6:4）
4. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 机器体检（专名/时间线/人物状态/道具扣账）
5. 每集八问自检（装配 `slices/screenplay-stage6-review.md`；见第五节）
6. `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>` 提交台账增量（summary 的 chapter=集号，one_line=本集一句话，hook_type=集末钩子类型，changes=状态变化）

### 阶段6 stage6（自检与修订）

每集交付前必跑（见第五节）；季末全量体检前先 `bash scripts/wm-status.sh --dir <目录>` 输出台账现状，再执行：全季钩子链扫描、悬念账户清零核对、人物弧光落位、专名表全扫、A/B线咬合复盘、每集八问报告归档。

### record（台账，全程）

装配：`slices/screenplay-record-ledger.md`（台账语义映射与一致性三不）。
季末：`bash scripts/wm-archive.sh --dir <目录> --part N`（part=季号）归档；此后引用旧季只依据季摘要。

## 四、台账语义映射（wm-commit.sh JSON 字段 ↔ 剧本概念）

| commit 字段 | 剧本概念 |
|---|---|
| names | 专名表：人名/地名/机构/职务/术语（错字核对唯一基准） |
| characters | 人物三维+语言指纹+口语档位+每集状态（位置/信息量/关系） |
| foreshadow | 伏笔/支票/可回环物件（埋设集-暗示集-引爆集） |
| timeline | 故事内时间线+场次时序（日夜连续性） |
| suspense | 悬念账户四层（余额与预期兑付集；警戒线余额≥3） |
| info_gap | 观众/角色信息差三模式逐集状态 |
| plotlines | A/B线咬合点+反派计划线+动机演进段位 |
| summary{chapter,one_line,hook_type,changes} | 每集摘要（chapter=集号） |
| words_count | 本集页数或字数（按 init 口径） |

## 五、交付自检要求（每集硬性，全过才输出）

1. **两遍交付制**：第二遍以剧本医生身份逐场重扫（第一扫逻辑与人物，第二扫台词与格式）。
2. **每集八问**（装配 `slices/screenplay-stage6-review.md` 逐项核对）：场次连续性/场功能在位/钩子链/对白三测（遮名10句+黑名单+朗读3处）/人味落点/格式洁净度（专名逐字对照）/台词分布/页数预算。
3. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 报告问题已全部处理。
4. 已 commit 台账增量；上集钩子的处理方式已在下集开头落实。

## 六、常见故障（卡文了→诊断路径）

按层定位，定位到哪层修哪层，禁止跳层直接改台词（结构病禁用修辞药）：
- **序列层**：本序列目标模糊（3-8场四要素缺）→ 重写序列
- **场层**：本场冲突为空/过渡场超限（上限2）→ 删/合并/重设冲突
- **线层**：B线久未咬合（每集至少一次）/反派线停摆 → 回集纲补咬合点
- **钩子层**：上集钩子悬置超3分钟未回应/连续两集延迟处理 → 调整开场
- **工具故障**：状态对不上 → `bash scripts/wm-doctor.sh --dir <目录>`；修复后 `bash scripts/wm-restore.sh --dir <目录>`

## 七、与其他技能的自动协作

- 由 `skills/writing-master/SKILL.md` 路由进入；用户改写小说/换赛道 → 回读主路由重路由。
- 跨赛道加读（原文细则，预算允许时）：`slices/novel-stage4-hooks.md`（悬念账户/钩子五型原文）、`slices/novel-stage6-writing.md`（对话与可读性原文）、`slices/novel-stage3-characters.md`（人物立体化原文）。
- 新会话续作：任何技能 `bash scripts/wm-restore.sh --dir <目录>` 无损续接。

下一步建议：执行开场确认五问后进入阶段1核心设定表。
