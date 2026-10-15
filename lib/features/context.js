/**
 * ★ 防遗忘引擎：写作任务书。
 *
 * 产品定位（PRD F2）：这是整个插件最重要的功能。
 * 目标不是「把数据倒给模型」，而是让模型动笔前就明确「本章必须遵守什么」。
 *
 * 设计要点：
 * - 纯派生、不落盘：每次现算，保证永远新鲜（不依赖任何缓存失效逻辑）。
 * - 固定优先级：硬约束 > 本章大纲 > 主角状态 > 伏笔 > 前情 > 其余。
 *   模型对开头和结尾最敏感，所以最要命的约束放在最前。
 * - 双重输出：结构化对象（给工具用）+ Markdown（给人看）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside } from '../core/paths.js';
import { readText, exists } from '../core/store.js';
import {
  readState, readIndex, readForeshadowing, readMemory, readProject,
  findChapter, recentChapters, openForeshadowing, staleCharacters, recentCharacters,
  searchMemory,
} from '../core/state.js';
import { toInt, formatVolumeLabel } from '../util.js';
import { analyzePacing } from './pacing.js';

/** 任务书里按顺序编号用的中文数字。 */
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

/** 任务书硬约束（写死在代码里，因为它们是不可协商的产品原则）。 */
export const HARD_RULES = [
  '大纲即法律：严格遵循本章章纲，不擅自改变剧情走向；若认为大纲有问题，先停下来说明理由并征求作者意见。',
  '设定即物理：严格遵守设定集与状态卡，不得让角色使用未掌握的能力、出现在不可能的地点。',
  '发明需登记：本章新出现的人物/地点/势力/物品/能力，必须在提交时写入 deltas，否则后续章节会当作不存在。',
  '状态要延续：主角的身体状况、伤势、所在地、境界必须与状态卡一致（例如"右臂受伤"期间不得写出双手持剑的潇洒动作）。',
];

/** 读取章纲文件内容（不存在返回 null）。 */
export function readChapterOutline(root, chapter) {
  const dir = inside(root, DIRS.chapterOutlines);
  const candidates = [
    `第${String(toInt(chapter)).padStart(4, '0')}章.md`,
    `第${toInt(chapter)}章.md`,
  ];
  for (const name of candidates) {
    const file = path.join(dir, name);
    if (exists(file)) return { path: `${DIRS.chapterOutlines}/${name}`.split(path.sep).join('/'), text: readText(file) ?? '' };
  }
  return null;
}

/** 读取卷纲。 */
export function readVolumeOutline(root, volume) {
  const dir = inside(root, DIRS.volumes);
  const candidates = [`第${toInt(volume)}卷.md`, `第${String(toInt(volume)).padStart(2, '0')}卷.md`];
  for (const name of candidates) {
    const file = path.join(dir, name);
    if (exists(file)) return { path: `${DIRS.volumes}/${name}`.split(path.sep).join('/'), text: readText(file) ?? '' };
  }
  return null;
}

/** 读取总纲。 */
export function readMasterOutline(root) {
  const file = inside(root, DIRS.outline, '总纲.md');
  return exists(file) ? { path: `${DIRS.outline}/总纲.md`, text: readText(file) ?? '' } : null;
}

/** 读取设定集某篇。 */
export function readSetting(root, name) {
  const file = inside(root, DIRS.settings, `${name}.md`);
  return exists(file) ? readText(file) ?? '' : null;
}

