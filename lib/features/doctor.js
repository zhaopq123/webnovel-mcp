/**
 * doctor：机器态体检与重建（P1-1）。
 *
 * check（只读）：把提交链完整重放一遍，与当前的
 *   state.json / index.json / foreshadowing.json / 正文文件 / 摘要文件 逐项对账，
 *   再扫一遍骨架里的未填占位符。核心不变量：提交链是唯一事实来源，
 *   「重放结果 == 现役机器态」才叫健康。
 *
 * rebuild（写）：从提交链重放重建机器态。先自动备份到 .webnovel/trash/；
 *   只重建「由提交链推导」的部分——记忆（memory.json）、审查记录（reviews/）、
 *   卷登记信息（state.progress.volumes）不属于提交链，一律保持不动。
 *
 * 重放与实时提交共用 applyChapterFacts（见 commit.js）——两边永不漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, inside, findChapterFile, listChapterFiles } from '../core/paths.js';
import { exists, withProjectLock, writeTextAtomic, copyTree } from '../core/store.js';
import {
  defaultState, defaultIndex, defaultForeshadowing,
  readState, readIndex, readForeshadowing, readProject,
  writeState, writeIndex, writeForeshadowing, findChapter,
} from '../core/state.js';
import { applyChapterFacts, readCommit, listCommits, renderSummary } from './commit.js';
import { toInt, isoNow, wrapTitle } from '../util.js';

/** 骨架模板里的未填标记（见 core/project.js 的模板）。 */
const PLACEHOLDER_MARKERS = ['（待补', '（主角）在（背景）'];

/** 把值转成键序无关的规范形式（对象键排序，数组保序），用于对账比较。 */
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}

const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * 按提交记录顺序重放整条链。
 *
 * 不区分修正记录：每一条记录的 deltas 都是「该章累计生效的全部事实」
 * （修正记录由 commitChapter 原样延续上一版 deltas），线别等条目字段同样
 * 按记录重放——实时提交与重放走应用层完全相同的路径。
 *
 * @returns {{bundle, perChapter, perChapterState}} bundle=最终机器态；
 *   perChapter=各章重放出的索引条目；perChapterState=各章提交后的状态快照
 */
function replayChain(root, records) {
  let bundle = { state: defaultState(), index: defaultIndex(), ledger: defaultForeshadowing() };
  const perChapter = new Map();
  const perChapterState = new Map();
  for (const rec of records) {
    const num = toInt(rec.chapter);
    const file = findChapterFile(root, num);
    const out = applyChapterFacts(bundle, num, {
      title: rec.title,
      words: rec.words,
      file: file ? path.relative(root, file).split(path.sep).join('/') : null,
      strand: rec.strand,
      hook: rec.hook,
      ending: rec.ending,
      summary: rec.summary,
      deltas: rec.deltas,
      committedAt: rec.committedAt,
    });
    perChapter.set(num, out.entry);
    perChapterState.set(num, out.state);
    bundle = { state: out.state, index: out.index, ledger: out.ledger };
  }
  return { bundle, perChapter, perChapterState };
}

/** 递归找出目录下所有 .md 文件（相对 root 的路径）。 */
function listMarkdownDeep(root, dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(abs);
      }
    }
  };
  walk(dir);
  return out.map((abs) => path.relative(root, abs).split(path.sep).join('/'));
}

/** 扫描骨架占位符：返回 [{path, count, sample}]。 */
function scanPlaceholders(root) {
  const hits = [];
  const roots = [inside(root, DIRS.settings), inside(root, DIRS.outline)];
  for (const dir of roots) {
    for (const rel of listMarkdownDeep(root, dir)) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        continue;
      }
      let count = 0;
      let sample = '';
      for (const marker of PLACEHOLDER_MARKERS) {
        const times = text.split(marker).length - 1;
        if (times > 0) {
          count += times;
          if (!sample) sample = marker;
        }
      }
      if (count > 0) hits.push({ path: rel, count, sample });
    }
  }
  return hits;
}

