/**
 * ★ 提交链：把一章的「事实」落库。
 *
 * 产品定位（PRD F4）：这是「不忘」的物理基础。
 * 每写完一章，把该章产生的事实变化提交进来，系统据此更新：
 *   状态卡 / 章节索引 / 伏笔台账 / 时间线 / 摘要
 *
 * 三条铁律：
 * 1. 原子性 —— 要么全成功，要么全部不落盘（先算完再统一写）。
 * 2. 幂等 —— 同一章重复提交是覆盖，不是追加。
 * 3. 可审计 —— commits/ 里的记录只增不改，永不删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, inside, findChapterFile } from '../core/paths.js';
import { readText, writeTextAtomic, writeJsonAtomic, withProjectLock, exists } from '../core/store.js';
import {
  readState, readIndex, readForeshadowing, readProject,
  writeState, writeIndex, writeForeshadowing,
  upsertChapter, findChapter, applyProtagonistPatch, applyCharacterPatches,
  applyWorldPatch, appendTimeline, applyStrand, upsertForeshadowing,
  nextForeshadowingId, openForeshadowing,
} from '../core/state.js';
import { toInt, countWords, isoNow, sanitizeFilename } from '../util.js';
import { normalizeStrand } from './pacing.js';

/** 允许的钩子强度。 */
const HOOK_STRENGTHS = ['weak', 'medium', 'strong'];

/**
 * 提交一章。
 *
 * @param {string} root 项目根
 * @param {object} facts
 *   chapter        {number}  必填
 *   title          {string}  章节标题
 *   summary        {string}  本章摘要（2-4 句，将作为下一章的前情）
 *   strand         {string}  quest | fire | constellation
 *   hook           {{type,strength}} 章末钩子
 *   ending         {{time,location}} 结尾场景
 *   wordCount      {number}  可选，默认从正文文件统计
 *   deltas         {object}  事实增量（见下）
 *   force          {boolean} 跳过连续性检查
 *
 * deltas 支持：
 *   protagonist   { location, condition, 'power.realm', goldenFinger:{...} }
 *   characters    [{ name, patch:{...} }]
 *   world         { factions:[], locations:[], powerSystem:[] }
 *   timeline      { time, location, event }
 *   foreshadowing { planted:[{name,plannedPayoff,importance,note}], paid:["名称或id"] }
 */
