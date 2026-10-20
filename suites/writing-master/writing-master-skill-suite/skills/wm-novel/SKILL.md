---
name: wm-novel
description: 长篇小说赛道技能（19节通用引擎 + 言情模式v8.1引擎，二选一）。通用模式适用：网文全题材×全套路——玄幻/仙侠/都市/悬疑/科幻/历史/游戏/武侠/现实/奇幻等一切流派，及规则怪谈/无限流/灵气复苏/末日废土/赛博朋克/克苏鲁/种田基建/知乎短篇等新兴赛道，30万字-1000万字（知乎短篇可小体量走短部换算）。言情模式适用：恋爱为绝对主线的言情网文——先婚后爱、甜宠、细水长流等，20-30万字起步，HE（v8.1 全自动/协作双模式，v2.0 起由原独立赛道整体并入）。触发词：写小说、写言情、写甜文、先婚后爱、女主男主、糖虐、开新书、玄幻、仙侠、都市、悬疑、系统流、重生、穿越、退婚、赘婿、无限流、快穿、废柴、战神、规则怪谈、灵气复苏、末世、赛博朋克、克苏鲁、种田、知乎短篇、设定、世界观、人物档案、路线图、章纲、写第N章、卷末结算、连载报告、卡文了、完本、规划下一部、TXT交付。用户要创作或续写长篇小说（含言情小说）时使用本技能（由主路由 writing-master 转入，也可直接触发）。
---

# wm-novel · 长篇小说赛道 SKILL（19节通用引擎 + 言情模式 v8.1）

## 一、用途与引擎选择（先选模式再动笔）

本赛道含两套引擎，按题材主线二选一（v2.0 起言情不再单列赛道，整体并入本赛道为一个模式；原 v8.1 专用机制与 romance-* 切片一条未删）：

- **通用模式（默认）**：按19节通用引擎完成长篇小说从设定到正文的全流程：题材×套路选型 → 体量自适应结构换算 → 核心设定 → 世界观 → 人物 → 路线图 → 章纲 → 正文循环 → 完本修订。题材覆盖网文全景（男频10/女频6/跨频4/新兴9，见 `slices/webnovel-genre-panorama.md`）×10大套路（见 `slices/webnovel-trope-quickref.md`）。产出物：结构换算表、核心设定表、人物档案、路线图+部大纲、每批章纲、正文（每章3000-4000字）、连载状态报告、部总结包。
- **言情模式**（init 加 `--genre romance`）：沿用原言情引擎 v8.1 完成"六份全局文档 → 黄金三章 → 逐章循环 → 卷末结算 → 完结回收 → TXT交付"全流程，行为与原独立言情赛道完全一致。每章产出固定结构：①章节规划卡 ②正文2000-3000字 ③创作后台 ④六重自检结果 ⑤下一步。专用机制（糖虐节奏、信息差泄底、男主视角回甘、全局六文档、创作后台与六重自检等）与 romance-* 切片全部保留，详见第七节。
- **分流口径（自动分流逻辑不变）**：恋爱为绝对主线 → 言情模式；感情非唯一主线 → 通用模式（启用感情线模块 `slices/novel-stage1-romance-line.md`）。

## 二、通用模式 · 前置条件

- 已执行 `bash scripts/wm-init.sh --track novel --title <名> --target-words <N> [--dir <目录>]`（包根执行；--dir 缺省为当前目录；不加 --genre 即通用模式）。
- 续写项目：先 `bash scripts/wm-restore.sh --dir <目录>`，以恢复包为唯一事实依据。
- 知识切片位于 `knowledge/slices/`（正文即原文规则，一字未改）；模板位于 `templates/`。
- `bash scripts/wm-context.sh --dir <目录> [--task <plan|write|review|report>] [--chapter N]` 输出推荐切片清单（id/路径/字数），读取预算≤3000字/次。

