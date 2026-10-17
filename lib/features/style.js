/**
 * 文风漂移与 AI 味（提示词 15.6 / 二创纪律）。
 *
 * 产品定位：文风崩了不比设定崩了轻——读者说不出哪里变了，但会「感觉不对」然后弃书。
 * 机器能判的部分做成量化指标：句长、段长、对话占比、标点密度。判不了的（语感、幽默感）
 * 不猜，留给 Agent。
 *
 * 口径只有一份：所有阈值集中在 STYLE_THRESHOLDS，测试断言直接引用它，
 * 不在别处再写一遍数字——两处阈值必然漂移，最后没人知道该信哪个。
 *
 * 基线文件 `.webnovel/style-baseline.json`：
 * - 首次提交自动建（取本章指标）；
 * - 前 5 章逐章并入样本，取平均，避免拿单章噪声当「本书文风」；
 * - 每 30 章对比一次，写 `.webnovel/reviews/style-chNNNN.json`；
 * - 人工基准优先（webnovel_memory action=baseline），可 JSON 覆盖或从正文重建。
 *
 * AI 味启发式也在这里：它和文风漂移共用同一套文本统计，分开放两套反而会得出
 * 互相矛盾的结论（「句长正常」与「句长过于均匀」同时出现）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, inside } from '../core/paths.js';
import { readText, exists, writeJsonAtomic } from '../core/store.js';
import { toInt, isoNow, stripMarkdown, textHash } from '../util.js';

/**
 * 文风阈值（唯一真相源）。
 *
 * relative = 相对基线的变化比例（0.35 即 35%）；absolute = 绝对差值（对话占比按百分点算）。
 * compareEvery 是检查间隔：基准在第 1 章建立时 checkedAtChapter=0，第 30 章正好触发。
 */
export const STYLE_THRESHOLDS = {
  compareEvery: 30,
  baselineSampleChapters: 5,
  minSentences: 20,
  minParagraphs: 5,
  minChars: 500,
  metrics: {
    avgSentence: { label: '平均句长', mode: 'relative', limit: 0.35, unit: '字' },
    sentenceSd: { label: '句长波动', mode: 'relative', limit: 0.45, unit: '字' },
    avgParagraph: { label: '平均段长', mode: 'relative', limit: 0.40, unit: '字' },
    dialogueRatio: { label: '对话占比', mode: 'absolute', limit: 0.12, unit: '%' },
    punctuationDensity: { label: '标点密度', mode: 'relative', limit: 0.30, unit: '' },
  },
  aiFlavor: {
    minChars: 400,
    // 套话黑名单：出现即计数，密度超过阈值就报。都是「正确的废话」——
    // 单看一句没错，成片出现就是 AI 腔。
    cliches: [
      '心中涌起一股', '不由得', '情不自禁', '嘴角勾起一抹', '眼中闪过一丝',
      '仿佛', '似乎', '宛如', '空气仿佛凝固', '时间仿佛静止',
      '深吸一口气', '缓缓开口', '淡淡说道', '微微一笑', '眉头微皱',
      '一股强大的气息', '肉眼可见', '不容置疑', '无可挑剔',
      '在这个世界', '与此同时', '值得一提的是', '总而言之', '换句话说',
    ],
    clichePerKChars: 6,          // 每千字套话命中数上限
    uniformSentenceCv: 0.28,     // 句长变异系数低于此值 = 句长过于均匀
    abstractChain: 4,            // 连续抽象名词（的/地 串联）超过此数
    notABCount: 3,               // 连续「不是A而是B」句式超过此数
    notABPerKChars: 2.5,         // 每千字「不是…而是…」上限
  },
};

/** 参与对比的指标键（顺序稳定，报告与测试共用）。 */
export const STYLE_METRIC_KEYS = Object.keys(STYLE_THRESHOLDS.metrics);

const PUNCT_RE = /[，。！？、；：""''「」『』（）【】…—·,.!?;:"()]/g;
const SENTENCE_SPLIT_RE = /[。！？!?…]+/;

/** 安全数字（NaN/Infinity → 0）。 */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 四舍五入到 3 位（报告与基线可读，也避免浮点尾差导致「看起来变了」）。 */
function round3(value) {
  return Math.round(num(value) * 1000) / 1000;
}

/** 说话内容总字数（中文引号/直角引号/英文双引号都算）。 */
function quotedChars(body) {
  let total = 0;
  const re = /“([^”\n]{1,400})”|「([^」\n]{1,400})」|『([^』\n]{1,400})』|"([^"\n]{1,400})"/g;
  for (const m of body.matchAll(re)) {
    const text = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    total += text.replace(/\s+/g, '').length;
  }
  return total;
}

