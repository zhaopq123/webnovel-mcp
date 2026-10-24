/**
 * 状态摘要与待办（PRD F9）。
 *
 * 产品目标：每次开工，一句话就知道「我写到哪了、有什么没做完」。
 * 这是用户最常调用的功能，所以输出必须短、必须可执行。
 */
import path from 'node:path';
import { DIRS, inside, listChapterFiles } from '../core/paths.js';
import { exists } from '../core/store.js';
import { readState, readIndex, readForeshadowing, readProject, openForeshadowing, staleCharacters, findChapter } from '../core/state.js';
import {  toInt, countWords, percent , wrapTitle } from '../util.js';
import { analyzePacing } from './pacing.js';
import { listChapterOutlines } from './outline.js';
import { listCommits } from './commit.js';
import { memoryStats } from './memory.js';
import { computeStructure, renderStructureTable, renderStructureSummary } from './structure.js';
import { narrativeDebt, renderDebtSummary, debtHeadline, debtTodos } from './ledger.js';
import { dossierOverview } from './dossier.js';
import { partProgress, renderPartLine, renderPartCooldown } from './parts.js';
import { readStyleBaseline, latestStyleReport, renderStyleDriftItems } from './style.js';

/**
 * 生成项目状态快照。
 * @param {string} root 书项目目录
 * @param {{ structure?: 'summary'|'full'|'off' }} [options] 结构换算块的详略；
 *   默认 summary（三行）——status 是每轮都可能调的省 token 入口，全表留给显式要求。
 * @returns {{ headline, lines, todos, stats }}
 */
