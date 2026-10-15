# expert/ · 网文写作搭档 + 网文质检员（WorkBuddy 专家包）

MCP 是「手」，这两个专家包是「操作手册」。装了它们，WorkBuddy 按固定闭环帮你写长篇：
写手取任务书 → 写 → 查重 → 自审 → 提交事实增量；质检员次日独立只读验收，报告追加进当日手记。

**不装专家包，MCP 的 11 个工具照样能用**，只是 WorkBuddy 不知道什么时候该调哪个。

| 专家 | 角色 | 何时上场 |
|---|---|---|
| `webnovel-coach`（网文写作搭档） | 写作+自检+commit+手记 | 「写下一章 / 开新书」；无人值守日更 21:00 |
| `webnovel-reviewer`（网文质检员） | 独立只读验收（R1-R8 清单），只报不修 | 「验收今天的章节」；无人值守验收 22:00 |

> 为什么验收要独立专家：写手自检是「运动员兼裁判」，读感项自检是自欺。
> reviewer 用 fresh context 复跑写手的自报项（字数/章号/查重/事实链），并对账设定。
> 详见工作区《网文日更-验收机制设计-20261016.md》。

## 包结构（WorkBuddy 专家格式 v2.0）

```
expert/webnovel-coach/        # 写手
expert/webnovel-reviewer/     # 质检员（只读）
├── .codebuddy-plugin/
│   └── plugin.json          专家清单（categoryId=06-ContentCreative，agent 型）
├── agents/
│   └── webnovel-*.md        专家正文：coach=无人值守条款+铁律+工具地图+开书+写章闭环；
│                             reviewer=无人值守验收+R1-R8 清单+只读铁律+降级路径+输出格式
└── avatars/
    └── expert.png           头像（512×512，≤500KB）
```

> 2026-10-15 起从旧 DSH 插件格式（`plugin.json` + `dsh` 字段）迁移为 WorkBuddy 开放平台专家格式。
> 旧版本用户请以本目录为准重新导入。

## 安装（WorkBuddy）

方式一 · 专家中心导入（推荐）：

1. 打开 WorkBuddy 左侧边栏「专家 · 技能 · 连接器」→「专家」→「我的专家」→「创建专家」；
2. 把本目录（`expert/webnovel-coach/` 或 `expert/webnovel-reviewer/`）打包为 zip 提交，或按引导补全信息；
3. 在「我的专家」里确认「网文写作搭档」「网文质检员」已存在即可召唤。

方式二 · 放到专家目录（本地开发用）：

```bash
mkdir -p ~/.workbuddy/plugins/marketplaces/my-experts/plugins
cp -r expert/webnovel-coach expert/webnovel-reviewer ~/.workbuddy/plugins/marketplaces/my-experts/plugins/
```

> 历史上本文件写的 `~/.workbuddy-ai/skills/` 路径有误，正确位置是上面的专家目录；
> 以 skill 形式安装（`~/.workbuddy/skills/`）也能触发，但**不要与专家同时安装**，会双触发。

装完重开会话，说「帮我开一本新书」即可。校验安装是否生效：

```bash
node --test test/contract.test.mjs    # 确认专家正文引用的工具名与 MCP 实现一致
```

## 专家正文引用的工具

`webnovel_init` / `webnovel_status` / `webnovel_books` / `webnovel_outline` /
`webnovel_context` / `webnovel_commit` / `webnovel_query` / `webnovel_pacing` /
`webnovel_review` / `webnovel_memory` / `webnovel_doctor`

> `test/contract.test.mjs` 会断言「专家正文提到的工具必须真实存在」，防止文档与实现脱节。

## 维护约定

- 改工具名 → 同步改 `agents/webnovel-coach.md`、`agents/webnovel-reviewer.md` 和 `mcp/tool-names.mjs`，然后跑契约测试
- 改写作流程 → 只动 `agents/webnovel-coach.md`，MCP 实现不用动
- 改无人值守条款 / 查重闸门 / 去 AI 味铁律 → 只动 `agents/webnovel-coach.md`（L0 流程引擎层）
- 改验收清单 / 只读铁律 → 只动 `agents/webnovel-reviewer.md`
- 专家包版本必须与 `package.json` 对齐（repo-hygiene 门禁遍历 expert/ 下所有专家）
- MCP 的 6 个 prompts 与专家正文同源，改流程时两边一起改，或者只改一边然后跑
  `node --test test/contract.test.mjs`
