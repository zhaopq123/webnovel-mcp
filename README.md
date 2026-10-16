# webnovel-mcp · 长篇网文写作助手（MCP）

> **你负责想故事，我负责记住所有事。**
> 给 AI 写作加上「不会忘的设定库」：写作任务书 + 章节提交链 + 伏笔台账 + 节奏体检 + 一致性审查。
> 零运行时依赖（只用 Node 内置模块），项目是纯文本，数据全在你自己的机器上。

---

## 它解决什么问题

用 AI 写长篇，一定会遇到：

- 写到第 180 章，AI 让**第 42 章就被废了右手**的主角「双手握剑」。
- 第 12 章埋的玉佩伏笔说好第 60 章揭晓，写到第 200 章**再也没出现过**。
- 编辑说「感情线太少」，你回头数，发现已经 **60 章没写过女主**。
- 每开一个新会话，AI 都**从零开始重新认识你的书**。

根因不是模型不聪明，是**记忆没有落地**：上下文一压缩，设定就没了。

这个 MCP 把「设定、伏笔、时间线、进度」变成**磁盘上的结构化数据**，
每次动笔前自动组装成一份「写作任务书」交给 Agent。

---

## 30 秒接入 WorkBuddy

在 `~/.workbuddy-ai/mcp.json`（以及 `~/.workbuddy/mcp.json`）的 `mcpServers` 里加一条：

```json
"webnovel": {
  "type": "streamableHttp",
  "url": "http://<主机>:8600/mcp",
  "headers": { "Authorization": "Bearer <token>" },
  "timeout": 240000
}
```

然后在 WorkBuddy 的**连接器管理**里点**信任**，重启会话。之后直接说人话：

```
帮我开一本新书，都市异能，主角能看见别人头顶的倒计时，目标 200 万字
写第 1 章
主角现在什么境界？
玉佩那条伏笔收了没？
查一下节奏
```

---

## 11 个工具

| 工具 | 什么时候用 |
|---|---|
| `webnovel_init` | 开新书（建骨架） |
| `webnovel_status` | 「写到哪了 / 接下来做什么」 |
| `webnovel_books` | 书库里有哪几本书 / 切换书 |
| `webnovel_outline` | 定总纲 / 卷纲 / **章纲** / 保存正文 |
| `webnovel_context` | **动笔前**拿写作任务书 |
| `webnovel_commit` | **写完后**提交事实增量 |
| `webnovel_query` | 查角色 / 伏笔 / 设定 / 时间线 / 全文检索 |
| `webnovel_pacing` | 节奏体检（三线占比与断档） |
| `webnovel_review` | 审查某一章（六维一致性） |
| `webnovel_memory` | 沉淀 / 检索写作经验 |
| `webnovel_doctor` | 机器态体检 / 从提交链重放重建 |

关键机制一句话：**审查记录**——`webnovel_review` 的结果会落盘，`webnovel_commit`
凭它放行（还有未处理的 🔴 会被拒绝）；**状态尾**——每次工具返回末尾附带最新状态行，
没有系统提示钩子的裸客户端也丢不了上下文；**体检**——提交链是唯一事实来源，
怀疑「系统记的」和「实际写过的」对不上时，`webnovel_doctor` 重放对账给你看。

另外提供 6 个 MCP 提示词（`prompts/list`）：`webnovel-init` / `webnovel-plan` / `webnovel-write` /
`webnovel-review` / `webnovel-query` / `webnovel-learn` —— 客户端不装任何专家包也能拿到整套流程手册。

---

## 两种运行方式

### 1. 局域网 / 手机部署（推荐，多个客户端共用）

```bash
VIVO_HOST=<手机IP> VIVO_USER=<ssh 用户> bash scripts/deploy-vivo.sh
```

部署脚本会：打包传输 → 生成 `config.env`（含 token，权限 600）→ 安装
`webnovel-mcp-guard` / `webnovel-mcp-ctl` → 启动服务 → 登记开机自启 → 打印连接器配置。

