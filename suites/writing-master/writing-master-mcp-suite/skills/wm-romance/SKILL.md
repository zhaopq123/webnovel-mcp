---
name: wm-romance
description: 言情长篇小说赛道技能（v8.1引擎，全自动/协作双模式）。适用：先婚后爱、甜宠、细水长流等言情网文，20-30万字起步，HE。触发词：写言情、写甜文、先婚后爱、女主男主、糖虐、写第N章、卷末结算、完结、TXT交付。用户要创作或续写言情小说时使用本技能（由主路由 writing-master 转入，也可直接触发）。
---

# wm-romance · 言情赛道 SKILL（v8.1，全自动/协作双模式）

## 一、用途

按言情引擎 v8.1 完成"六份全局文档 → 黄金三章 → 逐章循环 → 卷末结算 → 完结回收 → TXT交付"全流程。每章产出固定结构：①章节规划卡 ②正文2000-3000字 ③创作后台 ④六重自检结果 ⑤下一步。

## 二、前置条件与模式开关（本赛道特有）

- 初始化：`bash scripts/wm-init.sh --track romance --title <名> --target-words <N> --mode auto|collab [--dir <目录>]`
- **--mode auto（全自动）**：v8.1 原生模式——需要拍板的事项按专业推荐直接决定，不停下来询问，写完本书为止；默认设定包可自动微调但不得询问。
- **--mode collab（协作）**：关键节点停下来等用户确认——①阶段0六文档确认 ②设定包微调 ③卷末修正案 ④矛盾处理二选一 ⑤每章写完是否继续。
- 缺省模式：collab（更安全；用户说"全自动写完别问我"或 init 传 auto 时切回原生全自动）。
- **运行中切换模式**：编辑 `<作品目录>/.wm/state.json` 的 mode 字段（auto↔collab），改完用 `bash scripts/wm-status.sh --dir <目录>` 验证生效。这是数据文件操作，不是新命令。
- 切片中的「模式注」标出全自动差异点所在（一/三/十二/十三节）；collab 模式下凡"直接决定/自动确认/直接继续/直接选"处改为先展示方案经确认后执行。
- 续写项目：先 `bash scripts/wm-restore.sh --dir <目录>`。

## 三、阶段流程与切片装配表

### 阶段0 init（六份全局文档）

装配：`slices/romance-init-role.md`（角色定位+默认设定包+模式总开关）+ `slices/romance-workflow.md`（工作流程）+ `slices/romance-core-psych.md`（读者心理M1-M4，全程底座）。
动作：生成六份全局文档（模板 `templates/romance-全局六文档.md`、`templates/romance-人物档案卡.md`）：
①人物档案卡 ②全书大纲 ③期待线总表 ④信息差台账 ⑤桥段登记表 ⑥子类型爽点备忘录。
auto：自动确认后直接进入创作；collab：交用户确认。
随后把基础事实（人物/期待线/信息差）写入 `更新.json`，执行 `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>`（这是台账基线，后续每章 diff 依此）。

### 黄金三章（第1-3章）

装配：`slices/romance-golden-three.md` + `slices/romance-hooks-pace.md` + `slices/romance-info-gap.md` + `slices/romance-pov.md`。
按每章循环执行（见下），三章清单全过才算开局成立。

### 每章循环（阶段1）

1. `bash scripts/wm-context.sh --dir <目录> --task plan --chapter N` → 写前输出**章节规划卡七项**（模板 `templates/romance-章节规划卡.md`）：本章目标/期待线推进/埋露爆伏笔编号/钩子类型/情绪定位（爽疼痒交替）/糖虐等级/信息差变动预告
2. `bash scripts/wm-context.sh --dir <目录> --task write --chapter N` → 按预算装配写作切片（全部在 knowledge/slices/，正文即原文规则）：
   - 常规章：`slices/romance-pov.md`（视角铁律，最高优先级）+ `slices/romance-language.md` + `slices/romance-dialogue.md` + `slices/romance-info-gap.md`
   - 按章型加读：糖点章+`slices/romance-antitrope.md`（糖点独家性）；节奏章+`slices/romance-hooks-pace.md`（三章一循环节拍表）；男主视角片段章+`slices/romance-pov.md` 的R4.3/R4.4细则
3. 写正文 2000-3000字（纯中文；对话叙述约4:6；男主视角片段用"———"加【视角切换】标出）
4. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 机器体检
5. **六重自检**（装配 `slices/romance-ledger-review.md`；模板 `templates/romance-创作后台与六重自检.md`）：写前自检+写后A结构与人物/B去AI味禁英文/C对白/D钩子留存/E余味——任何一项不过关→修改→重检该项→循环至全通过才输出
6. `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>`：提交伏笔/期待线/信息差/人物状态（亲密度及驱动事件）/时间线/summary
7. 输出创作后台；**auto：直接写下一章不询问；collab：向用户确认后继续**

