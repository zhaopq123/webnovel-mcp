# 变更记录

## [1.5.0] - 2026-10-20

这版只做一件事：**把 WritingMaster 双套装挂进仓库**。主体 12 个工具、19 节提示词、
现有 `skills/` `expert/` `prompt/` 一行未动；`suites/` 与主体互不引用、互不依赖，
删掉它本仓照常运行。

### 新增

- **`suites/writing-master/`**：原样收录 WritingMaster 1.2.0 双套装——
  `writing-master-skill-suite/`（满血版：13 条 `wm-*` 命令、82 张知识切片、29 个交付模板、
  6 个技能、605 条自测）与 `writing-master-mcp-suite/`（同引擎 + `scripts/mcp-server.mjs`
  翻译壳，13 个 `wm_` 工具，给只认 MCP 的客户端）。
- **`suites/writing-master/README.md`**：两套装怎么选、装机三步、自检命令，以及
  **账本边界**——主体状态在 `.webnovel/`、套件在 `.wm/`，同一本书只挂一套，避免双账本打架。
- 根 README 增「附带套件：WritingMaster 双套装」段；`package.json` 的 `files` 加入 `suites`，
  发布物带得上套件。

### 修复

- **分发包中文文件名乱码**：原始 zip 未置 UTF-8 标志（352 个条目全是 0x0），Windows 常规解压
  会把 29 个中文模板名解成 GBK 乱码，且不同原名塌缩成同一乱码名互相覆盖，实际只剩 12 个模板。
  本次按 `cp437 → UTF-8` 还原文件名后收录：29 个模板齐全，262 个同名文件 sha256 全等；
  原解压里 34 个模板已丢、另有 24 个以乱码名顶着。
- **ESM 作用域冲突**：仓根 `package.json` 是 `"type": "module"`，套件引擎 `scripts/wm.js`
  是 CommonJS，原样放入会 `ReferenceError: require is not defined` 直接熄火（实测）。
  两个套装根各加一份 `package.json`（`{"type": "commonjs"}`）做作用域切分，引擎代码未改。

### 调整

- **判重门禁豁免 `suites/`**：套件 `knowledge/source/novel-full.md` + 26 张 `novel-*` 切片
  就是本仓 `prompt/CREATIVE-PROMPT.md` 的整份/分段拷贝，`check-rule-duplication` 会判 40 处
  「原文照抄」。套件是独立产品，漂移由它自己的 `knowledge/lock.json` 指纹锁负责，
  故在 `SKIP_DIRS` 里加 `suites`（带注释说明口径）。豁免面只限这一个目录，
  `skills/` `expert/` `lib/` 照旧受管。
- **运行产物不入仓**：`.tap.txt` / `.run.log` 是跑测机器日志（含绝对路径，进仓即触发卫生门禁），
  不收录；`tests/REPORT.md` 保留作 605/605 的凭证。`.gitignore` 加
  `suites/**/tests/.tap.txt`，防止下次跑测又把产物带进来。

### 说明

- 仓库版本统一到 1.5.0（`package.json`、`CHANGELOG`、两个专家包 `plugin.json` 同步）；
  MCP `serverInfo.version` 仍从 `package.json` 读取，不另设真相源。
- 回归：`node --test` 380 条全绿（改动前后一致）；套件侧 `wm-init` + `wm-doctor`（D01–D08
  通过、D04 空名词表警告属预期）、MCP stdio 握手 + `wm_init` 实调闭环均已实测。

## [1.4.0] - 2026-10-17

这版的主题：**把「未闭环」清零**。老书可以带着提交链之外的人工数据安全升级；
审查补上归属核对、AI 味与外部查重；提示词第 8.2 节的信息隔离、第 2.1 节的体量调整说明，
从「靠 Agent 自觉」变成工具能机械核对或直说的东西。

### 新增