export function projectStatus(root, options = {}) {
  const structureMode = ['summary', 'full', 'off'].includes(options.structure) ? options.structure : 'summary';
  const { value: project } = readProject(root);
  const { value: state } = readState(root);
  const { value: index } = readIndex(root);
  const { value: ledger } = readForeshadowing(root);

  const current = toInt(state.progress.currentChapter);
  const written = listChapterFiles(root);
  const commits = listCommits(root);
  const outlines = listChapterOutlines(root);

  // 已写正文但未提交的章节
  const uncommitted = written
    .map((f) => {
      const m = /^第(\d+)章/.exec(f.name);
      return m ? Number(m[1]) : null;
    })
    .filter((n) => n !== null && !commits.includes(n))
    .sort((a, b) => a - b);

  const open = openForeshadowing(ledger, current);
  const overdue = open.filter((f) => f.overdue);
  const stale = staleCharacters(state, current, 30);
  const pacing = analyzePacing(root, { uptoChapter: current });
  const memory = memoryStats(root);

  // 文风漂移：只认「基线之后」产生的报告——作者用 memory action=baseline 重设基准后，
  // 旧报告就该失效，否则重设了还在报警，等于没重设。
  const styleBaseline = readStyleBaseline(root);
  const styleReport = latestStyleReport(root);
  // 报告必须晚于基准：毫秒时间戳优先；老基线没有 ms 字段时退回章号比较。
  const reportMs = Number(styleReport?.checkedAtMs);
  const baselineMs = Number(styleBaseline?.createdAtMs);
  const reportIsNewer = styleReport && styleBaseline
    ? (Number.isFinite(reportMs) && Number.isFinite(baselineMs)
      ? reportMs > baselineMs
      : Number(styleReport.chapter) > Number(styleBaseline.calibratedAtChapter))
    : false;
  const styleDrift = Boolean(styleBaseline && styleReport && styleReport.drifted && reportIsNewer);

  // 体量自适应引擎（提示词第二节）：每次读现算，不往 project.json 里存副本——
  // 存了就产生第二份真相（改了目标字数没人重算 → 表和实际不符）。详见 lib/features/structure.js。
  const structure = computeStructure({
    targetWords: project?.targetWords,
    targetChapters: project?.targetChapters,
    currentChapter: current,
  });

  // 叙事债务总账（提示词 4.1/4.4/2.3/第五节）：伏笔、悬念账户、支票、误导线索并成一张账。
  // 部数决定余额线是 3 还是 4，所以必须拿上面现算的 structure 喂它——这条推导链只留一份。
  const debt = narrativeDebt(ledger, { chapter: current, partsCount: structure.parts.count });

  // 人物档案（提示词第六节 + 6.14 主角人味）：缺口数由 dossier.js 判，这里只搬运。
  const dossier = dossierOverview(state);

  // 部进度：已建部（事实）优先，没建部才退回结构换算（计划）。两条线各说各的，标了来源。
  const part = partProgress(state, structure, current);

  // 完本判定：以目标章数为准。旧实现直接 current+1，状态指针一旦被写坏（如 723），
  // 完本 300 章的书还会显示「下一章 724」。current 或已提交章数任一达到目标即算完本。
  const targetChapters = toInt(project?.targetChapters, 0);
  const finished = Boolean(project && targetChapters > 0
    && (current >= targetChapters || commits.length >= targetChapters));
  const nextChapter = finished ? null : Math.max(current + 1, written.length + 1);
  const hasNextOutline = !finished && outlines.includes(nextChapter);

  /* ---------------- 待办清单（按优先级） ---------------- */
  const todos = [];
  if (uncommitted.length > 0) {
    todos.push({
      priority: 'high',
      action: `提交第 ${uncommitted.join('、')} 章`,
      why: '正文已写但未提交——不提交的话，这些章节的设定变化不会被系统记住',
      tool: 'webnovel_commit',
    });
  }
  if (overdue.length > 0) {
    todos.push({
      priority: 'high',
      action: `回收到期伏笔：${overdue.map((f) => f.name).join('、')}`,
      why: '已超过计划回收章节，读者会认为你忘了',
      tool: 'webnovel_outline / webnovel_commit',
    });
  }
  const errorAlerts = pacing.alerts.filter((a) => a.level === 'error');
  if (errorAlerts.length > 0) {
    todos.push({
      priority: 'high',
      action: errorAlerts.map((a) => a.message).join('；'),
      why: '节奏红线告警',
      tool: 'webnovel_pacing',
    });
  }
  if (styleDrift) {
    todos.push({
      priority: 'normal',
      action: `回拉文风：第 ${styleReport.chapter} 章检测到漂移`,
      why: renderStyleDriftItems(styleReport.items),
      tool: 'webnovel_review',
    });
  }
  if (!finished && !hasNextOutline) {
    todos.push({
      priority: 'normal',
      action: `为第 ${nextChapter} 章定章纲`,
      why: '「大纲即法律」——没有章纲就不该动笔',
      tool: 'webnovel_outline',
    });
  }
  if (stale.length > 0) {
    todos.push({
      priority: 'normal',
      action: `安排久未出场角色：${stale.slice(0, 3).map((c) => c.name).join('、')}`,
      why: '超过 30 章未出场，读者会淡忘',
      tool: 'webnovel_query',
    });
  }
  if (dossier.gaps > 0) {
    todos.push({
      priority: 'normal',
      action: `补齐主要人物档案（${dossier.gaps} 处缺口：${dossier.majorNames.slice(0, 3).join('、')}）`,
      why: '6.1/6.2：无欲望恐惧与内在矛盾的人物=纸板人，对话区分度也建不起来',
      tool: 'webnovel_commit',
    });
  }
  if (dossier.protagonistGaps.length > 0) {
    todos.push({
      priority: 'normal',
      action: `填主角人味三项（缺 ${dossier.protagonistGaps.map((g) => g.label).join('、')}）`,
      why: '6.14：能力可以开挂，人格必须是普通人——四维全满的主角是执行器不是人',
      tool: 'webnovel_commit',
    });
  }
  if (part?.overdue) {
    todos.push({
      priority: 'high',
      action: `第 ${part.part} 部已写超部末（止于第 ${part.toChapter} 章）——先收部并归档部摘要`,
      why: `2.5：部完结必须输出【部总结包】压成 ≤15 行摘要；超出部末还在写＝三幕收束已经被挤掉`,
      tool: 'webnovel_outline',
    });
  } else if (part?.cooldown) {
    todos.push({
      priority: 'normal',
      action: `启动第 ${part.part} 部收尾（剩 ${part.remainingInPart} 章）——本部弧光格显形 + 跨部钩子`,
      why: '17.6：进入倒数 10 章主动启动部收尾；2.6 部末必须留指向下一部的具体诱因',
      tool: 'webnovel_outline',
    });
  }
  if (!project?.logline) {
    todos.push({ priority: 'low', action: '补上「一句话故事」', why: '写作时是最有效的方向锚点', tool: 'webnovel_init' });
  }
  if (memory.total === 0) {
    todos.push({
      priority: 'low',
      action: '沉淀第一条写作经验',
      why: '把有效的写法记下来，后续章节会自动带上',
      tool: 'webnovel_memory',
    });
  }

  /* ---------------- 输出 ---------------- */
  // 债务类待办排最前：读者弃书是因为总账爆了，不是因为某个角色 30 章没出场。
  todos.unshift(...debtTodos(debt, { limit: 3 }));

  const lines = [];
  const headline = project
    ? `${wrapTitle(project.title)}已写 ${commits.length} 章 / ${state.progress.totalWords} 字，进度 ${percent(commits.length, project.targetChapters)}`
    : '这不是一个已初始化的书项目';

  lines.push(headline);
  if (project) {
    lines.push(`题材：${project.genre}${project.genreTags?.length ? `（${project.genreTags.join('/')}）` : ''}｜目标 ${project.targetWords} 字 / ${project.targetChapters} 章`);
  }
  if (state.protagonist?.name) {
    const bits = [state.protagonist.name];
    if (state.protagonist.power?.realm) bits.push(state.protagonist.power.realm);
    if (state.protagonist.location) bits.push(`在${state.protagonist.location}`);
    if (state.protagonist.condition) bits.push(state.protagonist.condition);
    lines.push(`主角：${bits.join(' · ')}`);
  }
  lines.push(finished
    ? `下一章：已完本（目标 ${targetChapters} 章；记录进度第 ${current} 章）`
    : `下一章：第 ${nextChapter} 章${hasNextOutline ? '（章纲已就绪）' : '（还缺章纲）'}`);
  lines.push(`角色 ${Object.keys(state.characters).length} 人｜伏笔未回收 ${open.length} 条${overdue.length ? `（到期 ${overdue.length}）` : ''}｜写作记忆 ${memory.total} 条`);
  if (styleDrift) {
    lines.push(`文风漂移：第 ${styleReport.chapter} 章 —— ${renderStyleDriftItems(styleReport.items)}`);
  }
  if (project && dossier.major > 0) {
    lines.push(`人物档案：主要 ${dossier.major} 人（缺口 ${dossier.gaps} 处）｜信息表 ${dossier.infoItems} 条`
      + (dossier.protagonistGaps.length ? `｜主角人味缺 ${dossier.protagonistGaps.length} 项（6.14）` : ''));
  }

  if (project && part?.source === 'authored') {
    // 没建部时结构换算已经有一行「当前：第 N 部第 X 章」，这里不重复报估算值。
    const partLine = renderPartLine(part);
    if (partLine) lines.push(partLine);
  }

  if (project && structureMode !== 'off') {
    lines.push('');
    const rendered = structureMode === 'full' ? renderStructureTable(structure) : renderStructureSummary(structure);
    // 已建部时以部表为准：换算表里「按章数均分」的估算行会和部表打架，去掉那一行。
    lines.push(...(part?.source === 'authored' ? rendered.filter((l) => !l.startsWith('当前：')) : rendered));
  }

  if (project && part?.source === 'authored' && renderPartCooldown(part)) {
    lines.push('');
    lines.push(renderPartCooldown(part));
  }

  // 债务账：一句话总账 + 要紧的几条。什么都不欠时只留一行 ✅，别为空账占篇幅。
  const hasDebt = debtHeadline(debt) !== null;
  lines.push('');
  lines.push(hasDebt ? `叙事债务：${debtHeadline(debt)}` : '叙事债务：✅ 账上没有未清的条目');

  if (todos.length > 0) {
    lines.push('');
    lines.push('待办：');
    for (const t of todos) {
      const icon = t.priority === 'high' ? '🔴' : t.priority === 'normal' ? '🟡' : 'ℹ️';
      lines.push(`${icon} ${t.action}　— ${t.why}`);
    }
  } else {
    lines.push('');
    lines.push('✅ 没有待办，一切就绪。');
  }

  return {
    project,
    headline,
    lines,
    todos,
    structure,
    structureMode,
    debt,
    stats: {
      chaptersCommitted: commits.length,
      chaptersWritten: written.length,
      uncommitted,
      totalWords: state.progress.totalWords,
      currentChapter: current,
      nextChapter,
      finished,
      characters: Object.keys(state.characters).length,
      dossierMajor: dossier.major,
      dossierGaps: dossier.gaps,
      dossierInfoItems: dossier.infoItems,
      dossierProtagonistGaps: dossier.protagonistGaps.length,
      part: part?.part ?? null,
      partSource: part?.source ?? null,
      partRemaining: part?.remainingInPart ?? null,
      partCooldown: Boolean(part?.cooldown),
      partOverdue: Boolean(part?.overdue),
      foreshadowingOpen: open.length,
      foreshadowingOverdue: overdue.length,
      debtBalance: debt.balance,
      debtRequired: debt.required,
      debtSuspense: debt.byType.suspense,
      debtCheques: debt.byType.cheque,
      debtRedHerrings: debt.byType.red_herring,
      debtErrors: debt.errors.length,
      debtWarns: debt.warns.length,
      memoryEntries: memory.total,
      pacingAlerts: pacing.alerts.length,
      styleBaselineChapter: styleBaseline?.calibratedAtChapter ?? null,
      styleBaselineSource: styleBaseline?.source ?? null,
      styleDriftChapter: styleDrift ? styleReport.chapter : null,
      structureParts: structure.parts.count,
      structureChapters: structure.chapters.suggested,
      structureTiers: structure.tiers.count,
      structureOnionLayers: structure.onion.layers,
      structureSuspenseLayers: structure.suspense.layers,
      structureWarnings: structure.notes.filter((n) => n.level === 'warn').length,
    },
  };
}

