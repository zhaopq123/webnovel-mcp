/**
 * 节奏分析（Strand Weave）。
 *
 * 产品定位（PRD F6）：治「跑偏」。
 * 网文长篇的三条线必须轮转，任何一条断档太久读者就会流失：
 *   quest（主线剧情）/ fire（感情线）/ constellation（世界观扩展）
 *
 * 红线参考行业经验值，可在 Config 里调整。
 */
import { readIndex, readState } from '../core/state.js';
import { toInt } from '../util.js';

/** 三线元信息。 */
export const STRANDS = {
  quest: { key: 'quest', label: '主线剧情', ideal: 0.6, maxGap: 5, color: '🔵' },
  fire: { key: 'fire', label: '感情线', ideal: 0.2, maxGap: 10, color: '🔴' },
  constellation: { key: 'constellation', label: '世界观', ideal: 0.2, maxGap: 15, color: '🟢' },
};

export const STRAND_KEYS = Object.keys(STRANDS);

/** 归一化线名（容忍中文与别名）。 */
export function normalizeStrand(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (STRAND_KEYS.includes(raw)) return raw;
  const alias = {
    主线: 'quest', 剧情: 'quest', 主线剧情: 'quest', quest: 'quest', q: 'quest',
    感情: 'fire', 感情线: 'fire', 爱情: 'fire', fire: 'fire', f: 'fire', 言情: 'fire',
    世界观: 'constellation', 设定: 'constellation', 扩展: 'constellation',
    constellation: 'constellation', c: 'constellation', 世界: 'constellation',
  };
  return alias[raw] ?? null;
}

/**
 * 分析节奏。
 * @param {string} root
 * @param {{ uptoChapter?: number, window?: number, maxGapOverrides?: object }} options
 */
export function analyzePacing(root, options = {}) {
  const { value: index } = readIndex(root);
  const { value: state } = readState(root);
  const upto = toInt(options.uptoChapter, Number.MAX_SAFE_INTEGER);
  const windowSize = toInt(options.window, 20);

  const chapters = index.chapters
    .filter((c) => toInt(c.chapter) <= upto)
    .sort((a, b) => toInt(a.chapter) - toInt(b.chapter));

  const counts = { quest: 0, fire: 0, constellation: 0, unknown: 0 };
  for (const c of chapters) {
    const key = normalizeStrand(c.strand);
    if (key) counts[key] += 1;
    else counts.unknown += 1;
  }
  const classified = counts.quest + counts.fire + counts.constellation;

  const ratios = {};
  for (const key of STRAND_KEYS) {
    ratios[key] = classified > 0 ? counts[key] / classified : 0;
  }

  // 断档：从最新章往回数，某条线多少章没出现
  const current = chapters.length > 0 ? toInt(chapters[chapters.length - 1].chapter) : toInt(state.progress?.currentChapter);
  const gaps = {};
  const lastSeen = {};
  for (const key of STRAND_KEYS) {
    const last = [...chapters].reverse().find((c) => normalizeStrand(c.strand) === key);
    lastSeen[key] = last ? toInt(last.chapter) : null;
    gaps[key] = last ? current - toInt(last.chapter) : current;
  }

  const alerts = [];
  for (const key of STRAND_KEYS) {
    const meta = STRANDS[key];
    const maxGap = toInt(options.maxGapOverrides?.[key], meta.maxGap);
    if (chapters.length >= 5 && gaps[key] >= maxGap) {
      // 越过红线本身就是 error：红线是「不能超过」的线，不是「超过两倍才算事」的线。
      // 从未出现和「写过但断档」要分开说——前者是「还没安排过」，后者是「安排过又丢了」。
      const tail = lastSeen[key] === null
        ? `从未出现（已写 ${chapters.length} 章）`
        : `已连续 ${gaps[key]} 章未出现`;
      alerts.push({
        level: 'error',
        strand: key,
        gap: gaps[key],
        message: `${meta.label}${tail}（红线 ${maxGap} 章）——建议安排相关情节，否则读者会流失`,
      });
    }
  }
  // 偏科要在开局就说话。旧版只在写满 20 章后才比占比，于是「前三章全是主线、
  // 感情线与世界观一章都没有」这种情况报的是「无明显节奏问题」——假绿灯比没灯更害人。
  // 连续同线 + 有线从未出现，第 3 章就能判定，不用等样本够。
  const lastKey = normalizeStrand(chapters[chapters.length - 1]?.strand);
  let streak = 0;
  if (lastKey) {
    for (const c of [...chapters].reverse()) {
      if (normalizeStrand(c.strand) !== lastKey) break;
      streak += 1;
    }
  }
  if (streak >= toInt(options.streakThreshold, 3)) {
    const absent = STRAND_KEYS.filter((k) => k !== lastKey && lastSeen[k] === null);
    if (absent.length > 0) {
      alerts.push({
        level: 'warning',
        strand: lastKey,
        gap: gaps[lastKey],
        message: `${STRANDS[lastKey].label}已连续 ${streak} 章，${absent.map((k) => STRANDS[k].label).join('、')}至今从未出现`
          + '——单线推到底读者会疲劳，建议安排一次轮转',
      });
    }
  }

  if (classified >= 20) {
    for (const key of STRAND_KEYS) {
      const meta = STRANDS[key];
      const actual = ratios[key];
      const diff = actual - meta.ideal;
      if (diff < -0.15 && gaps[key] < meta.maxGap) {
        alerts.push({
          level: 'info',
          strand: key,
          gap: gaps[key],
          message: `${meta.label}占比 ${(actual * 100).toFixed(1)}%，低于理想 ${(meta.ideal * 100).toFixed(0)}%——长期看需要补量`,
        });
      }
    }
  }

  // 最近 window 章的分布
  const recent = chapters.slice(-windowSize);
  const recentCounts = { quest: 0, fire: 0, constellation: 0, unknown: 0 };
  for (const c of recent) {
    const key = normalizeStrand(c.strand);
    if (key) recentCounts[key] += 1;
    else recentCounts.unknown += 1;
  }

  return {
    chapter: current,
    totalChapters: chapters.length,
    unclassified: counts.unknown,
    counts,
    ratios,
    gaps,
    lastSeen,
    recent: { window: recent.length, counts: recentCounts },
    alerts,
    dominant: state.strand?.dominant ?? null,
    healthy: alerts.filter((a) => a.level === 'error').length === 0,
  };
}

