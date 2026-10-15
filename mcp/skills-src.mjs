/**
 * 6 个技能注册。
 *
 * 产品定位（PRD F10）：降低使用门槛——用户说人话，Agent 知道该调哪些工具、按什么顺序。
 * 技能正文写「何时用 + 分步流程 + 对应工具」，是 Agent 的操作手册。
 */
import { TOOL_NAMES } from './tool-names.mjs';

/** 技能定义：[name, description, whenToUse, body] */
const SKILLS = [
  {
    name: 'webnovel-init',
    description: '从零开一本新书：建项目骨架、定设定集、写总纲、拆第一卷。',
    whenToUse: '用户说「开一本新书 / 新建小说 / 帮我建个项目 / 我想写一本 XX 的小说 / 从零开始写一本」。',
    body: `# 开新书

## 流程

### 1. 先问清 4 件事（一次性问完，别挤牙膏）
- 书名（可暂定）
- 题材（都市异能 / 玄幻 / 悬疑 / 古言 / 科幻 …）
- 一句话故事（主角在什么背景下，为了什么，必须做什么）
- 目标规模（多少字 / 多少章，决定节奏与卷数）

如果用户说「你帮我定」，就基于题材给出 2-3 个方案让他选，不要替他拍板。

### 2. 建骨架
调用 \`webnovel_init\`，传入书名/题材/标签/一句话/目标字数与章数。
它会建出：设定集/ 大纲/ 正文/ + .webnovel/（机器态）。已存在的文件绝不覆盖。

### 3. 定设定集（4 篇，缺一不可）
用 \`webnovel_outline action=read scope=master\` 之类读回模板，然后逐个填充并保存：
- **世界观**（设定集/世界观.md）：核心规则、势力、禁忌。规则定下就不能违反。
- **力量体系**（设定集/力量体系.md）：等级阶梯 + 突破条件 + 战斗规则 + **禁止事项**。
  力量体系是长篇最容易崩的地方，务必写清「不能做什么」。
- **主角卡**（设定集/主角卡.md）：性格**必须有缺点**，否则人物扁平。
- **金手指**（设定集/金手指.md）：重点是**能力边界**（做不到什么、代价、冷却）。

用 \`webnovel_outline action=write_master\` 保存总纲；设定集文件用文件写工具直接写。

### 4. 写总纲
三幕结构 + 核心冲突（外部/内部）+ 主线脉络 + 感情线 + 世界观扩展线。
调 \`webnovel_outline action=write_master\`。

### 5. 拆第一卷
调 \`webnovel_outline action=write_volume volume=1 title=... chapterRange="1-100"\`。
卷内要有节拍表（起承转合），并列出本卷要埋/要收的伏笔。

### 6. 收尾
调 \`webnovel_status\` 展示成果，并告诉用户下一步是「写第 1 章章纲」。

## 注意
- 设定集和总纲是**用户的作品**，你是在帮他整理，不要擅自决定剧情走向。
- 每完成一步都简要汇报，不要一口气做完才说话。
- 中文字数目标通常 100 万字起步，别把规模定太小。`,
  },

  {
    name: 'webnovel-plan',
    description: '规划卷纲与章纲：把总纲拆成可执行的章节计划。',
    whenToUse: '用户说「拆卷 / 定大纲 / 规划下一卷 / 写章纲 / 这章要发生什么 / 后面怎么走」。',
    body: `# 规划大纲

## 层级
总纲 → 卷纲（每卷 50-150 章）→ 章纲（单章）。

## 写卷纲
调 \`webnovel_outline action=write_volume volume=N title="卷名" chapterRange="起始-结束"\`。

卷纲要包含：
- **本卷目标**：主角要达成什么、读者要获得什么信息
- **节拍表**：起承转合四段，标注大致章节与情绪曲线
- **要埋的伏笔** / **要收的伏笔**（对照 \`webnovel_query kind=foreshadowing\` 的结果）
- **卷末钩子**

写卷纲前先调 \`webnovel_pacing\` 看三线是否均衡，据此分配本卷的线别配比。

## 写章纲（每章动笔前必做）
调 \`webnovel_outline action=write_chapter chapter=N\`。

章纲四要素：
1. **本章目标**：推进什么情节 / 揭示什么信息
2. **场景**：时间 + 地点 + 出场人物
3. **关键事件**：3-5 个节拍点
4. **章末钩子**：留什么悬念

同时标注**线别**（quest / fire / constellation）——提交时会用到，节奏统计依赖它。

## 注意
- 「大纲即法律」：章纲定下后，写正文时不得擅自偏离。若确实需要改，先改章纲并告知用户。
- 一次别规划太多章（建议 5-20 章一批），留出根据读者反馈调整的余地。
- 伏笔要写回收计划（plannedPayoff），否则系统无法提醒你。`,
  },

  {
    name: 'webnovel-write',
    description: '写一章的完整闭环：取任务书 → 写 → 自审 → 提交。',
    whenToUse: '用户说「写第 N 章 / 继续写 / 下一章 / 接着写 / 更新一章」。',
    body: `# 写一章

## 标准闭环（按顺序，不要跳步）

### 第 1 步：取写作任务书（必做，不可跳过）
调 \`webnovel_context chapter=N\`。

- 若返回 **blockers**（例如「本章还没有章纲」）→ **停下**，先用 \`webnovel_outline action=write_chapter\` 定章纲，
  或请用户确认。**绝不在没有章纲的情况下裸写正文。**
- 若返回 warnings → 在动笔时留意（伏笔到期、跳章等）。

任务书里的「主角当前状态」是硬约束：**伤势、境界、所在地必须延续**。
比如状态卡写「右臂受伤」，就不能写出「双手持剑」的动作。

### 第 2 步：写正文
按任务书的章纲与建议字数写。写作要点：
- 网文节奏快，开头 3 段内要进冲突
- 单段 80-200 字（移动端阅读）
- 对话推进情节，别全靠叙述
- 章末必须留钩子

### 第 3 步：保存正文
调 \`webnovel_outline action=write_text chapter=N title="章节标题" text="正文全文"\`。

### 第 4 步：自审
调 \`webnovel_review chapter=N\`。
- 有 🔴 error（如状态冲突）→ **必须修改**，改完重新保存再审。
- 🟡 warning → 视情况修改，向用户说明。

### 第 5 步：提交（必做，不可跳过）
调 \`webnovel_commit\`（系统会核对第 4 步的审查记录：还有未处理的 🔴 会被拒绝；
确认按原稿提交才可传 \`force=true\`），参数：
- \`chapter\` / \`title\` / \`summary\`（2-4 句，会作为下一章前情，务必写）
- \`strand\`：本章线别
- \`hook\`：章末钩子类型与强度
- \`ending\`：结尾时间与地点（用于下一章连贯性检查）
- \`deltas\`：**本章的事实增量**——这是最容易被漏掉但最关键的部分：
  - 主角状态变化（位置、伤势、境界）
  - 新出现的角色、地点、势力
  - 埋下的伏笔（含计划回收章节）与回收的伏笔
  - 时间线推进

**判断标准：如果这章发生的事不写进 deltas，下一章就会当作没发生。**

### 第 6 步：汇报
调 \`webnovel_status\` 给出进度与下一步建议。

## 注意
- 不要把「写正文」和「提交」分成两轮对话——一次做完，否则容易忘提交。
- 若用户要连写多章，每章都要走完整闭环，不要攒着一起提交。
- 重提早于当前进度的旧章默认会被拒绝（防止状态卡与伏笔台账回退失真）；
  确要修正历史章节，传 \`force=true\` 进入「历史修正模式」——该模式忽略 deltas，只更新该章索引、摘要与字数（线别沿用原值）。`,
  },

  {
    name: 'webnovel-review',
    description: '审查章节质量与一致性，给出可执行的修改建议。',
    whenToUse: '用户说「检查这章 / 有没有问题 / 帮我审一下 / 会不会崩设定 / 这章写得怎么样」。',
    body: `# 审查章节

## 机器审查
调 \`webnovel_review chapter=N\`，得到六个维度的问题清单：

| 维度 | 检查什么 |
|---|---|
| 设定一致性 | 状态冲突（断手还握剑）、境界回退、已死角色出场 |
| 叙事连贯 | 与上一章的结尾场景是否衔接（同一场戏接着演不会误报） |
| 节奏 | 三线是否断档、是否连续多章单线推到底、本章字数是否够本书章均目标 |
| 大纲符合度 | 章纲要素是否都在正文出现 |
| 伏笔 | 到期未回收、埋了没登记 |
| 追读力 | 章末钩子、段落长度、对话比例 |

审查结果会落盘为该章的**审查记录**，提交时作为放行凭据；
审查之后正文又改过要重新审（系统按文本指纹核对，拿旧稿记录蒙混不过去）。

## 你的补充审查（机器判不了的）
在机器结果之上，你还要看：
- **OOC**：角色的言行是否符合人设？性格有没有为剧情让路？
- **爽点密度**：该爽的地方够不够爽？有没有憋屈太久？
- **信息密度**：有没有大段设定灌输？读者会不会跳读？
- **逻辑漏洞**：动机是否成立？巧合是否过多？

## 输出要求
- 按严重程度排序，**先说必须改的**
- 每条问题都给：问题 → 原文位置 → 具体怎么改
- 不要泛泛而谈「可以更精彩」，要具体到句子
- 审完问用户是否要按建议修改

## 批量审查
用户说「审一下最近几章」时，逐章调 \`webnovel_review\`，
最后汇总出**跨章的共性问题**（这比单章问题更有价值）。`,
  },

  {
    name: 'webnovel-query',
    description: '查询书里的任何事实：设定、角色、伏笔、时间线、章节内容。',
    whenToUse: '用户说「主角现在什么境界 / 某某是谁 / 那件事是哪一章写的 / 玉佩伏笔收了没 / 帮我查一下」。',
    body: `# 查询

## 按类型选 kind
调 \`webnovel_query kind=...\`：

| kind | 用途 | 常用参数 |
|---|---|---|
| \`status\` | 进度概览 | — |
| \`character\` | 角色卡 | \`name\`（不传=列全部） |
| \`foreshadowing\` | 伏笔台账 | \`status\` |
| \`chapter\` | 某章详情 + 事实变化 | \`chapter\` |
| \`setting\` | 设定集 | \`name\`（不传=列篇目） |
| \`timeline\` | 事件时间线 | \`limit\` |
| \`memory\` | 写作经验 | \`query\` |
| \`search\` | 全文检索 | \`query\` |

## 用法要点
- 问「哪一章写过 X」→ \`kind=search query="X"\`，会在正文/章纲/设定/摘要里找。
- 问「这个设定是什么」→ 先 \`kind=setting\` 列篇目，再取具体篇。
- 问「现在写到哪了」→ \`kind=status\`（或直接用 \`webnovel_status\`）。

## 注意
**动笔前拿上下文不要用这个工具**，要用 \`webnovel_context\`——
它会把大纲、状态、伏笔、前情一次性组装成任务书，而不是让你零散地查。`,
  },

  {
    name: 'webnovel-learn',
    description: '把有效的写法沉淀成长期记忆，后续章节自动复用。',
    whenToUse: '用户说「记住这个写法 / 以后都这样写 / 上次那个教训 / 读者反馈说要改 / 我的文风是」。',
    body: `# 沉淀写作经验

## 何时该沉淀
- 用户明确说「以后都这么写」
- 用户给了读者/编辑反馈，且适用于后续章节
- 你发现某个写法效果好（例如「短句打斗更带感」）
- 用户纠正了你的写作习惯（例如「别用太多感叹号」）

## 怎么记
调 \`webnovel_memory action=learn\`：
- \`kind\`：style（文风）/ technique（写法）/ setting（设定约定）/ feedback（反馈）/ character（人物把握）
- \`title\`：一句话概括
- \`content\`：**具体怎么做**（要可执行，别写「写得更好」这种废话）
- \`tags\`：便于检索
- \`chapter\`：来自哪一章

## 好例子
✅ 「动作场面用 8-15 字短句，避免长定语；打斗段落不超过 5 行」
✅ 「主角说话不用书面语，句尾常带「吧」「嘛」」
❌ 「要注意文笔」（不可执行）

## 检索
调 \`webnovel_memory action=recall query="打斗"\` 或 \`action=stats\` 看统计。

## 机制说明
沉淀过的经验会**自动出现在后续每章的写作任务书里**（第九节），
所以这是让 Agent「越写越懂你的书」的核心手段。`,
  },
];

/**
 * 注册技能。
 * @returns {Array<() => void>} disposers
 */
export function registerSkills(ctx) {
  const disposers = [];
  for (const skill of SKILLS) {
    disposers.push(ctx.skills.register({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      content: skill.body,
      source: 'custom',
      provider: 'dsh-webnovel-writer',
      invocation: { modelInvocable: true, userInvocable: true },
    }));
  }
  return disposers;
}

/** 技能名清单（供自检）。 */
export const SKILL_NAMES = SKILLS.map((s) => s.name);

/** 技能引用的工具名（供自检：确保技能里提到的工具都真实存在）。 */
export function referencedTools() {
  const found = new Set();
  for (const skill of SKILLS) {
    for (const m of skill.body.matchAll(/webnovel_[a-z_]+/g)) found.add(m[0]);
  }
  return [...found].filter((n) => TOOL_NAMES.includes(n) || n.startsWith('webnovel_'));
}
