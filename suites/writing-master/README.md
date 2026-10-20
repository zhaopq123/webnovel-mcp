# 附带套件 · WritingMaster 写作大师（双套装）

**定位：外挂套件，不是 webnovel-mcp 的依赖。** 本目录原样收录 WritingMaster 双套装，
与仓库主体（MCP 服务、19 节提示词、专家包、skills）**互不引用、互不依赖**——
删掉整个 `suites/` 目录，主体照常运行；反之亦然。

| 套装 | 给谁 | 与另一套装的关系 |
|---|---|---|
| `writing-master-skill-suite/` | 有技能系统（读文件 + 跑 bash）的 Agent：WorkBuddy / Claude Code / Cursor / Cline | **满血版**，推荐 |
| `writing-master-mcp-suite/` | 只认 MCP 协议的客户端：Claude Desktop / Cursor MCP | 同引擎 + `scripts/mcp-server.mjs` 翻译壳（13 个 `wm_` 工具） |

两套装内容几乎同源（同一份 `knowledge/`、`templates/`、`scripts/`、`skills/`），
差别只在 README 与 `tests/` 的运行产物；`mcp-suite` 里 `skills/` 用不上但保留。

## 内含规模（实测）

- 82 张知识切片（`knowledge/slices/`，带 `index.json` + `lock.json` 指纹锁）
- 29 个交付模板（`templates/`，覆盖 novel / romance / screenplay / jubensha / toolbook 五赛道）
- 6 个技能（`skills/writing-master` 主路由 + 5 个 `wm-*` 赛道）
- 13 条命令（`scripts/wm-*.sh`）+ 1 个 Node 引擎（`scripts/wm.js`，零第三方依赖）
- 605 条自测（`tests/`，可删，删了不影响使用）

## 装机

**skill 套装（满血版）**

```bash
cd suites/writing-master/writing-master-skill-suite
bash scripts/wm-init.sh --track novel --title 冒烟测试 --target-words 300000 --dir /tmp/wm-smoke
bash scripts/wm-doctor.sh --dir /tmp/wm-smoke
```

再把 `skills/writing-master/SKILL.md` 的路径写进 Agent 的系统提示，或让 Agent
在写作需求时先读该文件（详见包内 `README.md`）。

**mcp 套装**

```json
{
  "mcpServers": {
    "writing-master": {
      "command": "node",
      "args": ["<绝对路径>/suites/writing-master/writing-master-mcp-suite/scripts/mcp-server.mjs"]
    }
  }
}
```

握手自检：`echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node scripts/mcp-server.mjs`
应列出 13 个 `wm_` 工具（`wm_init`…`wm_verify`）。

## 与 webnovel-mcp 主体的边界（重要）

两套系统的**账本目录不同、状态不互通**，不要把同一本书同时挂在两套里：

| | 状态目录 | 命令/工具 |
|---|---|---|
| webnovel-mcp（主体） | `.webnovel/` | `webnovel_*` 12 个 MCP 工具 |
| WritingMaster（本套件） | `.wm/` | `wm_*` 13 个命令/工具 |

## 来源与处理说明

- 版本：WritingMaster 1.2.0（`mcp-server.mjs` 自报版本号），双套装原包直入，**未改任何逻辑内容**
- 文件名修复：原始 zip 未置 UTF-8 标志，常规解压在 Windows 上会把 29 个中文模板名解成乱码
  （且乱码重名互相覆盖，只剩 12 个）。本目录是按 UTF-8 正确还原后的完整版，29 个模板齐全
- **ESM 作用域隔离**：本仓根 `package.json` 声明了 `"type": "module"`，而套件引擎
  `scripts/wm.js` 是 CommonJS（`require` 写就）。原样放进来会被当 ESM 解释，直接
  `ReferenceError: require is not defined` 全线熄火。所以两个套装根各放了一份
  `package.json`（`{"type": "commonjs"}`）把作用域切回来——**引擎与技能内容一行未改**，
  只加了这个隔离层。单独把套装拷出仓外使用也不受影响
- **判重门禁豁免**：套件的 `knowledge/source/novel-full.md` 与 26 张 `novel-*` 切片，
  内容就是本仓 `prompt/CREATIVE-PROMPT.md` 的整份/分段拷贝（同一份 19 节原文）。
  仓库的「规则正文全仓库只有一份」门禁会因此判红，已在 `scripts/check-rule-duplication.mjs`
  里把 `suites/` 列为豁免目录：套件是独立产品，它的知识库漂移由自己的
  `knowledge/lock.json` 指纹锁负责（`wm_verify` 每次都会校验），不归本仓单一原文原则管
- **运行产物不收录**：原包自带的 `tests/.tap.txt`、`tests/.run.log` 是跑测机器的日志
  （里面写着那台机器的绝对路径，进了公开仓就触发卫生门禁），本次只保留 `tests/REPORT.md`
  ——「605/605 全绿」的统计与逐 case 明细都在里面，`bash tests/run.sh` 随时可重跑
- 本套件不参与本仓 `node --test`（用例是 bash 写的，走 `tests/run.sh`）
