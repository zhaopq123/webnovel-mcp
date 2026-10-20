# webnovel-mcp · 长篇网文写作助手（MCP）

[![CI](https://github.com/zhaopq123/webnovel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zhaopq123/webnovel-mcp/actions/workflows/ci.yml)

> **你负责想故事，我负责记住所有事。**
> 把 19 节创作提示词变成可执行的闭环：按阶段取规则 → 动笔前发任务书 → 写完提交事实链 →
> 审查门禁放行。零运行时依赖，项目是纯文本，数据全在你自己的机器上。

---

## 它解决什么问题

用 AI 写长篇，一定会遇到：

- 写到第 180 章，AI 让**第 42 章就被废了右手**的主角「双手握剑」。
- 第 12 章埋的玉佩伏笔说好第 60 章揭晓，写到第 200 章**再也没出现过**。
- 编辑说「感情线太少」，你回头数，发现已经 **60 章没写过女主**。
- 每开一个新会话，AI 都**从零开始重新认识你的书**。

根因不是模型不聪明，是**记忆没有落地**：上下文一压缩，设定就没了。
这个 MCP 把「设定、伏笔、时间线、进度」变成**磁盘上的结构化数据**，
每次动笔前自动组装成一份「写作任务书」交给 Agent；创作规则本身按阶段切片供给，
不把 3 万字提示词每次灌进上下文。

---

## 30 秒接入

任选一种方式（对应「分发矩阵」里的前两种形态）：

```json
"webnovel": {
  "type": "streamableHttp",
  "url": "http://<主机>:8600/mcp",
  "headers": { "Authorization": "Bearer <token>" },
  "timeout": 240000
}
```

或本机 stdio：

```json
"webnovel": {
  "command": "node",
  "args": ["/绝对路径/webnovel-mcp/server.mjs", "--stdio"],
  "env": { "WEBNOVEL_ROOT": "/绝对路径/books" }
}
```

连上后直接说人话：

```
帮我开一本新书，都市异能，主角能看见别人头顶的倒计时，目标 200 万字
写第 1 章
主角现在什么境界？
玉佩那条伏笔收了没？
查一下节奏
```

---

## 12 个工具

| 工具 | 什么时候用 |
|---|---|
| `webnovel_init` | 开新书（建骨架；回报带体量结构换算：几部/几卷/章数） |
| `webnovel_status` | 「写到哪了 / 接下来做什么」——结构换算、部进度与倒计时、按优先级排的待办 |
| `webnovel_books` | 书库里有哪几本书 / 切换书 |
| `webnovel_outline` | 总纲 / **部纲** / 卷纲 / **章纲** / 保存正文 / 当日手记；`write_part` 登记部，`archive_part` 归档部摘要；`read` 必须显式传 `scope` |
| `webnovel_context` | **动笔前**拿写作任务书（含本章必守规则切片） |
| `webnovel_commit` | **写完后**提交事实增量（状态/角色档案/伤病与持有物/伏笔/悬念/支票/红鲱鱼/时间线/专名/视角与知情变化） |
| `webnovel_query` | 查角色 / 伏笔 / 设定 / 时间线 / 专名 / 全文检索 |
| `webnovel_pacing` | 节奏体检（三线占比与断档） |
| `webnovel_review` | 审查某一章（一致性 + 归属 + 信息隔离 + 文风 / AI 味 + 可选外部查重），结果落盘并作为提交凭据 |
| `webnovel_craft` | **查创作提示词**：地图 / 按节取 / 按阶段装配 / 设定记录落点 / 自检 |
| `webnovel_memory` | 沉淀 / 检索写作经验（自动进后续任务书）；`action=baseline` 设定或重建文风基准 |
| `webnovel_doctor` | 机器态体检 / 从提交链重放重建 / 老书迁移对账（`reconcile`，登记迁移基线） |

### v1.4.0：老书能升级，审查更硬

- **迁移基线**：`doctor action=reconcile` 把提交链之外手工维护的人物、伏笔、专名登记为
  `.webnovel/commits/_baseline.json`，只修正文路径/字数/进度这类客观引用；rebuild 和新章节都在
  基线上叠加，不再逼你删数据。缺章、多账、正文缺失一律拒绝，不掩盖。
- **8.2 信息隔离**：`pov` + `deltas.knowledge` 机械核对「谁怎么知道、能不能用、能不能说」；
  违反 review 🔴、commit 默认拦截，知情状态跨章重放。
- **3.6⑧ 扩展**：角色卡新增 `condition`（伤病）与 `items[]`（持有物）；错位伤病、非持有者使用
  会报，泛称句、长名遮蔽、无字段老卡不误伤。
- **AI 味 + 外部查重**：review 每章查套话密度、句长过匀、抽象名词链、「不是 A 而是 B」；
  `plagiarism=true` 抽 10–16 字特征句调 websearch MCP，未配置/不可达会明说「未执行，不等于通过」。
- **文风漂移**：首次提交自动建基准，每 30 章对比句长/段长/对话占比/标点密度，漂移写报告并报警；
  `webnovel_memory action=baseline` 可人工覆盖或从正文重建。
- **2.1 调整说明**：重复 `init` 改目标体量时输出旧→新 diff（部/卷/层级/悬念层等），同值静默。
- **`hinted` 证据 + 悬念层级**：暗示必须能在本章正文里找到证据；悬念层必须按
  短→卷→部→跨部→全书 逐级开。

关键机制一句话：**审查记录**——`webnovel_review` 的结果会落盘，`webnovel_commit`
凭它放行（还有未处理的 🔴 会被拒绝）；**状态尾**——每次工具返回末尾附带最新状态行，
没有系统提示钩子的裸客户端也丢不了上下文；**体检**——提交链是唯一事实来源，
怀疑「系统记的」和「实际写过的」对不上时，`webnovel_doctor` 重放对账给你看。

另外提供 6 个 MCP 提示词（`prompts/list`）：`webnovel-init` / `webnovel-plan` / `webnovel-write` /
`webnovel-review` / `webnovel-query` / `webnovel-learn` —— 客户端不装任何专家包也能拿到整套流程手册。

---

## 19 节能力地图

《小说创作全流程协作提示词》原文逐字保存在 `prompt/CREATIVE-PROMPT.md`（sha256 锁），
经 `webnovel_craft` 切片供给。**能机械核对的落进工具；设计、文风、读感仍是 agent 执行项**，
工具不假装能判。

| 节 | 讲什么 | 在工具里的落点 |
|---|---|---|
| 第 1 节 总则 | 防幻觉三铁律、合规红线 | `craft` 原文；任务书「本章必守」每次携带；`commit`/`review` 门禁 |
| 第 2 节 体量自适应 | 字数 → 部/卷/章/层级/洋葱/悬念账户换算 | `init`/`status` 结构换算表（只算不存）；重复 `init` 输出调整说明；`state.progress.parts[]` 部表；`parts` 倒计时 |
| 第 3 节 逻辑一致性 | 五条追踪线、信息差、因果链、每章八问 | `review` 一致性 + 3.6⑧ 归属核对（含伤病/持有物）；`doctor` 对账提交链；任务书状态卡 |
| 第 4 节 读者钩子 | 悬念账户、五种钩子、还债、支票管理 | 钩子落 `index`；悬念/支票/红鲱鱼进 `foreshadowing.json`；`hinted` 证据核对与悬念层递进校验；债务账进 `status` |
| 第 5 节 真相与反转 | 情理之中、意料之外、二次爆炸、串联引爆 | 设计靠 agent（`craft` 原文）；落地后由 `review` 的伏笔/大纲符合度兜底 |
| 第 6 节 人物立体化 | 三维、内在矛盾、语言指纹、反派线、关系五级 | `state.characters` 档案 + `dossier` 缺口；任务书档案快照；3.6⑧ |
| 第 7 节 感情线节拍器 | 六拍、心动写法、误会与咬合 | 阶段规则随任务书注入；节奏线别统计进 `pacing`；设计靠 agent |
| 第 8 节 视角制式 | 单视角/多视角、全书锁定 | `pov` + `deltas.knowledge` 由 `review` / `commit` 机械核对信息隔离；视角切换的叙事设计仍靠 agent |
| 第 9 节 流程总控 | 五级闭环，上一级输出是下一级输入 | 工具链本身就是闭环：`context → write_text → review → commit → status` |
| 第 10 节 阶段 1 核心设定 | 开场四问、核心设定表、俗套声明 | `craft brief stage=stage1`；`init` 骨架；`write_master` |
| 第 11 节 阶段 2 世界观 | 世界观与层级体系 | `craft brief stage=stage2`；设定集模板；`terms` 专名账本 |
| 第 12 节 阶段 3 人物 | 按第六节建档 | `craft brief stage=stage3`；`commit deltas.characters` 档案字段 |
| 第 13 节 阶段 4 路线图 | 全书路线图 + 当前部三幕大纲 | `write_part`（部纲）+ `write_volume`（卷纲）；`craft brief stage=stage4` |
| 第 14 节 阶段 5 章纲 | 每批 10 章，章纲八行 | `write_chapter`；`context` 把本章章纲列为「法律」；缺章纲即 blocker |
| 第 15 节 阶段 6 正文 | 结构、句式、对话、去 AI 味、两遍交付 | `context` 自动装配本章必守切片；`review` 查 AI 味/钩子/段落，可选外部查重；`craft get id=15.5/15.8` |
| 第 16 节 阶段 7 完本修订 | 终章后的全书修订 | `craft brief stage=stage7`；修订是 agent 执行项，工具只保数据一致 |
| 第 17 节 连载状态报告 | 每 10 章一份，卷末/部末合并结算 | `status` 随时取进度；`craft brief stage=report`；部结算走 `archive_part` |
| 第 18 节 交互协议 | 我的回答方式、确认节点、交付节奏 | MCP 提示词与 `craft brief stage=protocol`；工具返回文案统一说人话 |
| 第 19 节 设定记录 | 20 张表的格式与增量维护 | `craft action=map` 逐表给落点；`state` / `index` / 台账 / `terms` / 摘要分区承接 |

> 想看逐节原文：`webnovel_craft action=get id=<节号>`；看全部切片：`action=sections`。
> 原文与切片库不一致时 `action=check` 会当场报红（`scripts/build-prompt-catalog.mjs --check` 同口径）。

---

## 按阶段取规则

不用记 19 节全文。任务书默认已经装配本章要用的切片（预算 2400 字，超了会点名缺哪节），
需要更多时按阶段取：

| 阶段 | 什么时候用 | 取法 |
|---|---|---|
| 开工协商 | 开书前问清体量/题材/视角/感情线 | `webnovel_craft action=brief stage=negotiate` |
| 阶段 1-3 | 核心设定 → 世界观 → 人物建档 | `stage=stage1` / `stage2` / `stage3` |
| 阶段 4 | 全书路线图 + 当前部三幕大纲 | `stage=stage4`（或中文「部纲」「大纲」） |
| 阶段 5 | 章纲（每批 10 章） | `stage=stage5`（或「章纲」） |
| 阶段 6 | 正文写作（两遍交付制） | `webnovel_craft action=brief stage=stage6` |
| 阶段 7 | 完本修订 | `stage=stage7`（或「修订」） |
| 连载报告 | 每 10 章 / 卷末 / 部末 | `stage=report` |
| 设定记录 | 20 张表该落哪 | `action=map` |
| 交互协议 | 回答方式与确认节点 | `stage=protocol` |

单节精确取：`action=get id=15.5`（去 AI 味）、`id=15.8`（两遍交付）、`id=3.6`（逻辑自检）、
`id=2.5`（部摘要）。想看所有切片号用 `action=sections`。

预算旋钮：`WEBNOVEL_BRIEF_RULES_CHARS`（默认 2400，上限 6000），或 `WEBNOVEL_BRIEF_RULES=off`。
**压缩只压装配量，不压判据**：被截掉的切片会点名，不会静默丢规则。

---

## 分发矩阵（四形态，专家包不替代工具）

| 形态 | 给谁 | 怎么装 | 怎么验 |
|---|---|---|---|
| **WorkBuddy 专家包** `expert/` | WorkBuddy，要「双专家 + 定时日更」 | 专家中心导入 `expert/webnovel-coach/`、`expert/webnovel-reviewer/`（见 [expert/README.md](expert/README.md)） | `node --test test/contract.test.mjs` + `test/repo-hygiene.test.mjs` |
| **SKILL.md** `skills/` | Qoder / Claude 等有技能系统的客户端 | 把 `skills/webnovel-craft/SKILL.md`、`skills/webnovel-coach/SKILL.md`、`skills/webnovel-reviewer/SKILL.md` 连同目录拷进客户端的 skills 目录 | `node --test test/distribution.test.mjs`（front-matter/切片号） |
| **纯文本整段** `prompt/paste-any-agent.md` | 什么插件/MCP 都没有的 agent | 整段粘贴进系统提示词或自定义指令 | `node scripts/build-dist.mjs --check`（与原文逐字符一致） |
| **AGENTS.md 片段** `prompt/agents-md-snippet.md` | 能连 MCP、但没有专家/技能系统的客户端 | 贴进 `AGENTS.md` / `CLAUDE.md` / Qoder 自定义指令，并填好 MCP 连接串 | 说「查一下网文状态」，能返回书库即通 |

四份都只是「操作手册」，规则原文始终只有 `prompt/CREATIVE-PROMPT.md` 一份；
专家包与 SKILL 里需要规则时一律 `webnovel_craft` 取，不抄正文。

---

## 附带套件：WritingMaster 双套装

`suites/writing-master/` 收录第三方写作套件 WritingMaster **2.0.0**（13 条命令 / 82 张知识切片 /
29 个交付模板 / 4 大赛道 —— 长篇（含言情模式）/ 剧本 / 剧本杀 / 工具书 / 655 条自测），
原样直入、**与主体互不依赖**：删掉 `suites/` 本仓照常运行，反之亦然。两套装按客户端能力二选一：

| 套装 | 给谁 | 入口 |
|---|---|---|
| `suites/writing-master/writing-master-skill-suite/` | 能读文件、能跑 bash 的 Agent（满血版） | `skills/writing-master/SKILL.md` |
| `suites/writing-master/writing-master-mcp-suite/` | 只认 MCP 的客户端 | `scripts/mcp-server.mjs`（13 个 `wm_` 工具） |

**别混账本**：主体状态在 `.webnovel/`，套件在 `.wm/`，同一本书只挂一套。装机与自检见
[suites/writing-master/README.md](suites/writing-master/README.md)。

---

## 两种运行方式

### 1. 局域网 / 手机部署（推荐，多个客户端共用）

```bash
VIVO_HOST=<手机IP> VIVO_USER=<ssh 用户> bash scripts/deploy-vivo.sh
```

部署脚本会：打包传输（**不含 `config.env`**）→ **保留/补全 `config.env`，绝不重写**（缺 token
才生成整份，已有则先备份再只追加缺的键）→ 安装 `webnovel-mcp-guard` / `webnovel-mcp-ctl` →
启动服务 → 登记开机自启 → 打印连接器配置（token 打码）。

`VIVO_HOST` / `VIVO_USER` **没有默认值**，缺了直接 `exit 2` 点名缺哪个——这是要 ssh 进你
手机的脚本，写死示例 IP 既泄漏作者环境，又把「忘了配」变成一句看不懂的超时报错。

手机侧运维：

```bash
webnovel-mcp-ctl status | restart | stop | logs | token | books
webnovel-mcp-ctl clean [--force] <bookId>...   # 删书（已写正文的要显式 --force）
```

### 2. 本机 stdio（不需要常驻服务）

见上方「30 秒接入」的第二种配置。

---

## 升级（把这个链接丢给别的 Agent 就够）

**书库不动**：升级只替换代码，`books/` 与 `config.env` 从不参与覆盖。把下面这段直接发给
装着本工具的 Agent 即可：

> 读 https://github.com/zhaopq123/webnovel-mcp 的 README「升级」一节，把当前部署升到最新版：
> 先 `git pull` 拿到新代码，再按原来的部署方式重启；升级前后用 `/health` 比对 `version`。
> **不要删 `books/` 和 `config.env`**，也不要把书库挪进仓库目录。

按部署方式选一条：

| 你怎么跑的 | 怎么升 |
|---|---|
| 本机 stdio / 局域网常驻 | `git pull` → 重启客户端里的 server 进程（MCP 配置不用改） |
| 手机 / 服务器（`deploy-vivo.sh`） | `VIVO_HOST=<IP> VIVO_USER=<用户> bash scripts/deploy-vivo.sh`（幂等：保留 `books/`、保留 `config.env`、自动 restart） |
| 只用客户端形态（专家包 / SKILL / 纯文本） | 重新导入 `expert/`，或重拷 `skills/`；规则原文只有 `prompt/CREATIVE-PROMPT.md` 一份，不用手动同步 |

升完确认：

```bash
curl -s http://<host>:<port>/health      # version 应为新版本号
```

版本与兼容性：

- **数据**：`.webnovel/` 结构向后兼容，老书无需迁移；要补登记手工数据的迁移基线，
  用 `webnovel_doctor action=reconcile`（见 v1.4.0 变更说明）
- **1.6.0 起附带套件 WritingMaster 升 2.0**：言情不再单列赛道，套件的
  `--track romance` 改成 `--track novel --genre romance`（旧参数仍可用并提示迁移）；
  套件账本 `.wm/` 与主体 `.webnovel/` 互相独立，互不迁移
- **降级**：代码可回退到任意 tag，但已经被新版写过的账本不要指望旧版全认——升级前先备份 `books/`

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
| `WEBNOVEL_BRIEF_RULES` | `on` | 任务书里的「本章必守」提示词切片；设 `off` 整块不带 |
| `WEBNOVEL_BRIEF_RULES_CHARS` | `2400` | 上面那块切片的字数预算（上限 6000）；**按优先级取到装不下为止**，被截掉的会点名并指路 `webnovel_craft`，不会静默丢规则 |
| `WEBNOVEL_STRUCTURE` | `summary` | `webnovel_status` 的体量结构换算块详略：`summary` 三行 / `full` 整张表 / `off` 不带（单次调用可用 `structure=` 参数覆盖） |
| `WEBNOVEL_SEARCH_URL` | 空 | 外部查重用的 websearch MCP 地址（如 `http://127.0.0.1:8300/mcp`）。不配 = 查重明示「未执行」，不假装通过 |
| `WEBNOVEL_SEARCH_TOKEN` | 空 | 上面那个服务的 Bearer token，只存服务端、不回显 |
| `WEBNOVEL_SEARCH_TIMEOUT_MS` | `12000` | 单次查重工具调用超时（毫秒） |

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
├── 大纲/      总纲.md · 部纲/第1部.md · 卷纲/ · 章纲/
├── 正文/      第0001章-夜航.md
└── .webnovel/ state · index · foreshadowing · terms · memory · summaries · reviews · parts
               commits/（含 `_baseline.json` 老书迁移基线）
               style-baseline.json（风格漂移基线，首次 review 或 memory 重建时生成）
```

`.webnovel/` 里只有两样「不是投影」的东西：`commits/_baseline.json`（接管老书时
`doctor action=reconcile` 用当前机器态写下的起点，doctor 重放要以它为底）和 `style-baseline.json`
（文风锚点，首次审查自动校准，也可用 `memory action=baseline` 人工重设）。这两个文件删了
不会丢正文，但老书重建和风格告警会失去参照。

全是纯文本：能读、能改、能 git、能随时打包带走。

---

## 文档

- **[使用手册](docs/GUIDE.md)**：从零装好、开书、日更到完结的完整操作路径（面向使用者，先读这个）
- **[服务部署与配置](docs/USAGE.md)**：启动参数、环境变量、两种运行方式细节
- **[日更自动化配置单](docs/AUTOMATION.md)**：三条定时任务照抄即建，双专家双闸说明
- **[架构说明](docs/ARCHITECTURE.md)**
- **[专家包安装](expert/README.md)** · **[分发四形态](#分发矩阵四形态专家包不替代工具)** · **[19 节能力地图](#19-节能力地图)**

---

## 开发与测试

**提交前必跑四条**（`.github/workflows/ci.yml` 跑的就是这几条，本地绿了再推）：

```bash
npm test                                        # ① 全部单测（自动发现 test/ 下文件；当前 380 个）
node scripts/build-prompt-catalog.mjs --check    # ② 提示词原文 ↔ 切片库 ↔ sha 锁三者一致
node scripts/check-rule-duplication.mjs          # ③ 规则正文全仓库只有一份（跨文件重复=0）
node scripts/build-dist.mjs --check              # ④ 纯文本分发版与原文逐字符一致
```

```bash
node scripts/build-prompt-catalog.mjs --selftest      # 判据自己能变红（防空转的绿）
node scripts/check-rule-duplication.mjs --selftest
node scripts/build-dist.mjs --selftest
node --test test/state.test.js            # 只想跑一个文件

node scripts/live-check.mjs http://<主机>:8600/mcp <token>       # 黑盒验收
node scripts/scenario-check.mjs http://<主机>:8600/mcp <token>   # 场景验收
node scripts/robustness-check.mjs http://<主机>:8600/mcp <token> # 健壮性
```

> 三套验收会在服务端书库留下测试书（MCP 没有删书工具，客户端删不掉），每个脚本跑完
> 会打印对应的 `webnovel-mcp-ctl clean ...` 命令，照着清就行。
>
> 不要用 `node --test test/`：Node 24 把带斜杠的目录参数当成**单个文件**，只会得到一句
> 没有信息量的 `ERR_TEST_FAILURE`。`npm test` 走的是无参自动发现。

---

MIT © 2026
