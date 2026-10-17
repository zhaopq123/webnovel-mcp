/**
 * 体量自适应引擎（提示词第二节 2.2–2.6 的公式落点）。
 *
 * 产品目标：作者只需要回答「目标体量多少字」（2.1），其余结构参数一律换算出来，
 * 不需要他做任何配置选择。换算表随 `webnovel_status` 输出，所以「写到哪部/哪卷、
 * 还剩几章收部」每次看都是现算的，不会出现「早先算过一次后来忘了改」的过期结构。
 *
 * 刻意「只算不存」：structure 是 targetWords 的纯函数。一旦把它写进 project.json
 * 就制造了第二份真相——改了目标字数却没人重算，表和实际就对不上。2.1 要求的
 * 「中途改目标时重算后续参数并输出调整说明」由「每次读都重算」天然满足
 * （调整说明＝对比新旧两次换算表，见 renderStructureDiff）。
 *
 * 公式本体在 `prompt/CREATIVE-PROMPT.md` 第二节，这里只落算术、注释只标节号，
 * 不复制规则正文（避免正文两处漂移）。
 */
import { clamp, toInt } from '../util.js';

/** 2.2 恒定单元与 2.3 公式里出现的全部常数（集中一处，便于与提示词对账）。 */
export const STRUCTURE_CONSTANTS = {
  chapterWords: [3000, 4000],        // 章：任何体量恒定
  volumeChapters: [50, 80],          // 卷：任何体量恒定（约 20–30 万字）
  partChapters: [130, 150],          // 部：任何体量恒定（约 40–60 万字）
  wordsPerPart: 550_000,             // 部数 = 总字数 ÷ 55 万，向上取整
  chapterWordsMid: 3500,             // 章数建议值口径（区间中值，不是新规则）
  volumeChaptersMid: 65,             // 卷长建议值口径（同上）
  bigTier: { base: 4, cap: 10 },     // 大层级数 = 4+N（上限 10）
  onion: { base: 2, cap: 5 },        // 反派洋葱 = min(2+N, 5)
  suspenseIdleChapters: 50,          // 任何层悬置超 50 章无暗示 = 警报
  castRebuildIdleChapters: 60,       // 配角连续 60 章未出场再登场需重建立戏
  partSummaryMaxLines: 15,           // 部摘要不超过 15 行
  defaultTargetWords: 1_000_000,     // 2.1：「写多长写多长」按 100 万字规划
};

const C = STRUCTURE_CONSTANTS;

/**
 * 悬念账户层名（2.3 的口径）。层数按部数分段加层：
 * 1 部只用前 3 层；≥2 部加「跨部」；≥4 部再加「全书」。
 * 导出去给叙事债务账本（lib/features/ledger.js）复用——层名两处各写一套，
 * 台账里的「部」和换算表里的「本部级」就会对不上。
 */
export const SUSPENSE_LAYERS = ['短', '卷', '部', '跨部', '全书'];

/** 部数 N → 本书启用的悬念账户层名。 */
export function suspenseLayersFor(partsCount) {
  const N = Math.max(1, toInt(partsCount, 1));
  const names = SUSPENSE_LAYERS.slice(0, 3);
  if (N >= 2) names.push(SUSPENSE_LAYERS[3]);
  if (N >= 4) names.push(SUSPENSE_LAYERS[4]);
  return names;
}

