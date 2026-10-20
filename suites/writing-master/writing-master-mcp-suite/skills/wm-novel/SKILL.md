---
name: wm-novel
description: 长篇小说全流程赛道技能（19节通用引擎驱动）。适用：网文全题材×全套路——玄幻/仙侠/都市/悬疑/科幻/历史/游戏/武侠/现实/奇幻等一切流派，及规则怪谈/无限流/灵气复苏/末日废土/赛博朋克/克苏鲁/种田基建/知乎短篇等新兴赛道，30万字-1000万字（知乎短篇可小体量走短部换算）。触发词：写小说、开新书、玄幻、仙侠、都市、悬疑、系统流、重生、穿越、退婚、赘婿、无限流、快穿、废柴、战神、规则怪谈、灵气复苏、末世、赛博朋克、克苏鲁、种田、知乎短篇、设定、世界观、人物档案、路线图、章纲、写第N章、连载报告、卡文了、完本、规划下一部。用户要创作或续写长篇小说时使用本技能（由主路由 writing-master 转入，也可直接触发）。
---

# wm-novel · 长篇小说赛道 SKILL（19节引擎驱动）

## 一、用途

按19节通用引擎完成长篇小说从设定到正文的全流程：题材×套路选型 → 体量自适应结构换算 → 核心设定 → 世界观 → 人物 → 路线图 → 章纲 → 正文循环 → 完本修订。题材覆盖网文全景（男频10/女频6/跨频4/新兴9，见 `slices/webnovel-genre-panorama.md`）×10大套路（见 `slices/webnovel-trope-quickref.md`）；女频言情主线由 romance 赛道承接，感情非唯一主线的女频题材在本赛道启用感情线模块。产出物：结构换算表、核心设定表、人物档案、路线图+部大纲、每批章纲、正文（每章3000-4000字）、连载状态报告、部总结包。

## 二、前置条件

- 已执行 `bash scripts/wm-init.sh --track novel --title <名> --target-words <N> [--dir <目录>]`（包根执行；--dir 缺省为当前目录）。
- 续写项目：先 `bash scripts/wm-restore.sh --dir <目录>`，以恢复包为唯一事实依据。
- 知识切片位于 `knowledge/slices/`（正文即原文规则，一字未改）；模板位于 `templates/`。
- `bash scripts/wm-context.sh --dir <目录> [--task <plan|write|review|report>] [--chapter N]` 输出推荐切片清单（id/路径/字数），读取预算≤3000字/次。

## 三、阶段流程与切片装配表

> 纪律：进入任一阶段前先装配该阶段切片（用 wm-context.sh 或按下表直读）；原文规则为硬性约束，违反任一条即返工。

### 阶段0 negotiate（开场确认：先选型，再四问）

| 装配切片 | 用途 |
|---|---|
| `slices/novel-negotiate-general.md` | 防幻觉三铁律、合规红线、适用范围 |
| `slices/novel-negotiate-volume.md` | 体量自适应引擎（2.1开场必问、2.2-2.6换算与归档协议） |
| `slices/novel-negotiate-process.md` | 七阶段总控、五级闭环、部循环机制 |
| `slices/webnovel-genre-panorama.md` | 网文题材全景：题材/套路概念区分+男频10/女频6/跨频4清单（全赛道共用切片，无track字段） |
| `slices/webnovel-genre-emerging.md` | 新兴/高热度细分赛道9条清单（全赛道共用切片） |
| `slices/webnovel-trope-quickref.md` | 10大套路速查：讲故事的方式，非题材（全赛道共用切片） |
| `slices/novel-trope-engine-map.md` | 套路×引擎挂接映射：系统流↔金手指规则、重生/穿越↔信息差、退婚/赘婿/废柴/战神↔俗套声明制、快穿/无限流↔部循环跨部结构等 |

