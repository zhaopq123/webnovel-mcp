/**
 * ★ 提交链：把一章的「事实」落库。
 *
 * 产品定位（PRD F4）：这是「不忘」的物理基础。
 * 每写完一章，把该章产生的事实变化提交进来，系统据此更新：
 *   状态卡 / 章节索引 / 伏笔台账 / 时间线 / 摘要
 *
 * 四条铁律：
 * 1. 原子性 —— 要么全成功，要么全部不落盘（先算完再统一写）。
 * 2. 幂等 —— 同一章重复提交是覆盖，不是追加。
 * 3. 可审计 —— commits/ 里的记录只增不改，永不删除。
 * 4. 可重放 —— 记录里的 deltas 是「本章累计生效的全部事实」（重提会把上次的
 *    增量合并进来）。doctor 的体检与重建依赖这个不变量，别退化成「只记本次增量」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, inside, findChapterFile } from '../core/paths.js';
import { readText, writeTextAtomic, writeJsonAtomic, withProjectLock, exists } from '../core/store.js';
import {
  readState, readIndex, readForeshadowing, readTerms, readProject,
  defaultTerms,
  writeState, writeIndex, writeForeshadowing, writeTerms,
  upsertChapter, findChapter, applyProtagonistPatch, applyCharacterPatches,
  applyWorldPatch, appendTimeline, applyStrand, upsertForeshadowing, upsertTerm,
  findTerm, nextForeshadowingId, openForeshadowing,
} from '../core/state.js';
import { toInt, countWords, isoNow, deepMerge, mergeArray, textHash } from '../util.js';
import { normalizeStrand } from './pacing.js';
import { readReviewRecord } from './review.js';
import {
  ensureStyleBaseline, detectStyleDrift, markStyleChecked, saveStyleReport, renderStyleDriftItems,
} from './style.js';
import { validateKnowledge, applyKnowledge, renderKnowledgeItem } from './knowledge.js';
import { normalizeTermType, knownProperNouns, detectUnregisteredTerms, renderUnregisteredWarning } from './terms.js';
import { normalizeDossierPatch } from './dossier.js';
import {
  compactLedgerPatch, isKnownLedgerType, normalizeLedgerLayer,
  ledgerTypeLabel, withHint, hintsOf, debtFromProject, typeOf,
} from './ledger.js';

/** 允许的钩子强度。 */
const HOOK_STRENGTHS = ['weak', 'medium', 'strong'];

/** 取第一个有效正整数（都为空时返回 null）——「到期章」的两个说法归一成一个落库字段用。 */
function firstPositiveOrNull(...values) {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const n = toInt(v);
    if (n > 0) return n;
  }
  return null;
}

/** 条目是否还在账上（未回收）。status 缺省按 open 处理，与 ledger.js 的 isOpen 同一口径。 */
const isOpenType = (item) => String(item?.status ?? 'open') === 'open';

/** 去掉全部空白后再比对（中文正文里的换行/缩进不该让证据核对失败）。 */
const squeeze = (text) => String(text ?? '').replace(/\s+/g, '');

/** hinted 元素的键：兼容 `"名称"` 与 `{ name|id, evidence }` 两种写法。 */
function hintedKeyOf(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') return String(item.name ?? item.id ?? '').trim();
  return '';
}

/**
 * 实时提交时的暗示证据核对（2.3 的 hinted）。
 *
 * 只在**实时提交**时核对，重放侧不重复：证据「当时确实在正文里」是提交那一刻的事实；
 * 若重放再查一次，作者日后 force 改稿会让旧章的暗示凭空消失，提交链就不可重放了。
 *
 * - 带 evidence：去空白后必须是本章正文的子串，否则拒绝登记并警告（宁缺勿假）；
 * - 不带 evidence 的旧字符串：照旧登记，但明确提示「补 evidence 才能机械核对」；
 * - 返回值只留字符串键——提交记录与 applyChapterFacts 看到的仍是 v1.2.x 的形状。
 */