- **doctor `action=reconcile` + 迁移基线**：老书里手工维护的人物卡、伏笔台账、专名不再被当成
  「对不上账」逼着删。reconcile 先只读体检确认确有可修差异，再备份（`.webnovel/trash/`），
  只修客观引用（失效正文路径按章号找回、索引字数/标题、进度章号/总字数），最后把当前
  state / index / ledger / terms 登记为 `.webnovel/commits/_baseline.json`（`kind=state-baseline`、
  `basedOnChapter`、`reason`）。重放时基线按章号整份接管，之后的新章节继续在基线上叠加；
  rebuild 不再丢人工数据。索引缺章/多章、提交记录损坏、正文缺失、坏基线一律拒绝——
  reconcile 不掩盖数据缺失。
- **2.1 目标体量调整说明**：已有书重复 `init` 改 `targetWords` / `targetChapters` 时，
  输出「旧值 → 新值」及部数、每部章数区间、卷数、大层级、洋葱层、悬念层、弧光段、归档次数的
  变化；同值重跑、未传目标值、老项目缺字段三种情况静默，不误报。
- **`hinted` 证据核对 + 悬念层级递进**：`deltas.foreshadowing.hinted` 接受
  `{ name|id, evidence }`；evidence 必须是本章正文（去空白）的子串，找不到就拒绝登记并点名。
  旧字符串格式继续兼容但提示补证据。`ledger` 新增 `suspense-layer-skip`：
  启用的悬念层必须按 短→卷→部→跨部→全书 逐级开，1 部书禁用跨部/全书层。
- **文风漂移自动对比（15.6）**：新增 `lib/features/style.js`，指标为平均句长、句长标准差、
  平均段长、对话占比、标点密度；首次提交自动建 `.webnovel/style-baseline.json`（前 5 章取平均），
  每 30 章对比一次，超阈值写 `.webnovel/reviews/style-chNNNN.json` 并在 commit / status / review
  报警。`webnovel_memory action=baseline` 支持人工设定或从正文重建，人工基准优先。
- **多视角信息隔离（8.2）**：提交支持 `pov` 与 `deltas.knowledge[{who,fact,mode,witnessedBy?,toldBy?,evidence?}]`。
  `learn` 必须有目击或转述来源，转述人必须自己先知道；`use` / `reveal` 必须已登记 `knows`
  且不在 `notKnows`。违反 review 🔴，commit 默认拦截（`force` 可过但不写入被拒条目）；
  knows/notKnows 随提交链跨章重放。
- **3.6⑧ 剩余三类归属**：角色卡新增 `condition`（伤病状态）与 `items[]`（持有物品）。
  伤病只在「角色名与冲突动作同句」时报红（按伤处匹配动作，已愈不算）；物品在「使用动词 +
  物品名 + 命名角色」同句、且当场没有登记持有者时告警；泛称句、无字段老卡不判；
  长名遮蔽（「陈三娘」不算「陈三」）。
- **审查新增 AI 味与外部查重**：`ai-flavor` 维度用四类启发式（套话黑名单密度、句长过于均匀、
  抽象名词链、连续「不是 A 而是 B」），样本 <400 字不判。`webnovel_review plagiarism=true`
  从正文抽 10–16 字特征句（专名/低频词优先），经 `WEBNOVEL_SEARCH_URL` 调 websearch MCP；
  ≥10 字连续相同判命中，有结果但无连续相同记「待人工确认」；未配置/不可达明确写
  「未执行，不等于通过」。手写零依赖 Streamable HTTP 客户端，支持 JSON / SSE。

### 改进

- **部署脚本不覆盖 `config.env`**：`scripts/deploy-vivo.sh` 打包时排除 `config.env`；
  线上已有配置只补缺失键、不改现值，并在改动前留 `.bak`。此前整份重写会丢掉后加的
  `WEBNOVEL_SEARCH_*`，属于升级事故隐患。
- **审查输出**：新增 `信息隔离` / `AI 味` / `外部查重` 维度；审查记录落盘查重摘要
  （`executed / reason / phrases / searched / hits / pending / partial`）。
