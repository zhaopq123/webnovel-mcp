# 日更自动化工作流（automation 配置单）

无人值守日更的完整串联：

```
automation（定时器）→ 专家（唯一编剧）→ MCP 工具（手）→ 当日手记 / commit 链（唯一事实源）
```

- **双专家双闸**：21:00 `webnovel-coach` 写章+自检 → 22:00 `webnovel-reviewer` fresh context
  独立只读验收（R1-R8 清单，报告追加进当日手记）。coach 自检是运动员兼裁判，reviewer 补独立视角。
- **书籍数据只存在于本地设备**（`books/` 目录），永不进本仓库。专家包与工作流定义进仓库，产物不进。
- **bookId 写死在 prompt 里是有意的**：无人值守会话不能提问，必须写死目标书；
  写错的失败模式是良性的（MCP 报错 → 专家停笔写手记），远好于「写最新一本」式的静默错写。
- 三条都先手动触发测一遍，再开定时。

## 配置单 1 · 网文日更-写作

| 字段 | 值 |
|---|---|
| scheduleType | recurring |
| rrule | `FREQ=DAILY;BYHOUR=21;BYMINUTE=0` |
| expertId | `webnovel-coach` |

prompt：

```
无人值守日更：跑《末世：我的面板能看到弱点》（bookId=moshimianbao）的当日写作闭环。
第一步 webnovel_status 续接状态并读最近一份手记里的「验收报告」段；再 webnovel_context 取下一章任务书；
按任务书与章纲写正文（2600 字硬线、去 AI 味铁律、开头 3 段进冲突、章末留钩子），
依次执行：保存正文 → 查重（websearch 可用则查，不可用记进手记）→ webnovel_review 自审 →
webnovel_commit 提交事实增量 → webnovel_outline action=write_note 写当日手记六段。
有 blocker 就停笔写进手记「待作者决策」，不裸写。漏跑的日子跳过不补。
全程不要向用户提问，按专家正文的铁律自行处理。
```

## 配置单 2 · 网文日更-验收

| 字段 | 值 |
|---|---|
| scheduleType | recurring |
| rrule | `FREQ=DAILY;BYHOUR=22;BYMINUTE=0` |
| expertId | `webnovel-reviewer` |

prompt：

```
无人值守验收：对《末世：我的面板能看到弱点》（bookId=moshimianbao）当日章节跑 8 项验收
（R1 字数硬线 2600 / R2 章号连续 / R3 AI 味 13 词扫描 / R4 查重复跑 / R5 设定一致性：
能力边界·主角状态·已故角色 / R6 事实链完整 / R7 手记六段闭环 / R8 读感抽读只出建议），
结论三选一：通过 / 有条件通过 / 打回。
验收报告用 webnovel_outline action=write_note 追加进当日手记（格式按专家正文模板）。
只读铁律：不写正文、不 commit、不跑 review、不改设定；只报不修。
今日无新章节就写一行「今日无更新，验收跳过」退出。周日升级周检：设定四篇全书对账+伏笔台账+节奏。
全程不要向用户提问。
```

## 配置单 3 · 网文大纲提前量体检

| 字段 | 值 |
|---|---|
| scheduleType | recurring |
| rrule | `FREQ=WEEKLY;BYDAY=SU;BYHOUR=20;BYMINUTE=0` |
| expertId | `webnovel-coach` |

prompt：

```
每周大纲提前量体检（只读，不创作）：《末世：我的面板能看到弱点》（bookId=moshimianbao）。
webnovel_status 看已写章数，查章纲库存（最后一份章纲的章号），提前量 = 库存 - 已写。
提前量 ≥20 章：一句话汇报「提前量充足（N 章）」即结束。
低于 20 章：明确提醒作者本周要补章纲，列出建议补的章段（下一批 10 章）、
对应卷纲节拍表位置，然后停下等作者来对话补纲——绝不自行写章纲。
顺手读最近一份验收报告，有未处理的 🔴 一并提醒。全程只读，不改任何数据。
```

## 换一本书 / 开第二本

1. 找 coach 对话走四问开书（书名、题材、一句话故事、目标规模）→ `webnovel_init`；
2. **手动会话**定设定集四篇 + 前 10 章章纲（创作决策必须作者在场，无人值守不碰）；
3. 照抄上面配置单新建一组「写作+验收」automation，prompt 里 bookId 换成新书 id；
4. 旧书写完后把旧的三条 automation 停用/删除——体系（专家、MCP、门禁）原样复用。

## 诚实边界

- R8 读感是 agent 自评，有盲区——人每天 2 分钟抽读省不掉；
- 查重引擎覆盖有限，发布前人工复查不变；
- reviewer 与 coach 共用同一条 MCP 提交链，reviewer 只读（唯一写通道是 write_note 与
  `webnovel_memory kind=feedback`），不污染事实源。
