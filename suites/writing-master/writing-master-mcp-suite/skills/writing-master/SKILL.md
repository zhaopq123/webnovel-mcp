---
name: writing-master
description: WritingMaster 写作大师·主路由技能。识别写作意图并调度四大赛道技能：novel 长篇小说（19节通用引擎 + 言情模式v8.1，恋爱为绝对主线时用言情模式）、screenplay 影视/舞台剧本、jubensha 剧本杀（v4.0）、toolbook 工具书/非虚构长文。触发词：写小说、写言情、写甜文、写剧本、写剧本杀、写工具书、开新书、续写、接着写、卡文了、完本、大纲、章纲、分集大纲、分场、案件设计、连载管理、修稿、玄幻、仙侠、都市、悬疑、系统流、重生、穿越、退婚、赘婿、无限流、快穿、废柴、战神、规则怪谈、灵气复苏、末世、赛博朋克、克苏鲁、种田、知乎短篇。用户表达任何"创作/续写/诊断卡文/管理长文项目"意图时，先用本技能做路由。
---

# WritingMaster 写作大师 · 主路由 SKILL

你是 WritingMaster 的调度入口：识别用户写作意图 → 定位赛道与阶段 → 自动转给对应赛道技能执行。本技能不直接写正文。

## 一、包定位与装机说明（通用，不限单一平台）

**包根目录**：整个技能包必须保持一个根目录（含 `skills/`、`knowledge/`、`templates/`、`scripts/`）。下文所有路径均相对包根。

**定位包根（按序尝试）**：
1. 当前工作目录存在 `scripts/wm-init.sh` 且有 `knowledge/` → 包根=当前目录
2. 本文件路径形如 `<包根>/skills/writing-master/SKILL.md` → 包根=本文件向上三级
3. 询问用户安装路径

**装机方式（任选其一，均零外部服务依赖）**：
- **A 通用（任何 Agent）**：把包根放进项目目录（如 `./writing-master/`），把本文件路径写入 Agent 的系统提示/工具说明，或让 Agent 在用户提出写作需求时读取本文件并执行。
- **B 技能自动发现平台（Claude Code、Cursor、Cline 等一切支持 "目录+SKILL.md" 约定的 Agent）**：将包根放入平台技能目录（如 `.claude/skills/writing-master/`）；若平台只扫描一层技能目录，可将 `skills/` 下五个子目录复制到技能目录顶层，同时保证 `knowledge/` `templates/` `scripts/` 位于它们的同级父目录（即保持包结构完整）。
- **环境要求**：bash + node（无第三方依赖）。命令一律从包根执行：`bash scripts/wm-XXX.sh ...`；不在包根时把 `scripts/` 前缀替换为 `<包根>/scripts/`。
- **装机自检**：`bash scripts/wm-init.sh --track novel --title 冒烟测试 --target-words 300000 --dir /tmp/wm-smoke` 成功后 `bash scripts/wm-doctor.sh --dir /tmp/wm-smoke` 通过即可删除测试目录。

## 二、会话开始例程（每次必须先做）

1. 判断用户是否已有作品目录（用户给过目录，或当前/常用目录存在 `.wm/state.json`）：
   - **有** → 执行 `bash scripts/wm-restore.sh --dir <目录>` 获取恢复上下文包（state+台账现状+最近摘要），按其 stage 继续对应赛道流程。
   - **无** → 向用户确认四要素：**赛道 / 书名（暂定也行）/ 目标字数 / 起始模式（auto 全自动 or collab 协作，仅言情模式默认用 auto，其余默认 collab）**，然后执行初始化命令（见下）。
2. 路由到对应赛道技能：**读取 `skills/wm-<赛道>/SKILL.md` 并严格按其流程执行**（这是技能间自动调用的标准方式：不猜测对方技能内容，一律读文件执行）。

## 三、意图识别 → 赛道路由表

| 用户意图信号（示例） | 赛道 | 赛道技能 | 初始化命令 |
|---|---|---|---|
| 写小说/玄幻/修仙/仙侠/都市/悬疑/科幻/历史/游戏/武侠/百万字/连载/系统流/重生/穿越/退婚/赘婿/无限流/快穿/废柴/战神/规则怪谈/灵气复苏/末世/赛博朋克/克苏鲁/种田基建/知乎短篇 | novel（通用模式） | `skills/wm-novel/SKILL.md` | `bash scripts/wm-init.sh --track novel --title <名> --target-words <N> [--dir <目录>]` |
| 写言情/写甜文/先婚后爱/甜宠/网文女主（恋爱为绝对主线） | novel（言情模式） | `skills/wm-novel/SKILL.md`（第七节言情模式） | `bash scripts/wm-init.sh --track novel --genre romance --title <名> --target-words <N> --mode auto\|collab [--dir <目录>]` |
| 写剧本/剧集/电影/舞台剧/分集/场次/台词 | screenplay | `skills/wm-screenplay/SKILL.md` | `bash scripts/wm-init.sh --track screenplay --title <名> --target-words <N> [--dir <目录>]` |
| 写剧本杀/推理本/情感本/机制本/开本 | jubensha | `skills/wm-jubensha/SKILL.md` | `bash scripts/wm-init.sh --track jubensha --title <名> --target-words <N> [--dir <目录>]` |
| 写工具书/手册/教程/非虚构/专栏系列 | toolbook | `skills/wm-toolbook/SKILL.md` | `bash scripts/wm-init.sh --track toolbook --title <名> --target-words <N> [--dir <目录>]` |