- **工具描述与 schema**：`webnovel_commit` 补 `condition` / `items` / `pov` / `knowledge`；
  `webnovel_review` 补 `plagiarism`；`webnovel_doctor` 补 `reconcile` 与 `reason`；
  `webnovel_memory` 的 action 列表补 `baseline`。

### 测试

- 全量 **380/380 绿**（14.7s），连跑两轮无抖动；升级前 316 条全部保留。
- 新增 7 个测试文件 64 条：`doctor-reconcile`（10）、`structure-adjust`（4）、
  `ledger-hint`（8）、`style`（7）、`knowledge`（8）、`ownership-extended`（15）、
  `plagiarism`（12）。
- 四道门禁全绿：`build-prompt-catalog --check`（19 节 / 92 切片 / 22181 字）、
  `check-rule-duplication`（跨文件重复 0）、`build-dist --check`（逐字符一致），
  三个 `--selftest` 均能自己变红。
- 本地黑盒：`live-check` 28/28、`scenario-check` 20/20、`robustness-check` 6/6；
  另做老数据演练（手工人物/台账/专名 + 坏索引 → check 红 → reconcile → 绿 →
  rebuild 保留 → 再提交一章仍绿，正文 sha 不变）。

## [1.3.0] - 2026-10-17

这版的主题：**把 19 节创作提示词变成可执行的数据模型**。原文逐字入库、构建成 92 个切片，
由第 12 个工具按阶段装配；原先只写在提示词里的【设定记录】20 张表，逐张落到持久化结构。
专家包只保留「角色 + 流程 + 指路」，不再抄规则正文——规则从此只有一份。

### 新增

- **`prompt/CREATIVE-PROMPT.md`（原文）+ `prompt/catalog.json`（92 切片）+ sha256 锁**：
  原文是唯一事实来源，切片由 `scripts/build-prompt-catalog.mjs` 生成；`--check` 校验三者一致，
  `--selftest` 8 项证明判据能红（含拼接还原逐字符一致）。
- **第 12 个工具 `webnovel_craft`**：`sections` / `get` / `brief` / `map` / `check`。
  11 个阶段包（开工协商、阶段 1-7、连载报告、设定记录、流程协议），认中文阶段说法；
  超预算时显式声明截断并指路 `action=get`，不静默丢规则。
- **写作任务书接入「本章必守」**：按优先级装配提示词切片，默认预算 2400 字（`WEBNOVEL_BRIEF_RULES_CHARS`
  可调，`WEBNOVEL_BRIEF_RULES=off` 可关）；装配说明与硬约束始终保留，切片库缺失时告警但不阻断写作。
- **专名账本 `terms`**（铁律 1）：`.webnovel/terms.json` 持久化；commit 接受 `deltas.terms[]`，
  正文启发式点名「疑似未登记专名」（保守误报口径，只 warning 不 block）；query `kind=term` 可查；
  老书无账本照常读，doctor 重放可对账。
- **体量自适应引擎**：按目标字数现算部数/卷数/大层级/洋葱层/悬念账户层（2.2、2.3 公式），
  `webnovel_status` 默认给三行摘要、`structure=full` 展开全表；目标字数与章数打架时 🔴 点名，
  并把建议值算给作者。只算不存，避免制造第二份真相。
- **叙事债务账本**：伏笔台账升级为四类（伏笔/悬念/支票/红鲱鱼），带层级、暗示章、到期章；
  余额不足、长期无暗示、支票逾期、红鲱鱼缺真实解释分别判定，阈值集中在 `LEDGER_THRESHOLDS`。
- **人物档案扩展**（第六节）：三维、内在矛盾、语言指纹、关系推进五级、`knows/notKnows/mistaken`
  信息表、主角 `humanFlaws`；3.6⑧ 归属核对覆盖「说话人」与「秘密知情者」两类，
  章节带 🔴 时 commit 不放行（可显式 `force`）。
- **部（part）结构层**：`outline action=write_part` / `archive_part`，读 `scope=part|part_summary`；
  部摘要硬限 15 个非空行，落 `.webnovel/parts/`；status 与任务书显示当前位置，倒数 10 章提醒收尾；
  未建部的老书不编部号。
