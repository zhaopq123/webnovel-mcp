/**
 * 全书机检（doctor action=scan）。
 *
 * 只读、不写盘；所有指标都带章号与原文片段，便于直接定位。
 * 指标口径尽量机械可复现——「像不像 AI」是 review 的事，这里只报可数的事实。
 */
import { readIndex } from '../core/state.js';
import { countWords, toInt } from '../util.js';
import { readChapterText } from './outline.js';
import { chaptersWithText } from './booktext.js';

/** 15.5 词汇黑名单（叙述禁用）。 */
export const BANNED_TERMS = [
  '勾起唇角', '勾起一抹', '眸子', '眸光', '眼底闪过一丝', '心脏猛地一缩',
  '喉结滚动', '指节泛白', '身体一僵',
];

/** 15.5 句式/套话黑名单（计数型）。 */
export const BANNED_PATTERNS = [
  { name: '不是……而是……', re: /不是[^。！？!?\n]{1,24}而是/g, limit: 2, unit: '章' },
  { name: '不仅……更是……', re: /不仅[^。！？!?\n]{1,24}更是/g, limit: 0, unit: '章' },
  { name: '仿佛/宛如/犹如', re: /仿佛|宛如|犹如/g, limit: 1, unit: '千字' },
  { name: '值得注意的是', re: /值得注意的是/g, limit: 0, unit: '章' },
  { name: '不得不说', re: /不得不说/g, limit: 2, unit: '章' },
  { name: '可以说', re: /可以说/g, limit: 2, unit: '章' },
  { name: '总而言之', re: /总而言之/g, limit: 0, unit: '章' },
  { name: '某种意义上', re: /某种意义上/g, limit: 0, unit: '章' },
  { name: '时间仿佛静止', re: /时间仿佛静止/g, limit: 0, unit: '章' },
  { name: '在那一刻', re: /在那一刻/g, limit: 1, unit: '章' },
];

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uf900-\ufaff]/;

