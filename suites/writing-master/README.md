# WritingMaster 套件（MCP 版，已并入本服务）

**这里只剩 MCP 版**。它的 13 个 `wm_*` 工具已经**融合进 webnovel-mcp 本身**：
同一个服务、同一个连接、同一个 token，`tools/list` 会同时返回 13 个 `webnovel_*` 和 13 个 `wm_*`。
不需要再起第二个进程，也不需要单独配置。

| 位置 | 是什么 |
|---|---|
| `writing-master-mcp-suite/` | 套件本体（引擎 `scripts/wm.js` + 薄壳 `scripts/mcp-server.mjs` + 82 切片 + 29 模板 + 655 条自测） |
| `lib/features/wm-bridge.mjs` | 桥接层：每次 `wm_*` 调用拉起一次子进程，走 JSON-RPC 转发，**不复制任何校验逻辑** |
| `mcp/wm-tools.generated.mjs` | 13 个工具的 schema，由 `node scripts/gen-wm-tools.mjs` 从上游生成，禁止手改 |
| `test/wm-bridge.test.mjs` | 漂移门禁：上游 schema 变了没重新生成 → 红 |

**Skill 版不在这里**：它在独立仓库 https://github.com/zhaopq123/writing-master
（给能读文件、能跑 bash 的 Agent 用，入口是 `bash scripts/wm-*.sh`）。

## 两族工具别混账本

| | 账本目录 | 工具前缀 |
|---|---|---|
| webnovel-mcp（本体） | `.webnovel/` | `webnovel_*` |
| WritingMaster 套件 | `.wm/` | `wm_*` |

同一本书只挂一套。`wm_*` 认的是作品目录 `dir`（不是书库里的 `bookId`），所以两套数据物理隔离。

## 改了套件怎么同步

```bash
node scripts/gen-wm-tools.mjs          # 上游 schema 变了就重跑，再提交 mcp/wm-tools.generated.mjs
node scripts/gen-wm-tools.mjs --check  # CI 里的对账（不一致就红）
bash suites/writing-master/writing-master-mcp-suite/tests/run.sh   # 套件自己的 655 条用例
```