动作（按序）：
1. **题材×套路选型（10.0四问之前的固定步骤）**：装配上表后四张切片 → 与用户确认频段/题材/子类、主套路（唯一）与辅套路 → 按选定题材加读对应增量切片（速查见下）→ 输出【题材套路选型表】（模板 `templates/novel-题材套路选型表.md`：含层级体系预设、金手指初案、俗套预声明、引擎挂接勾选、女频言情主线分流确认）。**选型结论未与用户确认，禁止进入四问。**
2. 按10.0依序四问（体量→视角→感情线→文风样本）→ 输出【全书结构换算表】+【核心设定表】（模板 `templates/novel-核心设定表.md`）。

题材增量切片速查（按选型加读，novel 赛道原创增量）：
- `slices/novel-genre-male-power.md`：玄幻/仙侠/奇幻/武侠（超凡力量类）
- `slices/novel-genre-male-reality.md`：都市/历史/现实（现实基底类）
- `slices/novel-genre-male-type.md`：科幻/悬疑/游戏（类型强设定类）
- `slices/novel-genre-emerging-loop.md`：规则怪谈/无限流·诸天/快穿（副本规则类）
- `slices/novel-genre-emerging-shift.md`：灵气复苏/末日废土/赛博朋克/克苏鲁（世界变异类）
- `slices/novel-genre-emerging-build.md`：种田基建/知乎短篇（经营与短形态类）

### 阶段1 stage1（核心设定）

装配：`slices/novel-stage1-setup.md` + `slices/novel-stage1-pov.md` +（启用感情线时）`slices/novel-stage1-romance-line.md`；阶段1声明后常驻。
题材挂钩（已选型时）：金手指四字段按 `slices/novel-trope-engine-map.md` 勾选项从严执行；俗套声明制自查清单与题材增量切片的俗套声明参考合并核对（变体三方向：反用/深化/转移）。
产出：核心设定表（俗套声明制必跑、打回条件自检）。

### 阶段2 stage2（世界观）

装配：`slices/novel-stage2-world.md`（+已选型时：题材增量切片的层级体系适配示例——11节"悬疑=信息掌握层级"等题材化阶梯）。产出：层级体系/金手指规则/铁律/世界观规则（入设定记录"已确立设定"区）。

### 阶段3 stage3（人物）

装配：`slices/novel-stage3-characters.md`（人物立体化系统）+ `slices/novel-stage3-cast.md`（阶段3执行）。
产出：人物三维档案/口语档位/人味档案/反派计划线/配角小弧光。

### 阶段4 stage4（路线图+部大纲）

装配：`slices/novel-stage4-roadmap.md` + `slices/novel-stage4-hooks.md` + `slices/novel-stage4-reversal.md`（+感情线时加 `slices/novel-stage1-romance-line.md` 的节拍部分）。
产出：路线图、本部三幕大纲、伏笔矩阵与误导线索表、悬念账户规划、人味节点（模板 `templates/novel-伏笔矩阵与误导线索表.md`）。

### 阶段5 stage5（章纲，每批10章）

装配：`slices/novel-stage5-outline.md` + `slices/novel-stage4-hooks.md`。
产出：每章8行+附加标注（模板 `templates/novel-章纲8行.md`）。

### 阶段6 stage6（正文循环，每章）