## 三、通用模式 · 阶段流程与切片装配表

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
| `slices/novel-trope-engine-map.md` | 套路×引擎挂接映射：系统流↔金手指规则、重生/穿越↔信息差、退婚/赘婿↔打脸节奏等（阶段0选型用） |

动作：按装配切片完成题材×套路选型与开场四问（体量/更新强度/完结标准/禁忌线），产出物落 `templates/novel-题材套路选型表.md`、`templates/novel-核心设定表.md`；基础事实写入 `更新.json` 后 `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>` 建台账基线。

### 阶段1-3 setup / world / characters

装配：`slices/novel-stage1-pov.md`（叙事人称与视角铁律）、`slices/novel-stage1-setup.md`（核心设定五要素）、`slices/novel-stage2-world.md`（世界观搭建与名词锁定）、`slices/novel-stage3-cast.md`（人物群像卡）、`slices/novel-stage3-characters.md`（口语档位/失控降级）；含重要感情线时加 `slices/novel-stage1-romance-line.md`（六拍节拍，感情非唯一主线的女频题材在此启用）。
动作：产出 `templates/novel-设定记录骨架.md` 与人物档案；世界观专有名词全部先入专名表。

### 阶段4 hooks / reversal / roadmap

装配：`slices/novel-stage4-hooks.md`（钩子库）、`slices/novel-stage4-reversal.md`（反转与误导线索）、`slices/novel-stage4-roadmap.md`（路线图与部大纲）。
动作：产出 `templates/novel-伏笔矩阵与误导线索表.md` 与路线图；用 `bash scripts/wm-outline.sh --save master|part` 存总纲/部纲。

### 阶段5 outline（章纲，章纲门禁源头）

装配：`slices/novel-stage5-outline.md`。
动作：每批章纲按 `templates/novel-章纲8行.md` 写作，`bash scripts/wm-outline.sh --save chapter` 逐章存档（outline_gate 启用时 context --task write 前必须先存）。

### 阶段6 writing / logic（正文循环）

每章闭环：`bash scripts/wm-outline.sh --dir <目录> --list chapter` 核对 → `bash scripts/wm-context.sh --dir <目录> --task write --chapter N` 装配 → 写正文3000-4000字（装配 `slices/novel-stage6-writing.md` 句式/去AI味 + `slices/novel-stage6-logic.md` 逻辑八问）→ `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` → 按第五节自检 → `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>`。
连载报告：每10章 `bash scripts/wm-status.sh --dir <目录>`，按 `templates/novel-连载状态报告.md` 人肉输出；查询台账用 `bash scripts/wm-query.sh --dir <目录> --what <characters|foreshadow|suspense|info_gap|plotlines|timeline|names> [--keyword 词]`。

### 阶段7 revision（完本修订与部循环）

装配：`slices/novel-stage7-revision.md`（完本修订清单）、`slices/novel-report-serial.md`（连载报告口径）、`slices/novel-record.md`（拆书与记录）。
动作：部末 `bash scripts/wm-archive.sh --dir <目录> --part N`（摘要入 `templates/novel-部总结包.md`）→ 活跃区切卷。

### protocol（交互协议，全程常驻）

装配：`slices/novel-protocol.md`。指令语义：「通过」进下一阶段；「继续」按台账续最近未完成动作；「写第N章」出正文；「卡文了」按闭环层级诊断（见第六节）；部循环指令「规划下一部/全书收尾/开始修订」。

## 四、通用模式 · 台账语义映射（wm-commit.sh 的 JSON 字段 ↔ 设定记录分区）

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

## 五、通用模式 · 交付自检要求（每章硬性，全过才输出）

