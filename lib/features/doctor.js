/**
 * doctor：机器态体检与重建（P1-1）。
 *
 * check（只读）：把提交链完整重放一遍，与当前的
 *   state.json / index.json / foreshadowing.json / terms.json / 正文文件 / 摘要文件
 *   逐项对账，再扫一遍骨架里的未填占位符。核心不变量：提交链是唯一事实来源，
 *   「重放结果 == 现役机器态」才叫健康。
 *
 * rebuild（写）：从提交链重放重建机器态。先自动备份到 .webnovel/trash/；
 *   只重建「由提交链推导」的部分——记忆（memory.json）、审查记录（reviews/）、
 *   卷登记信息（state.progress.volumes）不属于提交链，一律保持不动。
 *   专名账本（terms.json）与伏笔台账同理：只由 deltas 推导，所以会被重建覆盖
 *   ——想手工加专名也走 webnovel_commit 的 deltas.terms，别改文件（改了重建会没）。
 *
 * 重放与实时提交共用 applyChapterFacts（见 commit.js）——两边永不漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, inside, findChapterFile, listChapterFiles } from '../core/paths.js';
import { exists, withProjectLock, writeTextAtomic, copyTree, writeJsonAtomic, SCHEMA_VERSION } from '../core/store.js';
import {
  defaultState, defaultIndex, defaultForeshadowing, defaultTerms,
  readState, readIndex, readForeshadowing, readTerms, readProject,
  writeState, writeIndex, writeForeshadowing, writeTerms, findChapter,
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

/** 迁移基线文件名（v1.4.0 起支持；放在提交目录里，与章节记录一起参与重放）。 */
const BASELINE_FILE = '_baseline.json';

/**
 * 读取迁移基线。基线记录的是「v1.4.0 升级时已存在、但不在提交链里的人工状态」，
 * 例如 v1.3.0 以前直接改 state.json / terms.json 留下的章节备注与专名。
 *
 * 为什么允许这种记录：提交链是常态下唯一事实来源，但老书已经有人工维护的数据；
 * 升级时把当前态一次性写成可重放的基线，比重建时丢掉、或让 check 永远红着都诚实。
 * 基线之后的章节继续在基线上叠加，新提交仍走正常的 deltas。
 *
 * 形状不正确一律忽略并报错——坏基线比没有基线更危险（rebuild 会照着它写盘）。
 */
export function readBaselines(root) {
  const dir = inside(root, DIRS.commits);
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter((f) => f === BASELINE_FILE || /^_baseline-.+\.json$/.test(f))
      .sort();
  } catch {
    return { records: [], issues: [] };
  }
  const records = [];
  const issues = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const badIndex = raw?.index != null && !Array.isArray(raw.index.chapters);
      if (raw?.kind !== 'state-baseline' || !raw.state || !Array.isArray(raw.ledger?.items) || !Array.isArray(raw.terms?.items) || badIndex) {
        issues.push(`迁移基线 ${name} 形状不正确（需要 kind=state-baseline + state/ledger/terms，index.chapters 可选），已忽略。`);
        continue;
      }
      records.push({ ...raw, file: name, basedOnChapter: Math.max(0, toInt(raw.basedOnChapter)) });
    } catch (err) {
      issues.push(`迁移基线 ${name} 无法解析：${err.message}`);
    }
  }
  return { records, issues };
}