### 卷末结算（阶段2）

装配：`slices/romance-workflow.md` 阶段2 + `slices/romance-ledger-review.md`。
动作：`bash scripts/wm-status.sh --dir <目录>` → 卷末盘点（伏笔埋设兑现清单/期待线推进度/未回收项预警[超12章标红]/余味细节/桥段登记/人物状态快照/爽点兑现度）。大纲需滚动修正时：auto 直接出修正案并执行同步台账；collab 出方案交确认。盘点完成后 `bash scripts/wm-archive.sh --dir <目录> --part N`（N=卷号，归档卷摘要入历史区，此后引用已完结卷只依据卷摘要）。

### 完结回收（阶段3）

装配：`slices/romance-workflow.md` 阶段3 + `slices/romance-antitrope.md`（尾声余味三原则）+ `slices/romance-output.md`。
动作：最后5章输出回收计划表（禁无交代）；主线感情完整确认场景（禁开放式烂尾）；尾声日常小细节收尾+留一处小空白；番外规划（男主视角暗恋回溯+婚后日常）；全书按卷合并 TXT 交付（文件名原创不撞名）。

### recover（异常与记忆恢复）

装配：`slices/romance-recovery.md`。中途改设定→先输出影响评估再执行并同步台账；发现既往矛盾→主动指出给两方案（auto 按专业推荐直接选/collab 交用户）；上下文接近极限→输出六本台账快照+最近三章摘要建议保存，新会话用 `bash scripts/wm-restore.sh --dir <目录>` 续接。

### protocol（输出格式，全程常驻）

装配：`slices/romance-output.md`：每章固定五段结构；管理文档可用编号表格百分比；正文严禁英文；章题《书名》第X章 章节标题（带钩子）。

## 四、台账语义映射（wm-commit.sh JSON 字段 ↔ 六本台账/相关账）

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

## 五、交付自检要求（每章硬性）

1. 六重自检逐条通过（见创作后台模板），禁止标注问题但照常交稿。
2. `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> --chapter N` 报告问题已处理。
3. 正文纯中文、无英文字母（管理文档不受此限）；对话叙述约4:6；男主内心零直写。
4. 已 commit：伏笔/期待线/信息差/人物状态（跳格检验：亲密度无事件驱动上升≥2级=bug重写）/时间线。
5. auto 模式下写完全书前不询问；collab 模式每章确认。

## 六、常见故障（卡文了→诊断路径）

- **感情推进不动**：查期待线是否跳格（协议期→习惯→心动→误会→挑明→确认不可跳）→ 回节拍表补中间格
- **糖发腻/读者吃饱了**：查M1间歇性强化（糖掐着给）→ 检查三章一循环节拍与虐不超糖
- **信息差倒挂**：排序必须读者＞男主＞女主 → 检查最近男主视角片段是否泄底超量（占比10%-20%、每5-8章一次）
- **伏笔悬置**：待兑现距上次露出超12章=标红 → 下批章纲优先安排
- **跳章写作风险**：禁止跳章破坏伏笔顺序；必须调整时在创作后台标注"跳章写作，伏笔顺序已乱"并重排
- **工具故障**：`bash scripts/wm-doctor.sh --dir <目录>` 体检 → 修复后 `bash scripts/wm-restore.sh --dir <目录>`

## 七、与其他技能的自动协作

- **女频题材衔接（网文全题材路由口径）**：本赛道承接以感情线为绝对主线的女频题材（现言/古言/幻言/年代言情的甜宠、先婚后爱、豪门总裁、娱乐圈等）。用户题材为女频但感情非唯一主线时（女强争霸、宅斗权谋、种田经营、基建、快穿任务、悬疑女主向等）→ 回读 `skills/writing-master/SKILL.md` 重路由到 novel 赛道，并启用其感情线模块（`slices/novel-stage1-romance-line.md`，六拍节拍按 novel 流程执行）；题材与套路全景参考全赛道共用切片 `slices/webnovel-genre-panorama.md`、`slices/webnovel-trope-quickref.md`（novel 阶段0选型用）。
- 由 `skills/writing-master/SKILL.md` 路由进入；改赛道/开新书 → 回读主路由。
- 通用强化可加读 novel 切片：`slices/novel-stage6-writing.md`（句式/去AI味细则）、`slices/novel-stage3-characters.md`（口语档位/失控降级）——预算允许时。
- 新会话续作：任何技能 `bash scripts/wm-restore.sh --dir <目录>` 无损续接。

下一步建议：执行 wm-init（选定 auto/collab）后进入阶段0六文档。
