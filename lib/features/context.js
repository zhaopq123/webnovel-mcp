/**
 * ★ 防遗忘引擎：写作任务书。
 *
 * 产品定位（PRD F2）：这是整个插件最重要的功能。
 * 目标不是「把数据倒给模型」，而是让模型动笔前就明确「本章必须遵守什么」。
 *
 * 设计要点：
 * - 纯派生、不落盘：每次现算，保证永远新鲜（不依赖任何缓存失效逻辑）。
 * - 固定优先级：硬约束 > 本章大纲 > 主角状态 > 伏笔 > 前情 > 其余。
 *   模型对开头和结尾最敏感，所以最要命的约束放在最前。
 * - 双重输出：结构化对象（给工具用）+ Markdown（给人看）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside } from '../core/paths.js';
import { readText, exists } from '../core/store.js';
import {
  readState, readIndex, readForeshadowing, readMemory, readProject, readTerms,
  findChapter, recentChapters, openForeshadowing, staleCharacters, recentCharacters,
  searchMemory,
} from '../core/state.js';
import { toInt, formatVolumeLabel } from '../util.js';
import { analyzePacing } from './pacing.js';
import { TERM_TYPES } from './terms.js';
import { loadCatalog, briefRules, briefTriggers, BRIEF_DEFAULT_CHARS } from './craft.js';
import { briefDossiers } from './dossier.js';
import { partProgress, renderPartLine, renderPartCooldown } from './parts.js';
import { debtFromProject, renderDebtSummary, debtHeadline, debtTag, payoffVerb } from './ledger.js';

/** 任务书里按顺序编号用的中文数字。 */
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五'];

/** 任务书硬约束（写死在代码里，因为它们是不可协商的产品原则）。 */
export const HARD_RULES = [
  '大纲即法律：严格遵循本章章纲，不擅自改变剧情走向；若认为大纲有问题，先停下来说明理由并征求作者意见。',
  '设定即物理：严格遵守设定集与状态卡，不得让角色使用未掌握的能力、出现在不可能的地点。',
  '发明需登记：本章新出现的人物/地点/势力/物品/能力，必须在提交时写入 deltas，否则后续章节会当作不存在。',
  '状态要延续：主角的身体状况、伤势、所在地、境界必须与状态卡一致（例如"右臂受伤"期间不得写出双手持剑的潇洒动作）。',
];

/** 读取章纲文件内容（不存在返回 null）。 */
export function readChapterOutline(root, chapter) {
  const dir = inside(root, DIRS.chapterOutlines);
  const candidates = [
    `第${String(toInt(chapter)).padStart(4, '0')}章.md`,
    `第${toInt(chapter)}章.md`,
  ];
  for (const name of candidates) {
    const file = path.join(dir, name);
    if (exists(file)) return { path: `${DIRS.chapterOutlines}/${name}`.split(path.sep).join('/'), text: readText(file) ?? '' };
  }
  return null;
}

/** 读取卷纲。 */
export function readVolumeOutline(root, volume) {
  const dir = inside(root, DIRS.volumes);
  const candidates = [`第${toInt(volume)}卷.md`, `第${String(toInt(volume)).padStart(2, '0')}卷.md`];
  for (const name of candidates) {
    const file = path.join(dir, name);
    if (exists(file)) return { path: `${DIRS.volumes}/${name}`.split(path.sep).join('/'), text: readText(file) ?? '' };
  }
  return null;
}

/** 读取总纲。 */
export function readMasterOutline(root) {
  const file = inside(root, DIRS.outline, '总纲.md');
  return exists(file) ? { path: `${DIRS.outline}/总纲.md`, text: readText(file) ?? '' } : null;
}

/** 读取设定集某篇。 */
export function readSetting(root, name) {
  const file = inside(root, DIRS.settings, `${name}.md`);
  return exists(file) ? readText(file) ?? '' : null;
}