/**
 * 统计一章的文风指标。
 * @param {string} text 正文（Markdown 会被剥掉）
 * @returns {{chars:number,sentences:number,paragraphs:number,avgSentence:number,
 *   sentenceSd:number,avgParagraph:number,dialogueRatio:number,punctuationDensity:number}}
 */
export function analyzeStyle(text) {
  const body = stripMarkdown(String(text ?? '')).replace(/\r\n/g, '\n');
  const compact = body.replace(/\s+/g, '');
  const chars = compact.length;
  if (chars === 0) {
    return {
      chars: 0, sentences: 0, paragraphs: 0,
      avgSentence: 0, sentenceSd: 0, avgParagraph: 0,
      dialogueRatio: 0, punctuationDensity: 0,
    };
  }

  // 句子：按句末标点切；没有标点的长文按一整句算，恰好能暴露「一逗到底」。
  const sentenceLengths = body
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.replace(/\s+/g, '').length)
    .filter((n) => n > 0);
  const sentences = sentenceLengths.length || 1;
  const totalSentenceChars = sentenceLengths.reduce((sum, n) => sum + n, 0) || chars;
  const avgSentence = totalSentenceChars / sentences;
  const variance = sentenceLengths.length > 1
    ? sentenceLengths.reduce((sum, n) => sum + (n - avgSentence) ** 2, 0) / sentenceLengths.length
    : 0;

  const paragraphs = body.split(/\n+/).filter((p) => p.trim().length > 0).length || 1;
  const punctuation = (compact.match(PUNCT_RE) ?? []).length;

  return {
    chars,
    sentences,
    paragraphs,
    avgSentence: round3(avgSentence),
    sentenceSd: round3(Math.sqrt(variance)),
    avgParagraph: round3(chars / paragraphs),
    dialogueRatio: round3(quotedChars(body) / chars),
    punctuationDensity: round3(punctuation / chars),
  };
}

/** 平均多章指标（基线样本用）。 */
function averageMetrics(list) {
  const out = {};
  for (const key of STYLE_METRIC_KEYS) {
    const values = list.map((m) => num(m?.[key])).filter((n) => n > 0);
    out[key] = values.length > 0 ? round3(values.reduce((s, n) => s + n, 0) / values.length) : 0;
  }
  out.sentences = Math.round(list.reduce((s, m) => s + toInt(m?.sentences), 0) / Math.max(1, list.length));
  out.paragraphs = Math.round(list.reduce((s, m) => s + toInt(m?.paragraphs), 0) / Math.max(1, list.length));
  return out;
}

/** 基线文件路径。 */
export function styleBaselinePath(root) {
  return inside(root, FILES.styleBaseline);
}