/** 深拷贝 JSON 值，避免基线对象被后续 applyChapterFacts 改到。 */
const cloneJson = (value) => JSON.parse(JSON.stringify(value));

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
function replayChain(root, records, baselines = []) {
  let bundle = { state: defaultState(), index: defaultIndex(), ledger: defaultForeshadowing(), terms: defaultTerms() };
  const perChapter = new Map();
  const perChapterState = new Map();
  const events = [
    ...records.map((rec) => ({ type: 'chapter', at: toInt(rec.chapter), rec })),
    ...baselines.map((b) => ({ type: 'baseline', at: toInt(b.basedOnChapter), b })),
  ].sort((a, b) => a.at - b.at || (a.type === 'chapter' ? 0 : 1));
  for (const ev of events) {
    if (ev.type === 'baseline') {
      // 基线是「这一章之后的人工状态快照」：整份替换机器态；索引若随基线保存也一并替换。
      // 只用于最终机器态与后续章节；不回填更早章节的摘要快照。
      bundle = {
        state: cloneJson(ev.b.state),
        index: ev.b.index && Array.isArray(ev.b.index.chapters) ? cloneJson(ev.b.index) : bundle.index,
        ledger: cloneJson(ev.b.ledger),
        terms: cloneJson(ev.b.terms),
      };
      continue;
    }
    const rec = ev.rec;
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
    bundle = { state: out.state, index: out.index, ledger: out.ledger, terms: out.terms };
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
function diffAgainstReplay(state, index, ledger, terms, rebuilt) {
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
  // 专名账本：名字即主键、条目不存时间，所以整份可以直接比（能比是因为设计时就去掉了 id 和时间）
  if (!same(terms.items, rebuilt.terms.items)) warn('replay-terms', '专名账本');

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
  const { value: terms, warnings: tmw } = readTerms(root);
  for (const w of [...sw, ...iw, ...lw, ...tmw]) add('error', 'unreadable', w);

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

  // ---- 重放对账（含迁移基线）----
  const { records: baselines, issues: baselineIssues } = readBaselines(root);
  for (const msg of baselineIssues) add('error', 'baseline-broken', msg);
  const { bundle } = replayChain(root, records, baselines);
  issues.push(...diffAgainstReplay(state, index, ledger, terms, bundle));
  if (baselines.length > 0) {
    const based = baselines.map((b) => `第 ${b.basedOnChapter} 章`).join('、');
    add('info', 'baseline-applied', `已登记迁移基线（${based}）：基线里的人工状态按原样保留，之后的新章节继续在基线上叠加。`);
  }

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
      terms: terms.items.length,
    },
  };
}

/**
 * 迁移对账（持有项目锁；先备份）。
 *
 * 用途：老书里存在「提交链之外的人工维护数据」（例如直接改 state.json 补人物备注、
 * 手工改 terms.json / foreshadowing.json）。rebuild 会把这些当脏数据清掉，check 则永远红着。
 * reconcile 不去猜谁对谁错，而是把**当前机器态**登记成一份可重放的迁移基线：
 *   - 之后 check = 提交链 + 基线，与现役数据一致；
 *   - 之后 rebuild 从链上重放也不会丢人工数据；
 *   - 之后提交的新章节继续在基线上叠加（applyChapterFacts 与实时提交同一条路径）。
 *
 * 只修「客观可判」的引用错误：索引里的失效正文路径、索引字数/标题、进度章号/总字数。
 * 结构性错误（索引缺章/多章、提交记录损坏、正文缺失）一律拒绝——那是数据缺失，不是对账。
 *
 * 失败自动回滚到操作前的机器态（备份在 .webnovel/trash/ 里也保留一份）。
 *
 * @param {string} root
 * @param {{confirm?: boolean, reason?: string}} options
 */