/** 向上取整的除法（章数、部数都用它，避免 0.3 部这种没法执行的值）。 */
function divUp(total, size) {
  if (!size || size <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/**
 * 部位置换算（2.2 的算术本体）：结构参数 + 章号 → 在第几部、部内第几章、部末章。
 *
 * 单独导出而不是只塞进 computeStructure 的 progress：同一张换算表会被拿不同章号来问
 * （status 问当前章、任务书问下一章）。若 partProgress 复用它计算时传进去的 currentChapter，
 * 换一个章号就会答错——这里让调用方永远按**它自己给的章号**现算。
 */
export function partPositionAt(structure, chapter) {
  const ch = toInt(chapter);
  const per = toInt(structure?.parts?.chaptersPerPart);
  const n = Math.max(1, toInt(structure?.parts?.count, 1));
  if (ch <= 0 || per <= 0) return null;
  const part = clamp(divUp(ch, per), 1, n);
  const start = (part - 1) * per + 1;
  const end = Math.min(part * per, toInt(structure?.chapters?.max, part * per));
  return {
    currentChapter: ch,
    part,
    chaptersIntoPart: ch - start + 1,
    totalChapters: end - start + 1,
    remainingInPart: Math.max(0, end - ch),
    partEndChapter: end,
    nextPartStartChapter: part < n ? end + 1 : null,
  };
}

/**
 * 由目标体量换算全部结构参数。
 * @param {{ targetWords?: number, targetChapters?: number, currentChapter?: number }} input
 * @returns 结构换算结果（含 notes：换算里发现不自洽时的提示，不静默吞掉）
 */
export function computeStructure(input = {}) {
  const rawWords = Number(input.targetWords);
  const targetWords = Number.isFinite(rawWords) && rawWords > 0 ? Math.round(rawWords) : C.defaultTargetWords;
  const assumedWords = !(Number.isFinite(rawWords) && rawWords > 0);

  const notes = [];
  if (assumedWords) {
    notes.push({ level: 'info', text: `没给目标字数，按 2.1 以 ${wan(C.defaultTargetWords)} 万字规划；定了体量请写进 project.json 的 targetWords。` });
  }

  // ── 章数（2.2：章恒定 3000–4000 字 → 体量只决定数量）────────────────
  const chapters = {
    min: Math.round(targetWords / C.chapterWords[1]),
    suggested: Math.round(targetWords / C.chapterWordsMid),
    max: Math.ceil(targetWords / C.chapterWords[0]),
  };

  // ── 部数 N（2.2：部数 = 总字数 ÷ 55 万，向上取整，至少 1 部）──────────
  const parts = {
    count: Math.max(1, Math.ceil(targetWords / C.wordsPerPart)),
    band: [...C.partChapters],
    words: C.wordsPerPart,
  };
  parts.chaptersPerPart = divUp(chapters.suggested, parts.count);

  // ── 卷数（2.2：卷 50–80 章恒定；先把卷长塞进恒定区间，塞不下就如实报）──
  let volumeCount = clamp(Math.round(chapters.suggested / C.volumeChaptersMid), 1, chapters.suggested);
  while (volumeCount < chapters.suggested && divUp(chapters.suggested, volumeCount) > C.volumeChapters[1]) {
    volumeCount += 1;
  }
  const volumes = {
    count: volumeCount,
    band: [...C.volumeChapters],
    chaptersPerVolume: divUp(chapters.suggested, volumeCount),
    perPart: Number((volumeCount / parts.count).toFixed(1)),
  };

  // ── 动态参数（2.3）───────────────────────────────────────────────
  const N = parts.count;
  const tiers = {
    count: Math.min(C.bigTier.base + N, C.bigTier.cap),
    cap: C.bigTier.cap,
    formula: `4+N，上限 ${C.bigTier.cap}`,
  };
  const onion = {
    layers: Math.min(C.onion.base + N, C.onion.cap),
    cap: C.onion.cap,
    formula: `min(2+N, ${C.onion.cap})`,
    perPart: 1,
    firstPartLayer: '表层',
  };
  const suspenseNames = suspenseLayersFor(N);
  const suspense = {
    layers: suspenseNames.length,
    names: suspenseNames,
    idleAlertChapters: C.suspenseIdleChapters,
  };
  const conflictRounds = N <= 3 ? 1 : Math.ceil(N / 3);
  const conflict = {
    rounds: conflictRounds,
    mode: N <= 3 ? '一轮' : '多轮',
    rule: N <= 3 ? 'N≤3：人际→组织→规则/世界→自我 全书走一轮' : 'N≥4：允许多轮循环，每轮换更大舞台',
    selfLayerIrreversible: true,
    ladder: ['人际', '组织', '规则/世界', '自我'],
  };

  // ── 弧光与归档（2.4 / 2.5）与跨部（2.6）────────────────────────────
  const arc = { segments: N, note: '总弧光拆成 N 段，每部信念推进 1 格、部末以具体行为显形，推进不可逆' };
  const archive = {
    times: Math.max(0, N - 1),
    summaryMaxLines: C.partSummaryMaxLines,
    note: N <= 1 ? '1 部书无归档动作，但部总结包照写' : `每部完结输出【部总结包】，全书共归档 ${Math.max(0, N - 1)} 次`,
  };
  const crossPart = {
    hookRequired: true,
    castRebuildIdleChapters: C.castRebuildIdleChapters,
    firstChapterTask: '新部第一章前 1000 字：重建局面 + 引入本部新变量 + 回收上部钩子的回响',
  };

  // ── 当前进度落点（有了章号才知道「现在在第几部」）─────────────────────
  let progress = null;
  const currentChapter = toInt(input.currentChapter);
  const position = partPositionAt({ parts, chapters }, currentChapter);
  if (position) {
    progress = {
      ...position,
      volume: clamp(divUp(currentChapter, volumes.chaptersPerVolume), 1, volumes.count),
      partBoundaryChapters: Array.from({ length: N - 1 }, (_, i) => (i + 1) * parts.chaptersPerPart),
    };
    if (currentChapter > chapters.max) {
      notes.push({
        level: 'warn',
        text: `已写 ${currentChapter} 章，超出 ${wan(targetWords)} 万字的换算区间上限 ${chapters.max} 章——要么体量已经涨了（改 targetWords 重算），要么该收部了。`,
      });
    }
  }

  // ── 不自洽检查：这是这张表最有价值的地方，别只做算术──────────────────
  const declared = toInt(input.targetChapters);
  if (declared > 0 && (declared < chapters.min || declared > chapters.max)) {
    notes.push({
      level: 'warn',
      text: `目标 ${wan(targetWords)} 万字对应 ${chapters.min}–${chapters.max} 章，但项目写了 ${declared} 章（按 3000–4000 字/章 ≈ ${wan(Math.round((declared * C.chapterWords[0]) / 10000) * 10000)}–${wan(Math.round((declared * C.chapterWords[1]) / 10000) * 10000)} 万字）。两个字口径不一致，以哪个为准要先定，否则章纲字数和结构换算会各算一套。`,
    });
  }
  if (parts.chaptersPerPart < C.partChapters[0] && N === 1) {
    notes.push({
      level: 'info',
      text: `${wan(targetWords)} 万字 ≈ ${(targetWords / C.wordsPerPart).toFixed(2)} 部，装不满一个部的恒定区间（${C.partChapters[0]}–${C.partChapters[1]} 章）：按 1 部执行，三幕循环压缩在本部内走完，不用等部末才收。`,
    });
  } else if (parts.chaptersPerPart > C.partChapters[1]) {
    const fit = divUp(chapters.suggested, C.partChapters[1]);
    notes.push({
      level: 'warn',
      text: `按 ${N} 部拆分每部 ${parts.chaptersPerPart} 章，超出部的恒定上限 ${C.partChapters[1]} 章——建议按 ${fit} 部（约 ${divUp(chapters.suggested, fit)} 章/部），否则部末的三幕收束会挤不下。`,
    });
  }
  if (volumes.chaptersPerVolume > C.volumeChapters[1] || (volumes.chaptersPerVolume < C.volumeChapters[0] && chapters.suggested > C.volumeChapters[1])) {
    notes.push({
      level: 'info',
      text: `卷长换算为 ${volumes.chaptersPerVolume} 章/卷（恒定区间 ${C.volumeChapters[0]}–${C.volumeChapters[1]} 章）：${volumes.chaptersPerVolume < C.volumeChapters[0] ? '短书的卷可以低于下限，别为了凑 50 章硬合并卷' : '注意每卷实际章数落在恒定区间内再切卷'}。`,
    });
  }

  return {
    targetWords,
    assumedWords,
    chapters,
    parts,
    volumes,
    tiers,
    onion,
    suspense,
    conflict,
    arc,
    archive,
    crossPart,
    progress,
    notes,
    // 换算依据一行话，方便 agent 复述给人听（也方便测试断言 N 的来源）
    derivedFrom: `${wan(targetWords)} 万字 ÷ ${wan(C.wordsPerPart)} 万/部 = ${(targetWords / C.wordsPerPart).toFixed(2)} → N=${N} 部（向上取整，至少 1 部）`,
  };
}

/** 字数 → 万字（换算表给人看，别写 1000000 这种数）。 */
export function wan(words) {
  const w = toInt(words) / 10000;
  return `${Number.isInteger(w) ? w : w.toFixed(1)}`;
}

/** 告警/说明行：两种渲染都要带，别在这儿分叉。 */
function renderNotes(s) {
  return s.notes.map((n) => `- ${n.level === 'warn' ? '🔴' : 'ℹ️'} ${n.text}`);
}

/** 当前进度落点行（两种渲染共用一句，口径不会漂）。 */
function renderProgress(s) {
  const p = s.progress;
  if (!p) return [];
  return [`当前：第 ${p.currentChapter} 章 → 第 ${p.part} 部第 ${p.chaptersIntoPart} 章（本部止于第 ${p.partEndChapter} 章，距部末 ${p.remainingInPart} 章）｜第 ${p.volume} 卷`];
}

/**
 * 2.1 的「目标体量调整说明」：对比新旧两次换算表，只列真正变化的项。
 *
 * 为什么单独成一个函数：init 改目标字数是**写操作**，作者必须看见「哪些结构参数被重算了」，
 * 否则改一个数字导致部数/章数悄悄翻倍，下一章就会按错的结构写。同值重跑不输出任何东西。
 *
 * @param {object} prev 旧的 computeStructure 结果
 * @param {object} next 新的 computeStructure 结果
 * @param {{prevTargetChapters?: number, nextTargetChapters?: number}} meta 目标章数（不在结构结果里）
 * @returns {string[]} 无变化返回 []
 */
export function renderStructureDiff(prev, next, meta = {}) {
  if (!prev || !next) return [];
  const rows = [];
  const push = (label, from, to) => {
    if (String(from) === String(to)) return;
    rows.push(`- ${label}：${from} → ${to}`);
  };
  push('目标字数', `${wan(prev.targetWords)} 万字`, `${wan(next.targetWords)} 万字`);
  if (meta.prevTargetChapters !== undefined && meta.nextTargetChapters !== undefined) {
    push('目标章数', `${toInt(meta.prevTargetChapters)} 章`, `${toInt(meta.nextTargetChapters)} 章`);
  }
  push('全书章数（建议）', `${prev.chapters.suggested} 章`, `${next.chapters.suggested} 章`);
  push('全书章数区间', `${prev.chapters.min}–${prev.chapters.max} 章`, `${next.chapters.min}–${next.chapters.max} 章`);
  push('部数', `${prev.parts.count} 部`, `${next.parts.count} 部`);
  push('每部章数', `${prev.parts.chaptersPerPart} 章`, `${next.parts.chaptersPerPart} 章`);
  push('卷数', `${prev.volumes.count} 卷`, `${next.volumes.count} 卷`);
  push('每卷章数', `${prev.volumes.chaptersPerVolume} 章`, `${next.volumes.chaptersPerVolume} 章`);
  push('大层级数', `${prev.tiers.count} 层`, `${next.tiers.count} 层`);
  push('反派洋葱', `${prev.onion.layers} 层`, `${next.onion.layers} 层`);
  push('悬念账户', `${prev.suspense.layers} 层（${prev.suspense.names.join('/')}）`, `${next.suspense.layers} 层（${next.suspense.names.join('/')}）`);
  push('冲突编排', `${prev.conflict.mode}${prev.conflict.rounds > 1 ? `（约 ${prev.conflict.rounds} 轮）` : ''}`, `${next.conflict.mode}${next.conflict.rounds > 1 ? `（约 ${next.conflict.rounds} 轮）` : ''}`);
  push('部阶段弧光', `${prev.arc.segments} 段`, `${next.arc.segments} 段`);
  push('记忆归档', `${prev.archive.times} 次`, `${next.archive.times} 次`);
  if (rows.length === 0) return [];
  return [
    '## 目标体量调整说明（提示词 2.1）',
    '',
    '检测到目标体量变化，以下结构参数已按新目标重算（旧 → 新）：',
    '',
    ...rows,
    '',
    '> 只影响之后的规划：已写章节不重算，已登记的部/卷不自动改；按新表推进后续章纲与部末收束。',
    '',
  ];
}

/**
 * 渲染完整结构换算表（markdown）。返回行数组，调用方决定插在哪儿——
 * init 报告用它（开书第一屏就该看见全表，一次性的成本）。
 */
export function renderStructureTable(s) {
  const lines = [];
  lines.push(`体量结构换算（提示词第二节）：${s.derivedFrom}`);
  lines.push('');
  lines.push('| 结构单元 | 换算结果 | 依据 |');
  lines.push('|---|---|---|');
  lines.push(`| 章 | ${C.chapterWords[0]}–${C.chapterWords[1]} 字（恒定） | 2.2 |`);
  lines.push(`| 全书章数 | ${s.chapters.min}–${s.chapters.max} 章，建议 ${s.chapters.suggested} 章 | 目标字数 ÷ 章恒定字数 |`);
  lines.push(`| 卷 | ${s.volumes.count} 卷（约 ${s.volumes.chaptersPerVolume} 章/卷，恒定 ${s.volumes.band[0]}–${s.volumes.band[1]}） | 2.2 |`);
  lines.push(`| 部 | ${s.parts.count} 部（约 ${s.parts.chaptersPerPart} 章/部，恒定 ${s.parts.band[0]}–${s.parts.band[1]}） | 2.2 |`);
  lines.push(`| 大层级数 | ${s.tiers.count}（${s.tiers.formula}） | 2.3 |`);
  lines.push(`| 反派洋葱 | ${s.onion.layers} 层（${s.onion.formula}，每部剥 ${s.onion.perPart} 层，第 1 部剥${s.onion.firstPartLayer}） | 2.3 |`);
  lines.push(`| 悬念账户 | ${s.suspense.layers} 层：${s.suspense.names.join('/')}（任一层悬置超 ${s.suspense.idleAlertChapters} 章无暗示＝警报） | 2.3 |`);
  lines.push(`| 冲突层级 | ${s.conflict.mode}${s.conflict.rounds > 1 ? `（约 ${s.conflict.rounds} 轮）` : ''}：${s.conflict.ladder.join('→')}；自我层成长不可逆 | 2.3 |`);
  lines.push(`| 部阶段弧光 | ${s.arc.segments} 段（每部信念推进 1 格，推进不可逆） | 2.4 |`);
  lines.push(`| 记忆归档 | 归档 ${s.archive.times} 次（N−1），部摘要 ≤${s.archive.summaryMaxLines} 行 | 2.5 |`);
  lines.push(`| 配角重建立戏 | 连续 ${s.crossPart.castRebuildIdleChapters} 章未出场再登场时必须重建立戏 | 2.6 |`);
  const progress = renderProgress(s);
  if (progress.length > 0) {
    lines.push('');
    lines.push(...progress);
    if (s.progress.nextPartStartChapter) {
      lines.push(`下一部自第 ${s.progress.nextPartStartChapter} 章起——按 2.6：新部第一章前 1000 字要完成「重建局面 + 引入本部新变量 + 回收上部钩子的回响」。`);
    } else {
      lines.push('已是最后一部：按 2.4，总弧光只在终部兑现。');
    }
  }
  lines.push(...renderNotes(s));
  lines.push('');
  lines.push('以上参数由目标字数换算，改 targetWords 后本表自动重算（2.1 的「中途改目标重算」）。');
  return lines;
}

/**
 * 紧凑版（默认给 `webnovel_status` 用）：三行讲完换算 + 进度 + 告警。
 *
 * 为什么不默认发全表：status 是最省 token 的入口工具，也是 agent 每轮都可能调的那一个，
 * 二十行表格会把它的定位打掉。全表留在 `structure=full`（以及 init 的开书报告里），
 * 需要规划时才展开——**要提醒作者的口径不自洽（🔴）在两版里都在**，压缩没压掉判据。
 */
export function renderStructureSummary(s) {
  const lines = [];
  lines.push(`结构换算（提示词第二节，按目标字数现算）：${s.derivedFrom}`);
  lines.push(`　${s.chapters.suggested} 章（${s.chapters.min}–${s.chapters.max}）｜${s.parts.count} 部·约 ${s.parts.chaptersPerPart} 章/部｜${s.volumes.count} 卷·约 ${s.volumes.chaptersPerVolume} 章/卷`);
  lines.push(`　大层级 ${s.tiers.count}｜反派洋葱 ${s.onion.layers} 层｜悬念账户 ${s.suspense.layers} 层（${s.suspense.names.join('/')}）｜冲突${s.conflict.mode}｜弧光 ${s.arc.segments} 段｜归档 ${s.archive.times} 次`);
  const progress = renderProgress(s);
  if (progress.length > 0) lines.push(...progress);
  lines.push(...renderNotes(s));
  lines.push('　要逐项依据（含恒定区间与节号）：`webnovel_status` 传 `structure=full`。');
  return lines;
}