function verifyHinted(hinted, bodyText) {
  const hints = [];
  const warnings = [];
  const noEvidence = [];
  const text = squeeze(bodyText);
  for (const item of hinted) {
    const key = hintedKeyOf(item);
    if (!key) {
      warnings.push('暗示登记里有一条既没有名称也没有 id，已忽略。');
      continue;
    }
    const evidence = item && typeof item === 'object' ? String(item.evidence ?? '').trim() : '';
    if (!evidence) {
      noEvidence.push(key);
      hints.push(key);
      continue;
    }
    if (!text.includes(squeeze(evidence))) {
      warnings.push(
        `「${key}」的暗示证据在本章正文里找不到，暗示登记已拒绝——证据：`
        + `${evidence.length > 40 ? `${evidence.slice(0, 40)}…` : evidence}。`
        + '（按去空白后的原文做子串比对；确实暗示了就把原句复制进 evidence。）',
      );
      continue;
    }
    hints.push(key);
  }
  if (noEvidence.length > 0) {
    warnings.push(
      `暗示登记 ${noEvidence.join('、')} 没带 evidence：按旧格式已登记，但无法机械核对正文。`
      + '下次写成 {name:"…", evidence:"正文原句"} 才能核对。',
    );
  }
  return { hints, warnings };
}

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
 *   pov            {string}  本章视角人物（8.2；必须是已登记角色）
 *   deltas         {object}  事实增量（见下）
 *   force          {boolean} 「我知道有警告/拦截，坚持执行」的逃生门：
 *                           跳过上一章未提交警告 / 旧章重提阻断 / 审查门禁。
 *                           旧章重提带 force 时进入「历史修正模式」：deltas 全部忽略，
 *                           只更新该章索引、摘要与字数（线别沿用原值）；记录里保留
 *                           本章此前已生效的 deltas——它们仍生效，链上必须仍可重放。
 *
 * deltas 支持：
 *   protagonist   { location, condition, 'power.realm', goldenFinger:{...} }
 *   characters    [{ name, patch:{...} }]
 *   world         { factions:[], locations:[], powerSystem:[] }
 *   timeline      { time, location, event }
 *   foreshadowing { planted:[{name,plannedPayoff,importance,note,type,layer}], paid:["名称或id"],
 *                   hinted:["名称或id" | {name|id, evidence}] }
 *                 （hinted 带 evidence 时必须能在本章正文里找到，否则拒绝登记——2.3）
 *   terms         [{ name, type, aliases?, note? }]  专名登记（铁律 1「名词锁定」）
 *   knowledge     [{ who, fact, mode:'learn'|'use'|'reveal', witnessedBy?, toldBy?, evidence? }]
 *                 多视角信息隔离（8.2）：learn 必须可追溯，use/reveal 必须先知道；
 *                 违反默认拦截（force 可过），通过校验的 learn 累积进人物卡 knows。
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
    // 老书没有 terms.json 也照样读：readTerms 缺文件回空账本，不报错（additive 演进）
    const { value: terms, warnings: tw } = readTerms(root);
    warnings.push(...sw, ...iw, ...fw, ...tw);

    // ---- 旧章重提防护 ----
    // 重提/补登早于当前进度的章节会让状态卡与伏笔台账回退失真：
    // upsertForeshadowing 会把已回收的伏笔 deepMerge 回 open，applyCharacterPatches
    // 会把 lastChapter 拉回旧章。默认阻断；force 走「历史修正模式」（见下）。
    const currentChapter = toInt(state.progress.currentChapter);
    const isCorrection = chapter < currentChapter;
    const prevEntry = findChapter(index, chapter);
    if (isCorrection && !facts.force) {
      throw new Error(
        `第 ${chapter} 章早于当前进度（第 ${currentChapter} 章）。重提或补登旧章会让状态卡与伏笔台账回退失真`
        + '（已回收伏笔复活、角色 lastChapter 回退）。'
        + '若确要修正这一章（正文重写 / 摘要更正后重新落库），请用 force=true 重提——'
        + '历史修正模式下 deltas 会全部忽略，只更新该章的索引、摘要与字数。',
      );
    }

    // ---- 连续性检查（护栏）----
    if (!facts.force && chapter > 1 && !isCorrection) {
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
    } else if (isCorrection && toInt(prevEntry?.words, 0) > 0) {
      // 历史修正时正文文件可能已改名/移动，没给字数就沿用记录里的，别把已有字数冲成 0
      words = toInt(prevEntry.words, 0);
      warnings.push(`未找到第 ${chapter} 章的正文文件，字数沿用上次提交记录（${words} 字）。`);
    } else {
      warnings.push(`未找到第 ${chapter} 章的正文文件，字数记为 0。建议先写正文再提交。`);
    }

    // ---- 审查门禁 ----
    // L0 场景客户端没有钩子，服务器是唯一能设门的地方：
    // 审查记录与本稿一致且存在 error 级问题时，默认阻断；其余情形只提醒。
    let reviewMeta = null;
    if (!isCorrection) {
      const reviewRecord = readReviewRecord(root, chapter);
      if (!reviewRecord) {
        warnings.push('本章没有审查记录。建议提交前先用 webnovel_review 审一遍——它会落盘审查记录，提交时凭记录放行。');
      } else {
        const hash = textHash(bodyText);
        const stale = Boolean(reviewRecord.textHash) && reviewRecord.textHash !== hash;
        const errs = toInt(reviewRecord.summary?.error, 0);
        if (stale) {
          warnings.push('审查记录对应的是旧稿（审查之后正文又改过），建议重新审查后再提交。');
        }
        if (!stale && errs > 0 && !facts.force) {
          const top = (reviewRecord.issues ?? [])
            .filter((i) => i.severity === 'error')
            .slice(0, 3)
            .map((i, n) => `${n + 1}）${i.message}`)
            .join('；');
          throw new Error(
            `第 ${chapter} 章审查未过：${errs} 个严重问题——${top}。`
            + '修完正文后用 webnovel_review 重新审查再提交；若确认按原稿提交，请传 force=true。',
          );
        }
        if (!stale && errs > 0 && facts.force) {
          warnings.push(`force 提交：本章审查还有 ${errs} 个严重问题未处理。`);
        }
        reviewMeta = {
          reviewedAt: reviewRecord.reviewedAt ?? null,
          textHash: reviewRecord.textHash ?? null,
          summary: reviewRecord.summary ?? null,
          stale,
        };
      }
    }

    // ---- 应用增量 + 生成章节产物 ----
    // 历史修正模式：deltas 全部忽略，状态卡 / 伏笔台账零改动。
    const deltas = facts.deltas && typeof facts.deltas === 'object' ? facts.deltas : {};
    const ignoredDeltas = [];
    if (isCorrection) {
      for (const key of Object.keys(deltas)) {
        if (deltas[key] !== undefined) ignoredDeltas.push(key);
      }
      warnings.push(ignoredDeltas.length > 0
        ? `历史修正模式：deltas 已全部忽略（${ignoredDeltas.join('、')}），只更新第 ${chapter} 章的索引、摘要与字数。状态卡 / 伏笔台账未做任何改动。`
        : `历史修正模式：只更新第 ${chapter} 章的索引、摘要与字数，未触碰状态卡 / 伏笔台账。`);
    }

    const strand = normalizeStrand(facts.strand) ?? null;
    if (facts.strand && !strand) {
      warnings.push(`无法识别线别「${facts.strand}」，已忽略。可用：quest / fire / constellation。`);
    }
    if (isCorrection && strand) {
      const carried = normalizeStrand(prevEntry?.strand) ?? prevEntry?.strand ?? null;
      if (strand !== carried) {
        warnings.push(`历史修正模式：线别沿用原值${carried ? `「${carried}」` : '（原值未设）'}，本次提交的线别已忽略（线别牵扯三线统计，不在修正范围内）。`);
      }
    }

    // ---- 暗示证据核对（2.3）----
    // 核对放在实时提交层，不放进 applyChapterFacts：重放必须复现「当时登记了什么」，
    // 不能因为日后改稿重新审判历史证据（否则 doctor 的对账会凭空漂移）。
    let commitDeltas = deltas;
    if (!isCorrection && Array.isArray(deltas.foreshadowing?.hinted)) {
      const verified = verifyHinted(deltas.foreshadowing.hinted, bodyText);
      warnings.push(...verified.warnings);
      const fsd = { ...deltas.foreshadowing };
      if (verified.hints.length > 0) fsd.hinted = verified.hints;
      else delete fsd.hinted;
      commitDeltas = { ...deltas };
      if (Object.keys(fsd).length > 0) commitDeltas.foreshadowing = fsd;
      else delete commitDeltas.foreshadowing;
    }

    // ---- 多视角信息隔离（8.2）----
    // 校验只看「本章提交的事实」，不看正文文笔；review 可传同一组 pov/knowledge 预检。
    // 被拒的条目即使 force 也不写进记录——force 是「我知道有问题仍要提交」，
    // 不是「把有问题的事实变成真的」。只有通过校验的条目才进入状态与重放链。
    const povName = String(facts.pov ?? '').trim();
    let knowledgeMeta = null;
    if (!isCorrection) {
      const rawKnowledge = Array.isArray(deltas.knowledge) ? deltas.knowledge : [];
      if (povName || rawKnowledge.length > 0) {
        const check = validateKnowledge(state, { pov: povName, knowledge: rawKnowledge });
        warnings.push(...check.warnings);
        if (check.errors.length > 0) {
          const top = check.errors
            .slice(0, 3)
            .map((e, n) => `${n + 1}）${e.message}`)
            .join('；');
          if (!facts.force) {
            throw new Error(
              `第 ${chapter} 章信息隔离校验未过：${check.errors.length} 个严重问题——${top}。`
              + '按建议补 learn / 改台词 / 登记角色后重新提交；确认按原稿提交请传 force=true。',
            );
          }
          warnings.push(`force 提交：本章有 ${check.errors.length} 条信息隔离问题未处理，相关条目未写入状态。`);
        }
        const nextDeltas = { ...commitDeltas };
        if (check.accepted.length > 0) {
          nextDeltas.knowledge = check.accepted.map(({ id, ...rest }) => rest);
        } else {
          delete nextDeltas.knowledge;
        }
        commitDeltas = nextDeltas;
        knowledgeMeta = {
          pov: povName || null,
          learned: check.learned,
          used: check.accepted.filter((i) => i.mode === 'use').map((i) => ({ who: i.who, fact: i.fact })),
          revealed: check.accepted.filter((i) => i.mode === 'reveal').map((i) => ({ who: i.who, fact: i.fact })),
          rejected: check.errors.length,
        };
      }
    }

    const title = String(facts.title ?? '').trim()
      || guessTitleFromFile(chapterFile)
      || (isCorrection ? String(prevEntry?.title ?? '').trim() : '')
      || `第${chapter}章`;

    // ★ 与 doctor 的提交链重放共用同一核心：实时提交与「从记录重放」必须逐字段一致。
    const core = applyChapterFacts(
      { state, index, ledger, terms },
      chapter,
      {
        title,
        words,
        file: chapterFile ? path.relative(root, chapterFile).split(path.sep).join('/') : null,
        strand: facts.strand,
        hook: facts.hook,
        ending: facts.ending,
        summary: facts.summary,
        deltas: commitDeltas,
        correction: isCorrection,
      },
    );
    warnings.push(...core.warnings);
    const nextState = core.state;
    const nextIndex = core.index;
    const nextLedger = core.ledger;
    const nextTerms = core.terms;
    const entry = core.entry;
    const plantedReport = core.planted;
    const paidReport = core.paid;
    const hintedReport = core.hinted ?? [];
    const registeredReport = core.registered;

    // ---- 文风基准与漂移（15.6）----
    // 基线自动建、前 5 章取平均、每 30 章比一次；人工基准（memory action=baseline）优先，
    // ensureStyleBaseline 见到 source=manual 不会自动吸收新样本。
    let styleMeta = null;
    if (!isCorrection && bodyText.trim()) {
      const ensured = ensureStyleBaseline(root, chapter, bodyText);
      const drift = detectStyleDrift(ensured.baseline, chapter, bodyText);
      let styleReportPath = null;
      if (drift.checked && drift.drifted) {
        styleReportPath = saveStyleReport(root, chapter, { baseline: ensured.baseline, drift, text: bodyText });
        const rel = path.relative(root, styleReportPath).split(path.sep).join('/');
        warnings.push(
          `文风漂移：${renderStyleDriftItems(drift.items)}（基线第 ${ensured.baseline.calibratedAtChapter} 章，报告 ${rel}）。`
          + '若是有意调整文风，用 webnovel_memory action=baseline 重设基准；否则按报告里的指标回拉。',
        );
      }
      if (drift.checked) markStyleChecked(root, ensured.baseline, chapter);
      styleMeta = {
        baselineSource: ensured.baseline.source,
        baselineCreated: ensured.created,
        baselineSampled: ensured.sampled,
        baselineAtChapter: ensured.baseline.calibratedAtChapter,
        checked: drift.checked,
        drifted: drift.drifted,
        skipped: drift.skipped,
        items: drift.items,
        reportPath: styleReportPath
          ? path.relative(root, styleReportPath).split(path.sep).join('/')
          : null,
      };
    }

    // ---- 名词锁定（铁律 1）：正文里出现、机器态里查无此名的疑似专名 ----
    // 只提醒不拦截：识别是启发式，误报会存在；拦截等于把启发式的错误变成作者的损失。
    // 「已知」全集比账本宽（角色卡/世界设定/时间线都算），所以本章刚登记的角色不会重复报。
    const unregistered = detectUnregisteredTerms(bodyText, knownProperNouns(nextState, nextTerms));
    const unregisteredWarning = renderUnregisteredWarning(unregistered);
    if (unregisteredWarning) warnings.push(unregisteredWarning);

    // ---- 摘要文件 ----
    const summaryText = renderSummary(entry, nextState, chapter);
    writeTextAtomic(inside(root, DIRS.summaries, `ch${String(chapter).padStart(4, '0')}.md`), summaryText);

    // ---- 提交记录（审计链）----
    // 记录里的 deltas 是「本章累计生效的全部事实」：重提时把上次记录合并进来，
    // 审计链才能被完整重放（doctor 依赖此不变量）。
    // 修正模式不产生新事实，但必须把上次记录的 deltas 原样延续——那些事实仍然
    // 生效（修正只回滚文本层），deltas 记空会让 doctor 重建把它们抹掉。
    const prevRecord = readCommit(root, chapter);
    const effectiveDeltas = isCorrection
      ? (prevRecord?.deltas && typeof prevRecord.deltas === 'object' ? prevRecord.deltas : {})
      : (prevRecord ? accumulateDeltas(prevRecord.deltas, commitDeltas) : commitDeltas);
    const commitRecord = {
      schemaVersion: 1,
      chapter,
      title,
      words,
      strand: entry.strand,
      hook: entry.hook,
      ending: entry.ending,
      summary: entry.summary,
      deltas: effectiveDeltas,
      warnings,
      committedAt: isoNow(),
    };
    if (isCorrection) {
      commitRecord.mode = 'correction';
      if (ignoredDeltas.length > 0) commitRecord.ignoredDeltas = ignoredDeltas;
      if (Object.keys(deltas).length > 0) commitRecord.submittedDeltas = deltas;
    }
    if (reviewMeta) commitRecord.review = reviewMeta;
    if (styleMeta) commitRecord.style = styleMeta;
    if (povName) commitRecord.pov = povName;
    writeJsonAtomic(inside(root, DIRS.commits, `ch${String(chapter).padStart(4, '0')}.json`), commitRecord);

    // ---- 统一写回 ----
    writeState(root, nextState);
    writeIndex(root, nextIndex);
    writeForeshadowing(root, nextLedger);
    // 账本内容真变了才落盘：老书不会无缘无故多出一个空 terms.json，
    // 同一批专名重复提交也不产生多余写盘。
    if (JSON.stringify(nextTerms.items) !== JSON.stringify(terms.items)) writeTerms(root, nextTerms);

    // ---- 报告 ----
    const overdue = openForeshadowing(nextLedger, chapter).filter((f) => f.overdue);
    return {
      chapter,
      title,
      words,
      strand,
      planted: plantedReport.map((p) => ({ name: p.name, plannedPayoff: p.plannedPayoff, type: p.type ?? 'foreshadow' })),
      paid: paidReport,
      hinted: hintedReport,
      registered: registeredReport.map((t) => ({ name: t.name, type: t.type })),
      unregistered: unregistered.map((t) => ({ name: t.name, type: t.type })),
      termsTotal: nextTerms.items.length,
      overdue: overdue.map((f) => ({ name: f.name, plannedPayoff: f.plannedPayoff })),
      // 本章提交后的叙事债务总账（回执里只播一行，全账在 query）
      debt: debtFromProject(project, nextLedger, chapter),
      // 文风基准/漂移结果（回执里只播「建立了基准」「检测到漂移」两种，安静时不占行）
      style: styleMeta,
      // 视角与认知变更（8.2）：回执里播「得知/使用/透露」三类，方便作者核对
      pov: povName || null,
      knowledge: knowledgeMeta,
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

/**
 * 规整 deltas.timeline：台账每章一条 { time, location, event }。
 * 调用方传数组时合并为一条（time/location 取首个非空，event 用「；」串联），
 * 避免数组被展开成数字键后静默读成空行。
 */
export function normalizeTimeline(timeline) {
  if (!Array.isArray(timeline)) return timeline;
  const entries = timeline.filter((t) => t && typeof t === 'object');
  if (entries.length === 0) return { time: null, location: null, event: null };
  const first = (key) => entries.map((t) => t[key]).find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  return {
    time: first('time') ?? null,
    location: first('location') ?? null,
    event: entries.map((t) => String(t.event ?? '').trim()).filter(Boolean).join('；') || null,
  };
}

/**
 * 把一章的事实应用到 (state, index, ledger) 上，返回更新后的三者与本章索引条目。
 *
 * ★ commitChapter 与 doctor 的提交链重放共用这一个实现——「实时提交」和
 * 「从提交记录重放」永远得到同一结果（doctor 的体检与重建依赖这个不变量）。
 *
 * @param {{state, index, ledger}} bundle 当前机器态
 * @param {number} chapter 章节号
 * @param {object} facts
 *   title / words / file / strand / hook / ending / summary  已解析好的章节字段
 *   deltas      {object}  本章事实增量（重放时取记录里的累计值）
 *   correction  {boolean} 历史修正模式：忽略 deltas，只更新索引条目
 *   committedAt {string}  提交时间（重放时取记录原值，保证索引逐字段一致）
 * @returns {{state, index, ledger, entry, planted, paid, warnings}}
 */
export function applyChapterFacts(bundle, chapter, facts = {}) {
  const num = toInt(chapter);
  const isCorrection = Boolean(facts.correction);
  const deltas = isCorrection ? {} : (facts.deltas && typeof facts.deltas === 'object' ? facts.deltas : {});
  const warnings = [];
  const planted = [];
  const paid = [];
  const hinted = [];

  let state = bundle.state;
  let ledger = bundle.ledger;
  // 老调用方（或未登记过专名的书）没带 terms：给空账本，保证函数对 bundle.terms 缺失同样成立
  let terms = bundle.terms ?? defaultTerms();
  const registered = [];
  const strand = normalizeStrand(facts.strand) ?? null;
  const prevEntry = findChapter(bundle.index, num);

  if (!isCorrection) {
    if (deltas.protagonist) {
      state = applyProtagonistPatch(state, deltas.protagonist);
    }
    if (Array.isArray(deltas.characters) && deltas.characters.length > 0) {
      // 形状/取值问题当场说（normalize 幂等，applyCharacterPatches 里再走一次同一份判据）
      for (const item of deltas.characters) {
        warnings.push(...normalizeDossierPatch(item?.patch ?? {}).warnings.map((w) => `角色「${item?.name ?? '?'}」：${w}`));
      }
      state = applyCharacterPatches(state, deltas.characters, num);
    }
    // 信息隔离：learn 累积进 knows/notKnows（8.2）。放在角色补丁之后，
    // 同一章「登记角色 + 得知信息」不会因为顺序丢掉后者。
    if (Array.isArray(deltas.knowledge) && deltas.knowledge.length > 0) {
      state = applyKnowledge(state, deltas.knowledge);
    }
    if (deltas.world) {
      state = applyWorldPatch(state, deltas.world);
    }
    if (strand) {
      state = applyStrand(state, num, strand);
    }
    if (deltas.timeline && typeof deltas.timeline === 'object') {
      state = appendTimeline(state, { chapter: num, ...normalizeTimeline(deltas.timeline) });
    }

    if (Array.isArray(deltas.foreshadowing?.planted)) {
      for (const item of deltas.foreshadowing.planted) {
        if (!item || !item.name) continue;
        // 类别与层名认不出来时**不猜**：猜错会把悬念记成伏笔，而「余额线」「50 章无暗示」
        // 只对悬念账户执法——一条走错类的悬念等于账户上凭空少一笔，且没人报警。
        const rawType = String(item.type ?? '').trim();
        if (rawType && !isKnownLedgerType(rawType)) {
          warnings.push(`「${item.name}」的 type="${rawType}" 系统不认，已按伏笔登记。`
            + '可选：foreshadow/suspense/cheque/red_herring（也认中文：伏笔/悬念/支票/红鲱鱼）。');
        }
        const rawLayer = String(item.layer ?? '').trim();
        if (rawLayer && normalizeLedgerLayer(rawLayer) === null) {
          warnings.push(`「${item.name}」的 layer="${rawLayer}" 不是本书的悬念账户层，未写入。`
            + '可选：短/卷/部/跨部/全书（用 webnovel_status 看本书实际启用哪几层）。');
        }
        const due = firstPositiveOrNull(item.plannedPayoff, item.dueChapter);
        const record = {
          id: item.id ?? nextForeshadowingId(ledger),
          name: String(item.name),
          plantedChapter: num,
          plannedPayoff: due,
          status: 'open',
          paidChapter: null,
          importance: item.importance ?? 'normal',
          note: item.note ?? '',
          // 只存非默认值：老条目的形状不随升级漂移（doctor 整表对账才稳）
          ...compactLedgerPatch(item),
        };
        // 埋下即「已暗示」只对读者可见的三类成立（悬念/支票/误导线索——它们本来就是明写的）。
        // 暗埋的伏笔不能这么算：4.4 明写「暗埋的伏笔回收时兑现惊喜，不提前剧透」，
        // 给它记一次暗示等于承认读者已经知道，之后 2.3 的悬置判据就再也不会提醒这条线。
        const readerVisible = typeOf(record) !== 'foreshadow';
        if (readerVisible) record.hintChapters = hintsOf(withHint({ hintChapters: record.hintChapters }, num));
        if (record.hintChapters && record.hintChapters.length === 0) delete record.hintChapters;
        ledger = upsertForeshadowing(ledger, record);
        planted.push(record);
      }
    }
    // 暗示登记（2.3「悬置超 50 章无暗示＝警报」的唯一数据来源）。
    // 没有这条路，工具只能从埋下章算悬置——把「一直在露脸」的悬念也报成僵尸线。
    if (Array.isArray(deltas.foreshadowing?.hinted)) {
      for (const item of deltas.foreshadowing.hinted) {
        // 兼容 {name|id, evidence}：证据核对在实时提交层（verifyHinted），这里只取键。
        const key = hintedKeyOf(item);
        if (!key) {
          warnings.push('暗示登记里有一条既没有名称也没有 id，已忽略。');
          continue;
        }
        const target = ledger.items.find((i) => i.id === key || i.name === key);
        if (!target) {
          warnings.push(`要登记暗示的条目「${key}」不在台账中，已忽略。可先在 planted 里登记。`);
          continue;
        }
        if (!isOpenType(target)) {
          warnings.push(`「${target.name}」已是 ${target.status} 状态，暗示登记已忽略。`);
          continue;
        }
        const patched = withHint(target, num);
        ledger = upsertForeshadowing(ledger, { id: target.id, hintChapters: patched.hintChapters });
        hinted.push(target.name);
      }
    }
    if (Array.isArray(deltas.foreshadowing?.paid)) {
      for (const key of deltas.foreshadowing.paid) {
        const target = ledger.items.find((i) => i.id === key || i.name === key);
        if (!target) {
          warnings.push(`要回收的条目「${key}」不在台账中，已忽略。可先在 planted 里登记。`);
          continue;
        }
        ledger = upsertForeshadowing(ledger, { id: target.id, status: 'paid', paidChapter: num });
        paid.push(target.name);
      }
    }
    if (Array.isArray(deltas.foreshadowing?.dropped)) {
      for (const key of deltas.foreshadowing.dropped) {
        const target = ledger.items.find((i) => i.id === key || i.name === key);
        if (target) {
          ledger = upsertForeshadowing(ledger, { id: target.id, status: 'dropped' });
          warnings.push(`${ledgerTypeLabel(target)}「${target.name}」已标记为放弃（dropped）。建议在正文或设定里交代，避免读者追问。`);
        }
      }
    }

    // 专名登记（铁律 1「名词锁定」）。名字就是主键，所以重复登记是合并、不是追加；
    // 类别认不出的一律落 other，别编一个类别出来（后续按类别过滤会漏掉它）。
    if (Array.isArray(deltas.terms)) {
      for (const item of deltas.terms) {
        const name = String(item?.name ?? '').trim();
        if (!name) {
          warnings.push('deltas.terms 里有空名字条目，已忽略（专名必须带 name）。');
          continue;
        }
        const existed = findTerm(terms, name);
        terms = upsertTerm(terms, {
          name,
          type: normalizeTermType(item.type),
          aliases: item.aliases,
          firstChapter: num,
          note: item.note ?? '',
        });
        if (!existed) registered.push(terms.items.find((t) => t.name === name || t.aliases.includes(name)));
      }
    }
  }

  // 进度与索引条目
  const words = toInt(facts.words, 0);
  const title = String(facts.title ?? '').trim()
    || (isCorrection ? String(prevEntry?.title ?? '').trim() : '')
    || `第${num}章`;
  const hook = facts.hook && typeof facts.hook === 'object' ? {
    type: String(facts.hook.type ?? '').trim(),
    strength: HOOK_STRENGTHS.includes(facts.hook.strength) ? facts.hook.strength : undefined,
  } : null;
  const entry = {
    chapter: num,
    title,
    words,
    file: facts.file ?? (isCorrection ? prevEntry?.file ?? null : null),
    // 修正模式的线别沿用原值——状态侧从不接受修正（无回滚），索引字段必须与状态一致，
    // 否则重放会对不上账（见 commitChapter 的线别告警）。
    strand: isCorrection ? (normalizeStrand(prevEntry?.strand) ?? prevEntry?.strand ?? null) : strand,
    hook: hook && hook.type ? hook : (isCorrection ? prevEntry?.hook ?? null : null),
    ending: facts.ending && typeof facts.ending === 'object' ? facts.ending : (isCorrection ? prevEntry?.ending ?? null : null),
    summary: facts.summary !== undefined
      ? String(facts.summary ?? '').trim()
      : (isCorrection ? String(prevEntry?.summary ?? '') : ''),
    committedAt: facts.committedAt ?? isoNow(),
  };
  state = { ...state, progress: { ...state.progress } };
  state.progress.currentChapter = Math.max(toInt(state.progress.currentChapter), num);
  state.progress.totalWords = bundle.index.chapters
    .filter((c) => toInt(c.chapter) !== num)
    .reduce((sum, c) => sum + toInt(c.words), 0) + words;
  const index = upsertChapter(bundle.index, entry);

  return { state, index, ledger, terms, entry, planted, paid, hinted, registered, warnings };
}

/**
 * 累积「本章累计生效的事实」：把上次提交记录的 deltas 与本次合并。
 *
 * 语义对齐顺序应用的叠加效果：
 * - protagonist / characters：字段级深合并（重提没重复写的字段不会丢）
 * - world：数组唯一化合并
 * - timeline：以本次为准（同章覆盖语义）
 * - foreshadowing：planted 按名合并、paid/dropped 取并集
 * - terms：按名字合并（重提只报一部分专名时，之前登记的不能从记录里消失）
 */
function accumulateDeltas(prev, next) {
  const prevD = prev && typeof prev === 'object' ? prev : {};
  const nextD = next && typeof next === 'object' ? next : {};
  const out = { ...nextD };

  const protagonist = deepMerge(prevD.protagonist ?? {}, nextD.protagonist ?? {});
  if (Object.keys(protagonist).length > 0) out.protagonist = protagonist;
  else delete out.protagonist;

  const chars = new Map();
  for (const c of [...(Array.isArray(prevD.characters) ? prevD.characters : []), ...(Array.isArray(nextD.characters) ? nextD.characters : [])]) {
    if (!c || !c.name) continue;
    chars.set(c.name, deepMerge(chars.get(c.name) ?? {}, c.patch ?? {}));
  }
  if (chars.size > 0) out.characters = [...chars.entries()].map(([name, patch]) => ({ name, patch }));
  else delete out.characters;

  const world = {};
  for (const key of ['powerSystem', 'factions', 'locations']) {
    const merged = mergeArray(prevD.world?.[key] ?? [], nextD.world?.[key] ?? []);
    if (merged.length > 0) world[key] = merged;
  }
  if (Object.keys(world).length > 0) out.world = world;
  else delete out.world;

  if (!nextD.timeline && prevD.timeline) out.timeline = prevD.timeline;

  // 专名：按名字合并、别名取并集。重提只报一部分专名时，之前登记的必须仍在记录里，
  // 否则 doctor 重建会把已经生效过的专名从账本里抹掉（等于把「名词锁定」的账做漏）。
  const termsBy = new Map();
  for (const t of [...(Array.isArray(prevD.terms) ? prevD.terms : []), ...(Array.isArray(nextD.terms) ? nextD.terms : [])]) {
    if (!t || !t.name) continue;
    const last = termsBy.get(t.name) ?? {};
    const merged = { ...last, ...t };
    merged.aliases = [...new Set([...(Array.isArray(last.aliases) ? last.aliases : []), ...(Array.isArray(t.aliases) ? t.aliases : [])])];
    if (merged.aliases.length === 0) delete merged.aliases;
    termsBy.set(String(t.name), merged);
  }
  if (termsBy.size > 0) out.terms = [...termsBy.values()];
  else delete out.terms;

  // 知识变更：按 who+fact+mode 去重（重提同一章时把上次的 learn 保留下来，
  // 否则 doctor 重放会把已经得知的信息重新判成「不知道」）。
  const knowledgeBy = new Map();
  for (const item of [
    ...(Array.isArray(prevD.knowledge) ? prevD.knowledge : []),
    ...(Array.isArray(nextD.knowledge) ? nextD.knowledge : []),
  ]) {
    if (!item || !item.who || !item.fact) continue;
    const mode = String(item.mode ?? 'learn');
    const key = `${item.who}|${item.fact}|${mode}`;
    knowledgeBy.set(key, { ...(knowledgeBy.get(key) ?? {}), ...item, mode });
  }
  if (knowledgeBy.size > 0) out.knowledge = [...knowledgeBy.values()];
  else delete out.knowledge;

  const fsPrev = prevD.foreshadowing ?? {};
  const fsNext = nextD.foreshadowing ?? {};
  const plantedBy = new Map();
  for (const it of [...(Array.isArray(fsPrev.planted) ? fsPrev.planted : []), ...(Array.isArray(fsNext.planted) ? fsNext.planted : [])]) {
    if (!it || !it.name) continue;
    plantedBy.set(it.name, { ...(plantedBy.get(it.name) ?? {}), ...it });
  }
  const paid = [...new Set([...(Array.isArray(fsPrev.paid) ? fsPrev.paid : []), ...(Array.isArray(fsNext.paid) ? fsNext.paid : [])])];
  const dropped = [...new Set([...(Array.isArray(fsPrev.dropped) ? fsPrev.dropped : []), ...(Array.isArray(fsNext.dropped) ? fsNext.dropped : [])])];
  // 暗示登记也要进「本章累计事实」：doctor 重放靠它把 hintChapters 长回来。
  // 漏了这一条，重放出来的悬置章数会比现役账本大，体检会报一个不存在的假差异。
  const hinted = [...new Set([...(Array.isArray(fsPrev.hinted) ? fsPrev.hinted : []), ...(Array.isArray(fsNext.hinted) ? fsNext.hinted : [])])];
  const fsn = {};
  if (plantedBy.size > 0) fsn.planted = [...plantedBy.values()];
  if (paid.length > 0) fsn.paid = paid;
  if (dropped.length > 0) fsn.dropped = dropped;
  if (hinted.length > 0) fsn.hinted = hinted;
  if (Object.keys(fsn).length > 0) out.foreshadowing = fsn;
  else delete out.foreshadowing;

  return out;
}

/** 渲染章节摘要文件（doctor 重建时复用，保证摘要与提交链一致）。 */
export function renderSummary(entry, state, chapter) {
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