export async function commitChapter(root, facts = {}) {
  const chapter = toInt(facts.chapter);
  if (chapter <= 0) throw new Error('commit 需要有效的 chapter（正整数）');

  return withProjectLock(root, () => {
    const warnings = [];

    // ---- 读 ----
    const { value: project } = readProject(root);
    if (!project) throw new Error('这不是一个已初始化的书项目（缺少 .webnovel/project.json）。请先运行 webnovel_init。');

    const { value: state, warnings: sw } = readState(root);
    const { value: index, warnings: iw } = readIndex(root);
    const { value: ledger, warnings: fw } = readForeshadowing(root);
    warnings.push(...sw, ...iw, ...fw);

    // ---- 连续性检查（护栏）----
    if (!facts.force && chapter > 1) {
      const prev = findChapter(index, chapter - 1);
      if (!prev) {
        warnings.push(`第 ${chapter - 1} 章没有提交记录。若确实要跳章，请显式传 force: true。`);
      }
    }

    // ---- 正文与字数 ----
    let chapterFile = findChapterFile(root, chapter);
    let words = toInt(facts.wordCount, 0);
    let bodyText = '';
    if (chapterFile) {
      bodyText = readText(chapterFile) ?? '';
      if (words <= 0) words = countWords(bodyText);
    } else if (words > 0) {
      warnings.push(`未找到第 ${chapter} 章的正文文件（正文/ 目录下），仅按传入字数记录。`);
    } else {
      warnings.push(`未找到第 ${chapter} 章的正文文件，字数记为 0。建议先写正文再提交。`);
    }

    // ---- 应用增量 ----
    let nextState = state;
    const deltas = facts.deltas && typeof facts.deltas === 'object' ? facts.deltas : {};

    if (deltas.protagonist) {
      nextState = applyProtagonistPatch(nextState, deltas.protagonist);
    }
    if (Array.isArray(deltas.characters) && deltas.characters.length > 0) {
      nextState = applyCharacterPatches(nextState, deltas.characters, chapter);
    }
    if (deltas.world) {
      nextState = applyWorldPatch(nextState, deltas.world);
    }

    const strand = normalizeStrand(facts.strand) ?? null;
    if (strand) {
      nextState = applyStrand(nextState, chapter, strand);
    } else if (facts.strand) {
      warnings.push(`无法识别线别「${facts.strand}」，已忽略。可用：quest / fire / constellation。`);
    }

    if (deltas.timeline && typeof deltas.timeline === 'object') {
      nextState = appendTimeline(nextState, { chapter, ...deltas.timeline });
    }

    // ---- 伏笔 ----
    let nextLedger = ledger;
    const plantedReport = [];
    if (Array.isArray(deltas.foreshadowing?.planted)) {
      for (const item of deltas.foreshadowing.planted) {
        if (!item || !item.name) continue;
        const record = {
          id: item.id ?? nextForeshadowingId(nextLedger),
          name: String(item.name),
          plantedChapter: chapter,
          plannedPayoff: item.plannedPayoff === null || item.plannedPayoff === undefined ? null : toInt(item.plannedPayoff),
          status: 'open',
          paidChapter: null,
          importance: item.importance ?? 'normal',
          note: item.note ?? '',
        };
        nextLedger = upsertForeshadowing(nextLedger, record);
        plantedReport.push(record);
      }
    }
    const paidReport = [];
    if (Array.isArray(deltas.foreshadowing?.paid)) {
      for (const key of deltas.foreshadowing.paid) {
        const target = nextLedger.items.find((i) => i.id === key || i.name === key);
        if (!target) {
          warnings.push(`要回收的伏笔「${key}」不在台账中，已忽略。可先在 planted 里登记。`);
          continue;
        }
        nextLedger = upsertForeshadowing(nextLedger, { id: target.id, status: 'paid', paidChapter: chapter });
        paidReport.push(target.name);
      }
    }
    if (Array.isArray(deltas.foreshadowing?.dropped)) {
      for (const key of deltas.foreshadowing.dropped) {
        const target = nextLedger.items.find((i) => i.id === key || i.name === key);
        if (target) {
          nextLedger = upsertForeshadowing(nextLedger, { id: target.id, status: 'dropped' });
          warnings.push(`伏笔「${target.name}」已标记为放弃（dropped）。建议在正文或设定里交代，避免读者追问。`);
        }
      }
    }

    // ---- 进度 ----
    const title = String(facts.title ?? '').trim()
      || guessTitleFromFile(chapterFile)
      || `第${chapter}章`;
    nextState.progress.currentChapter = Math.max(toInt(nextState.progress.currentChapter), chapter);
    nextState.progress.totalWords = index.chapters
      .filter((c) => toInt(c.chapter) !== chapter)
      .reduce((sum, c) => sum + toInt(c.words), 0) + words;

    // ---- 索引 ----
    const hook = facts.hook && typeof facts.hook === 'object' ? {
      type: String(facts.hook.type ?? '').trim(),
      strength: HOOK_STRENGTHS.includes(facts.hook.strength) ? facts.hook.strength : undefined,
    } : null;
    const entry = {
      chapter,
      title,
      words,
      file: chapterFile ? path.relative(root, chapterFile).split(path.sep).join('/') : null,
      strand,
      hook: hook && hook.type ? hook : null,
      ending: facts.ending && typeof facts.ending === 'object' ? facts.ending : null,
      summary: String(facts.summary ?? '').trim(),
      committedAt: isoNow(),
    };
    const nextIndex = upsertChapter(index, entry);

    // ---- 摘要文件 ----
    const summaryText = renderSummary(entry, nextState, chapter);
    writeTextAtomic(inside(root, DIRS.summaries, `ch${String(chapter).padStart(4, '0')}.md`), summaryText);

    // ---- 提交记录（审计链）----
    const commitRecord = {
      schemaVersion: 1,
      chapter,
      title,
      words,
      strand,
      hook: entry.hook,
      ending: entry.ending,
      summary: entry.summary,
      deltas,
      warnings,
      committedAt: isoNow(),
    };
    writeJsonAtomic(inside(root, DIRS.commits, `ch${String(chapter).padStart(4, '0')}.json`), commitRecord);

    // ---- 统一写回 ----
    writeState(root, nextState);
    writeIndex(root, nextIndex);
    writeForeshadowing(root, nextLedger);

    // ---- 报告 ----
    const overdue = openForeshadowing(nextLedger, chapter).filter((f) => f.overdue);
    return {
      chapter,
      title,
      words,
      strand,
      planted: plantedReport.map((p) => ({ name: p.name, plannedPayoff: p.plannedPayoff })),
      paid: paidReport,
      overdue: overdue.map((f) => ({ name: f.name, plannedPayoff: f.plannedPayoff })),
      progress: {
        currentChapter: nextState.progress.currentChapter,
        totalWords: nextState.progress.totalWords,
        targetWords: project.targetWords,
        targetChapters: project.targetChapters,
      },
      warnings,
      summaryPath: `${DIRS.summaries}/ch${String(chapter).padStart(4, '0')}.md`.split(path.sep).join('/'),
      commitPath: `${DIRS.commits}/ch${String(chapter).padStart(4, '0')}.json`.split(path.sep).join('/'),
    };
  });
}

