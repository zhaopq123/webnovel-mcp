/**
 * 一致性审查（六维）。
 *
 * 产品定位（PRD F7）：治「崩塌」。
 * 参考实现的六维审查：爽点 / 一致性 / 节奏 / OOC / 连贯 / 追读力。
 * 本插件用「可判定的规则 + 启发式」实现，不依赖额外模型调用——
 * 机器能判的机器判，判不了的交给 Agent（在技能里写明）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside } from '../core/paths.js';
import { readText, exists, writeJsonAtomic } from '../core/store.js';
import { isInitialized } from '../core/project.js';
import { readState, readIndex, readForeshadowing, readProject, findChapter, recentChapters, openForeshadowing } from '../core/state.js';
import { toInt, countWords, containsIgnoreCase, stripMarkdown, isoNow, textHash } from '../util.js';
import { analyzePacing, STRANDS, normalizeStrand } from './pacing.js';
import { readChapterOutline, suggestWords } from './context.js';
import { readChapterText } from './outline.js';

/** 严重级别排序权重。 */
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/** 审查记录路径（.webnovel/reviews/ch0012.json）。 */
export function reviewRecordPath(root, chapter) {
  return inside(root, DIRS.reviews, `ch${String(toInt(chapter)).padStart(4, '0')}.json`);
}

