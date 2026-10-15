# expert/ · 可选专家包（长篇网文写作搭档）

MCP 是「手」，这个专家包是「操作手册」。装了它，WorkBuddy 会按固定闭环帮你写长篇：
取任务书 → 写 → 自审 → 提交事实增量，而不是每次凭运气调工具。

**不装专家包，MCP 的 10 个工具照样能用**，只是 WorkBuddy 不知道什么时候该调哪个。

## 包结构

```
expert/webnovel-coach/
├── plugin.json          包描述（category=content，capability=prompt）
└── agents/
    └── webnovel-coach.md 专家正文：铁律 + 工具地图 + 开书流程 + 写章闭环 + 审查 + 经验沉淀
```

## 安装（WorkBuddy）

WorkBuddy 的专家包统一放在技能目录下：`~/.workbuddy-ai/skills/`（用户级）或项目内
`.workbuddy-ai/skills/`（项目级）。把 `expert/webnovel-coach/` 整个目录复制进去即可：

```bash
mkdir -p ~/.workbuddy-ai/skills
cp -r expert/webnovel-coach ~/.workbuddy-ai/skills/webnovel-coach
```

然后重开一个会话，说「写第 1 章」即可触发。校验安装是否生效：

```bash
node --test test/contract.test.mjs    # 确认专家正文引用的工具名与 MCP 实现一致
```

## 专家正文引用的工具

`webnovel_init` / `webnovel_status` / `webnovel_books` / `webnovel_outline` /
`webnovel_context` / `webnovel_commit` / `webnovel_query` / `webnovel_pacing` /
`webnovel_review` / `webnovel_memory`

> `test/contract.test.mjs` 会断言「专家正文提到的工具必须真实存在」，防止文档与实现脱节。

## 维护约定

- 改工具名 → 同步改 `agents/webnovel-coach.md` 和 `mcp/tool-names.mjs`，然后跑契约测试
- 改写作流程 → 只动 `agents/webnovel-coach.md`，MCP 实现不用动
- MCP 的 6 个 prompts 与专家正文同源（都来自原 DSH 插件的 6 个技能），
  改流程时两边一起改，或者只改一边然后跑 `node --test test/contract.test.mjs`
