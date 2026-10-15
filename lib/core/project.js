/**
 * 项目创建：一条命令建出完整可写骨架。
 *
 * 产品目标（PRD F1）：从「我有个想法」到「可以写第一章」，5 分钟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, ensureDir, inside } from './paths.js';
import { SCHEMA_VERSION, readJsonMigrated, writeJsonAtomic, writeTextAtomic, exists } from './store.js';
import {
  defaultState, defaultIndex, defaultForeshadowing, defaultMemory,
} from './state.js';
import { isoNow } from '../util.js';

/* ------------------------------------------------------------------ *
 * 模板：建项目时生成的人类可读骨架
 * ------------------------------------------------------------------ */

function worldTemplate({ title, genre, logline }) {
  return `# 世界观

> 《${title}》· ${genre}

## 一句话定位
${logline || '（待补：用一句话说清这个世界最特别的地方）'}

## 时代与舞台
- 时代：
- 主要舞台：
- 社会形态：

## 核心规则
> 这个世界「什么可以、什么不可以」。规则一旦定下，全书不得违反。

1.
2.
3.

## 势力
| 势力 | 立场 | 目标 | 与主角关系 |
|---|---|---|---|
|  |  |  |  |

## 禁忌与代价
- 使用力量的代价：
- 不可触碰的禁忌：
`;
}

function powerTemplate() {
  return `# 力量体系

> 力量体系是长篇最容易崩的地方。定好之后，每次突破都要对得上。

## 等级阶梯
| 阶 | 名称 | 标志能力 | 寿元/代价 | 全书占比 |
|---|---|---|---|---|
| 1 |  |  |  | 前 20% |
| 2 |  |  |  |  |

## 突破条件
- 每阶的瓶颈是什么：
- 需要什么资源/机缘：

## 战斗规则
- 同阶对战看什么：
- 越阶挑战的可能性与代价：
- 杀伤力的上限（防止后期战力通胀）：

## 禁止事项
- 不允许出现的设定（防止后期加设定打脸）：
`;
}

function protagonistTemplate() {
  return `# 主角卡

## 基本信息
- 姓名：
- 年龄：
- 出身：
- 外貌特征：

## 性格
- 核心性格：
- 优点：
- 缺点（必须有，否则人物扁平）：
- 说话风格：

## 动机与目标
- 表层目标（想做什么）：
- 深层动机（为什么）：
- 内心恐惧：

## 成长线
- 起点状态：
- 转折点：
- 终点状态：

## 人际关系
| 角色 | 关系 | 情感基调 | 首次出场 |
|---|---|---|---|
|  |  |  |  |
`;
}

function goldenFingerTemplate() {
  return `# 金手指

## 是什么

## 能力边界（非常重要）
> 写清「不能做什么」，比写「能做什么」更能防止崩坏。

- 能做到：
- 做不到：
- 使用代价：
- 冷却/限制：

## 成长路径
| 阶段 | 解锁能力 | 对应章节区间 |
|---|---|---|
| 1 |  |  |
`;
}

function masterOutlineTemplate({ title, genre, targetWords, targetChapters }) {
  return `# 总纲

> 《${title}》· ${genre} · 目标 ${targetWords} 字 / ${targetChapters} 章

## 一句话故事
（主角）在（背景）中，为了（目标），必须（行动），否则（代价）。

## 核心冲突
- 外部冲突（人与世界）：
- 内部冲突（人与自己）：
- 贯穿全书的终极问题：

## 三幕结构
### 第一幕：建立（约 1-20%）
- 主角登场状态：
- 打破平衡的事件：
- 第一次选择：

### 第二幕：对抗（约 20-80%）
- 主要对手与升级路径：
- 中点转折：
- 最低谷：

### 第三幕：解决（约 80-100%）
- 最终对决：
- 主题落点：

## 主线脉络
1.
2.
3.

## 感情线
- 对象：
- 关系推进节点：

## 世界观扩展线
- 要逐步揭示的世界真相：
`;
}

function volumeTemplate(volume, chapterRange, title) {
  return `# 第${volume}卷 ${title || ''}

> 章节范围：${chapterRange}

## 本卷目标
- 主角本卷要达成：
- 本卷要揭示的设定：

## 卷内节拍
| 阶段 | 章节 | 事件 | 情绪 |
|---|---|---|---|
| 起 |  |  |  |
| 承 |  |  |  |
| 转 |  |  |  |
| 合 |  |  |  |

## 本卷埋下的伏笔
- [ ]

## 本卷应回收的伏笔
- [ ]

## 卷末钩子
`;
}