/** 读基线；不存在或损坏返回 null（损坏不阻断写作，下次提交会重建）。 */
export function readStyleBaseline(root) {
  const file = styleBaselinePath(root);
  if (!exists(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.kind !== 'style-baseline' || !raw.metrics || typeof raw.metrics !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

/** 写基线（原子）。 */
export function writeStyleBaseline(root, baseline) {
  writeJsonAtomic(styleBaselinePath(root), baseline);
  return styleBaselinePath(root);
}

function makeBaseline({ source, metrics, chapter, sampleEntries = [], checkedAtChapter = 0 }) {
  const samples = [...sampleEntries];
  return {
    schemaVersion: 1,
    kind: 'style-baseline',
    source,
    createdAt: isoNow(),
    // 毫秒时间戳：判断「报告是否晚于基线」不能只靠秒级字符串——
    // 测试与正常写作都可能在同一秒内完成建基线+写报告，秒级比较会把新报告判成旧的。
    createdAtMs: Date.now(),
    calibratedAtChapter: toInt(chapter, 0),
    // checkedAtChapter=0 表示「尚未做过漂移检查」：基准在第 1 章建立，第 30 章正好触发。
    checkedAtChapter: toInt(checkedAtChapter, 0),
    sampleChapters: samples.map((s) => toInt(s.chapter)),
    samples,
    metrics,
  };
}

/**
 * 提交时维护基线：
 * 1. 没有基线 → 用本章建立；
 * 2. 自动基线还没凑满样本（前 5 章）且本章紧接上一章 → 并入样本并重算平均；
 * 3. 人工/重建基线不自动吸收（有则优先）。
 *
 * @returns {{baseline:object, created:boolean, sampled:boolean, metrics:object}}
 */
export function ensureStyleBaseline(root, chapter, text) {
  const numChapter = toInt(chapter);
  const metrics = analyzeStyle(text);
  const existing = readStyleBaseline(root);
  if (!existing) {
    const baseline = makeBaseline({
      source: 'auto', metrics, chapter: numChapter,
      sampleEntries: [{ chapter: numChapter, metrics }],
    });
    writeStyleBaseline(root, baseline);
    return { baseline, created: true, sampled: true, metrics };
  }

  const samples = Array.isArray(existing.samples) ? existing.samples.filter((s) => s && s.metrics) : [];
  const canSample = existing.source === 'auto'
    && samples.length > 0
    && samples.length < STYLE_THRESHOLDS.baselineSampleChapters
    && numChapter === toInt(existing.calibratedAtChapter) + 1
    && !samples.some((s) => toInt(s.chapter) === numChapter);
  if (!canSample) {
    return { baseline: existing, created: false, sampled: false, metrics };
  }

  const nextSamples = [...samples, { chapter: numChapter, metrics }];
  const next = {
    ...existing,
    calibratedAtChapter: numChapter,
    sampleChapters: nextSamples.map((s) => toInt(s.chapter)),
    samples: nextSamples,
    metrics: averageMetrics(nextSamples.map((s) => s.metrics)),
  };
  writeStyleBaseline(root, next);
  return { baseline: next, created: false, sampled: true, metrics };
}

/** 记录「第 N 章已做过漂移检查」，避免同一章或同一区间重复报警。 */
export function markStyleChecked(root, baseline, chapter) {
  const next = { ...baseline, checkedAtChapter: toInt(chapter) };
  writeStyleBaseline(root, next);
  return next;
}

/** 指标变化是否超过阈值（返回 item 或 null）。 */
function compareMetric(key, baseValue, currentValue) {
  const rule = STYLE_THRESHOLDS.metrics[key];
  const base = num(baseValue);
  const current = num(currentValue);
  // 只要求基线为正：当前值为 0 是有意义的漂移（对话占比归零、句长波动归零），
  // 旧写法把 0 当「没数据」跳过，恰好漏掉最典型的一种文风漂移。
  if (base <= 0) return null;
  if (rule.mode === 'absolute') {
    const diff = Math.abs(current - base);
    return diff >= rule.limit
      ? { metric: key, label: rule.label, baseline: base, current, diff: round3(diff), threshold: rule.limit, mode: rule.mode, direction: current < base ? 'down' : 'up' }
      : null;
  }
  const change = Math.abs(current - base) / base;
  return change >= rule.limit
    ? { metric: key, label: rule.label, baseline: base, current, change: round3(change), threshold: rule.limit, mode: rule.mode, direction: current < base ? 'down' : 'up' }
    : null;
}

/**
 * 漂移检查（纯函数，不写盘）。
 *
 * 触发条件：距上次检查 ≥ compareEvery 章，且本章样本量足够（句/段/字数下限）。
 * 样本太短时返回 skipped，不把「这一章只有三句」当成文风变了。
 */
export function detectStyleDrift(baseline, chapter, text) {
  const metrics = analyzeStyle(text);
  const numChapter = toInt(chapter);
  if (!baseline) {
    return { checked: false, drifted: false, skipped: 'no-baseline', metrics, items: [] };
  }
  const lastChecked = toInt(baseline.checkedAtChapter, 0);
  if (numChapter - lastChecked < STYLE_THRESHOLDS.compareEvery) {
    return {
      checked: false, drifted: false, skipped: 'not-due', metrics, items: [],
      dueAtChapter: lastChecked + STYLE_THRESHOLDS.compareEvery,
    };
  }
  if (metrics.chars < STYLE_THRESHOLDS.minChars
    || metrics.sentences < STYLE_THRESHOLDS.minSentences
    || metrics.paragraphs < STYLE_THRESHOLDS.minParagraphs) {
    return { checked: false, drifted: false, skipped: 'sample-too-small', metrics, items: [] };
  }
  const items = [];
  for (const key of STYLE_METRIC_KEYS) {
    const item = compareMetric(key, baseline.metrics?.[key], metrics[key]);
    if (item) items.push(item);
  }
  return { checked: true, drifted: items.length > 0, skipped: null, metrics, items };
}

/** 漂移项的给人看的一句话。 */
export function renderStyleDriftItems(items) {
  return (items ?? []).map((item) => {
    if (item.mode === 'absolute') {
      return `${item.label} ${Math.round(item.baseline * 100)}% → ${Math.round(item.current * 100)}%`;
    }
    const pct = Math.round(num(item.change) * 100);
    return `${item.label} ${item.baseline} → ${item.current}（${item.direction === 'up' ? '升' : '降'} ${pct}%）`;
  }).join('；');
}

/** 审查/状态共用的只读检查（不维护基线、不写报告——写盘只发生在 commit 与 memory）。 */
export function styleDriftForReview(root, chapter, text) {
  const baseline = readStyleBaseline(root);
  if (!baseline) return { baseline: null, checked: false, drifted: false, skipped: 'no-baseline', items: [], metrics: analyzeStyle(text) };
  return { baseline, ...detectStyleDrift(baseline, chapter, text) };
}

/* ------------------------------------------------------------------ *
 * AI 味启发式（提示词 15.6 / 二创纪律）
 * ------------------------------------------------------------------ */

/**
 * 抽象名词表：只收「单看很高级、成串出现就是空转」的词。
 * 不追求全——判据的职责是抓典型，漏几个不影响结论；乱收会制造误报。
 */
const ABSTRACT_NOUN_RE = /命运|时间|岁月|灵魂|内心|真相|恐惧|希望|绝望|孤独|愤怒|悲伤|温柔|力量|意志|气息|光芒|深渊|黑暗|光明|世界|规则|宿命|记忆|情绪|情感|意识|存在|虚无|永恒|轮回|因果|人性|欲望|执念|信念|威严|杀意|寒意|暖意|压迫感|神圣|不朽|沧桑|悲凉|荒凉|苍凉|寂寞|缱绻|旖旎/g;

/** 抽象名词链允许的连接词/间隔（的、地、之、与、和、顿号，中间最多夹 6 个字）。 */
const ABSTRACT_LINK_RE = /^[^。！？!?\n]{0,6}[的地之与和、][^。！？!?\n]{0,6}$/;

function maxAbstractChain(sentence) {
  const hits = [...sentence.matchAll(ABSTRACT_NOUN_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  let best = 0;
  let run = 0;
  let prevEnd = -1;
  for (const hit of hits) {
    if (prevEnd >= 0) {
      const between = sentence.slice(prevEnd, hit.start);
      run = ABSTRACT_LINK_RE.test(between) ? run + 1 : 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    prevEnd = hit.end;
  }
  return best;
}

/** 「不是A而是B」句式（含「并非…而是」）：AI 最爱用的伪深刻结构。 */
const NOT_AB_RE = /(?:不是|并非)[^。！？!?\n]{1,24}?而是/g;

/**
 * AI 味启发式（纯函数，不写盘）。
 *
 * 四类判据，全部来自 STYLE_THRESHOLDS.aiFlavor：
 *   ① 套话黑名单密度（「心中涌起一股」「嘴角勾起一抹」这类正确的废话）；
 *   ② 句长过于均匀（变异系数低于阈值＝每句都差不多长，像模板生成）；
 *   ③ 抽象名词链（命运的无常、时间的残酷、人性的幽暗……连续空转）；
 *   ④ 连续「不是A而是B」（伪深刻句式刷屏）。
 *
 * 样本太短（< minChars）返回 skipped，不拿三五百字判「AI 味」。
* 判据只报「有证据的一类」，每条带原文，不输出玄学分数。
 */
export function detectAiFlavor(text) {
  const body = stripMarkdown(String(text ?? '')).replace(/\r\n/g, '\n');
  const cfg = STYLE_THRESHOLDS.aiFlavor;
  const metrics = analyzeStyle(body);
  if (metrics.chars < cfg.minChars) {
    return { checked: false, skipped: 'sample-too-small', chars: metrics.chars, issues: [], stats: {} };
  }

  const issues = [];
  const perK = (count) => (metrics.chars > 0 ? (count * 1000) / metrics.chars : 0);

  // ① 套话密度
  const clicheHits = [];
  for (const phrase of cfg.cliches) {
    let count = 0;
    let from = 0;
    for (;;) {
      const idx = body.indexOf(phrase, from);
      if (idx < 0) break;
      count += 1;
      from = idx + phrase.length;
    }
    if (count > 0) clicheHits.push({ phrase, count });
  }
  const clicheTotal = clicheHits.reduce((sum, h) => sum + h.count, 0);
  const clicheDensity = perK(clicheTotal);
  if (clicheDensity > cfg.clichePerKChars) {
    const top = [...clicheHits].sort((a, b) => b.count - a.count).slice(0, 4)
      .map((h) => `「${h.phrase}」×${h.count}`).join('、');
    issues.push({
      kind: 'cliche',
      label: '套话密度',
      message: `AI 味：套话 ${clicheTotal} 处（每千字 ${clicheDensity.toFixed(1)} 处，上限 ${cfg.clichePerKChars}）——${top}`,
      evidence: clicheHits[0] ? body.slice(Math.max(0, body.indexOf(clicheHits[0].phrase) - 16), body.indexOf(clicheHits[0].phrase) + clicheHits[0].phrase.length + 16).replace(/\n/g, ' ') : null,
      suggestion: '删掉「正确的废话」，换成具体动作、感官细节或人物独有的反应；同一套话全章最多留一处。',
    });
  }

  // ② 句长过于均匀（样本够才判）
  const cv = metrics.avgSentence > 0 ? metrics.sentenceSd / metrics.avgSentence : 0;
  if (metrics.sentences >= STYLE_THRESHOLDS.minSentences && cv > 0 && cv < cfg.uniformSentenceCv) {
    issues.push({
      kind: 'uniform-sentence',
      label: '句长过于均匀',
      message: `AI 味：句长变异系数 ${cv.toFixed(2)}（低于 ${cfg.uniformSentenceCv}）——每句长度太接近，读起来像模板`,
      evidence: `平均 ${metrics.avgSentence} 字/句，标准差 ${metrics.sentenceSd}`,
      suggestion: '故意插几个三五个字的短句，再放一两个长句；节奏要有快慢，不要每句都一个长度。',
    });
  }

  // ③ 抽象名词链
  const chains = [];
  for (const sentence of body.split(/[。！？!?…\n]+/)) {
    const chain = maxAbstractChain(sentence);
    if (chain >= cfg.abstractChain) chains.push({ chain, sentence: sentence.trim().slice(0, 80) });
  }
  if (chains.length > 0) {
    const worst = chains.sort((a, b) => b.chain - a.chain)[0];
    issues.push({
      kind: 'abstract-chain',
      label: '抽象名词空转',
      message: `AI 味：${chains.length} 处抽象名词连用（最长 ${worst.chain} 个，上限 ${cfg.abstractChain}）——命运、时间、人性这类词成串出现，信息量为零`,
      evidence: worst.sentence,
      suggestion: '把抽象词换成具体的人、物、动作：不写「命运的残酷」，写「他把最后半块饼塞进嘴里，没抬头」。',
    });
  }

  // ④ 「不是A而是B」句式
  const notAB = (body.match(NOT_AB_RE) ?? []).length;
  const notABDensity = perK(notAB);
  if (notAB >= cfg.notABCount || notABDensity > cfg.notABPerKChars) {
    const m = NOT_AB_RE.exec(body);
    NOT_AB_RE.lastIndex = 0;
    issues.push({
      kind: 'not-ab',
      label: '伪深刻句式',
      message: `AI 味：「不是…而是…」句式 ${notAB} 处（每千字 ${notABDensity.toFixed(1)}，上限 ${cfg.notABCount} 处 / ${cfg.notABPerKChars}）`,
      evidence: m ? m[0] : null,
      suggestion: '这种句式一章最多留一次。连续用会显得人物在发表演讲，而不是在做事。',
    });
  }

  return {
    checked: true,
    skipped: null,
    chars: metrics.chars,
    issues,
    stats: {
      cliches: clicheTotal,
      clichePerKChars: Number(clicheDensity.toFixed(2)),
      sentenceCv: Number(cv.toFixed(3)),
      abstractChains: chains.length,
      notAB,
      notABPerKChars: Number(notABDensity.toFixed(2)),
    },
  };
}

/** AI 味问题的给人看的一句话。 */
export function renderAiFlavorItems(issues) {
  return (issues ?? []).map((issue) => issue.message).join('；');
}


/** 写漂移报告（只在超阈值时调用）。 */
export function saveStyleReport(root, chapter, { baseline, drift, text }) {
  const numChapter = toInt(chapter);
  const file = inside(root, DIRS.reviews, `style-ch${String(numChapter).padStart(4, '0')}.json`);
  writeJsonAtomic(file, {
    schemaVersion: 1,
    kind: 'style-drift',
    chapter: numChapter,
    checkedAt: isoNow(),
    checkedAtMs: Date.now(),
    textHash: textHash(text),
    drifted: Boolean(drift?.drifted),
    items: drift?.items ?? [],
    metrics: drift?.metrics ?? null,
    baseline: {
      source: baseline?.source ?? null,
      calibratedAtChapter: baseline?.calibratedAtChapter ?? null,
      metrics: baseline?.metrics ?? null,
    },
  });
  return file;
}

/** 最近一份文风报告（status 用）；没有返回 null。 */
export function latestStyleReport(root) {
  const dir = inside(root, DIRS.reviews);
  let latest = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^style-ch\d+\.json$/.test(name)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!latest || toInt(raw.chapter) > toInt(latest.chapter)) latest = raw;
      } catch { /* 坏报告跳过，不影响状态 */ }
    }
  } catch { /* 没有 reviews 目录 */ }
  return latest;
}

/**
 * 从正文重建基线（老书升级 / 人工重置）。
 * 取正文目录里最靠前的 sample 章，算平均；checkedAtChapter 归零，下一次检查从当前进度算起。
 */
export function rebuildStyleBaseline(root, { sample = STYLE_THRESHOLDS.baselineSampleChapters } = {}) {
  const dir = inside(root, DIRS.text);
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter((name) => /^第\d+章.*\.md$/.test(name))
      .sort()
      .slice(0, Math.max(1, toInt(sample, STYLE_THRESHOLDS.baselineSampleChapters)));
  } catch {
    throw new Error('正文/ 目录不存在或不可读，无法从正文重建文风基准。');
  }
  if (names.length === 0) throw new Error('正文/ 目录里没有章节文件，无法重建文风基准。');

  const entries = [];
  for (const name of names) {
    const chapter = toInt(/^第(\d+)章/.exec(name)?.[1], 0);
    const text = readText(path.join(dir, name)) ?? '';
    const metrics = analyzeStyle(text);
    if (metrics.chars > 0) entries.push({ chapter, metrics });
  }
  if (entries.length === 0) throw new Error('正文文件都是空的，无法重建文风基准。');

  const baseline = {
    ...makeBaseline({
      source: 'rebuild',
      metrics: averageMetrics(entries.map((e) => e.metrics)),
      chapter: entries[entries.length - 1].chapter,
      sampleEntries: entries,
      checkedAtChapter: entries[entries.length - 1].chapter,
    }),
  };
  writeStyleBaseline(root, baseline);
  return { baseline, sampledChapters: entries.map((e) => e.chapter) };
}

/**
 * 人工基准覆盖：只认已知指标键，值必须是正数。
 * @returns {{baseline:object}|{error:string}}
 */
export function setManualStyleBaseline(root, metrics, { chapter = 0, title = '' } = {}) {
  const clean = {};
  for (const key of STYLE_METRIC_KEYS) {
    const value = Number(metrics?.[key]);
    if (Number.isFinite(value) && value > 0) clean[key] = round3(value);
  }
  if (Object.keys(clean).length === 0) {
    return { error: `人工基准里没有任何可用指标。可用键：${STYLE_METRIC_KEYS.join(' / ')}（值必须是正数）。` };
  }
  const baseline = {
    ...makeBaseline({
      source: 'manual',
      metrics: clean,
      chapter,
      checkedAtChapter: toInt(chapter, 0),
    }),
    title: String(title ?? '').trim() || null,
  };
  writeStyleBaseline(root, baseline);
  return { baseline };
}
