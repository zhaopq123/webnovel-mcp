# webnovel-mcp · 技术架构

> 版本 v1.0.0 ｜ 形态：一个 MCP 服务（HTTP Streamable + stdio 双模式）｜ 零运行时依赖

---

## 1. 分层与依赖

```
server.mjs            HTTP / stdio 入口（node:http，零依赖）
mcp/protocol.mjs      JSON-RPC 分发（initialize/tools/prompts/ping + 版本协商）
mcp/prompts.mjs       6 个写作流程提示词（复用 mcp/skills-src.mjs）
mcp/tools.mjs         10 个 MCP 工具 + 书库定位与路径守卫
mcp/tool-names.mjs    工具名清单（契约测试的基准）
lib/features/         领域逻辑：context / commit / query / pacing / review / memory / status / outline
lib/core/             存储（原子写+锁+迁移）、状态读写、项目骨架、路径守卫
lib/util.js           纯函数
```

依赖方向单向无环：`server → mcp → lib/features → lib/core → lib/util`。
`lib/` 全部只用 `node:` 内置模块 —— 这是刻意的：部署到手机/任何 Linux 时
**不需要 npm install**，`node server.mjs` 就能跑。

## 2. 传输与协议

| 模式 | 用法 | 场景 |
|---|---|---|
| Streamable HTTP | `POST /mcp`，响应 `application/json` | WorkBuddy 连接器（推荐） |
| stdio | `node server.mjs --stdio`，逐行 JSON-RPC | 本机客户端 |

- **版本协商**：客户端报的协议版本 ≥ `2024-11-05` 就原样回显（本服务只用 tools/prompts
  两组各版本形状一致的能力），否则回落 `2025-03-26`。
- **会话**：每次请求带 `Mcp-Session-Id`（缺失则现场生成一个），服务端**无状态**——
  不保存会话，重启不丢任何东西。
- **不提供** GET 事件流（405）与资源（`resources/list` 回空列表，避免部分客户端报错）。
- **鉴权**：`WEBNOVEL_TOKEN` 非空时校验 `Authorization: Bearer`；`/health` 永开放，
  返回书名数、书库路径、运行秒数，供守护脚本探活。

## 3. 数据边界（安全模型）

书库根目录（`WEBNOVEL_ROOT`）+ 受限 `bookId`：

```
bookId → /^[_A-Za-z0-9\u4e00-\u9fa5][-\w\u4e00-\u9fa5]{0,63}$/   # 中英文数字-_，不以 - 开头
       → path.join(booksRoot, bookId)
       → realpath 必须仍落在 realpath(booksRoot) 之内（符号链接/junction 逃逸在此被拦）
```

三层保护叠加：

1. **字符白名单** —— `../`、绝对路径、`.hidden`、超长名直接拒。
2. **realpath 兜底** —— 书库里被人放了一个指向 `/etc` 的符号链接也没用。
3. **工具本身不接路径参数** —— 没有「读这个文件」这种接口，只有书库内的相对操作。

写操作另有 `lib/core/store.js` 的三件套：临时文件 + rename 原子落盘、
跨进程锁文件（30s 陈旧锁抢占）、同进程按 bookId 串行。并发提交同一章实测 6 路全部成功且索引只 1 条。

## 4. 记忆模型

```
真源（人写）      设定集/ 大纲/ 正文/          → 随时可改、可 git
投影（机器算）    .webnovel/{state,index,foreshadowing,memory}/  → 删了可从正文重提
审计（只增不改）  .webnovel/commits/chNNNN.json
```

写作闭环：`webnovel_context`（按章组装任务书：章纲/前情/主角状态/角色/到期伏笔/
时间线/节奏/沉淀经验/硬约束）→ 写正文 → `webnovel_review`（六维一致性）→
`webnovel_commit`（把本章事实增量写进投影层）。

## 5. 部署形态

```
Termux 层（进 proot 会多一层 --kill-on-exit 的坑）
~/webnovel-mcp/
├── server.mjs / mcp/ / lib/ / deploy/run.sh
├── config.env        权限 600：ROOT / PORT / BIND / TOKEN / MAX_BODY
├── books/            书库
└── logs →  ~/logs/webnovel-mcp.log

$PREFIX/bin/webnovel-mcp-guard    tmux svc-webnovel + while 循环 + 端口幂等 + 日志滚动
$PREFIX/bin/webnovel-mcp-ctl      status | restart | stop | logs | token | books | clean
$PREFIX/bin/ubuntu-autostart      开机自启登记（幂等）
```

`scripts/deploy-vivo.sh` 一条命令完成：打包 → ssh 传包 → 写 config.env（首次生成 token，
重复部署**沿用旧 token**）→ 装 guard/ctl → 启动 → 健康检查 → 登记自启 → 打印连接器配置。
目标机 `VIVO_HOST` / 登录用户 `VIVO_USER` 必须显式给，缺了 `exit 2`，没有默认值。

`webnovel-mcp-ctl clean` 是验收测试书的唯一清账出口：bookId 过合法性与真实路径检查（和
服务端同一条规则），已写正文的书默认拒删，要 `--force`。

## 6. 测试金字塔

| 层 | 文件 | 覆盖 |
|---|---|---|
| 单元 | `test/util.test.js` `test/store.test.js` `test/state.test.js` | 纯函数、原子写、锁、路径守卫、状态归一化 |
| 端到端 | `test/e2e.test.js` | 建书→章纲→任务书→正文→审查→提交→查询全链路 + 安全边界 |
| 协议 | `test/protocol.test.mjs` | 真起 HTTP 服务走 MCP：握手、工具清单、通知、错误码、鉴权、并发、符号链接 |
| 契约 | `test/contract.test.mjs` | 工具名/ schema / bookId 规则 / 提示词引用 四者不许脱节 |
| 黑盒 | `scripts/live-check.mjs` `scenario-check.mjs` `robustness-check.mjs` | 对**已部署实例**以真实客户端身份跑：写作闭环、场景不崩、长文/并发/多书 |

## 7. 已知限制

- 单章正文很大时（几万字）`review` 的全文检索是线性扫描，百万字级会有感——
  当前按「一本书 ≤2000 章」设计，超出时提示分卷。
- 跨设备不同步：数据只在部署机上。用 git 管 `books/` 即可自己同步。
- stdio 模式在部分客户端（WorkBuddy 桌面版）不显示在连接器列表里，因此默认推荐 HTTP。
