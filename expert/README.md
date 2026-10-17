# expert/ · 网文写作搭档 + 网文质检员（WorkBuddy 专家包）

MCP 是「手」，这两个专家包是「操作手册」。装了它们，WorkBuddy 按固定闭环帮你写长篇：
写手取任务书 → 写 → 查重 → 自审 → 提交事实增量；质检员次日独立只读验收，报告追加进当日手记。

**创作规则不在这两个文件里重复**：它们来自 `prompt/CREATIVE-PROMPT.md`（19 节原文，sha 锁定），
专家正文只写「什么时候做什么、用哪个工具」，需要规则时由 `webnovel_craft`
按阶段/按节取原文。规则只有一份，不会两处漂移。

**不装专家包，MCP 的 12 个工具照样能用**，只是 WorkBuddy 不知道什么时候该调哪个。
其他客户端的三种分发形态见仓库根 README 的「分发矩阵」。

| 专家 | 角色 | 何时上场 |
|---|---|---|
| `webnovel-coach`（网文写作搭档） | 写作 + 自检 + commit + 手记 | 「写下一章 / 开新书」；无人值守日更 21:00 |
| `webnovel-reviewer`（网文质检员） | 独立只读验收（R1-R8 清单），只报不修 | 「验收今天的章节」；无人值守验收 22:00 |

> 为什么验收要独立专家：写手自检是「运动员兼裁判」，读感项自检是自欺。
> reviewer 用 fresh context 复跑写手的自报项（字数/章号/查重/事实链），并对账设定。
> 详见 `02_交付件/webnovel/网文日更-验收机制设计-20261016.md`。

## 包结构（WorkBuddy 专家格式 v2.0）

```
expert/webnovel-coach/        # 写手
expert/webnovel-reviewer/     # 质检员（只读）
├── .codebuddy-plugin/
│   └── plugin.json          专家清单（categoryId=06-ContentCreative，agent 型）
├── agents/
│   └── webnovel-*.md        专家正文：coach=无人值守条款+铁律+12 工具地图+开书/写章闭环；
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

> **⚠️ 只拷目录不够（2026-10-16 实测）**：WorkBuddy 扫描本地专家市场按
> `~/.workbuddy/plugins/marketplaces/my-experts/.codebuddy-plugin/marketplace.json`
> 的 `plugins` 名单枚举——**名单里没有的包对 UI 完全不存在**。首次安装新专家
> 必须在该清单的 plugins 数组加一行 `{ "name": "<专家名>", "source": "./plugins/<专家名>",
> "description": "<一句话>" }`，然后重启 WorkBuddy。完整安装链共五处
> （市场清单 / marketplace 目录 / cache 快照 / installed_plugins.json /
> experts/custom/<用户id>/experts.json），走方式一的 UI 导入则全部自动完成——
> **不确定就选方式一**。

> 历史上本文件写的 `~/.workbuddy-ai/skills/` 路径有误，正确位置是上面的专家目录；
> 以 skill 形式安装（`~/.workbuddy/skills/`）也能触发，但**不要与专家同时安装**，会双触发。
> 想用 skill 形态，请改用仓库 `skills/` 下的三份 SKILL.md。

装完重开会话，说「帮我开一本新书」即可。校验安装是否生效：

```bash
node --test test/contract.test.mjs        # 专家正文引用的工具名必须真实存在
node --test test/repo-hygiene.test.mjs    # 专家包版本必须与 package.json 对齐
node --test test/distribution.test.mjs    # 四形态文件齐全、front-matter 合规、引用可解析
```

## 专家正文引用的工具（12 个）

`webnovel_init` / `webnovel_status` / `webnovel_books` / `webnovel_outline` /
`webnovel_context` / `webnovel_commit` / `webnovel_query` / `webnovel_craft` /
`webnovel_pacing` / `webnovel_review` / `webnovel_memory` / `webnovel_doctor`

> `test/contract.test.mjs` 会断言「专家正文提到的工具必须真实存在」，防止文档与实现脱节。

## 维护约定

- 改工具名 → 同步改 `agents/webnovel-coach.md`、`agents/webnovel-reviewer.md`、`mcp/tool-names.mjs`
  和三份 `skills/*/SKILL.md`，然后跑契约测试
- 改写作流程 → 只动 `agents/webnovel-coach.md`（以及 skill 版），MCP 实现不用动
- 改创作规则 → **只改 `prompt/CREATIVE-PROMPT.md` 并重锁**；不要往专家正文里抄
- 改验收清单 / 只读铁律 → 只动 `agents/webnovel-reviewer.md`（以及 skill 版）
- 专家包版本必须与 `package.json` 对齐（repo-hygiene 门禁遍历 expert/ 下所有专家）