- **四形态分发**：WorkBuddy 专家包、`skills/*/SKILL.md` ×3、`prompt/paste-any-agent.md`（整段纯文本）、
  `prompt/agents-md-snippet.md`（AGENTS.md / 自定义指令 + MCP 配置模板）。
  粘贴版由 `scripts/build-dist.mjs` 从原文生成，手改即红。

### 改进

- **专家包去重**：coach / reviewer 重写为「角色 + 闭环 + 工具地图 + 取规则指路」，
  规则正文一律 `webnovel_craft` 取；reviewer 的 R1 字数线改为对照本书章均目标，
  R5 接入 3.6⑧ 归属核对，R6 明确五类事实增量，R7 补齐 `scope=note|part|part_summary`。
- **README**：新增「19 节能力地图」「按阶段取规则」「分发矩阵」三段，工具表补到 12 个；
  明确四条提交前门禁，并标注四项「需 agent 执行、工具不假装能做」的诚实缺口。
- **CI** 增加纯文本分发版一致性检查与自测；`package.json` 的 `files` 补上 `prompt` / `skills` / `expert`，
  打包后 `webnovel_craft` 仍能读到切片。
- 版本三处对齐：`package.json`、MCP `serverInfo`、两个专家包 `plugin.json` 均为 1.3.0。

### 测试

- 全量 **316/316 绿**，连跑 3 轮无抖动；新增 `parts`、`distribution` 等判据，既有 309 条全部保留。
- 四条门禁：`npm test` / `build-prompt-catalog --check` / `check-rule-duplication`（重复条文数=0）/
  `build-dist --check`，各自配 `--selftest` 或反例自证。

## [1.2.4] - 2026-10-16

这版的主题：**修 1.2.3 的假缺口**——`scope=note` 早就有了，是调用方没传 scope 静默降级到总纲，
读回来的不是手记，于是被 reviewer 判成「工具缺口」，白挂了 3 小时。

### 修复

- **`action=read` 不传 scope 时静默降级**：历史行为是省略 scope 就落 `master`（给了 chapter 才落章纲），
  调用方拿到一份**内容完整但项不对**的返回值，无从察觉。现在返回值尾部附一行提示
  ——「未指定 scope，本次读的是总纲/章纲。要读别的请显式传 scope：master / volume / chapter / text / note」，
  把静默降级变成可见。显式传 scope 时**不出现**这行（否则是噪音）。默认落点本身不变，不破坏既有调用。
- **工具描述补齐五个 scope 取值与搭配参数**（`master` 总纲／`volume` 卷纲(volume=N)／
  `chapter` 章纲(chapter=N)／`text` 正文(chapter=N)／`note` 手记(date=YYYY-MM-DD，缺省今天)），
  并注明省略会默认落总纲——schema 自己说清楚，不靠调用方记忆。
- **reviewer 专家 R7/R8 补scope 必传**：R7 读手记写明 `scope=note`、R8 读正文写明 `scope=text`
  （原文只写 `action=read`，agent 无从判断该传什么）。
  同时加一条自查规则：**不得把会话内的工具 schema 快照当产品缺陷上报**——
  MCP schema 是会话初始化时的快照，看到枚举缺值先直连验证一次。
  2026-10-16 的 R7 误报正是这条缺失导致的。
- **coach 专家工具表补scope 取值表**；**USAGE 手册第3 节新增 scope 取值表 + 「不传默认读总纲」提示**。
- 新增回归测试：省略 scope 必带提示行（总纲/章纲两种文案）／显式传 scope 不带提示行，全量 185/185。

## [1.2.3] - 2026-10-16

这版的主题：**R7 验收闭环补全——手记读回**（reviewer 首跑全量验收提出的工具缺口）。

### 新增

- **`webnovel_outline action=read` 新增 `scope=note`**：读回当日手记，与 `write_note` 对称。
  `date` 可选（缺省今天，服务器本地时区）；非法日期与 write_note 同一防线硬拒绝；
  无手记返回明确提示不报错。reviewer 的 R7（手记六段闭环核查）从此可自动核验，
  不再「读不回、如实记黄」。