/** 重放对账：现役机器态 vs 重放结果（软字段；硬账另查）。 */
function diffAgainstReplay(state, index, ledger, rebuilt) {
  const issues = [];
  const warn = (code, what) => issues.push({
    severity: 'warn',
    code,
    message: `${what}与提交链重放结果不一致（可能被手工编辑过；确认无误后可用 rebuild 归一）。`,
  });

  const softWrong = [];
  for (const entry of index.chapters) {
    const re = findChapter(rebuilt.index, entry.chapter);
    if (!re) continue; // 缺账已由硬账检查报告，这里不重复
    for (const key of ['strand', 'hook', 'ending', 'summary']) {
      if (!same(entry[key] ?? null, re[key] ?? null)) {
        softWrong.push(`第 ${entry.chapter} 章的 ${key}`);
        break;
      }
    }
  }
  if (softWrong.length > 0) {
    issues.push({
      severity: 'warn',
      code: 'replay-index',
      message: `索引字段与提交链重放不一致：${softWrong.slice(0, 6).join('、')}${softWrong.length > 6 ? ` 等 ${softWrong.length} 处` : ''}。`,
    });
  }

  if (!same(state.protagonist, rebuilt.state.protagonist)) warn('replay-protagonist', '主角状态');
  if (!same(state.characters, rebuilt.state.characters)) warn('replay-characters', '角色表');
  if (!same(state.world, rebuilt.state.world)) warn('replay-world', '世界设定');
  if (!same(state.timeline, rebuilt.state.timeline)) warn('replay-timeline', '事件时间线');
  if (!same(state.strand, rebuilt.state.strand)) warn('replay-strand', '三线状态');
  // 伏笔台账：id 是内部序号（历史重提可能漂移），对账时忽略 id 只比事实字段
  const project = (ledger) => ledger.items.map(({ id, ...rest }) => rest);
  if (!same(project(ledger), project(rebuilt.ledger))) warn('replay-foreshadowing', '伏笔台账');

  return issues;
}

/**
 * 体检（只读）。
 * @returns {{ok, issues: Array<{severity, code, message}>, stats}}
 */