function clip(text, max = 42) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function splitParagraphs(text) {
  return String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function splitSentences(text) {
  return String(text ?? '')
    .split(/[。！？!?…；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function charLen(s) {
  return [...String(s ?? '').replace(/\s+/g, '')].length;
}

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** 段内重复的 6 字片段（同一段里出现 ≥2 次）。 */
function repeat6InParagraphs(text, chapter) {
  const hits = [];
  for (const [pi, para] of splitParagraphs(text).entries()) {
    const clean = para.replace(/\s+/g, '');
    if (clean.length < 12) continue;
    const seen = new Map();
    for (let i = 0; i + 6 <= clean.length; i += 1) {
      const gram = clean.slice(i, i + 6);
      if (!CJK.test(gram)) continue;
      if (/^(.)\1+$/.test(gram)) continue;
      seen.set(gram, (seen.get(gram) ?? 0) + 1);
    }
    const repeated = [...seen.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    for (const [gram, count] of repeated) {
      hits.push({ chapter, paragraph: pi + 1, gram, count });
    }
  }
  return hits;
}

/**
 * 扫描全书。
 * @returns {{ chapters:number, stats:object, issues:object, samples:object }}
 */
export function scanBook(root, { range = null, maxSamples = 12 } = {}) {
  const { value: index } = readIndex(root);
  const { chapters: nums, missing } = chaptersWithText(root, range);

  const perChapter = [];
  const repeats6 = [];
  const longSentences = [];
  const blankLineHits = [];
  const bannedHits = [];
  const patternHits = [];
  const latinHits = [];
  const halfWidthHits = [];
  const straightQuoteHits = [];
  const quoteBalance = { quoteLeft: 0, quoteRight: 0, cornerLeft: 0, cornerRight: 0, doubleLeft: 0, doubleRight: 0, imbalanced: [] };
  const sentenceMap = new Map();

  for (const num of nums) {
    const found = readChapterText(root, num);
    if (!found) continue;
    const text = found.text;
    const title = String(index.chapters.find((c) => toInt(c.chapter) === num)?.title ?? '');
    const words = countWords(text);
    const wordChars = Math.max(1, charLen(text));
    perChapter.push({ chapter: num, title, file: found.file, mtime: found.mtime, words });

    // 段内 6 字重复
    repeats6.push(...repeat6InParagraphs(text, num));

    // 超 40 字句
    for (const sentence of splitSentences(text)) {
      const len = charLen(sentence);
      if (len > 40) longSentences.push({ chapter: num, length: len, text: clip(sentence) });
    }

    // 连续空行（≥2 个空行）
    const blanks = text.match(/\n[ \t]*\n[ \t]*\n/g);
    if (blanks) blankLineHits.push({ chapter: num, count: blanks.length });

    // 禁词
    for (const term of BANNED_TERMS) {
      const count = text.split(term).length - 1;
      if (count > 0) {
        const at = text.indexOf(term);
        bannedHits.push({ chapter: num, term, count, evidence: clip(text.slice(Math.max(0, at - 10), at + term.length + 10)) });
      }
    }
    for (const pat of BANNED_PATTERNS) {
      const matches = text.match(pat.re) ?? [];
      if (matches.length === 0) continue;
      const allowed = pat.unit === '千字'
        ? Math.floor(wordChars / 1000) * pat.limit
        : pat.limit;
      const over = matches.length > allowed;
      patternHits.push({
        chapter: num,
        name: pat.name,
        count: matches.length,
        allowed,
        over,
        evidence: clip(matches[0]),
      });
    }

    // 拉丁字母词
    const latin = [...new Set(text.match(/[A-Za-z]{2,}/g) ?? [])];
    if (latin.length > 0) latinHits.push({ chapter: num, count: latin.length, words: latin.slice(0, 8) });

    // 半角标点
    const half = text.match(/[,.?!;:()]/g) ?? [];
    if (half.length > 0) {
      const at = text.search(/[,.?!;:()]/);
      halfWidthHits.push({ chapter: num, count: half.length, evidence: clip(text.slice(Math.max(0, at - 12), at + 12)) });
    }

    // 直引号 " 与 '
    const straight = text.match(/["']/g) ?? [];
    if (straight.length > 0) straightQuoteHits.push({ chapter: num, count: straight.length });

    // 引号配对
    const countChar = (ch) => text.split(ch).length - 1;
    quoteBalance.quoteLeft += countChar('\u201c');
    quoteBalance.quoteRight += countChar('\u201d');
    quoteBalance.cornerLeft += countChar('\u300c');
    quoteBalance.cornerRight += countChar('\u300d');
    quoteBalance.doubleLeft += countChar('\u300e');
    quoteBalance.doubleRight += countChar('\u300f');
    const localPairs = [
      ['\u201c', '\u201d', '双引号'],
      ['\u300c', '\u300d', '直角引号'],
      ['\u300e', '\u300f', '双直角引号'],
    ];
    for (const [l, r, label] of localPairs) {
      if (countChar(l) !== countChar(r)) quoteBalance.imbalanced.push({ chapter: num, label, left: countChar(l), right: countChar(r) });
    }

    // 跨章重复句（归一化后 ≥12 字）
    for (const sentence of splitSentences(text)) {
      const norm = sentence.replace(/[\s“”「」『』"'《》【】]/g, '');
      if (norm.length < 12) continue;
      const hit = sentenceMap.get(norm) ?? { text: sentence, chapters: new Set() };
      hit.chapters.add(num);
      sentenceMap.set(norm, hit);
    }
  }

  const crossChapter = [...sentenceMap.values()]
    .filter((s) => s.chapters.size >= 2)
    .map((s) => ({ text: clip(s.text, 60), chapters: [...s.chapters].sort((a, b) => a - b) }))
    .sort((a, b) => b.chapters.length - a.chapters.length)
    .slice(0, maxSamples);

  const words = perChapter.map((c) => c.words);
  const stats = {
    chapters: perChapter.length,
    missing,
    totalWords: words.reduce((a, b) => a + b, 0),
    medianWords: median(words),
    minWords: words.length ? Math.min(...words) : 0,
    maxWords: words.length ? Math.max(...words) : 0,
    under1000: perChapter.filter((c) => c.words < 1000).map((c) => c.chapter),
    over6000: perChapter.filter((c) => c.words > 6000).map((c) => c.chapter),
  };

  const issues = {
    repeat6: {
      count: repeats6.length,
      chapters: [...new Set(repeats6.map((h) => h.chapter))],
      samples: repeats6.slice(0, maxSamples),
    },
    crossChapter: { count: crossChapter.length, samples: crossChapter },
    banned: {
      count: bannedHits.reduce((n, h) => n + h.count, 0),
      samples: bannedHits.slice(0, maxSamples),
    },
    patterns: {
      overCount: patternHits.filter((h) => h.over).length,
      samples: patternHits.filter((h) => h.over).slice(0, maxSamples),
    },
    latin: { count: latinHits.reduce((n, h) => n + h.count, 0), samples: latinHits.slice(0, maxSamples) },
    halfWidth: { count: halfWidthHits.reduce((n, h) => n + h.count, 0), samples: halfWidthHits.slice(0, maxSamples) },
    straightQuotes: { count: straightQuoteHits.reduce((n, h) => n + h.count, 0), samples: straightQuoteHits.slice(0, maxSamples) },
    quoteBalance,
    blankLines: { count: blankLineHits.reduce((n, h) => n + h.count, 0), samples: blankLineHits.slice(0, maxSamples) },
    longSentences: { count: longSentences.length, samples: longSentences.slice(0, maxSamples) },
  };

  return { chapters: perChapter, stats, issues };
}

/** 渲染 scanBook 结果为 Markdown。 */
export function renderScanMarkdown(result) {
  const { stats, issues } = result;
  const out = [];
  const push = (line = '') => out.push(line);
  const row = (label, value, extra = '') => push(`| ${label} | ${value} | ${extra} |`);

  push(`# 全书机检报告（${stats.chapters} 章）`);
  push();
  push(`| 指标 | 数值 | 说明 |`);
  push(`|---|---:|---|`);
  row('总字数', stats.totalWords, '');
  row('单章字数中位', stats.medianWords, '');
  row('单章最低 / 最高', `${stats.minWords} / ${stats.maxWords}`, stats.under1000.length ? `低于 1000 字：第 ${stats.under1000.join('、')} 章` : '');
  if (stats.over6000.length) row('超 6000 字', stats.over6000.length, `第 ${stats.over6000.join('、')} 章`);
  row('段内 6 字重复', issues.repeat6.count, issues.repeat6.chapters.length ? `涉及 ${issues.repeat6.chapters.length} 章` : '');
  row('跨章重复句', issues.crossChapter.count, '归一化后 ≥12 字且出现在 ≥2 章');
  row('15.5 禁词', issues.banned.count, '');
  row('15.5 句式超限', issues.patterns.overCount, '');
  row('拉丁字母词', issues.latin.count, '');
  row('半角标点', issues.halfWidth.count, '');
  row('直引号 " / \'', issues.straightQuotes.count, '');
  row('连续空行', issues.blankLines.count, '');
  row('超 40 字句', issues.longSentences.count, '');
  const qb = issues.quoteBalance;
  const qUnbalanced = qb.quoteLeft !== qb.quoteRight || qb.cornerLeft !== qb.cornerRight || qb.doubleLeft !== qb.doubleRight;
  row('引号配对', qUnbalanced ? '不平衡' : '平衡',
    `“${qb.quoteLeft}/${qb.quoteRight}” 「${qb.cornerLeft}/${qb.cornerRight}」 『${qb.doubleLeft}/${qb.doubleRight}』`);
  if (stats.missing.length) {
    push();
    push(`⚠ 范围内缺正文：第 ${stats.missing.join('、')} 章`);
  }

  const section = (title, samples, render) => {
    if (!samples || samples.length === 0) return;
    push();
    push(`## ${title}`);
    for (const s of samples) push(`- ${render(s)}`);
  };

  section('段内 6 字重复（前 12 条）', issues.repeat6.samples,
    (s) => `第 ${s.chapter} 章 · 第 ${s.paragraph} 段 · 「${s.gram}」×${s.count}`);
  section('跨章重复句（前 12 条）', issues.crossChapter.samples,
    (s) => `第 ${s.chapters.join('/')} 章 · 「${s.text}」`);
  section('15.5 禁词', issues.banned.samples,
    (s) => `第 ${s.chapter} 章 · ${s.term} ×${s.count} · ${s.evidence}`);
  section('15.5 句式超限', issues.patterns.samples,
    (s) => `第 ${s.chapter} 章 · ${s.name} ×${s.count}（允许 ${s.allowed}）· ${s.evidence}`);
  section('拉丁字母词', issues.latin.samples,
    (s) => `第 ${s.chapter} 章 · ${s.count} 处 · ${s.words.join(' / ')}`);
  section('半角标点', issues.halfWidth.samples,
    (s) => `第 ${s.chapter} 章 · ${s.count} 处 · ${s.evidence}`);
  section('直引号', issues.straightQuotes.samples,
    (s) => `第 ${s.chapter} 章 · ${s.count} 处`);
  section('连续空行', issues.blankLines.samples,
    (s) => `第 ${s.chapter} 章 · ${s.count} 处`);
  section('超 40 字句', issues.longSentences.samples,
    (s) => `第 ${s.chapter} 章 · ${s.length} 字 · ${s.text}`);
  section('引号配对异常', qb.imbalanced,
    (s) => `第 ${s.chapter} 章 · ${s.label} 左 ${s.left} / 右 ${s.right}`);

  return out.join('\n');
}