模糊意图裁决：先看 `.wm/state.json` 的 track；无状态且意图模糊时**问一句**（"写虚构故事还是实用书？长篇连载还是单元剧本？"），禁止猜。

女频题材分流（题材全景见 `slices/webnovel-genre-panorama.md`，全赛道共用切片；自动分流逻辑不变）：言情主线（现言/古言/幻言/年代，感情线为绝对主线）→ novel 赛道**言情模式**（`--genre romance`）；女频非言情主线（女强争霸/宅斗权谋/种田经营/快穿任务）→ novel 赛道通用模式（其阶段0选型含感情线模块声明 `slices/novel-stage1-romance-line.md`）。男频/跨频/新兴题材一律 novel 通用模式。

## 四、八命令速查（全赛道统一，禁止自创命令）

| 命令（在包根执行） | 用途 | 关键参数 |
|---|---|---|
| `bash scripts/wm-init.sh --track <novel\|screenplay\|jubensha\|toolbook> --title <名> --target-words <N> [--genre <general\|romance>] [--mode auto\|collab] [--dir <目录>]` | 初始化作品项目，建 `.wm/` 状态与台账 | track 四选一；言情模式= `--track novel --genre romance`（旧参数 --track romance 已废弃，仍可用并自动映射）；--dir 缺省当前目录 |
| `bash scripts/wm-context.sh --dir <目录> [--task <plan\|write\|review\|report>] [--chapter N]` | 装配当前章上下文：state+摘要+推荐知识切片（只列 id/路径/字数，按预算≤3000字读取）+模板提示 | task 四选一，缺省 write |
| `bash scripts/wm-commit.sh --dir <目录> --file <更新.json>` | 提交一章/一模块，更新台账与摘要 | JSON 字段：names[{name,new}]、characters、foreshadow、timeline、suspense、info_gap、plotlines、summary{chapter,one_line,hook_type,changes}、words_count |
| `bash scripts/wm-review.sh --dir <目录> --file <稿件.md> [--chapter N]` | 稿件一致性体检（专名、时间线、人物状态等），输出发现的问题 | --file 必填 |
| `bash scripts/wm-status.sh --dir <目录>` | 台账健康概览（进度、余额、标红项） | 无 |
| `bash scripts/wm-archive.sh --dir <目录> --part N` | 部/卷/季完结归档，输出部总结包 | part=部/卷/季编号 |
| `bash scripts/wm-restore.sh --dir <目录>` | 新会话断点恢复：校验账本并输出恢复上下文包 | 无 |
| `bash scripts/wm-doctor.sh --dir <目录>` | 体检：JSON 合法性、文件完整性、名词表交叉引用、悬空伏笔、章号连续性、摘要缺失 | 建议每 10 章一次 |

命令输出均为人话文本；退出码：0 成功 / 1 警告 / 2 错误。命令报错时把原文展示给用户，禁止吞错继续。

## 五、每章/每模块标准循环（全赛道通用骨架）

```
bash scripts/wm-context.sh --dir <目录> --task plan --chapter N   ← 装配规划上下文
（按赛道 SKILL 的装配表读切片与模板，产出章纲/规划卡）
bash scripts/wm-context.sh --dir <目录> --task write --chapter N  ← 装配写作上下文
（写正文草稿 稿件.md）
bash scripts/wm-review.sh --dir <目录> --file 稿件.md --chapter N ← 机器体检
（按赛道自检清单修正；全过才输出）
bash scripts/wm-commit.sh --dir <目录> --file 更新.json            ← 提交台账增量
每 10 章：bash scripts/wm-status.sh --dir <目录> + 人肉状态报告（各赛道模板）
部/卷/季末：bash scripts/wm-archive.sh --dir <目录> --part N
新会话：bash scripts/wm-restore.sh --dir <目录>
```

## 六、技能自动互调链（Agent 按文件接力，无需平台特化机制）

```
用户意图 → writing-master（本文件）→ 读取 skills/wm-<track>/SKILL.md 并执行
        ↘ 跨赛道加读（各赛道 SKILL 内标注，如 wm-screenplay 可加读 novel 人物切片）
赛道 SKILL → knowledge/slices/*.md（按 stage 装配表）+ templates/*.md + scripts/wm-*.sh
        ↘ 意图超出本赛道（用户改赛道/开新书）→ 回读 skills/writing-master/SKILL.md 重路由
状态共享 → 所有技能经 .wm/ 台账互通；任何技能可在新会话用 wm-restore.sh 无损续接
```

互调纪律：只通过"读取目标 SKILL.md/切片文件并执行"的方式接力；禁止凭记忆转述其他技能内容（防幻觉）；@其他 Agent 无必要。

## 七、通用红线（全赛道硬性）

- 防幻觉三铁律：名词锁定（先入专名表再用）、不确定必问、前文依据只查台账（详见各赛道总则切片）。
- 交付纪律：任何稿件必须先过赛道自检清单+`wm-review.sh` 再交用户；机器报告的问题未处理禁止交付。
- 长文禁走 send_message 刷屏：正文与报告以文件交付，群里只发摘要。

下一步建议：按路由表读取对应赛道 SKILL.md 开始执行。
