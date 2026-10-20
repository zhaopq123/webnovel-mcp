---
name: wm-jubensha
description: 剧本杀全流程赛道技能（v4.0闭环版）。适用：本格/变格/情感/机制/恐怖全流派，3小时新手本到8小时深度本。触发词：写剧本杀、推理本、情感本、机制本、恐怖本、开本、真相设计、线索卡、DM手册、复盘、投凶、玩家剧本、案件。用户要创作或续写剧本杀作品时使用本技能（由主路由 writing-master 转入，也可直接触发）。
---

# wm-jubensha · 剧本杀赛道 SKILL（v4.0）

## 一、用途

按 v4.0 引擎产出**可直接开本游玩的游戏**——不是小说。全流程时序链（唯一合法顺序）：开场五问 → 参数确认 → 任务计划 → 阶段2真相设计 → 阶段3人物 → 阶段4四件套 → 阶段5静态自检 → 阶段6动态推演 → 阶段7修订。禁止跳序（跳序防护见9.2）。

## 二、前置条件

- 已执行 `bash scripts/wm-init.sh --track jubensha --title <名> --target-words <N> [--dir <目录>]`（target-words=预估全本字量，用于进度统计）。
- 续写项目：先 `bash scripts/wm-restore.sh --dir <目录>`，以"案件档案+任务计划"为唯一事实依据无损续作。
- 切片（正文即 v4.0 原文规则，一字未改）位于 `knowledge/slices/jubensha-*.md`；模板位于 `templates/jubensha-*.md`。
- **会话开始的第一个动作：执行1.1开场五问**（装配 `slices/jubensha-stage1-params.md`），除此之外不得先行产出任何内容。
- 每完成一个模块，对照任务计划勾销一项并更新案件档案（0.2长任务计划协议）。

## 三、阶段流程与切片装配表

### 阶段0 negotiate（总则+任务计划）

装配：`slices/jubensha-negotiate-general.md`（0.1适用范围/0.2长任务计划协议/0.3防幻觉三铁律/0.4合规红线+时序链）。
动作：输出【任务计划】（全部模块：真相文件→人物档案→各玩家剧本→线索卡→DM手册→复盘手册→自检报告→推演报告、产出顺序、分批方案），写入案件档案首行（模板 `templates/jubensha-案件档案.md`）。确认粒度：阶段之间必须用户确认"通过"；阶段之内连续产出逐项勾销，不逐个等待确认。

### 阶段1 stage1（开场五问+参数确认）

装配：`slices/jubensha-stage1-params.md`。
动作：1.1开场五问（流派/时长/难度/人数/特殊配置）→ 参数确认 → 按1.2公式输出结构换算表（幕数/搜证轮/线索总量/案件结构/双案凶手配置）→ 1.3调性样本确认（三段样本+调性指纹3-5项）。基础参数 commit 入台账。

### 阶段2 stage2（真相设计）

装配：`slices/jubensha-stage2-truth.md`（诡计与真相设计系统）。
动作：倒写起点产出【真相文件】（凶手/手法/动机/时间线全表——核心时段逐15分钟/红鲱鱼分配），与调性样本一并交用户确认。真相文件要点 commit（foreshadow 类型=真相/红鲱鱼）。

### 阶段3 stage3（人物系统）

装配：`slices/jubensha-stage3-characters.md`（三维/秘密三层/凶手伪装线/关系网/死者行为线）+（启用条件模块时）`slices/jubensha-stage3-modules.md`（阵营/技能卡/结局分支/惊吓点排布）。
产出：人物档案（含口语档位）、人物状态表基线、伪装线/死者行为线/分幕阅读发放表骨架。

### 阶段4 stage4（四件套交付，缺一不可开本）

装配：`slices/jubensha-stage4-deliverables.md` + `slices/jubensha-write-logic.md`（每模块五条追踪线/八问）+ `slices/jubensha-write-suspense.md`（疑点账户/三步揭晓/节奏三测试）。
按任务计划分批产出（模板：`templates/jubensha-玩家剧本.md`、`templates/jubensha-线索卡.md`、`templates/jubensha-DM手册.md`、`templates/jubensha-复盘手册与结算表.md`）：
1. **玩家剧本**（N份互相保密，每次输出1-2份保证质量；分幕阅读文本为骨架；性格用事件写）
2. **线索卡**（编号/投放幕轮/公开性/指向；剧本内文与线索卡逐字一致）
3. **DM手册**（开场白全文/流程时间轴/搜证规则/发放时机表/引导话术分级/投凶规则含平票全局唯一表述）
4. **复盘手册+结算表**（真相还原/红鲱鱼解释/平票三处对齐）
每模块交付后执行 `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>` 勾销任务计划并更新台账（summary 的 chapter=模块序号）；每完成一批模块跑 `bash scripts/wm-status.sh --dir <目录>` 查看任务计划进度与台账健康。