/** 列出设定集篇目。 */
export function listSettings(root) {
  const dir = inside(root, DIRS.settings);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

/** 任务书里每个类别最多列多少个名字（再多的名字给个计数，全表走 query）。 */
const TERM_BRIEF_LIMIT = 40;

/**
 * 把专名账本压成任务书能用的形状：按类别分组、组内截断。
 * 截断是刻意的——一本千章的书可能有上千条专名，全量灌进任务书会挤掉本章大纲。
 * 「名字漏了」的兜底是提交时的未登记告警 + `webnovel_query kind=term`。
 */
function summarizeTerms(terms) {
  const groups = [];
  const taken = new Set();
  for (const [key, label] of Object.entries(TERM_TYPES)) {
    const hits = terms.items.filter((t) => t.type === key);
    if (hits.length === 0) continue;
    for (const t of hits) taken.add(t.name);
    groups.push({ type: key, label, total: hits.length, items: hits.slice(0, TERM_BRIEF_LIMIT) });
  }
  // 兜住历史数据里没归进词表的类别：宁可多一列「未分类」，也不能让名字从任务书里凭空消失
  const rest = terms.items.filter((t) => !taken.has(t.name));
  if (rest.length > 0) {
    groups.push({ type: '', label: '未分类', total: rest.length, items: rest.slice(0, TERM_BRIEF_LIMIT) });
  }
  return { total: terms.items.length, groups };
}

/**
 * 构建写作任务书。
 * @param {string} root 项目根
 * @param {number} chapter 要写的章号
 * @returns {{ chapter, brief, markdown, warnings, blockers }}
 */
export function buildWritingBrief(root, chapter, options = {}) {
  const num = toInt(chapter);
  if (num <= 0) throw new Error(`非法章节号：${chapter}`);

  const warnings = [];
  const { value: project } = readProject(root);
  const { value: state, warnings: sw } = readState(root);
  const { value: index, warnings: iw } = readIndex(root);
  const { value: ledger, warnings: fw } = readForeshadowing(root);
  const { value: terms, warnings: tw } = readTerms(root);
  const { value: memory } = readMemory(root);
  warnings.push(...sw, ...iw, ...fw, ...tw);

  if (!project) warnings.push('未找到 project.json，建议先运行 webnovel_init 初始化项目');

  // ---- 前置检查（blockers：不满足就不该动笔）----
  const blockers = [];
  const chapterOutline = readChapterOutline(root, num);
  if (!chapterOutline) {
    blockers.push(`第 ${num} 章还没有章纲。请先用 webnovel_outline 定章纲——「大纲即法律」是本系统的第一原则。`);
  }

  const prev = findChapter(index, num - 1);
  if (num > 1 && !prev) {
    warnings.push(`第 ${num - 1} 章尚未提交（缺少提交记录）。若你确实跳章写作，请忽略此提示。`);
  }

  // ---- 组装 ----
  const volume = findVolume(state, num);
  const volumeOutline = volume ? readVolumeOutline(root, volume.volume) : null;

  // 本章必守（原文切片）：规则正文不在本文件里抄一份，运行时从 prompt 切片库取。
  // 取不到就明说并继续——任务书里「本书事实」比规则重要，不许因为规则库缺失就调不通。
  let stageRules = null;
  if (options.rules !== 'off') {
    try {
      const { catalog } = loadCatalog();
      const due = openForeshadowing(ledger, num).filter((f) => f.overdue).length;
      stageRules = briefRules(catalog, {
        maxChars: toInt(options.rulesMaxChars, BRIEF_DEFAULT_CHARS),
        triggers: briefTriggers({
          romanceEnabled: !!state.romance || project.romance === true,
          debtDue: due,
          batchReport: num % 10 === 0,
        }),
      });
    } catch (e) {
      warnings.push(`本章必守规则未加载：${e.message}`);
    }
  }

  const brief = {
    chapter: num,
    project: project
      ? {
        title: project.title,
        genre: project.genre,
        genreTags: project.genreTags ?? [],
        logline: project.logline ?? '',
        targetWords: project.targetWords,
        targetChapters: project.targetChapters,
        progressPercent: project.targetChapters ? Math.round((num / project.targetChapters) * 100) : null,
      }
      : null,
    volume: volume
      ? { ...volume, outlinePath: volumeOutline?.path ?? null }
      : null,
    chapterOutline: chapterOutline ? { path: chapterOutline.path, text: chapterOutline.text } : null,
    protagonist: state.protagonist,
    lockedTerms: summarizeTerms(terms),
    relatedCharacters: recentCharacters(state, num, 15),
    staleCharacters: staleCharacters(state, num, 30),
    // 部进度（只认已建部；没建部时结构换算那边会说计划值，任务书不重复估算）。
    part: partProgress(state, null, num),
    // 第六节档案快照：写正文时最容易被违反的是「谁不该知道什么」与「谁说话什么腔调」，
    // 这两件事在任务书里看不到，3.6⑧ 的归属核对就只能等审查阶段事后红。
    dossiers: briefDossiers(state),
    openForeshadowing: openForeshadowing(ledger, num),
    // 叙事债务总账（悬念余额 / 支票 / 误导线索）。部数→余额线的推导交给 debtFromProject，
    // 与 status / query / commit 回执走同一条链，别在任务书里再算一遍 3 还是 4。
    debt: debtFromProject(project, ledger, num),
    timeline: state.timeline.slice(-8),
    previous: recentChapters(index, 2, num).map((c) => ({
      chapter: c.chapter,
      title: c.title,
      summary: c.summary ?? '',
      hook: c.hook ?? null,
      ending: c.ending ?? null,
    })),
    pacing: analyzePacing(root, { uptoChapter: num }),
    memory: searchMemory(memory, '', [], 5),
    hardRules: HARD_RULES,
    stageRules,
    suggestedWords: suggestWords(project),
  };

  return {
    chapter: num,
    brief,
    markdown: renderBriefMarkdown(brief, { blockers, warnings }),
    warnings,
    blockers,
  };
}

/** 找出章号所属卷。 */
function findVolume(state, chapter) {
  const num = toInt(chapter);
  const volumes = Array.isArray(state.progress?.volumes) ? state.progress.volumes : [];
  for (const v of volumes) {
    const range = String(v.chapterRange ?? '');
    const match = /(\d+)\s*[-~到]\s*(\d+)/.exec(range);
    if (match) {
      const [, from, to] = match;
      if (num >= toInt(from) && num <= toInt(to)) return v;
    } else {
      const single = toInt(range);
      if (single > 0 && num === single) return v;
    }
  }
  return volumes.length > 0 ? volumes[volumes.length - 1] : null;
}

/** 建议本章字数：按目标章数与总字数推导，收敛到 2000-6000。 */
export function suggestWords(project) {
  const targetWords = toInt(project?.targetWords, 0);
  const targetChapters = toInt(project?.targetChapters, 0);
  if (targetWords > 0 && targetChapters > 0) {
    const per = Math.round(targetWords / targetChapters);
    return Math.min(6000, Math.max(2000, per));
  }
  return 3000;
}

/**
 * 把任务书渲染成 Markdown。
 * 顺序刻意如此：最要命的约束在最前，模型对首尾最敏感。
 */
export function renderBriefMarkdown(brief, { blockers = [], warnings = [] } = {}) {
  const out = [];
  const push = (line = '') => out.push(line);
  // 章节编号必须连续：条件区块（角色/伏笔/时间线…）没内容时会整块省略，
  // 若编号写死就会出现「四、」直接跳到「十、」——作者会以为工具坏了。
  let n = 0;
  const section = (title) => { n += 1; push(`## ${CN_NUM[n] ?? n}、${title}`); };

  push(`# 第 ${brief.chapter} 章 · 写作任务书`);
  push();

  if (blockers.length > 0) {
    push('## ⛔ 动笔前必须先解决');
    for (const b of blockers) push(`- ${b}`);
    push();
  }
  if (warnings.length > 0) {
    push('## ⚠ 需要注意');
    for (const w of warnings) push(`- ${w}`);
    push();
  }

  // 项目定位
  if (brief.project) {
    const p = brief.project;
    section('本书定位');
    push(`- 书名：${p.title}`);
    push(`- 题材：${p.genre}${p.genreTags?.length ? `（${p.genreTags.join(' / ')}）` : ''}`);
    if (p.logline) push(`- 一句话：${p.logline}`);
    push(`- 目标：${p.targetWords} 字 / ${p.targetChapters} 章${p.progressPercent !== null ? `（当前进度约 ${p.progressPercent}%）` : ''}`);
    if (brief.volume) push(`- 当前卷：${formatVolumeLabel(brief.volume.volume, brief.volume.title)}（${brief.volume.chapterRange ?? '范围未定'}）`);
    if (brief.part) {
      const line = renderPartLine(brief.part);
      if (line) push(`- ${line}`);
      const cooldown = renderPartCooldown(brief.part);
      if (cooldown) push(`- ${cooldown}`);
    }
    push(`- 建议本章字数：约 ${brief.suggestedWords} 字`);
    push();
  }

  // 本章大纲（法律）
  section('本章章纲（必须遵守）');
  if (brief.chapterOutline) {
    push(`来源：\`${brief.chapterOutline.path}\``);
    push();
    push(brief.chapterOutline.text.trim());
  } else {
    push('⚠ 本章还没有章纲。请先定章纲再动笔。');
  }
  push();

  // 前情
  section('前情提要');
  if (brief.previous.length > 0) {
    for (const c of brief.previous) {
      push(`### 第 ${c.chapter} 章 ${c.title ?? ''}`);
      if (c.summary) push(c.summary);
      if (c.hook?.type) push(`- 章末钩子：${c.hook.type}${c.hook.strength ? `（${c.hook.strength}）` : ''}`);
      if (c.ending?.location) push(`- 结尾场景：${c.ending.location}${c.ending.time ? ` · ${c.ending.time}` : ''}`);
      push();
    }
  } else {
    push('（这是第一章，无前情）');
    push();
  }

  // 主角状态（防 OOC / 防状态丢失）
  const pr = brief.protagonist;
  section('主角当前状态（不得违反）');
  if (pr?.name) {
    push(`- 姓名：${pr.name}`);
    if (pr.power?.realm) push(`- 境界：${pr.power.realm}${pr.power.bottleneck ? `（瓶颈：${pr.power.bottleneck}）` : ''}`);
    if (pr.location) push(`- 位置：${pr.location}`);
    if (pr.condition) push(`- 身体/处境：${pr.condition}　← 写作时务必延续此状态`);
    if (pr.goldenFinger?.name) push(`- 金手指：${pr.goldenFinger.name}${pr.goldenFinger.level ? ` Lv.${pr.goldenFinger.level}` : ''}${pr.goldenFinger.note ? `（${pr.goldenFinger.note}）` : ''}`);
  } else {
    push('（主角状态为空——建议先在设定集/主角卡.md 中确定主角，并在首次提交时写入状态）');
  }
  push();

  // 已锁定专名（铁律 1「名词锁定」）：这是最容易在长连载里破功的一条——
  // 第 200 章顺口编一个新宗门名，作者和读者都看不出，只有账本记得。
  const lt = brief.lockedTerms;
  section('已锁定专名（只能用这些写法）');
  if (!lt || lt.total === 0) {
    push('（专名账本为空）本章若出现新的人名/地名/势力/功法/物品/术语，先与作者确认用名，提交时写入 deltas.terms。');
  } else {
    for (const g of lt.groups) {
      const names = g.items.map((t) => (t.aliases?.length > 0 ? `${t.name}（亦作${t.aliases.join('、')}）` : t.name));
      push(`- ${g.label} ${g.total}：${names.join('、')}${g.total > g.items.length ? `…另有 ${g.total - g.items.length} 条` : ''}`);
    }
    push('铁律 1：以上名称一经确立即锁定，后续只能用其中一种写法并全书统一；要用没登记过的新名字，必须先问作者，禁止无声创造。');
    push(`共 ${lt.total} 条；查全表或某个名字：\`webnovel_query kind=term\`。`);
  }
  push();

  // 相关角色
  if (brief.relatedCharacters.length > 0 || brief.staleCharacters.length > 0) {
    section('角色');
    if (brief.relatedCharacters.length > 0) {
      push('近期出场：');
      push();
      push('| 角色 | 身份 | 境界 | 所在地 | 最后出场 |');
      push('|---|---|---|---|---|');
      for (const c of brief.relatedCharacters.slice(0, 12)) {
        push(`| ${c.name} | ${c.role ?? ''} | ${c.realm ?? ''} | ${c.location ?? ''} | 第 ${c.lastChapter ?? '?'} 章 |`);
      }
      push();
    }
    if (brief.staleCharacters.length > 0) {
      push('久未出场（考虑安排戏份或交代去向）：');
      for (const c of brief.staleCharacters.slice(0, 8)) {
        push(`- ${c.name}（第 ${c.lastChapter} 章后未再出现，已隔 ${brief.chapter - toInt(c.lastChapter)} 章）`);
      }
      push();
    }
    // 主要人物档案：只列已登记的项。写的时候照这张表分配信息，
    // 别把 A 的秘密从 B 嘴里说出来（3.6⑧），也别让所有人一个腔调（6.5）。
    if ((brief.dossiers ?? []).length > 0) {
      push('主要人物档案（第六节 · 写时照这张表分配信息）：');
      push();
      for (const d of brief.dossiers) {
        const head = [`${d.name}${d.role ? `（${d.role}）` : ''}`];
        if (d.relationLevel) head.push(`关系 ${d.relationLevel}/5`);
        push(`- ${head.join('｜')}`);
        if (d.desire || d.fear) push(`  - 欲望「${d.desire || '未填'}」／恐惧「${d.fear || '未填'}」${d.contradiction ? `／矛盾「${d.contradiction}」` : ''}`);
        if (d.secret) push(`  - 秘密：${d.secret}`);
        if (d.fingerprint) push(`  - 语言指纹：${d.fingerprint}`);
        if (d.knows.length) push(`  - 已知道：${d.knows.join('；')}`);
        if (d.notKnows.length) push(`  - **还不知道**：${d.notKnows.join('；')}`);
        if (d.mistaken.length) push(`  - 误以为：${d.mistaken.join('；')}`);
        if (d.gaps.length) push(`  - 档案缺口：${d.gaps.join('、')}`);
      }
      push();
      push('铁律：台词的信息量按上表分配——标了「还不知道」的事，本章不许从这个人嘴里出来（3.6⑧ 会核对）。');
      push();
    }
  }

  // 伏笔
  // 产品要点：未回收的伏笔必须全部在场，而不只是「快到期」的那些。
  // 只提醒快到期的，等于默许作者把还有几十章才回收的线索忘掉——那正是本插件要治的病。
  // 四类债务同住一张账，非伏笔的条目要标出来：把「支票」当伏笔列进红榜，作者会按伏笔的方式处理它。
  const overdue = brief.openForeshadowing.filter((f) => f.overdue);
  const aging = brief.openForeshadowing.filter((f) => f.aging);
  const pending = brief.openForeshadowing.filter((f) => !f.overdue && !f.aging);
  if (brief.openForeshadowing.length > 0) {
    section(`未回收债务（共 ${brief.openForeshadowing.length} 条）`);
    if (overdue.length > 0) {
      push('### 🔴 已到期，本章或近期应收');
      for (const f of overdue) {
        const planned = toInt(f.plannedPayoff);
        const verb = payoffVerb(f);
        // 计划回收章正好是本章时，不能说「已超期」——本章就是它的回收章。
        const when = planned === brief.chapter ? `本章应${verb}` : `已超期 ${brief.chapter - planned} 章`;
        push(`- ${debtTag(f)}**${f.name}**（第 ${f.plantedChapter} 章埋下，原计划第 ${planned} 章${verb}，${when}）${f.note ? ` — ${f.note}` : ''}`);
      }
    }
    if (aging.length > 0) {
      push('### 🟡 临近回收期');
      for (const f of aging) {
        push(`- ${debtTag(f)}${f.name}（计划第 ${f.plannedPayoff} 章${payoffVerb(f)}，还剩 ${toInt(f.plannedPayoff) - brief.chapter} 章）`);
      }
    }
    if (pending.length > 0) {
      push('### ⚪ 仍在铺垫（别当作没发生过）');
      for (const f of pending.slice(0, 20)) {
        const eta = f.plannedPayoff ? `计划第 ${f.plannedPayoff} 章${payoffVerb(f)}` : `${payoffVerb(f)}章未定`;
        push(`- ${debtTag(f)}${f.name}（第 ${f.plantedChapter} 章埋下，${eta}）`);
      }
      if (pending.length > 20) push(`- …另有 ${pending.length - 20} 条，用 webnovel_query kind=foreshadowing 查看`);
    }
    push();
  }

  // 叙事债务总账（4.1 余额 / 2.3 悬置硬线 / 4.4 支票期限 / 第五节 误导线索）
  // 与上一节的分工：上一节是逐条清单，这一节是总账与阈值判定——读者弃书看的是总账。
  // 「未启用账户」那条 ℹ️ 也要带：作者不知道要登记 suspense，余额判据就永远不会执法。
  if (debtHeadline(brief.debt) !== null || brief.debt.alerts.some((a) => a.level === 'info')) {
    section('叙事债务（悬念账户 / 支票 / 误导线索）');
    for (const line of renderDebtSummary(brief.debt, { limit: 3, header: debtHeadline(brief.debt) === null })) push(line);
    push();
  }

  // 时间线
  if (brief.timeline.length > 0) {
    section('最近事件时间线');
    for (const t of brief.timeline) {
      push(`- 第 ${t.chapter} 章｜${t.time ?? ''}｜${t.location ?? ''}｜${t.event ?? ''}`);
    }
    push();
  }

  // 节奏
  const pacing = brief.pacing;
  if (pacing?.alerts?.length > 0) {
    section('节奏提示');
    for (const a of pacing.alerts) push(`- ${a.message}`);
    push();
  }

  // 写作记忆
  if (brief.memory.length > 0) {
    section('已沉淀的写作经验');
    for (const m of brief.memory) push(`- 【${m.kind}】${m.title}：${m.content}`);
    push();
  }

  // 硬约束（放最后，收尾强化）
  section('硬约束（不可违反）');
  for (const r of brief.hardRules) push(`- ${r}`);
  push();

  // 本章必守（来自提示词原文切片，逐字未改；规则正文不在本文件里另存一份）
  const rules = brief.stageRules;
  if (rules) {
    section(`本章必守（提示词原文 · ${rules.chars} 字）`);
    push(`装配口径：按「最容易忘 + 后果最重」的优先级取到预算用完；`
      + `预算 ${rules.maxChars} 字，已带 ${rules.kept.length} 片。`);
    for (const k of rules.kept) push(`- ${k.id} ${k.why}`);
    if (rules.dropped.length > 0) {
      push(`- ⚪ 因超出预算未带：${rules.dropped.map((d) => `${d.id}(${d.why})`).join('、')}`);
      push('  （要全文：`webnovel_craft action=get ids="…"` 或 `action=brief stage=正文`）');
    }
    push();
    push(rules.text.trim());
    push();
  }

  push('> 完稿流程：先 `webnovel_review` 自审（有 🔴 必须改），再用 `webnovel_commit` 提交——不提交，本章的事下一章不会记得。');

  return out.join('\n').trimEnd() + '\n';
}