- 新增导出 `readNote(root, date)`；新增回归测试走完整 MCP 分发链
  （读回一致 / 无手记提示 / 路径逃逸拒绝），全量 184/184。

## [1.2.2] - 2026-10-16

这版的主题：**两个实测抓出的功能 bug 修复**（第 1-4 章真实写作回归发现）。

### 修复

- **`write_text` 不传 title 时文件名落「未命名」**：根因有两层——工具层没兜底，
  且 `sanitizeFilename('')` 自带「未命名」兜底（那是给书名用的）把空串又变回非空。
  现在 title 缺省时从正文一级标题（`# xxx`）自动提取，两者皆空才回落无后缀文件名。
  新增 `deriveTitleFromText`（导出，可测试）。
- **`webnovel_commit` 的 `deltas.timeline` 传数组时台账静默读空**：数组被展开成数字键，
  time/location/event 全空，时间线出现「第 N 章｜｜｜」。现在数组会被合并为一条
  （time/location 取首个非空，event 用「；」串联），单对象传法不变。新增
  `normalizeTimeline`（导出）；工具描述同步注明「每章一条，传数组会合并」。

### 测试

- 新增 2 条回归：title 缺省取 H1（含显式优先与无标题回落两个分支）、
  timeline 数组合并（含单对象照旧）。全量 183/183。

## [1.2.1] - 2026-10-16

这版的主题：**当日手记落盘（无人值守验收凭据）+ 独立验收专家 + 版本真相源修复**。

### 新增（MCP 服务）

- `webnovel_outline` 新增 `action=write_note`：当日手记落盘，追加写 `手记/YYYY-MM-DD.md`
  （`date` 可选，缺省今天；同日二次调用文末追加；非法日期硬拒绝，防路径穿越）。
  无人值守日更的闭环从此有盘上凭据——作者终审不用翻对话记录。
- 新书骨架增加 `手记/` 目录（`paths.js` DIRS.notes + init ensureDir）；老书首次调用自动建目录。
- 试跑第 2 章抓到的 bug：缺省日期原用 `toISOString()`（UTC），UTC+8 的凌晨会落到前一天——
  改为服务器本地时区取日，测试同步改本地时区口径。

### 新增（expert/ 专家包）

- **`webnovel-reviewer`（网文质检员）**：只读独立验收专家，与写作专家构成双闸——
  写作专家自检是「运动员兼裁判」，读感项自检是自欺；reviewer 用 fresh context 复跑它的自报项。
  每日 automation 22:00 触发（写作 21:00 后），跑 8 项清单：R1 字数硬线 / R2 章号连续 /
  R3 AI 味 13 词全文扫描 / R4 查重复跑 / R5 设定一致性（能力边界/主角状态/已故角色三高危点）/
  R6 事实链完整 / R7 手记自检闭环 / R8 读感抽读（只出建议不判红，终审权在人）。
  结论（通过/有条件通过/打回）以固定格式 `write_note` 追加进当日手记；P1 项同步
  `memory kind=feedback` 沉淀，次日任务书自动带上。周日自动升级周检（设定四篇全书对账+
  伏笔台账 planted 超 10 章提醒+节奏体检）。铁律：只读，唯一写通道是 write_note 与
  memory kind=feedback；只报不修；MCP 不可达直说不猜。
- **`docs/AUTOMATION.md`（日更自动化工作流配置单）**：三条 automation（写作 21:00 /
  验收 22:00 / 大纲提前量体检周日 20:00）的照抄即建配置单，含双专家双闸架构说明、
  bookId 写死的理由（失败模式对比）、换书/开第二本的操作序、诚实边界。
  工作流定义进仓库，书籍产物只在本地设备。

### 修复

- **版本号真相源**：1.2.0 只改了 CHANGELOG 和专家包，`package.json` 停在 1.1.0，
  服务自报版本号是假的。本版三处（package.json / 专家包 / CHANGELOG）对齐到 1.2.1。