/**
 * 供系统提示使用的极简状态行（省 token）。
 * 只在项目已初始化时返回内容。
 */
export function compactStatusLine(root) {
  try {
    const { value: project } = readProject(root);
    if (!project) return null;
    const { value: state } = readState(root);
    const { value: index } = readIndex(root);
    const { value: ledger } = readForeshadowing(root);
    const current = toInt(state.progress.currentChapter);
    const target = toInt(project.targetChapters, 0);
    const finished = target > 0 && (current >= target || index.chapters.length >= target);
    const overdue = openForeshadowing(ledger, current).filter((f) => f.overdue).length;

    const parts = [`${wrapTitle(project.title)}${project.genre || '未分类'}`];
    parts.push(`已写 ${index.chapters.length} 章 / ${state.progress.totalWords} 字（目标 ${project.targetChapters} 章${finished ? '，已完本' : ''}）`);
    if (state.protagonist?.name) {
      const bits = [state.protagonist.name];
      if (state.protagonist.power?.realm) bits.push(state.protagonist.power.realm);
      if (state.protagonist.location) bits.push(state.protagonist.location);
      if (state.protagonist.condition) bits.push(state.protagonist.condition);
      parts.push(`主角：${bits.join('·')}`);
    }
    if (overdue > 0) parts.push(`⚠ ${overdue} 条伏笔到期未回收`);
    return parts.join('｜');
  } catch {
    return null;
  }
}