export async function doctorReconcile(root, { confirm = false, reason = '' } = {}) {
  if (confirm !== true) {
    throw new Error('reconcile 会把当前机器态登记为迁移基线（会先自动备份到 .webnovel/trash/）。确认请显式传 confirm=true。');
  }
  return withProjectLock(root, () => {
    const { value: project } = readProject(root);
    if (!project) throw new Error('这不是一个已初始化的书项目（缺少 .webnovel/project.json）。请先运行 webnovel_init。');

    const { value: state, warnings: sw } = readState(root);
    const { value: index, warnings: iw } = readIndex(root);
    const { value: ledger, warnings: lw } = readForeshadowing(root);
    const { value: terms, warnings: tmw } = readTerms(root);
    const readProblems = [...sw, ...iw, ...lw, ...tmw];
    if (readProblems.length > 0) {
      throw new Error(`有机器态文件读不出来，先查清再 reconcile：${readProblems.join('；')}`);
    }

    // ---- 提交记录 ----
    const chapters = listCommits(root);
    const records = [];
    const broken = [];
    for (const ch of chapters) {
      const rec = readCommit(root, ch);
      if (rec) records.push(rec);
      else broken.push(ch);
    }
    if (broken.length > 0) {
      throw new Error(`第 ${broken.join('、')} 章提交记录损坏，reconcile 不会替坏记录编事实——先修记录或从备份恢复。`);
    }
    if (records.length === 0) {
      throw new Error('提交链里没有任何章节，没有可对账的基线位置——reconcile 被拒绝。');
    }

    const recordByChapter = new Map(records.map((r) => [toInt(r.chapter), r]));
    const recordSet = new Set(recordByChapter.keys());
    const indexSet = new Set(index.chapters.map((c) => toInt(c.chapter)));
    const missingInIndex = [...recordSet].filter((n) => !indexSet.has(n)).sort((a, b) => a - b);
    const extraInIndex = [...indexSet].filter((n) => !recordSet.has(n)).sort((a, b) => a - b);
    if (missingInIndex.length > 0 || extraInIndex.length > 0) {
      const parts = [];
      if (missingInIndex.length > 0) parts.push(`第 ${missingInIndex.join('、')} 章在提交链里但不在索引里`);
      if (extraInIndex.length > 0) parts.push(`第 ${extraInIndex.join('、')} 章在索引里但没有提交记录`);
      throw new Error(`索引与提交链的章节集合对不上（${parts.join('；')}）。这是数据缺失/多账，reconcile 不掩盖——先查清。`);
    }

    // ---- 基线位置与旧基线 ----
    const maxCh = Math.max(...recordSet);
    const { records: existingBaselines, issues: baselineIssues } = readBaselines(root);
    if (baselineIssues.length > 0) {
      throw new Error(`已存在的迁移基线损坏，先处理它再 reconcile：${baselineIssues.join('；')}`);
    }
    const futureBaseline = existingBaselines.find((b) => toInt(b.basedOnChapter) > maxCh);
    if (futureBaseline) {
      throw new Error(`迁移基线 ${futureBaseline.file} 的位置（第 ${futureBaseline.basedOnChapter} 章）晚于提交链最大章（第 ${maxCh} 章）——可能有提交记录丢失，reconcile 被拒绝。`);
    }

    // ---- 先只读体检，确认确有需要修的差异 ----
    const before = doctorCheck(root);
    const fixable = /^(file-missing|index-field-mismatch|progress-|replay-)/;
    if (!before.issues.some((i) => fixable.test(i.code))) {
      throw new Error('体检没有发现可用 reconcile 解决的差异（或只剩提示项），不需要登记基线。');
    }

    // ---- 计算修复（先在内存里改，验证不过不写盘）----
    const repairs = [];
    const nextIndex = cloneJson(index);
    const nextState = cloneJson(state);

    for (const entry of nextIndex.chapters) {
      const num = toInt(entry.chapter);
      const rec = recordByChapter.get(num);
      if (!rec) continue; // 集合已核对，这里不会发生

      // 1) 字数/标题以提交记录为准（客观事实，不是人工数据）
      if (toInt(entry.words) !== toInt(rec.words)) {
        repairs.push(`第 ${num} 章字数：索引 ${toInt(entry.words)} → 记录 ${toInt(rec.words)}`);
        entry.words = toInt(rec.words);
      }
      if (String(entry.title) !== String(rec.title)) {
        repairs.push(`第 ${num} 章标题：索引「${entry.title}」→ 记录「${rec.title}」`);
        entry.title = rec.title;
      }

      // 2) 失效正文路径按「第NNNN章」前缀找实际文件（正文缺失则不猜）
      //    没有登记 file 的条目不算引用错误——doctorCheck 的 file-missing 同样只查已登记的路径。
      if (!entry.file) continue;
      const currentFile = path.join(root, entry.file);
      if (exists(currentFile)) continue;
      {
        const actual = findChapterFile(root, num);
        if (!actual) {
          throw new Error(`第 ${num} 章的正文文件找不到（索引指向 ${entry.file}）——正文缺失无法 reconcile，请先恢复正文。`);
        }
        const rel = path.relative(root, actual).split(path.sep).join('/');
        repairs.push(`第 ${num} 章正文路径：${entry.file} → ${rel}`);
        entry.file = rel;
      }
    }

    const indexWords = nextIndex.chapters.reduce((sum, c) => sum + toInt(c.words), 0);
    if (toInt(nextState.progress.currentChapter) !== maxCh) {
      repairs.push(`当前进度：第 ${toInt(nextState.progress.currentChapter)} 章 → 第 ${maxCh} 章（提交链最大章号）`);
      nextState.progress.currentChapter = maxCh;
    }
    if (toInt(nextState.progress.totalWords) !== indexWords) {
      repairs.push(`总字数：${toInt(nextState.progress.totalWords)} → ${indexWords}（索引字数合计）`);
      nextState.progress.totalWords = indexWords;
    }

    // ---- 备份（先备份，后动手）----
    const backupDir = makeBackup(root);
    const baselinePath = inside(root, DIRS.commits, BASELINE_FILE);
    const previousBaseline = exists(baselinePath) ? fs.readFileSync(baselinePath, 'utf8') : null;
    let archivedBaseline = null;
    const touched = [];

    try {
      // 3) 旧基线换章号时归档保留（同一章号直接覆盖）——重放语义更忠实
      const previous = existingBaselines.find((b) => b.file === BASELINE_FILE);
      if (previous && toInt(previous.basedOnChapter) !== maxCh) {
        const stamp = isoNow().replace(/[:.]/g, '-');
        archivedBaseline = inside(root, DIRS.commits, `_baseline-ch${String(toInt(previous.basedOnChapter)).padStart(4, '0')}-${stamp}.json`);
        fs.renameSync(baselinePath, archivedBaseline);
      }

      // 4) 写修复后的机器态
      if (repairs.some((r) => r.startsWith('当前进度') || r.startsWith('总字数'))) {
        writeState(root, nextState);
        touched.push(FILES.state);
      }
      if (repairs.some((r) => r.startsWith('第 ') && (r.includes('章字数') || r.includes('章标题') || r.includes('章正文路径')))) {
        writeIndex(root, nextIndex);
        touched.push(FILES.index);
      }

      // 5) 登记迁移基线（基于修复后的状态，保证「基线 == 现役态」）
      const baseline = {
        schemaVersion: SCHEMA_VERSION,
        kind: 'state-baseline',
        createdAt: isoNow(),
        basedOnChapter: maxCh,
        reason: String(reason ?? '').trim() || '保留提交链之外的人工维护数据（v1.4.0 迁移）',
        state: cloneJson(nextState),
        index: cloneJson(nextIndex),
        ledger: cloneJson(ledger),
        terms: cloneJson(terms),
      };
      writeJsonAtomic(baselinePath, baseline);
      touched.push(path.relative(root, baselinePath).split(path.sep).join('/'));

      // 6) 用真体检自证；不过就回滚
      const after = doctorCheck(root);
      if (!after.ok) {
        throw new Error(`reconcile 后体检仍有错误，已回滚：${after.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('；')}`);
      }

      const backupRel = path.relative(root, backupDir).split(path.sep).join('/');
      const baselineRel = path.relative(root, baselinePath).split(path.sep).join('/');
      const warnLeft = after.issues.filter((i) => i.severity === 'warn').length;
      const lines = [
        `已登记迁移基线：提交链第 1–${maxCh} 章 + 当前机器态人工数据。`,
        `- 基线文件：${baselineRel}（kind=state-baseline，basedOnChapter=${maxCh}）`,
        `- 用途：${baseline.reason}`,
        `- 备份（操作前）：${backupRel}/`,
        repairs.length > 0
          ? `- 顺带修复 ${repairs.length} 处客观引用：${repairs.slice(0, 6).join('；')}${repairs.length > 6 ? ` 等 ${repairs.length} 处` : ''}`
          : '- 客观引用（正文路径/字数/进度）本来就对得上，无需修复。',
        `- 体检：${after.ok ? '✅ 无错误' : '🔴 仍有错误'}（剩余提示 ${warnLeft} 条）`,
        '- 之后的新章节继续在基线上叠加；要再人工改 state/terms，先改再用 reconcile 重新登记（或走 deltas）。',
        '建议接着跑一次 action=check 确认全绿。',
      ];
      return {
        backupDir: backupRel,
        baselineFile: baselineRel,
        basedOnChapter: maxCh,
        repairs,
        before: { errors: before.issues.filter((i) => i.severity === 'error').length, warns: before.issues.filter((i) => i.severity === 'warn').length },
        after: { ok: after.ok, errors: after.issues.filter((i) => i.severity === 'error').length, warns: warnLeft },
        archivedBaseline: archivedBaseline ? path.relative(root, archivedBaseline).split(path.sep).join('/') : null,
        lines,
      };
    } catch (err) {
      // 回滚：机器态从备份恢复；基线恢复为操作前（没有则删掉本次新建的）
      for (const rel of touched) {
        const abs = path.join(root, rel);
        const backupAbs = path.join(backupDir, path.basename(rel));
        if (rel === path.relative(root, baselinePath).split(path.sep).join('/')) continue;
        if (exists(backupAbs)) {
          try { fs.copyFileSync(backupAbs, abs); } catch { /* 尽力而为 */ }
        }
      }
      try {
        if (previousBaseline === null) {
          if (exists(baselinePath)) fs.rmSync(baselinePath);
        } else {
          writeTextAtomic(baselinePath, previousBaseline);
        }
        if (archivedBaseline && exists(archivedBaseline)) fs.rmSync(archivedBaseline);
      } catch { /* 尽力而为 */ }
      throw err;
    }
  });
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

  lines.push(`- 提交链：${result.stats.chapters} 章（损坏 ${result.stats.brokenCommits} 条）｜重放核对：${result.stats.replayed} 章｜专名账本：${result.stats.terms ?? 0} 条`);
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
  for (const file of [FILES.state, FILES.index, FILES.foreshadowing, FILES.terms]) {
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

    // 坏基线不能参与重建：它会整份写进 state/ledger/terms，比不重建更危险。
    const { records: baselines, issues: baselineIssues } = readBaselines(root);
    if (baselineIssues.length > 0) {
      throw new Error(`迁移基线损坏，重建被拒绝（现有机器态保持不动）：${baselineIssues.join('；')}`);
    }

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
    const { bundle, perChapter, perChapterState } = replayChain(root, records, baselines);

    // 提交链覆盖不到的部分保持不动：卷登记信息与部登记表都不属于提交链
    bundle.state.progress.volumes = Array.isArray(currentState.progress?.volumes) ? currentState.progress.volumes : [];
    bundle.state.progress.parts = Array.isArray(currentState.progress?.parts) ? currentState.progress.parts : [];

    // 3) 写回机器态 + 摘要文件
    writeState(root, bundle.state);
    writeIndex(root, bundle.index);
    writeForeshadowing(root, bundle.ledger);
    writeTerms(root, bundle.terms);
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
      `- 备份（重建前）：${backupRel}/（state / index / 伏笔台账 / 专名账本 / 摘要）`,
      `- 已重写：.webnovel/state.json、.webnovel/index.json、.webnovel/foreshadowing.json、.webnovel/terms.json、摘要 ${records.length} 篇`,
      `- 专名账本：重建后 ${bundle.terms.items.length} 条（要手工补登记请走 webnovel_commit 的 deltas.terms，直接改文件会被下次重建覆盖）`,
      `- 索引章节数：${currentIndex.chapters.length} → ${bundle.index.chapters.length}`,
      '- 不受影响：记忆（memory.json）、审查记录（reviews/）、卷登记信息、部登记表与部摘要归档（parts/）。',
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