### 阶段5 stage5（静态自检）

装配：`slices/jubensha-write-logic.md`（八问+归属核对）+ `slices/jubensha-write-text.md`（两遍交付制）。
动作：全本静态扫描——时间线/凶手三查/线索闭环/专名表全扫。机器辅助：`bash scripts/wm-review.sh --dir <目录> --file <模块.md>` 逐模块体检；`bash scripts/wm-doctor.sh --dir <目录>` 全项目体检。

### 阶段6 stage6（动态推演）

装配：`slices/jubensha-protocol-process.md`（试开推演规范）。
动作：模拟多策略玩家推演（凶手最优策略/好人最短推理路径/平票与双案结算复核），输出推演报告。

### 阶段7 stage7（修订）

按推演报告修订；修订后重跑受影响模块的八问与两遍交付制。

### 阶段8 record（案件档案，全程）

装配：`slices/jubensha-record-casefile.md`（第十节案件档案格式）。
模板：`templates/jubensha-案件档案.md`。分区对应台账见下节。

### 阶段9 protocol（流程总控+交互协议，全程常驻）

装配：`slices/jubensha-protocol-process.md`。用户说"通过"进下一阶段；"继续"按任务计划接最近未完成模块；用户可随时打断，打断后按档案接续。每模块文末必附交付声明："已核对案件档案：专名X个零错字；自检八问通过（含归属核对）；两遍交付制已执行；疑点账户余额X；信息表已更新；任务计划勾销第X项"。

## 四、台账语义映射（wm-commit.sh JSON 字段 ↔ 案件档案分区）

| commit 字段 | 案件档案分区 |
|---|---|
| names | 专名表（错字核对唯一基准；玩家剧本/线索卡/手册三处逐字一致） |
| characters | 人物三维+秘密三层+口语档位+人物状态表（位置/伤势/物品/已知-不知道-误以为/伪装进度——归属核对唯一基准）+凶手伪装线 |
| foreshadow | 真相文件要点+红鲱鱼表+线索台账（编号/指向/投放幕轮/被搜到/公开——类型标注：线索/红鲱鱼/真相） |
| timeline | 案件时间线全表（核心时段逐15分钟）+死者行为线 |
| suspense | 疑点账户（问题/抛出环节/预期回收点/玩家已意识到） |
| info_gap | 信息线（每角色信息状态+定向线索信息去向） |
| plotlines | 分幕阅读发放表+条件模块（阵营/技能/结局分支）+双凶本双线 |
| summary{chapter,one_line,hook_type,changes} | 模块勾销记录（chapter=模块序号） |
| words_count | 模块字量 |

## 五、交付自检要求（每模块硬性）

1. **两遍交付制**（第八节7）：第一遍写作→第二遍切换校对者身份逐行重扫——第一扫逻辑与人物（2.6八问+2.4归属+5.5档位核对+分幕文本与线索卡一致性），第二扫文字（黑名单+洁净度+朗读测试：随机抽三句台词念出来，像人说的还是像念稿？像念稿=重写）。
2. `bash scripts/wm-review.sh --dir <目录> --file <模块.md>` 报告问题已处理。
3. 交付声明逐项如实附文末（见阶段9）。
4. 任务计划已勾销、案件档案已更新、已 commit。

## 六、常见故障（卡壳→诊断路径）

- **真相撑不起时长/玩家提前锁凶**：回阶段2诡计可行性检验清单重查（装配 `slices/jubensha-stage2-truth.md`）
- **人物动机不自洽**：回5.x三查（凶手三查：动机/手法/时间线自洽）
- **线索闭环断裂**（关键实证缺失/指向死路）：回线索台账核对投放幕轮与指向链
- **平票/双案规则冲突**：全局唯一表述三处对齐检查（DM手册/结算表/案件档案）
- **跳序风险**：任何模块先于真相文件出现=跳序，回到时序链（0.2）
- **工具故障**：`bash scripts/wm-doctor.sh --dir <目录>` 体检 → 修复后 `bash scripts/wm-restore.sh --dir <目录>` 恢复档案

## 七、与其他技能的自动协作

- 由 `skills/writing-master/SKILL.md` 路由进入；改赛道 → 回读主路由。
- 对白与文字规范可加读 novel 原文切片：`slices/novel-stage6-writing.md`（15.3对话活人化/15.6洁净度原文细则）——预算允许时。
- 新会话续作：任何技能 `bash scripts/wm-restore.sh --dir <目录>` 以"案件档案+任务计划"无损续接。

下一步建议：执行开场五问并输出任务计划。