- `repo-hygiene` 测试读取专家包版本的路径随格式迁移更新为 `.codebuddy-plugin/plugin.json`；
  版本真相源从「只查 coach」升级为**遍历 expert/ 下所有专家包**，漏对齐一个就是假版本
  （反例自测通过：把 reviewer 版本改错，门禁确实红）。
- 契约测试补实 README 承诺但原本为空的防线：扫描 `expert/*/agents/*.md` 里的 `webnovel_*` 工具名引用，
  写错工具名（如把 outline 的 action 写成独立工具）直接红——上线当天就抓到 reviewer 正文里
  一个 `webnovel_write_text` 假工具名。测试 180→181。

### 变更（expert/ 专家包，同版本追加）

- coach 无人值守模式新增第 7 条「先看验收报告再动笔」：续接状态后读最近一份手记的验收报告段，
  🔴 必修项里能机械修的当次避开同类写法，设定级的写手记催作者——验收闭环从「报告」走到「修复」。
- reviewer（网文质检员）与 coach 双闸注册；`expert/README.md` 改为双专家说明。

## [1.2.0] - 2026-10-15

这版的主题：**专家包迁移 WorkBuddy 专家格式 + 无人值守日更闭环**。MCP 服务本身无改动。

### 新增（expert/ 专家包）

- **迁移为 WorkBuddy 开放平台专家格式 v2.0**（`.codebuddy-plugin/plugin.json` +
  `agents/` + `avatars/`），agent 型，categoryId=06-ContentCreative，
  旧 DSH 格式（`plugin.json` + `dsh` 字段）移除。
- **无人值守条款（L0 流程引擎层）**：定时日更场景下——醒来先 `status`+`context` 续接、
  有 blocker 停笔并留「待作者决策」、所有假设写进当日手记、**查重闸门**
  （commit 前标志性段落过搜索，命中现有作品即重写）、**去 AI 味硬规则**
  （禁用词表/四字词堆砌/俗套比喻/章末总结式收束，单段 80-200 字）、
  **当日手记固定格式**（写了什么/砍了什么/审查结论/查重/明日待办/待决策项）。
- 开书流程适配多品类：设定集 4 篇改为「世界观/主角卡/核心设定（能力边界）/
  关系与主线」通用结构，附末世系统流与女频的适配说明。
- `expert/README.md` 重写：修正安装路径（`~/.workbuddy-ai/skills/` → 专家目录
  `~/.workbuddy/plugins/marketplaces/my-experts/plugins/`），补专家中心导入方式，
  明确专家与 skill 二选一防双触发。

### 修复

- 专家正文工具列表补上 `webnovel_doctor`（v1.1.0 起已有，正文漏列）。

## [1.1.0] - 2026-10-15

这版的主题：**让「没有插件功能的客户端」（裸 API / 纯 stdio）也能安全地写长篇**。
四个 P0 问题 + 一个 P1 体检工具，全部来自与 lingfengQAQ/webnovel-writer 的对照排查。

### 新增

- **`webnovel_doctor` 机器态体检与重建（第 11 个工具）**：
  - `action=check`（只读）：把提交链完整重放一遍，逐项对账状态卡 / 索引 / 伏笔台账 /
    正文文件 / 摘要文件，并扫出骨架里未填的占位符。报错按 🔴🟡⚪ 分级。
  - `action=rebuild`：从提交链重放重建机器态。先自动备份到 `.webnovel/trash/`；
    必须显式传 `confirm=true` 才动手；空提交链拒绝重建。记忆（memory.json）、
    审查记录（reviews/）、卷登记信息不属于提交链，一律不动。
  - 重放与实时提交共用同一个核心（`applyChapterFacts`）——「重放结果 == 现役机器态」
    是硬不变量，两边永不漂移。