/* ------------------------------------------------------------------ *
 * 建项目
 * ------------------------------------------------------------------ */

/**
 * 创建书项目骨架。
 * @returns {{ root: string, created: string[], existed: boolean, meta: object }}
 *   created = 本次实际写入的文件（重复 init 时只含补全的缺失项 + project.json）
 */
export function initProject(root, options = {}) {
  const existed = exists(path.join(root, FILES.project));
  const created = [];

  // 已有元信息：重复 init 时只「补」不「冲」——显式传了新值的字段才更新
  const prevMeta = existed
    ? readJsonMigrated(path.join(root, FILES.project), null, 'project.json').value
    : null;
  const pickText = (incoming, current, fallback) => {
    if (incoming !== undefined && incoming !== null && String(incoming).trim() !== '') return String(incoming).trim();
    if (current !== undefined && current !== null && String(current).trim() !== '') return String(current).trim();
    return fallback;
  };
  const pickNum = (incoming, current, fallback) => {
    if (incoming !== undefined && incoming !== null && Number.isFinite(Number(incoming))) return Number(incoming);
    if (current !== undefined && current !== null && Number.isFinite(Number(current))) return Number(current);
    return fallback;
  };
  const meta = {
    title: pickText(options.title, prevMeta?.title, '未命名作品'),
    genre: pickText(options.genre, prevMeta?.genre, '未分类'),
    genreTags: Array.isArray(options.genreTags) ? options.genreTags : (Array.isArray(prevMeta?.genreTags) ? prevMeta.genreTags : []),
    logline: pickText(options.logline, prevMeta?.logline, ''),
    targetWords: pickNum(options.targetWords, prevMeta?.targetWords, 1_000_000),
    targetChapters: pickNum(options.targetChapters, prevMeta?.targetChapters, 400),
  };

  // 1. 目录骨架
  for (const dir of [DIRS.meta, DIRS.settings, DIRS.outline, DIRS.volumes, DIRS.chapterOutlines, DIRS.text, DIRS.summaries, DIRS.commits, DIRS.reviews, DIRS.trash]) {
    ensureDir(inside(root, dir));
  }

  // 2. 机器态：已存在则不动（补齐缺失是 init 的职责，重建机器态是 webnovel_doctor 的职责——
  //    init 把清空 state/index 当成「重置」用，会顺手抹掉伏笔台账与写作记忆）
  const project = {
    schemaVersion: SCHEMA_VERSION,
    ...meta,
    createdAt: existed && prevMeta?.createdAt ? prevMeta.createdAt : isoNow(),
    updatedAt: isoNow(),
  };
  writeJsonAtomic(path.join(root, FILES.project), project);
  created.push(FILES.project);

  if (!exists(path.join(root, FILES.state))) {
    const state = defaultState();
    state.protagonist.name = '';
    state.progress.volumes = [{
      volume: 1, title: '', chapterRange: `1-${Math.min(100, meta.targetChapters)}`, status: 'planning',
    }];
    writeJsonAtomic(path.join(root, FILES.state), state);
    created.push(FILES.state);
  }

  for (const [file, value] of [
    [FILES.index, defaultIndex()],
    [FILES.foreshadowing, defaultForeshadowing()],
    [FILES.memory, defaultMemory()],
  ]) {
    const target = path.join(root, file);
    if (exists(target)) continue;
    writeJsonAtomic(target, value);
    created.push(file);
  }

  // 3. 人类可读骨架（已存在则不覆盖——保护用户已有内容）
  const docs = [
    [path.join(DIRS.settings, '世界观.md'), worldTemplate(meta)],
    [path.join(DIRS.settings, '力量体系.md'), powerTemplate()],
    [path.join(DIRS.settings, '主角卡.md'), protagonistTemplate()],
    [path.join(DIRS.settings, '金手指.md'), goldenFingerTemplate()],
    [path.join(DIRS.outline, '总纲.md'), masterOutlineTemplate(meta)],
    [path.join(DIRS.volumes, '第1卷.md'), volumeTemplate(1, `1-${Math.min(100, meta.targetChapters)}`, '')],
  ];
  for (const [rel, content] of docs) {
    const target = inside(root, rel);
    if (exists(target)) continue;
    writeTextAtomic(target, content);
    created.push(rel.split(path.sep).join('/'));
  }

  return { root, created, existed, meta };
}

/** 读项目元信息（不存在返回 null）。 */
export function loadProject(root) {
  const file = path.join(root, FILES.project);
  if (!exists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 项目是否已初始化。 */
export function isInitialized(root) {
  return exists(path.join(root, FILES.project));
}