`VIVO_HOST` / `VIVO_USER` **没有默认值**，缺了直接 `exit 2` 点名缺哪个——这是要 ssh 进你
手机的脚本，写死示例 IP 既泄漏作者环境，又把「忘了配」变成一句看不懂的超时报错。

手机侧运维：

```bash
webnovel-mcp-ctl status | restart | stop | logs | token | books
webnovel-mcp-ctl clean [--force] <bookId>...   # 删书（已写正文的要显式 --force）
```

### 2. 本机 stdio（不需要常驻服务）

```json
"webnovel": {
  "command": "node",
  "args": ["/绝对路径/webnovel-mcp/server.mjs", "--stdio"],
  "env": { "WEBNOVEL_ROOT": "/绝对路径/books" }
}
```

---

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBNOVEL_ROOT` | `./books` | **书库根目录**。服务只在这个目录里读写 |
| `WEBNOVEL_PORT` | `8400` | HTTP 监听端口 |
| `WEBNOVEL_BIND` | `0.0.0.0` | 监听地址；只给本机用就设 `127.0.0.1` |
| `WEBNOVEL_TOKEN` | 空 | 非空则要求 `Authorization: Bearer <token>`；`/health` 免鉴权 |
| `WEBNOVEL_MAX_BODY` | 32MB | 单次请求体上限（提交整章正文用得到） |
| `WEBNOVEL_STATUS_FOOTER` | `full` | 工具返回末尾的状态行；设 `off` 关掉（只留「（书：id）」省 token） |

---

## 安全边界

1. **书库根目录 + 受限 bookId**：`bookId` 只允许中英文/数字/`-`/`_`，且解析结果必须
   （经 `realpath`）落在书库内 —— 路径穿越、绝对路径、符号链接逃逸都会被拒绝。
2. **不读调用方的文件系统**：工具是「内容进、内容出」，没有「传个路径让我读」这种接口。
3. **写操作原子 + 加锁**：临时文件 + rename 落盘，跨进程锁文件，并发提交同一章不会写坏数据。
4. **`.webnovel/` 是投影**：真源永远是 `正文/` + `大纲/`，删了也能重新提交出来。
5. 建议只在家里的局域网用，不要映射到公网。

---

## 数据长什么样

```
books/我的小说/
├── 设定集/    世界观.md · 力量体系.md · 主角卡.md · 金手指.md
├── 大纲/      总纲.md · 卷纲/ · 章纲/
├── 正文/      第0001章-夜航.md
└── .webnovel/ state / index / foreshadowing / memory / commits / summaries / reviews
```

全是纯文本：能读、能改、能 git、能随时打包带走。

---

## 文档

- **[使用手册](docs/GUIDE.md)**：从零装好、开书、日更到完结的完整操作路径（面向使用者，先读这个）
- **[服务部署与配置](docs/USAGE.md)**：启动参数、环境变量、两种运行方式细节
- **[日更自动化配置单](docs/AUTOMATION.md)**：三条定时任务照抄即建，双专家双闸说明
- **[架构说明](docs/ARCHITECTURE.md)**

---

## 开发与测试

```bash
npm test                                  # = node --test（自动发现 test/ 下全部文件）
node --test test/state.test.js            # 只想跑一个文件

node scripts/live-check.mjs http://<主机>:8600/mcp <token>       # 黑盒验收 18 项
node scripts/scenario-check.mjs http://<主机>:8600/mcp <token>   # 场景验收 20 项
node scripts/robustness-check.mjs http://<主机>:8600/mcp <token> # 健壮性 6 项
```

> 三套验收会在服务端书库留下测试书（MCP 没有删书工具，客户端删不掉），每个脚本跑完
> 会打印对应的 `webnovel-mcp-ctl clean ...` 命令，照着清就行。
>
> 不要用 `node --test test/`：Node 24 把带斜杠的目录参数当成**单个文件**，只会得到一句
> 没有信息量的 `ERR_TEST_FAILURE`。`npm test` 走的是无参自动发现。

---

MIT © 2026