每章固定循环：
1. `bash scripts/wm-context.sh --dir <目录> --task plan --chapter N` → 装配 `slices/novel-stage5-outline.md` 对应章纲+`slices/novel-stage4-hooks.md`
2. `bash scripts/wm-context.sh --dir <目录> --task write --chapter N` → 装配 `slices/novel-stage6-writing.md`（句式/对话/可读性/去AI味/两遍交付制）+ `slices/novel-stage6-logic.md`（逻辑八问）+（按需）`slices/novel-stage3-characters.md` 的语言指纹/口语档位部分
3. 写正文（3000-4000字）到稿件文件
4. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` → 机器体检
5. 自检清单全过（见第五节交付自检）→ 修正循环
6. `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>` 提交台账增量

### 阶段7 stage7（完本修订）

装配：`slices/novel-stage7-revision.md`。执行全文修订优先级纪律。

### report（每写完10章）

装配：`slices/novel-report-serial.md`。
动作：先 `bash scripts/wm-status.sh --dir <目录>` + `bash scripts/wm-doctor.sh --dir <目录>`，再输出17项连载状态报告（模板 `templates/novel-连载状态报告.md`）；报告节点与卷末/部末重合时合并综合报告。

### record（台账维护，全程）

装配：`slices/novel-record.md`。设定记录两区制（模板 `templates/novel-设定记录骨架.md`）。
部末：`bash scripts/wm-archive.sh --dir <目录> --part N` → 输出部总结包（模板 `templates/novel-部总结包.md`）→ 活跃区切卷。

### protocol（交互协议，全程常驻）

装配：`slices/novel-protocol.md`。指令语义：「通过」进下一阶段；「继续」按台账续最近未完成动作；「写第N章」出正文；「卡文了」按闭环层级诊断（见第六节）；部循环指令「规划下一部/全书收尾/开始修订」。

## 四、台账语义映射（wm-commit.sh 的 JSON 字段 ↔ 设定记录分区）

| commit 字段 | 对应设定记录分区 |
|---|---|
| names[{name,new}] | 已锁定专名（错字核对唯一基准） |
| characters | 人物三维档案+人物状态+口语档位+人味档案+动机演进 |
| foreshadow | 伏笔台账+支票清单+误导线索表+感情线拍点 |
| timeline | 时间线（故事内日期/时辰） |
| suspense | 悬念账户（问题/类型/抛出章/预期回收章/读者已意识到） |
| info_gap | 信息表（每角色知道/不知道/误以为） |
| plotlines | 反派计划线+渐变桥+各线进度 |
| summary{chapter,one_line,hook_type,changes} | 已写章节摘要（一句话+钩子类型+账户变动+人物状态变动+冲突层级） |
| words_count | 本章字数（3000-4000字恒定） |

## 五、交付自检要求（每章硬性，全过才输出）

1. 两遍交付制已执行（第一遍写作；第二遍换校对者身份：第一扫逻辑与人物[八问+归属核对]，第二扫文字[黑名单+洁净度+朗读测试]）。
2. 机器体检：`bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 报告的问题已全部处理。
3. 文末交付声明（原文第十八节7，逐项如实）：「已核对设定记录：本章专名X个均为已记录名词且零错字；逻辑自检八问通过（含归属核对）；对话人味四项通过；可读性回读测试通过（无拗口句/无超40字句/指代无歧义）；两遍交付制已执行（逻辑扫+文字扫）；悬念账户当前余额X个；本章出场人物X名，语言指纹与口语档案已核对；主角人味档案已核对；全文无繁体/英文字母/标点错误」。
4. 台账已 commit（含 summary 与 words_count）；跳过 commit 禁止进入下一章。

## 六、常见故障（卡文了→诊断路径）

用户说「卡文了」→ 按当前闭环层级诊断并给处方（原文第十八节4）：
- **章级**：章纲断层？章末钩子断链？→ 回该章8行核对，补冲突与钩子
- **批级**：悬念账户清空（余额<3）？情绪疲劳（连续同情绪章）？→ 下批章纲重排，先补账户/插入缓冲章
- **部级**：动机漂移？人物失真？冲突层级停滞？主角人味断供（连续五章四维全满）？→ 回部大纲与动机三段档案校正
- **工具故障**：状态对不上 → `bash scripts/wm-doctor.sh --dir <目录>` 体检；JSON/章号/摘要问题按报告修复后 `bash scripts/wm-restore.sh --dir <目录>` 恢复
- 信息不足或自检发现无法两全的矛盾 → 一律先问用户后写（原文第十八节6）

## 七、与其他技能的自动协作

- 本技能由 `skills/writing-master/SKILL.md` 路由进入；用户中途改赛道/开新书 → 回读主路由重路由。
- 深入参考：言情技法（糖虐节奏/泄底纪律）可加读 `slices/romance-hooks-pace.md`、`slices/romance-info-gap.md`（预算允许时）。
- 部末归档后新会话：任何技能可 `bash scripts/wm-restore.sh --dir <目录>` 无损续接本赛道项目。

下一步建议：执行阶段0装配表开始四问确认。