/** 从文件名推断章节标题（第0012章-拜入宗门.md → 拜入宗门）。 */
function guessTitleFromFile(file) {
  if (!file) return null;
  const base = path.basename(file, '.md');
  const match = /^第\d+章[-—_\s]*(.+)$/.exec(base);
  return match ? match[1].trim() : null;
}

/** 渲染章节摘要文件。 */
function renderSummary(entry, state, chapter) {
  const out = [];
  out.push(`# 第 ${entry.chapter} 章 ${entry.title}`);
  out.push('');
  out.push(`- 字数：${entry.words}`);
  if (entry.strand) out.push(`- 线别：${entry.strand}`);
  if (entry.hook?.type) out.push(`- 章末钩子：${entry.hook.type}${entry.hook.strength ? `（${entry.hook.strength}）` : ''}`);
  if (entry.ending?.location) out.push(`- 结尾场景：${entry.ending.location}${entry.ending.time ? ` · ${entry.ending.time}` : ''}`);
  out.push(`- 提交时间：${entry.committedAt}`);
  out.push('');
  if (entry.summary) {
    out.push('## 本章摘要');
    out.push('');
    out.push(entry.summary);
    out.push('');
  }
  if (state.protagonist?.name) {
    out.push('## 提交后主角状态');
    out.push('');
    const bits = [state.protagonist.name];
    if (state.protagonist.power?.realm) bits.push(`境界 ${state.protagonist.power.realm}`);
    if (state.protagonist.location) bits.push(`位于 ${state.protagonist.location}`);
    if (state.protagonist.condition) bits.push(`状态：${state.protagonist.condition}`);
    out.push(bits.join('｜'));
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** 读取某章的提交记录。 */
export function readCommit(root, chapter) {
  const file = inside(root, DIRS.commits, `ch${String(toInt(chapter)).padStart(4, '0')}.json`);
  if (!exists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 列出所有已提交章节号。 */
export function listCommits(root) {
  const dir = inside(root, DIRS.commits);
  try {
    return fs.readdirSync(dir)
      .map((f) => /^ch(\d+)\.json$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