/** 列出设定集篇目。 */
export function listSettings(root) {
  const dir = inside(root, DIRS.settings);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

/**
 * 构建写作任务书。
 * @param {string} root 项目根
 * @param {number} chapter 要写的章号
 * @returns {{ chapter, brief, markdown, warnings, blockers }}
 */
export function buildWritingBrief(root, chapter, options = {}) {
  const num = toInt(chapter);
  if (num <= 0) throw new Error(`非法章节号：${chapter}`);

  const warnings = [];
  const { value: project } = readProject(root);
  const { value: state, warnings: sw } = readState(root);
  const { value: index, warnings: iw } = readIndex(root);
  const { value: ledger, warnings: fw } = readForeshadowing(root);
  const { value: memory } = readMemory(root);
  warnings.push(...sw, ...iw, ...fw);

  if (!project) warnings.push('未找到 project.json，建议先运行 webnovel_init 初始化项目');

  // ---- 前置检查（blockers：不满足就不该动笔）----
  const blockers = [];
  const chapterOutline = readChapterOutline(root, num);
  if (!chapterOutline) {
    blockers.push(`第 ${num} 章还没有章纲。请先用 webnovel_outline 定章纲——「大纲即法律」是本系统的第一原则。`);
  }

  const prev = findChapter(index, num - 1);
  if (num > 1 && !prev) {
    warnings.push(`第 ${num - 1} 章尚未提交（缺少提交记录）。若你确实跳章写作，请忽略此提示。`);
  }

  // ---- 组装 ----
  const volume = findVolume(state, num);
  const volumeOutline = volume ? readVolumeOutline(root, volume.volume) : null;

  const brief = {
    chapter: num,
    project: project
      ? {
        title: project.title,
        genre: project.genre,
        genreTags: project.genreTags ?? [],
        logline: project.logline ?? '',
        targetWords: project.targetWords,
        targetChapters: project.targetChapters,
        progressPercent: project.targetChapters ? Math.round((num / project.targetChapters) * 100) : null,
      }
      : null,
    volume: volume
      ? { ...volume, outlinePath: volumeOutline?.path ?? null }
      : null,
    chapterOutline: chapterOutline ? { path: chapterOutline.path, text: chapterOutline.text } : null,
    protagonist: state.protagonist,
    relatedCharacters: recentCharacters(state, num, 15),
    staleCharacters: staleCharacters(state, num, 30),
    openForeshadowing: openForeshadowing(ledger, num),
    timeline: state.timeline.slice(-8),
    previous: recentChapters(index, 2, num).map((c) => ({
      chapter: c.chapter,
      title: c.title,
      summary: c.summary ?? '',
      hook: c.hook ?? null,
      ending: c.ending ?? null,
    })),
    pacing: analyzePacing(root, { uptoChapter: num }),
    memory: searchMemory(memory, '', [], 5),
    hardRules: HARD_RULES,
    suggestedWords: suggestWords(project),
  };

  return {
    chapter: num,
    brief,
    markdown: renderBriefMarkdown(brief, { blockers, warnings }),
    warnings,
    blockers,
  };
}

/** 找出章号所属卷。 */
function findVolume(state, chapter) {
  const num = toInt(chapter);
  const volumes = Array.isArray(state.progress?.volumes) ? state.progress.volumes : [];
  for (const v of volumes) {
    const range = String(v.chapterRange ?? '');
    const match = /(\d+)\s*[-~到]\s*(\d+)/.exec(range);
    if (match) {
      const [, from, to] = match;
      if (num >= toInt(from) && num <= toInt(to)) return v;
    } else {
      const single = toInt(range);
      if (single > 0 && num === single) return v;
    }
  }
  return volumes.length > 0 ? volumes[volumes.length - 1] : null;
}

/** 建议本章字数：按目标章数与总字数推导，收敛到 2000-6000。 */
export function suggestWords(project) {
  const targetWords = toInt(project?.targetWords, 0);
  const targetChapters = toInt(project?.targetChapters, 0);
  if (targetWords > 0 && targetChapters > 0) {
    const per = Math.round(targetWords / targetChapters);
    return Math.min(6000, Math.max(2000, per));
  }
  return 3000;
}

/**
 * 把任务书渲染成 Markdown。
 * 顺序刻意如此：最要命的约束在最前，模型对首尾最敏感。
 */
export function renderBriefMarkdown(brief, { blockers = [], warnings = [] } = {}) {
  const out = [];
  const push = (line = '') => out.push(line);
  // 章节编号必须连续：条件区块（角色/伏笔/时间线…）没内容时会整块省略，
  // 若编号写死就会出现「四、」直接跳到「十、」——作者会以为工具坏了。
  let n = 0;
  const section = (title) => { n += 1; push(`## ${CN_NUM[n] ?? n}、${title}`); };

  push(`# 第 ${brief.chapter} 章 · 写作任务书`);
  push();

  if (blockers.length > 0) {
    push('## ⛔ 动笔前必须先解决');
    for (const b of blockers) push(`- ${b}`);
    push();
  }
  if (warnings.length > 0) {
    push('## ⚠ 需要注意');
    for (const w of warnings) push(`- ${w}`);
    push();
  }

  // 项目定位
  if (brief.project) {
    const p = brief.project;
    section('本书定位');
    push(`- 书名：${p.title}`);
    push(`- 题材：${p.genre}${p.genreTags?.length ? `（${p.genreTags.join(' / ')}）` : ''}`);
    if (p.logline) push(`- 一句话：${p.logline}`);
    push(`- 目标：${p.targetWords} 字 / ${p.targetChapters} 章${p.progressPercent !== null ? `（当前进度约 ${p.progressPercent}%）` : ''}`);
    if (brief.volume) push(`- 当前卷：${formatVolumeLabel(brief.volume.volume, brief.volume.title)}（${brief.volume.chapterRange ?? '范围未定'}）`);
    push(`- 建议本章字数：约 ${brief.suggestedWords} 字`);
    push();
  }

  // 本章大纲（法律）
  section('本章章纲（必须遵守）');
  if (brief.chapterOutline) {
    push(`来源：\`${brief.chapterOutline.path}\``);
    push();
    push(brief.chapterOutline.text.trim());
  } else {
    push('⚠ 本章还没有章纲。请先定章纲再动笔。');
  }
  push();

  // 前情
  section('前情提要');
  if (brief.previous.length > 0) {
    for (const c of brief.previous) {
      push(`### 第 ${c.chapter} 章 ${c.title ?? ''}`);
      if (c.summary) push(c.summary);
      if (c.hook?.type) push(`- 章末钩子：${c.hook.type}${c.hook.strength ? `（${c.hook.strength}）` : ''}`);
      if (c.ending?.location) push(`- 结尾场景：${c.ending.location}${c.ending.time ? ` · ${c.ending.time}` : ''}`);
      push();
    }
  } else {
    push('（这是第一章，无前情）');
    push();
  }

  // 主角状态（防 OOC / 防状态丢失）
  const pr = brief.protagonist;
  section('主角当前状态（不得违反）');
  if (pr?.name) {
    push(`- 姓名：${pr.name}`);
    if (pr.power?.realm) push(`- 境界：${pr.power.realm}${pr.power.bottleneck ? `（瓶颈：${pr.power.bottleneck}）` : ''}`);
    if (pr.location) push(`- 位置：${pr.location}`);
    if (pr.condition) push(`- 身体/处境：${pr.condition}　← 写作时务必延续此状态`);
    if (pr.goldenFinger?.name) push(`- 金手指：${pr.goldenFinger.name}${pr.goldenFinger.level ? ` Lv.${pr.goldenFinger.level}` : ''}${pr.goldenFinger.note ? `（${pr.goldenFinger.note}）` : ''}`);
  } else {
    push('（主角状态为空——建议先在设定集/主角卡.md 中确定主角，并在首次提交时写入状态）');
  }
  push();

  // 相关角色
  if (brief.relatedCharacters.length > 0 || brief.staleCharacters.length > 0) {
    section('角色');
    if (brief.relatedCharacters.length > 0) {
      push('近期出场：');
      push();
      push('| 角色 | 身份 | 境界 | 所在地 | 最后出场 |');
      push('|---|---|---|---|---|');
      for (const c of brief.relatedCharacters.slice(0, 12)) {
        push(`| ${c.name} | ${c.role ?? ''} | ${c.realm ?? ''} | ${c.location ?? ''} | 第 ${c.lastChapter ?? '?'} 章 |`);
      }
      push();
    }
    if (brief.staleCharacters.length > 0) {
      push('久未出场（考虑安排戏份或交代去向）：');
      for (const c of brief.staleCharacters.slice(0, 8)) {
        push(`- ${c.name}（第 ${c.lastChapter} 章后未再出现，已隔 ${brief.chapter - toInt(c.lastChapter)} 章）`);
      }
      push();
    }
  }

  // 伏笔
  // 产品要点：未回收的伏笔必须全部在场，而不只是「快到期」的那些。
  // 只提醒快到期的，等于默许作者把还有几十章才回收的线索忘掉——那正是本插件要治的病。
  const overdue = brief.openForeshadowing.filter((f) => f.overdue);
  const aging = brief.openForeshadowing.filter((f) => f.aging);
  const pending = brief.openForeshadowing.filter((f) => !f.overdue && !f.aging);
  if (brief.openForeshadowing.length > 0) {
    section(`未回收伏笔（共 ${brief.openForeshadowing.length} 条）`);
    if (overdue.length > 0) {
      push('### 🔴 已到期，本章或近期应收');
      for (const f of overdue) {
        const planned = toInt(f.plannedPayoff);
        // 计划回收章正好是本章时，不能说「已超期」——本章就是它的回收章。
        const when = planned === brief.chapter ? '本章应回收' : `已超期 ${brief.chapter - planned} 章`;
        push(`- **${f.name}**（第 ${f.plantedChapter} 章埋下，原计划第 ${planned} 章回收，${when}）${f.note ? ` — ${f.note}` : ''}`);
      }
    }
    if (aging.length > 0) {
      push('### 🟡 临近回收期');
      for (const f of aging) {
        push(`- ${f.name}（计划第 ${f.plannedPayoff} 章回收，还剩 ${toInt(f.plannedPayoff) - brief.chapter} 章）`);
      }
    }
    if (pending.length > 0) {
      push('### ⚪ 仍在铺垫（别当作没发生过）');
      for (const f of pending.slice(0, 20)) {
        const eta = f.plannedPayoff ? `计划第 ${f.plannedPayoff} 章回收` : '回收章节未定';
        push(`- ${f.name}（第 ${f.plantedChapter} 章埋下，${eta}）`);
      }
      if (pending.length > 20) push(`- …另有 ${pending.length - 20} 条，用 webnovel_query kind=foreshadowing 查看`);
    }
    push();
  }

  // 时间线
  if (brief.timeline.length > 0) {
    section('最近事件时间线');
    for (const t of brief.timeline) {
      push(`- 第 ${t.chapter} 章｜${t.time ?? ''}｜${t.location ?? ''}｜${t.event ?? ''}`);
    }
    push();
  }

  // 节奏
  const pacing = brief.pacing;
  if (pacing?.alerts?.length > 0) {
    section('节奏提示');
    for (const a of pacing.alerts) push(`- ${a.message}`);
    push();
  }

  // 写作记忆
  if (brief.memory.length > 0) {
    section('已沉淀的写作经验');
    for (const m of brief.memory) push(`- 【${m.kind}】${m.title}：${m.content}`);
    push();
  }

  // 硬约束（放最后，收尾强化）
  section('硬约束（不可违反）');
  for (const r of brief.hardRules) push(`- ${r}`);
  push();

  return out.join('\n').trimEnd() + '\n';
}

/**
 * 精简版状态行：用于注入系统提示（省 token）。
 */
export function briefSummaryLine(root, chapter) {
  const num = toInt(chapter);
  const { value: project } = readProject(root);
  const { value: state } = readState(root);
  const { value: ledger } = readForeshadowing(root);
  const { value: index } = readIndex(root);
  const overdue = openForeshadowing(ledger, num).filter((f) => f.overdue);
  const parts = [];
  if (project) parts.push(`《${project.title}》（${project.genre}）`);
  parts.push(`进度：已写 ${index.chapters.length} 章 / 目标 ${project?.targetChapters ?? '?'} 章`);
  if (state.protagonist?.name) {
    const bits = [state.protagonist.name];
    if (state.protagonist.power?.realm) bits.push(state.protagonist.power.realm);
    if (state.protagonist.location) bits.push(state.protagonist.location);
    parts.push(`主角：${bits.join(' · ')}`);
  }
  if (overdue.length > 0) parts.push(`⚠ ${overdue.length} 条伏笔已到期未回收`);
  return parts.join('｜');
}