/** 渲染节奏报告为 Markdown。 */
export function renderPacingMarkdown(report) {
  const out = [];
  const push = (line = '') => out.push(line);

  push(`# 节奏体检报告（截至第 ${report.chapter} 章）`);
  push();
  push(`已统计 ${report.totalChapters} 章${report.unclassified > 0 ? `，其中 ${report.unclassified} 章未标注线别` : ''}`);
  push();

  if (report.alerts.length > 0) {
    push('## 告警');
    for (const a of report.alerts) {
      const icon = a.level === 'error' ? '🔴' : a.level === 'warning' ? '🟡' : 'ℹ️';
      push(`- ${icon} ${a.message}`);
    }
    push();
  } else {
    push('## ✅ 无明显节奏问题');
    push();
  }

  push('## 三线占比');
  push('| 线 | 章数 | 实际占比 | 理想占比 | 距上次出现 |');
  push('|---|---|---|---|---|');
  for (const key of STRAND_KEYS) {
    const meta = STRANDS[key];
    // 从未出现过的线不能说「N 章前」——那听起来像 N 章前写过。
    const seen = report.lastSeen?.[key] ?? null;
    const gapText = seen === null ? '未出现' : `${report.gaps[key]} 章前`;
    push(`| ${meta.color} ${meta.label} | ${report.counts[key]} | ${(report.ratios[key] * 100).toFixed(1)}% | ${(meta.ideal * 100).toFixed(0)}% | ${gapText} |`);
  }
  push();

  push(`## 最近 ${report.recent.window} 章分布`);
  for (const key of STRAND_KEYS) {
    const meta = STRANDS[key];
    const n = report.recent.counts[key];
    const bar = '█'.repeat(Math.min(30, n));
    push(`- ${meta.color} ${meta.label}：${bar} ${n} 章`);
  }
  push();

  return out.join('\n').trimEnd() + '\n';
}
