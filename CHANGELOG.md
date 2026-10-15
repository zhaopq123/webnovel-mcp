# 变更记录

## [1.0.1] - 2026-10-14

真机写作时暴露的三个问题，全修了。

### 修复

- **提交参数放错位置会静默丢数据（最严重）**：模型很容易把 `summary` / `strand` / `hook` /
  `ending` 塞进 `deltas` 里（`deltas` 是开放对象，客户端 schema 拦不住）。旧实现直接忽略，
  后果是索引里 `strand` 变 `null`、前情提要没摘要、节奏统计失真——而且**毫无提示**。
  现在：自动把这些字段提到顶层，`deltas` 里不认识的键单独点名，缺 `summary` 会提醒补提交。
  返回里附一段「参数位置提醒」，让模型下次写对。
- **角色首次出场章号不再需要手工填**：`firstChapter` / `lastChapter` 不传就按当前章自动填，
  首次出场章号不会被后续出场覆盖。原来角色卡一直显示「首次出场：未记录」。
- **`deltas.characters[].patch` 的字段说明补全**（原来没提 `role` / `relation` / `firstChapter`，
  作者照文档写就丢字段）。
- **任务书卷标重复**：显示成「当前卷：第 1 卷 第一卷」。初始卷名置空，并新增
  `formatVolumeLabel()` 去掉卷名里重复的「第N卷」前缀（支持中文数字，如「第一卷 旧城」→「第 1 卷旧城」）。

### 构建与门禁（10-15 补进同一个未发布版本）

- **版本号只有一个真相源**：`mcp/protocol.mjs` 的 `SERVER_INFO.version` 原来是写死的
  `1.0.0`，而 CHANGELOG 已经走到 1.0.1 —— 结果 `/health` 和启动日志自报的版本号是假的，
  以后排查会照着错版本找代码。现在从 `package.json` 读，改一处就够。
- **`npm test` 修好**：`node --test test/` 在 Node 24 下把带斜杠的目录当**单个文件**，
  只会吐一句没有信息量的 `ERR_TEST_FAILURE`（README 原本把它甩锅给「沙箱 spawn EPERM」，
  也是错的）。改成无参自动发现，Windows/cmd 下不需要 shell 展开通配符。
- **验收脚本的清账出口**：三套验收跑完会在服务端书库留下测试书，而 MCP 没有删书工具、
  客户端删不掉 —— 生产书库因此攒过 8 本测试书。`live-check` 原来还写着「默认会删掉测试书」
  （从未实现）并带一个只控制打印的假 `--keep` 开关，两者一起删掉，改为跑完打印确切命令；
  新增 `webnovel-mcp-ctl clean [--force] <bookId>...` 做真正的删除（bookId 合法性 + 真实路径
  必须落在书库内，与服务端同一条规则；已写正文的书默认拒删，防手滑）。
- **部署脚本不再「传了包却没换人」**：守护是幂等的，端口在就不拉起，旧 `deploy-vivo.sh`
  在服务已运行时只解包不重启 —— 实测出现过「部署完成」但 `/health` 与 MCP 握手仍报
  1.0.0 的情况。现在检测到端口在监听就显式 `restart`，部署动作与生效绑在一起。
- **发布脱敏**：`deploy-vivo.sh` 的 `VIVO_HOST` 默认值是内网 IP、`VIVO_USER` 默认值是作者
  登录名，README 与 `live-check` 注释里也各有一处内网 IP —— 全部去掉，缺目标直接 `exit 2`
  点名缺哪个变量（沿用「不给假默认值」的既有教训）。`LICENSE` 与专家包署名改成
  `webnovel-mcp contributors`，不再带个人用户名。
- **新增 `test/repo-hygiene.test.mjs`（4 项）**：内网 IP / 64 位令牌 / 私钥 / 个人邮箱 /
  本机用户目录 / 本机登录名（从环境变量取，不写死在仓库里）扫描 + 版本一致性 +
  `npm test` 写法检查。**每条门禁都做了反例验证**（塞 IP 会变红、版本号改回 1.0.0 会变红、
  test 脚本写回旧写法会变红），不养恒真门禁。

### 测试

本地 136 项（提交容错 2 + 卷标 1 + 书名 1 + 书列表 1 + 仓库卫生门禁 4）；线上三套
黑盒/场景/健壮性（18 + 13 + 6）全绿，真机写作闭环跑通，部署实例与本地逐文件 md5 一致。

## [1.0.0] - 2026-10-14

从 DSH Desktop 插件 `dsh-webnovel-writer` 迁移为 WorkBuddy MCP。功能等价，部署形态变了。

### 新增

- **一个 MCP 服务**，10 个工具：`webnovel_init` / `webnovel_status` / `webnovel_books` /
  `webnovel_outline` / `webnovel_context` / `webnovel_commit` / `webnovel_query` /
  `webnovel_pacing` / `webnovel_review` / `webnovel_memory`。
  `webnovel_books` 是新增的（DSH 插件没有，MCP 需要它来发现 bookId）。
- **6 个 MCP 提示词**（原 6 个 DSH 技能）：`webnovel-init/plan/write/review/query/learn`，
  客户端不装专家也能拿到整套流程手册。
- **HTTP Streamable + stdio 双模式**，可选 Bearer 鉴权，`/health` 探活。
- **书库根目录 + 受限 bookId** 取代原来的 `projectRoot` 任意路径参数，并加 realpath 兜底。
- `scripts/deploy-vivo.sh`：一条命令部署到 Termux 手机（守护 + 自启 + token 沿用制）。
- `scripts/live-check.mjs` / `scenario-check.mjs` / `robustness-check.mjs` 三套黑盒/场景/健壮性验收。
- `expert/webnovel-coach/` 可选专家包（WorkBuddy 专家形态）。
- 测试：本地 123 项（协议层 15 项 + 契约层 7 项 + 端到端 40 项 + 单元 61 项）。

### 修复

- **审查规则漏掉最常见的伤情写法**：原来只认「受伤/废/断/未愈/不能动」，作者写
  「右臂骨裂，短期内无法用力」时抓不到「双手握剑」。词表扩为
  「裂|折|无法用力|使不上|用不上|抬不起|麻痹」。
- **书列表输出串行**：原来从状态行里 `find(l => l.includes('章'))`，把标题行当成进度行，
  输出成 `样书乙　《《乙》》　《《乙》》已写 0 章`。改用 `stats` 单独拼。
- **书名双重包裹**：标题本身带《》时会输出《《甲》》。新增 `wrapTitle()` 统一处理。

### 破坏性变更

- `projectRoot` 工具参数**移除**，改为 `bookId`（书库子目录名）。
- 不再支持 DSH Host 插件形态；`lib/tools.js`、`lib/prompt.js`、`lib/skills.js`（注册部分）
  的 DSH 依赖已剥离，技能正文以 `mcp/skills-src.mjs` 复用。

### 已知限制

见 `docs/ARCHITECTURE.md` 第 7 节（大章节检索为线性扫描、无跨设备同步、
stdio 模式在部分客户端不显示）。