/** 读某章的审查记录；没有或损坏都返回 null（commit 门禁据此判定）。 */
export function readReviewRecord(root, chapter) {
  const file = reviewRecordPath(root, chapter);
  if (!exists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 审查一章。
 * @param {string} root
 * @param {number} chapter
 * @param {{ text?: string }} options 允许直接传正文（不落盘也能审）
 */
export function reviewChapter(root, chapter, options = {}) {
  const num = toInt(chapter);
  if (num <= 0) throw new Error('审查需要有效的章节号');

  const { value: state } = readState(root);
  const { value: index } = readIndex(root);
  const { value: ledger } = readForeshadowing(root);

  const stored = readChapterText(root, num);
  const text = String(options.text ?? stored?.text ?? '');
  if (!text.trim()) {
    throw new Error(`第 ${num} 章没有正文内容可审查（正文/ 下未找到，也未传入 text）。`);
  }

  const issues = [];
  const add = (dimension, severity, message, evidence, suggestion) => {
    issues.push({ dimension, severity, message, evidence, suggestion });
  };

  const words = countWords(text);
  const body = stripMarkdown(text);
  const outline = readChapterOutline(root, num);

  /* ---------------- 1. 一致性：状态冲突 ---------------- */
  const protagonist = state.protagonist ?? {};
  const condition = String(protagonist.condition ?? '').trim();
  if (condition) {
    const conflict = detectConditionConflict(condition, body);
    if (conflict) {
      add('consistency', 'error',
        `主角状态卡记录「${condition}」，但正文出现「${conflict.term}」——状态冲突`,
        conflict.sentence,
        '要么修正正文，要么说明该状态已恢复（并在 commit 里更新 condition）。');
    }
  }

  // 境界回退检测：正文出现低于当前境界的等级词
  const realm = String(protagonist.power?.realm ?? '').trim();
  if (realm && state.world?.powerSystem?.length > 0) {
    const realmIndex = state.world.powerSystem.findIndex((r) => containsIgnoreCase(realm, r));
    if (realmIndex > 0) {
      for (let i = 0; i < realmIndex; i += 1) {
        const lower = state.world.powerSystem[i];
        const pattern = new RegExp(`(?:突破|晋阶|升入|已达|修为)[^。！？\\n]{0,10}${lower}`, 'i');
        const hit = pattern.exec(body);
        if (hit) {
          add('consistency', 'warning',
            `主角已是「${realm}」，正文却出现「${lower}」的突破描述——疑似境界回退`,
            hit[0],
            '确认是否为回忆/他人视角；否则修正境界表述。');
          break;
        }
      }
    }
  }

  // 已死亡/离场角色出场检测（用 notes 里的标记）
  for (const [name, card] of Object.entries(state.characters ?? {})) {
    const note = String(card?.notes ?? '');
    if (/已死|阵亡|身亡|死亡|退场/.test(note)) {
      const mention = findMention(body, name);
      if (mention) {
        add('consistency', 'warning',
          `角色「${name}」状态卡标注为已离场/死亡（${note}），但本章仍有出场描写`,
          mention,
          '确认是否为回忆、幻觉、他人提及；若是本人出场请更新角色卡。');
      }
    }
  }

  /* ---------------- 2. 连贯性：与前章衔接 ---------------- */
  const chapterEntry = index.chapters.find((c) => toInt(c.chapter) === num);
  const prev = findChapter(index, num - 1);
  const prevLoc = prev?.ending?.location;
  // 只在「确实换了地方」时要求开头交代。上一章收在出租屋、本章仍收在出租屋，
  // 就是同一场戏接着演，这时提醒「开头没交代地点」是误报——
  // 误报多了，作者就学会整份报告不看。
  const sameScene = Boolean(prevLoc) && chapterEntry?.ending?.location === prevLoc;
  if (prevLoc && !sameScene) {
    const opening = body.slice(0, 400);
    if (!containsIgnoreCase(opening, prevLoc)) {
      add('continuity', 'info',
        `上一章结束于「${prevLoc}」，本章开头未提及该地点——确认场景切换是否交代清楚`,
        opening.slice(0, 80),
        '若为场景跳跃，建议在开头一句交代时间与地点，避免读者困惑。');
    }
  }
  // 注：曾经这里用「钩子类型名」去匹配正文开头（拿「危机钩」的「危机」二字找开头），
  // 但类型名是标签不是正文用词，正文几乎不可能出现，导致每章都误报「没有承接」。
  // 承接与否要看情节，机器判不了——交给 Agent 和作者，机器不猜。

  /* ---------------- 3. 节奏 ---------------- */
  const pacing = analyzePacing(root, { uptoChapter: num });
  for (const alert of pacing.alerts) {
    add('pacing', alert.level === 'error' ? 'error' : 'warning', alert.message, null,
      `考虑在本章加入${STRANDS[alert.strand]?.label ?? alert.strand}相关情节。`);
  }
  const strand = normalizeStrand(chapterEntry?.strand);
  if (!strand) {
    add('pacing', 'info',
      chapterEntry ? '本章已提交，但没标线别（strand）' : '本章还没提交，提交时记得标线别',
      null,
      '用 strand 标注本章属于 quest / fire / constellation，节奏统计才准确。');
  }

  /* ---------------- 4. 大纲符合度 ---------------- */
  if (!outline) {
    add('outline', 'warning',
      `第 ${num} 章没有章纲——「大纲即法律」原则未满足`,
      null,
      '补一份章纲，或确认本章确实属于自由发挥的部分。');
  } else {
    const keywords = extractKeywords(outline.text);
    const missing = keywords.filter((k) => !containsIgnoreCase(body, k));
    // 只在「要素全部/绝大多数都没出现」时才提醒：
    // 少一半漏一两个是正常的写作取舍，而漏光则基本等于偏离了大纲。
    if (keywords.length >= 2 && missing.length >= keywords.length) {
      add('outline', 'warning',
        `章纲里的要素似乎都没在正文出现（${missing.slice(0, 5).join('、')}）`,
        null,
        '核对是否偏离了大纲。若有意调整，请同步更新章纲，保持「大纲即法律」。');
    }
  }

  /* ---------------- 5. 伏笔 ---------------- */
  const open = openForeshadowing(ledger, num);
  const overdue = open.filter((f) => f.overdue);
  if (overdue.length > 0) {
    add('foreshadowing', 'warning',
      `${overdue.length} 条伏笔已到期未回收：${overdue.map((f) => f.name).join('、')}`,
      null,
      '安排回收，或调整 plannedPayoff 并说明原因。');
  }
  // 本章是否埋了新伏笔但没登记
  if (/(?:埋下|留下|伏笔|日后|将来会|日后再)/.test(body) && open.length === 0) {
    add('foreshadowing', 'info',
      '正文疑似埋下伏笔，但台账里没有未回收条目',
      null,
      '提交时用 deltas.foreshadowing.planted 登记，否则这条线索会被系统遗忘。');
  }

  /* ---------------- 6. 追读力 / 爽点 ---------------- */
  const tail = body.slice(-500);
  // 钩子 = 末尾留悬念/转折。词表要覆盖网文常见收尾方式：
  // 疑问感叹、悬停破折号、转折意外词，以及「指认/揭示类」收尾
  // （如「他半小时前刚见过」「正是同一个人」）——这类最容易被漏判。
  const tailHasHook = /[？?！!…]|——|突然|忽然|猛然|猛地|却|竟|竟然|居然|原来|没想到|偏偏|反而|直到|这时|此刻|就在|正是|就是他|就是她|同一个人|一模一样|认出|认得|见过/.test(tail);
  if (!tailHasHook) {
    add('reader-pull', 'warning',
      '章末缺少钩子（悬念/反转/期待感）',
      tail.slice(-80),
      '网文靠章末钩子留人。建议在最后一段埋一个悬念或转折。');
  }
  const paragraphs = body.split(/\n+/).filter((p) => p.trim().length > 0);
  const avgParagraph = paragraphs.length > 0 ? Math.round(words / paragraphs.length) : 0;
  if (avgParagraph > 260) {
    add('reader-pull', 'info',
      `段落偏长（平均 ${avgParagraph} 字/段）——移动端阅读体验差`,
      null,
      '网文建议单段 80-200 字，长段落拆开。');
  }
  const dialogueLines = paragraphs.filter((p) => /[""「」『』]/.test(p)).length;
  if (paragraphs.length >= 20 && dialogueLines === 0) {
    add('reader-pull', 'info',
      '本章几乎没有对话——纯叙述容易让读者疲劳',
      null,
      '考虑加入对话推进情节，对话是最省力的信息传递方式。');
  }

  /* ---------------- 7. 字数 ---------------- */
  // 基准用本书自己的章均目标（总字数 / 总章数推导），不用硬编码常量：
  // 100 万字 / 400 章和 20 万字 / 60 章的合格线本来就不一样。
  // 旧版只跟「近期均值」比，只要越写越长就永远不报——1372 字照样过审，
  // 而平台按 2000 字起收，等于写完白写。
  const base = suggestWords(readProject(root).value);
  if (words < base * 0.7) {
    add('pacing', 'warning',
      `本章 ${words} 字，不足本书章均目标 ${base} 字的七成`,
      null,
      '补到接近章均再提交。单章太短在免费平台会被当成凑数或断章，完读率直接掉下来。');
  } else if (words > base * 1.8) {
    add('pacing', 'info',
      `本章 ${words} 字，明显超出本书章均目标 ${base} 字`,
      null,
      '考虑拆成两章：单章过长在移动端反而掉完读。');
  }
  const recent = recentChapters(index, 5, num);
  if (recent.length >= 3) {
    const avg = Math.round(recent.reduce((s, c) => s + toInt(c.words), 0) / recent.length);
    if (avg > 0 && words < avg * 0.6) {
      add('pacing', 'info',
        `本章 ${words} 字，明显低于近期均值 ${avg} 字`,
        null,
        '确认是有意短章（过渡章）还是内容不足。');
    }
  }

  /* ---------------- 汇总 ---------------- */
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const summary = {
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };

  /* ---------------- 落盘审查记录 ---------------- */
  // commit 门禁凭这条记录判断「审没审、审的是哪版」：
  //   hash 一致 + error>0 → 阻断提交；hash 不一致 → 视为旧稿（只提醒）。
  // 只写入已初始化的书项目（临时目录/单测裸目录不落盘）。
  const reviewedAt = isoNow();
  const hash = textHash(text);
  const fromInline = options.text !== undefined && options.text !== null;
  let recordPath = null;
  if (isInitialized(root)) {
    recordPath = reviewRecordPath(root, num);
    writeJsonAtomic(recordPath, {
      schemaVersion: 1,
      chapter: num,
      reviewedAt,
      source: fromInline ? 'inline' : 'file',
      textHash: hash,
      words,
      summary,
      passed: summary.error === 0,
      hasOutline: Boolean(outline),
      strand,
      issues,
    });
  }

  return {
    chapter: num,
    words,
    paragraphs: paragraphs.length,
    hasOutline: Boolean(outline),
    strand,
    issues,
    summary,
    passed: summary.error === 0,
    reviewedAt,
    textHash: hash,
    recordPath,
    markdown: renderReviewMarkdown(num, { words, paragraphs: paragraphs.length, issues, summary, hasOutline: Boolean(outline) }),
  };
}

/**
 * 检测「身体状态」与正文动作的冲突。
 * 这是 PRD 场景 A（断手还握剑）的直接实现。
 */
const CONDITION_RULES = [
  { condition: /(右臂|右手|右腕)[^，。]{0,10}(受伤|伤|废|断|裂|折|未愈|不能动|不便|无法用力|使不上|用不上|抬不起|麻痹)/, conflicts: ['右手', '右掌', '双手', '挥剑', '持剑', '握剑', '拔剑', '握拳', '右臂一'] },
  { condition: /(左臂|左手|左腕)[^，。]{0,10}(受伤|伤|废|断|裂|折|未愈|不能动|不便|无法用力|使不上|用不上|抬不起|麻痹)/, conflicts: ['左手', '左掌', '双手', '挥剑', '持剑', '握剑', '拔剑', '握拳'] },
  { condition: /(双腿?|脚)[^，。]{0,10}(受伤|断|废|裂|折|不能|无法行走|站不起|走不动)/, conflicts: ['站起', '奔跑', '跃起', '大步', '飞奔', '疾驰'] },
  { condition: /(双目|眼睛|失明|瞎)/, conflicts: ['看见', '看到', '望着', '注视', '瞥见', '目光'] },
  { condition: /(昏迷|沉睡|不省人事)/, conflicts: ['睁眼', '坐起', '站起', '开口'] },
  { condition: /(重伤|垂死|濒死|气息奄奄)/, conflicts: ['纵身', '飞跃', '疾奔', '大战三百', '生龙活虎'] },
];

function detectConditionConflict(condition, body) {
  for (const rule of CONDITION_RULES) {
    if (!rule.condition.test(condition)) continue;
    for (const term of rule.conflicts) {
      const idx = body.indexOf(term);
      if (idx >= 0) {
        const start = Math.max(0, idx - 20);
        const end = Math.min(body.length, idx + term.length + 20);
        return { term, sentence: `…${body.slice(start, end).replace(/\n/g, ' ')}…` };
      }
    }
  }
  return null;
}

function findMention(body, name) {
  if (!name) return null;
  const idx = body.indexOf(name);
  if (idx < 0) return null;
  return `…${body.slice(Math.max(0, idx - 20), idx + name.length + 20).replace(/\n/g, ' ')}…`;
}

/**
 * 从章纲里提取「应当在正文逐字出现」的**命名实体**。
 *
 * 为什么只取这一类：拿整句或短语去匹配正文必然误报——
 * 章纲写「林越推开铁门」，正文写成「林越推开那扇锈迹斑斑的铁门」，
 * 字面永远对不上，结果就是每次都报「要素没写出来」，教会用户忽略审查。
 *
 * 而**专名**（引号标注的人名/地名/物品、加粗的设定词、带地名后缀的词）
 * 在正文里通常逐字出现，对不上就确实值得提醒。
 */
const STRUCTURAL_LABELS = /^(场景|关键事件|揭示|章末钩子|时间|地点|出场人物|本章目标|情绪|线别|势力|物品|能力|字数|备注|节拍|阶段|目标|冲突|钩子|伏笔|提示|前提|要求|限制|禁忌|核心|背景|基调|事件|开场|结尾|转折|看点|爽点)/;

function extractKeywords(text) {
  const source = String(text ?? '');
  const out = new Set();

  // 1. 引号标注的专名（作者明确点出的名字最可信）
  for (const m of source.matchAll(/[""「」『』]([^""「」『』]{2,12})[""「」『』]/g)) out.add(m[1].trim());

  // 2. 加粗的设定词
  for (const m of source.matchAll(/\*\*([^*]{2,12})\*\*/g)) out.add(m[1].trim());

  // 3. 组织/门派类专名（后缀必须无歧义——「门」既可能是宗门也可能是大门，
  //    「城」「山」「国」同理，都不收，否则「推开铁门」会被当成专名）
  for (const m of source.matchAll(/[\u4e00-\u9fa5]{1,3}(?:宗|派|学院|联盟|组织|公司|集团|家族|公会|商会)/g)) {
    if (m[0].length >= 2 && m[0].length <= 5) out.add(m[0]);
  }

  return [...out]
    .filter((k) => k.length >= 2 && k.length <= 12 && !STRUCTURAL_LABELS.test(k))
    .slice(0, 12);
}

/** 渲染审查报告。 */
export function renderReviewMarkdown(chapter, { words, paragraphs, issues, summary, hasOutline }) {
  const out = [];
  const push = (line = '') => out.push(line);

  push(`# 第 ${chapter} 章审查报告`);
  push();
  const verdict = summary.error > 0 ? '🔴 存在问题，建议修改后再提交'
    : summary.warning > 0 ? '🟡 基本可用，有若干可改进项'
      : '✅ 未发现明显问题';
  push(`**结论：${verdict}**`);
  push();
  push(`字数 ${words}｜段落 ${paragraphs}｜章纲 ${hasOutline ? '已有' : '缺失'}｜问题 ${summary.error} 严重 / ${summary.warning} 提醒 / ${summary.info} 建议`);
  push();

  if (issues.length === 0) {
    push('没有发现问题。');
    return out.join('\n').trimEnd() + '\n';
  }

  const dimLabel = {
    consistency: '设定一致性', continuity: '叙事连贯', pacing: '节奏',
    outline: '大纲符合度', foreshadowing: '伏笔', 'reader-pull': '追读力',
  };
  const grouped = {};
  for (const issue of issues) {
    (grouped[issue.dimension] ??= []).push(issue);
  }

  for (const [dim, list] of Object.entries(grouped)) {
    push(`## ${dimLabel[dim] ?? dim}`);
    for (const issue of list) {
      const icon = issue.severity === 'error' ? '🔴' : issue.severity === 'warning' ? '🟡' : 'ℹ️';
      push(`- ${icon} ${issue.message}`);
      if (issue.evidence) push(`  - 原文：${issue.evidence}`);
      if (issue.suggestion) push(`  - 建议：${issue.suggestion}`);
    }
    push();
  }

  return out.join('\n').trimEnd() + '\n';
}