export function doctorCheck(root) {
  const issues = [];
  const add = (severity, code, message) => issues.push({ severity, code, message });

  const { value: project } = readProject(root);
  if (!project) {
    throw new Error('这不是一个已初始化的书项目（缺少 .webnovel/project.json）。请先运行 webnovel_init。');
  }

  const { value: state, warnings: sw } = readState(root);
  const { value: index, warnings: iw } = readIndex(root);
  const { value: ledger, warnings: lw } = readForeshadowing(root);
  for (const w of [...sw, ...iw, ...lw]) add('error', 'unreadable', w);

  // ---- 提交链 ----
  const chapterNumbers = listCommits(root);
  const records = [];
  for (const ch of chapterNumbers) {
    const rec = readCommit(root, ch);
    if (!rec) {
      add('error', 'commit-broken', `第 ${ch} 章的提交记录损坏（无法解析），无法参与重放。`);
      continue;
    }
    records.push(rec);
  }

  // ---- 章节集合对账 ----
  const recordSet = new Set(records.map((r) => toInt(r.chapter)));
  const indexSet = new Set(index.chapters.map((c) => toInt(c.chapter)));
  const missingInIndex = [...recordSet].filter((n) => !indexSet.has(n)).sort((a, b) => a - b);
  const extraInIndex = [...indexSet].filter((n) => !recordSet.has(n)).sort((a, b) => a - b);
  if (missingInIndex.length > 0) add('error', 'index-missing', `提交链里的第 ${missingInIndex.join('、')} 章不在索引中——索引缺账。`);
  if (extraInIndex.length > 0) add('error', 'index-extra', `索引里的第 ${extraInIndex.join('、')} 章没有提交记录——无法追溯来源。`);

  // ---- 逐章字段对账 ----
  const wrong = [];
  for (const rec of records) {
    const entry = findChapter(index, rec.chapter);
    if (!entry) continue;
    if (toInt(entry.words) !== toInt(rec.words)) {
      wrong.push(`第 ${rec.chapter} 章字数（索引 ${toInt(entry.words)} / 记录 ${toInt(rec.words)}）`);
    }
    if (String(entry.title) !== String(rec.title)) {
      wrong.push(`第 ${rec.chapter} 章标题（索引「${entry.title}」/ 记录「${rec.title}」）`);
    }
  }
  if (wrong.length > 0) add('error', 'index-field-mismatch', `索引与提交记录不一致：${wrong.slice(0, 6).join('；')}${wrong.length > 6 ? ` 等 ${wrong.length} 处` : ''}。`);

  // ---- 进度硬账 ----
  const maxCh = recordSet.size > 0 ? Math.max(...recordSet) : 0;
  const cc = toInt(state.progress.currentChapter);
  if (cc !== maxCh) add('error', 'progress-chapter', `当前进度是第 ${cc} 章，提交链最大章号是第 ${maxCh} 章——对不上。`);
  const indexWords = index.chapters.reduce((sum, c) => sum + toInt(c.words), 0);
  const tw = toInt(state.progress.totalWords);
  if (tw !== indexWords) add('error', 'progress-words', `总字数（${tw}）与索引字数合计（${indexWords}）对不上。`);

  // ---- 文件完整性 ----
  const missingFiles = [];
  for (const entry of index.chapters) {
    if (!entry.file) continue;
    if (!exists(path.join(root, entry.file))) missingFiles.push(`第 ${entry.chapter} 章（${entry.file}）`);
  }
  if (missingFiles.length > 0) {
    add('error', 'file-missing', `索引指向的正文文件不存在：${missingFiles.slice(0, 6).join('；')}${missingFiles.length > 6 ? ` 等 ${missingFiles.length} 处` : ''}。`);
  }
  const summaryMissing = [];
  for (const rec of records) {
    const num = toInt(rec.chapter);
    if (!exists(inside(root, DIRS.summaries, `ch${String(num).padStart(4, '0')}.md`))) summaryMissing.push(num);
  }
  if (summaryMissing.length > 0) add('warn', 'summary-missing', `第 ${summaryMissing.join('、')} 章缺摘要文件（rebuild 可补齐）。`);
  const uncommitted = listChapterFiles(root)
    .map((f) => /^第(\d+)章/.exec(f.name))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => !recordSet.has(n));
  if (uncommitted.length > 0) add('info', 'text-uncommitted', `正文/ 里还有未提交的章节：第 ${uncommitted.join('、')} 章。`);

  // ---- 重放对账 ----
  const { bundle } = replayChain(root, records);
  issues.push(...diffAgainstReplay(state, index, ledger, bundle));

  // ---- 骨架占位符 ----
  const placeholders = scanPlaceholders(root);
  for (const hit of placeholders) {
    add('info', 'placeholder', `骨架未填完：${hit.path} 还有 ${hit.count} 处占位符（如「${hit.sample}」）。`);
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    stats: {
      chapters: recordSet.size,
      replayed: records.length,
      brokenCommits: chapterNumbers.length - records.length,
      uncommittedText: uncommitted.length,
      placeholders: placeholders.length,
    },
  };
}