1. 两遍交付制已执行（第一遍写作；第二遍换校对者身份：第一扫逻辑与人物[八问+归属核对]，第二扫文字[黑名单+洁净度+朗读测试]）。
2. 机器体检：`bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 报告的问题已全部处理。
3. 文末交付声明（原文第十八节7，逐项如实）：「已核对设定记录：本章专名X个均为已记录名词且零错字；逻辑自检八问通过（含归属核对）；对话人味四项通过；可读性回读测试通过（无拗口句/无超40字句/指代无歧义）；两遍交付制已执行（逻辑扫+文字扫）；悬念账户当前余额X个；本章出场人物X名，语言指纹与口语档案已核对；主角人味档案已核对；全文无繁体/英文字母/标点错误」。
4. 台账已 commit（含 summary 与 words_count）；跳过 commit 禁止进入下一章。

## 六、通用模式 · 常见故障（卡文了→诊断路径）

用户说「卡文了」→ 按当前闭环层级诊断并给处方（原文第十八节4）：
- **章级**：章纲断层？章末钩子断链？→ 回该章8行核对，补冲突与钩子
- **批级**：悬念账户清空（余额<3）？情绪疲劳（连续同情绪章）？→ 下批章纲重排，先补账户/插入缓冲章
- **部级**：动机漂移？人物失真？冲突层级停滞？主角人味断供（连续五章四维全满）？→ 回部大纲与动机三段档案校正
- **工具故障**：状态对不上 → `bash scripts/wm-doctor.sh --dir <目录>` 体检；JSON/章号/摘要问题按报告修复后 `bash scripts/wm-restore.sh --dir <目录>` 恢复
- 信息不足或自检发现无法两全的矛盾 → 一律先问用户后写（原文第十八节6）

## 七、言情模式（v8.1，全自动/协作双模式；原言情赛道整体并入，机制一条未删）

### 7.1 用途

按言情引擎 v8.1 完成"六份全局文档 → 黄金三章 → 逐章循环 → 卷末结算 → 完结回收 → TXT交付"全流程。每章产出固定结构：①章节规划卡 ②正文2000-3000字 ③创作后台 ④六重自检结果 ⑤下一步。

### 7.2 前置条件与模式开关（言情模式特有）

- 初始化：`bash scripts/wm-init.sh --track novel --genre romance --title <名> --target-words <N> --mode auto|collab [--dir <目录>]`
- **--mode auto（全自动）**：v8.1 原生模式——需要拍板的事项按专业推荐直接决定，不停下来询问，写完本书为止；默认设定包可自动微调但不得询问。
- **--mode collab（协作）**：关键节点停下来等用户确认——①阶段0六文档确认 ②设定包微调 ③卷末修正案 ④矛盾处理二选一 ⑤每章写完是否继续。
- 缺省模式：collab（更安全；用户说"全自动写完别问我"或 init 传 auto 时切回原生全自动）。
- **运行中切换模式**：编辑 `<作品目录>/.wm/state.json` 的 mode 字段（auto↔collab），改完用 `bash scripts/wm-status.sh --dir <目录>` 验证生效。这是数据文件操作，不是新命令。
- 切片中的「模式注」标出全自动差异点所在（一/三/十二/十三节）；collab 模式下凡"直接决定/自动确认/直接继续/直接选"处改为先展示方案经确认后执行。
- 续写项目：先 `bash scripts/wm-restore.sh --dir <目录>`。

### 7.3 阶段流程与切片装配表

#### 阶段0 init（六份全局文档）

装配：`slices/romance-init-role.md`（角色定位+默认设定包+模式总开关）+ `slices/romance-workflow.md`（工作流程）+ `slices/romance-core-psych.md`（读者心理M1-M4，全程底座）。
动作：生成六份全局文档（模板 `templates/romance-全局六文档.md`、`templates/romance-人物档案卡.md`）：
①人物档案卡 ②全书大纲 ③期待线总表 ④信息差台账 ⑤桥段登记表 ⑥子类型爽点备忘录。
auto：自动确认后直接进入创作；collab：交用户确认。
随后把基础事实（人物/期待线/信息差）写入 `更新.json`，执行 `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>`（这是台账基线，后续每章 diff 依此）。

#### 黄金三章（第1-3章）

装配：`slices/romance-golden-three.md` + `slices/romance-hooks-pace.md` + `slices/romance-info-gap.md` + `slices/romance-pov.md`。
按每章循环执行（见下），三章清单全过才算开局成立。

#### 每章循环（阶段1）

1. `bash scripts/wm-context.sh --dir <目录> --task plan --chapter N` → 写前输出**章节规划卡七项**（模板 `templates/romance-章节规划卡.md`）：本章目标/期待线推进/埋露爆伏笔编号/钩子类型/情绪定位（爽疼痒交替）/糖虐等级/信息差变动预告
2. `bash scripts/wm-context.sh --dir <目录> --task write --chapter N` → 按预算装配写作切片（全部在 knowledge/slices/，正文即原文规则）：
   - 常规章：`slices/romance-pov.md`（视角铁律，最高优先级）+ `slices/romance-language.md` + `slices/romance-dialogue.md` + `slices/romance-info-gap.md`
   - 按章型加读：糖点章+`slices/romance-antitrope.md`（糖点独家性）；节奏章+`slices/romance-hooks-pace.md`（三章一循环节拍表）；男主视角片段章+`slices/romance-pov.md` 的R4.3/R4.4细则
3. 写正文 2000-3000字（纯中文；对话叙述约4:6；男主视角片段用"———"加【视角切换】标出）
4. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 机器体检
5. **六重自检**（装配 `slices/romance-ledger-review.md`；模板 `templates/romance-创作后台与六重自检.md`）：写前自检+写后A结构与人物/B去AI味禁英文/C对白/D钩子留存/E余味——任何一项不过关→修改→重检该项→循环至全通过才输出
6. `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>`：提交伏笔/期待线/信息差/人物状态（亲密度及驱动事件）/时间线/summary
7. 输出创作后台；**auto：直接写下一章不询问；collab：向用户确认后继续**

#### 卷末结算（阶段2）

装配：`slices/romance-workflow.md` 阶段2 + `slices/romance-ledger-review.md`。
动作：`bash scripts/wm-status.sh --dir <目录>` → 卷末盘点（伏笔埋设兑现清单/期待线推进度/未回收项预警[超12章标红]/余味细节/桥段登记/人物状态快照/爽点兑现度）。大纲需滚动修正时：auto 直接出修正案并执行同步台账；collab 出方案交确认。盘点完成后 `bash scripts/wm-archive.sh --dir <目录> --part N`（N=卷号，归档卷摘要入历史区，此后引用已完结卷只依据卷摘要）。

#### 完结回收（阶段3）

装配：`slices/romance-workflow.md` 阶段3 + `slices/romance-antitrope.md`（尾声余味三原则）+ `slices/romance-output.md`。
动作：最后5章输出回收计划表（禁无交代）；主线感情完整确认场景（禁开放式烂尾）；尾声日常小细节收尾+留一处小空白；番外规划（男主视角暗恋回溯+婚后日常）；全书按卷合并 TXT 交付（文件名原创不撞名）。

#### recover（异常与记忆恢复）

装配：`slices/romance-recovery.md`。中途改设定→先输出影响评估再执行并同步台账；发现既往矛盾→主动指出给两方案（auto 按专业推荐直接选/collab 交用户）；上下文接近极限→输出六本台账快照+最近三章摘要建议保存，新会话用 `bash scripts/wm-restore.sh --dir <目录>` 续接。

#### protocol（输出格式，全程常驻）

装配：`slices/romance-output.md`：每章固定五段结构；管理文档可用编号表格百分比；正文严禁英文；章题《书名》第X章 章节标题（带钩子）。

### 7.4 台账语义映射（wm-commit.sh JSON 字段 ↔ 六本台账/相关账）

| commit 字段 | 对应言情概念 |
|---|---|
| names | 人名/地名/专有物（长线物证、可回环物件）锁定 |
| characters | 人物档案卡（公开层+隐藏层+语言档案+人物状态：称呼/亲密度/情绪基线/位置/随身物品） |
| foreshadow | 伏笔清单（埋/露/爆；距上次露出章数；超12章标红）+长短线物证 |
| timeline | 时间线台账（日期/星期/季节/已过天数，防"上周才认识怎么过了半年"） |
| suspense | 读者留存问题（每章末压着的未解问题）+倒计时装置进度 |
| info_gap | 信息差台账（不知方/藏方/读者是否知道+变动章） |
| plotlines | 期待线总表（每线状态/上次推进章/下次推进章） |
| summary{chapter,one_line,hook_type,changes} | 每章一句话剧情+钩子类型+期待线推进+信息差变动 |
| words_count | 本章字数（2000-3000） |

### 7.5 交付自检要求（每章硬性）

1. 六重自检逐条通过（见创作后台模板），禁止标注问题但照常交稿。
2. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 报告问题已处理。
3. 正文纯中文、无英文字母（管理文档不受此限）；对话叙述约4:6；男主内心零直写。
4. 已 commit：伏笔/期待线/信息差/人物状态（跳格检验：亲密度无事件驱动上升≥2级=bug重写）/时间线。
5. auto 模式下写完全书前不询问；collab 模式每章确认。

### 7.6 常见故障（卡文了→诊断路径）

- **感情推进不动**：查期待线是否跳格（协议期→习惯→心动→误会→挑明→确认不可跳）→ 回节拍表补中间格
- **糖发腻/读者吃饱了**：查M1间歇性强化（糖掐着给）→ 检查三章一循环节拍与虐不超糖
- **信息差倒挂**：排序必须读者＞男主＞女主 → 检查最近男主视角片段是否泄底超量（占比10%-20%、每5-8章一次）
- **伏笔悬置**：待兑现距上次露出超12章=标红 → 下批章纲优先安排
- **跳章写作风险**：禁止跳章破坏伏笔顺序；必须调整时在创作后台标注"跳章写作，伏笔顺序已乱"并重排
- **工具故障**：`bash scripts/wm-doctor.sh --dir <目录>` 体检 → 修复后 `bash scripts/wm-restore.sh --dir <目录>`

## 八、与其他技能的自动协作（通用/言情两模式共用）

- 本技能由 `skills/writing-master/SKILL.md` 路由进入；用户中途改赛道/开新书 → 回读主路由重路由。
- **女频题材衔接（网文全题材路由口径，自动分流逻辑不变）**：言情模式承接以感情线为绝对主线的女频题材（现言/古言/幻言/年代言情的甜宠、先婚后爱、豪门总裁、娱乐圈等）。用户题材为女频但感情非唯一主线时（女强争霸、宅斗权谋、种田经营、基建、快穿任务、悬疑女主向等）→ 走通用模式，并启用其感情线模块（`slices/novel-stage1-romance-line.md`，六拍节拍按通用模式流程执行）；题材与套路全景参考全赛道共用切片 `slices/webnovel-genre-panorama.md`、`slices/webnovel-trope-quickref.md`（阶段0选型用）。
- 深入参考（通用模式写感情戏时）：言情技法（糖虐节奏/泄底纪律）可加读 `slices/romance-hooks-pace.md`、`slices/romance-info-gap.md`（预算允许时）。言情模式反向上加读通用切片：`slices/novel-stage6-writing.md`（句式/去AI味细则）、`slices/novel-stage3-characters.md`（口语档位/失控降级）——预算允许时。
- 部末归档后新会话：任何技能可 `bash scripts/wm-restore.sh --dir <目录>` 无损续接本赛道项目（含言情模式项目）。

下一步建议：言情模式执行 `bash scripts/wm-init.sh --track novel --genre romance`（选定 auto/collab）后进入阶段0六文档；通用模式执行阶段0装配表开始四问确认。