- **状态双通道推送（L0 防忘）**：`webnovel_status` / `commit` / `query` / `pacing` /
  `review` / `memory` 的每次返回末尾都附带一行最新状态
  （书 id｜书名｜进度｜主角状态｜到期伏笔），无系统提示钩子的客户端也丢不了上下文；
  `initialize` 的 instructions 在书库恰好一本书时附上当前状态。
  用 `WEBNOVEL_STATUS_FOOTER=off` 可整体关掉（只留「（书：id）」省 token）。
- **`webnovel_review` 审查记录落盘 + `commit` 凭记录放行**：审查结果以文本指纹落盘为
  审查记录；提交时核对——还有未处理的 🔴 会被拒绝；改过正文要重新审查
  （拿旧稿记录蒙混不过去，行尾空白等编辑器噪音不误判）。没审过只提醒不阻断。
- **旧章重提防护**：重提早于当前进度的章节默认拒绝（防已回收伏笔复活、
  角色 lastChapter 回退）；确认修正传 `force=true` 进入「历史修正模式」——
  本次 deltas 忽略，只更新该章索引、摘要与字数（线别沿用原值），
  记录里延续本章此前已生效的事实，提交链保持可重放。

### 修复

- **历史修正模式下提交链会失去可重放性**（doctor 开发中自查发现）：修正记录原先把
  `deltas` 记空，导致该章此前生效的事实从链上消失——一旦跑 `rebuild`，
  这些事实（如已回收的伏笔、主角状态）会被重放结果抹掉。现在修正记录原样延续
  上一版 `deltas`，`doctor check` 对修正章零告警，`rebuild` 后事实原样恢复。
- **三线状态的 `sinceSwitch` 在同章重提时虚增**：`applyStrand` 对已在 history 里的
  章节号不再重复计数，重提不再污染「多久没切线」统计。
- **面向 L0 客户端的文案清账**：工具描述、提示词、服务器 instructions 里的示例
  统一为中性书（不再是测试书《听物》）；大纲类工具返回末尾给出明确的下一步
  （总纲→卷纲→章纲→任务书），正文保存类返回给出完稿流程（审查→提交）。

### 测试

本地 179 项（+40：《护栏》15 项钉住旧章重提与审查门禁；状态尾 5 项按格式逐字断言；
描述自足性 5 项；doctor 13 项；stdio 端到端走查 1 项；重复 init 防护 1 项）。
`test/selfcontained.test.mjs` 做「对外文案零测试书泄露」检查；
`test/stdio.test.mjs` 用真实字符串管道把无插件客户端全流程走一遍。

## [1.0.2] - 2026-10-15

拿它真写了三章（《闭环验证之书》2458 字）之后暴露的问题：**正文不合格时，工具说「没问题」**。

### 修复

- **节奏体检开局就发绿灯（最坑）**：占比偏科的检查门槛是「写满 20 章才比一次」，
  所以三章全是主线、感情线与世界观一章都没有时，报告印的是「✅ 无明显节奏问题」。
  长篇真正的死法就是单线推到底，而这台仪表在前 20 章全程装死。
  现在改成「连续同一线别 ≥ 3 章，且另有两条线从未出现过」当场警告，不等样本够。
- **单章 1372 字能过审**：字数只跟「近期均值」比，只要越写越长就永远不报。
  任务书里明明写着「建议本章字数 约 2500 字」，交稿时却一个字都不核对——说了等于没说。
  现在审查按**同一个来源**判定（总字数 ÷ 总章数推导，收敛 2000-6000）：
  不足七成报短章，超 1.8 倍提示拆章。基准跟着本书目标走，不写死常量。
- **「开头没交代地点」误报**：上一章收在出租屋、本章仍收在出租屋（同一场戏接着演），
  旧规则只看开头有没有「出租屋」三个字，照样提醒。现在只有本章结尾地点与前章不同
  （确实换了地方）才提醒。误报的代价是作者学会整份报告不看。

### 测试

本地 139 项。新增 3 项把上面三条钉住：三章同线必须出告警且不许印绿灯、
1400 字对 2500 字章均必须报短（2240 字不报）、场景未切换不误报而真切换必须报。

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