/** 渲染体检报告（Markdown）。 */
export function renderDoctorMarkdown(root, result) {
  const { value: project } = readProject(root);
  const lines = [];
  lines.push(`# 体检报告 · ${wrapTitle(project?.title)}`);
  lines.push('');

  const errs = result.issues.filter((i) => i.severity === 'error');
  const warns = result.issues.filter((i) => i.severity === 'warn');
  const infos = result.issues.filter((i) => i.severity === 'info');
  const dirty = errs.length > 0 || warns.some((i) => i.code.startsWith('replay'));

  lines.push(`- 提交链：${result.stats.chapters} 章（损坏 ${result.stats.brokenCommits} 条）｜重放核对：${result.stats.replayed} 章`);
  lines.push('');

  if (!dirty) {
    lines.push(errs.length === 0 && warns.length === 0 && infos.length === 0
      ? '✅ 结论：账目、文件与提交链重放全部一致，机器态健康。'
      : '✅ 结论：账目与文件全部对得上，机器态健康。以下是不影响一致性的提示：');
  } else {
    lines.push('🔴 结论：机器态与提交链对不上账——建议按下方建议修复。');
  }
  if (result.issues.length > 0) {
    lines.push('');
    const icon = { error: '🔴', warn: '🟡', info: '⚪' };
    for (const i of [...errs, ...warns, ...infos]) lines.push(`- ${icon[i.severity]} ${i.message}`);
  }
  if (dirty) {
    lines.push('');
    lines.push('修复：调 `webnovel_doctor action=rebuild confirm=true` —— 从提交链重放重建机器态，重建前会自动备份到 `.webnovel/trash/`。');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * rebuild
 * ------------------------------------------------------------------ */

/** 备份机器态到 .webnovel/trash/rebuild-<时间戳>/，返回备份目录绝对路径。 */
function makeBackup(root) {
  const stamp = isoNow().replace(/[:.]/g, '-');
  let backupDir = inside(root, DIRS.trash, `rebuild-${stamp}`);
  let n = 1;
  while (exists(backupDir)) {
    n += 1;
    backupDir = inside(root, DIRS.trash, `rebuild-${stamp}-${n}`);
  }
  fs.mkdirSync(backupDir, { recursive: true });
  for (const file of [FILES.state, FILES.index, FILES.foreshadowing]) {
    const src = path.join(root, file);
    if (exists(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(file)));
  }
  const summaries = inside(root, DIRS.summaries);
  if (exists(summaries)) {
    // 用 copyTree 而不是 fs.cpSync：见 store.js 的注释（Windows + 中文路径会直接打挂进程，
    // 而这里正是「恢复动作」——崩在这儿的代价最大）。
    copyTree(summaries, path.join(backupDir, 'summaries'));
  }
  return backupDir;
}

/**
 * 从提交链重建机器态（持有项目锁；先备份）。
 * @returns {Promise<{applied, skipped, backupDir, indexBefore, indexAfter, lines}>}
 */
export async function doctorRebuild(root, { confirm = false } = {}) {
  if (confirm !== true) {
    throw new Error('重建会覆盖机器态文件（会先自动备份到 .webnovel/trash/）。确认重建请显式传 confirm=true。');
  }
  return withProjectLock(root, () => {
    const { value: project } = readProject(root);
    if (!project) throw new Error('这不是一个已初始化的书项目（缺少 .webnovel/project.json）。请先运行 webnovel_init。');

    const chapters = listCommits(root);
    if (chapters.length === 0) {
      throw new Error('提交链里没有任何章节，没有可重放的依据——重建被拒绝（现有机器态保持不动）。');
    }

    const { value: currentState } = readState(root);
    const { value: currentIndex } = readIndex(root);

    // 1) 备份（先备份，后动手）
    const backupDir = makeBackup(root);

    // 2) 重放
    const records = [];
    const skipped = [];
    for (const ch of chapters) {
      const rec = readCommit(root, ch);
      if (rec) records.push(rec);
      else skipped.push(ch);
    }
    const { bundle, perChapter, perChapterState } = replayChain(root, records);

    // 提交链覆盖不到的部分保持不动：卷登记信息不属于提交链
    bundle.state.progress.volumes = Array.isArray(currentState.progress?.volumes) ? currentState.progress.volumes : [];

    // 3) 写回机器态 + 摘要文件
    writeState(root, bundle.state);
    writeIndex(root, bundle.index);
    writeForeshadowing(root, bundle.ledger);
    for (const rec of records) {
      const num = toInt(rec.chapter);
      const entry = perChapter.get(num);
      const stateAfter = perChapterState.get(num);
      writeTextAtomic(
        inside(root, DIRS.summaries, `ch${String(num).padStart(4, '0')}.md`),
        renderSummary(entry, stateAfter, num),
      );
    }

    const backupRel = path.relative(root, backupDir).split(path.sep).join('/');
    const lines = [
      `已从提交链重建机器态：重放 ${records.length} 章成功。`,
      `- 备份（重建前）：${backupRel}/（state / index / 伏笔台账 / 摘要）`,
      `- 已重写：.webnovel/state.json、.webnovel/index.json、.webnovel/foreshadowing.json、摘要 ${records.length} 篇`,
      `- 索引章节数：${currentIndex.chapters.length} → ${bundle.index.chapters.length}`,
      '- 不受影响：记忆（memory.json）、审查记录（reviews/）、卷登记信息。',
    ];
    if (skipped.length > 0) {
      lines.push(`- ⚠ 第 ${skipped.join('、')} 章提交记录不可读，已跳过（原样保留在备份中）。`);
    }
    lines.push('', '建议接着跑一次 action=check 确认全绿。');
    return {
      applied: records.length,
      skipped,
      backupDir: backupRel,
      indexBefore: currentIndex.chapters.length,
      indexAfter: bundle.index.chapters.length,
      lines,
    };
  });
}
