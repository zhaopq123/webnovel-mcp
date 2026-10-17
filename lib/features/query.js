/**
 * 查询：把结构化数据用自然语言回答出来。
 *
 * 产品定位（PRD F5）：作者和 Agent 都能问「主角现在什么境界」「玉佩伏笔还开着吗」。
 * 设计原则：返回人话，不返回 JSON（PRD 6.3）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside, listChapterFiles } from '../core/paths.js';
import { readText, exists } from '../core/store.js';
import {
  readState, readIndex, readForeshadowing, readMemory, readProject, readTerms,
  findChapter, sortChapters, openForeshadowing, searchMemory, staleCharacters,
  findTerm, searchTerms,
} from '../core/state.js';
import { toInt, countWords, truncate, containsIgnoreCase, escapeRegExp } from '../util.js';
import { STRANDS, normalizeStrand } from './pacing.js';
import { TERM_TYPES, normalizeTermType, termTypeLabel } from './terms.js';
import {
  debtFromProject, renderDebtReport, debtHeadline, debtTag, payoffVerb, hintsOf,
} from './ledger.js';
import { readSetting, listSettings, readMasterOutline, readChapterOutline, readVolumeOutline } from './context.js';
import { readCommit, listCommits } from './commit.js';

/* ------------------------------------------------------------------ *
 * 状态查询
 * ------------------------------------------------------------------ */

export function queryStatus(root) {
  const { value: project } = readProject(root);
  const { value: state } = readState(root);
  const { value: index } = readIndex(root);
  const { value: ledger } = readForeshadowing(root);
  const { value: terms } = readTerms(root);
  const current = state.progress.currentChapter;
  const open = openForeshadowing(ledger, current);

  const lines = [];
  if (project) {
    lines.push(`《${project.title}》｜${project.genre}｜目标 ${project.targetWords} 字 / ${project.targetChapters} 章`);
    if (project.logline) lines.push(`一句话：${project.logline}`);
  } else {
    lines.push('（未找到项目元信息）');
  }
  lines.push(`进度：已写 ${index.chapters.length} 章 / ${state.progress.totalWords} 字（最新第 ${current} 章）`);

  const p = state.protagonist;
  if (p?.name) {
    const bits = [p.name];
    if (p.power?.realm) bits.push(p.power.realm);
    if (p.location) bits.push(`在${p.location}`);
    if (p.condition) bits.push(p.condition);
    lines.push(`主角：${bits.join(' · ')}`);
  }
  const debt = debtFromProject(project, ledger, current);
  lines.push(`伏笔：未回收 ${open.length} 条${open.filter((f) => f.overdue).length > 0 ? `（其中 ${open.filter((f) => f.overdue).length} 条已到期）` : ''}`);
  // 四类债务同住一张账，`open.length` 已经把它们全数进去了，所以这一行要说清各是多少、
  // 以及 4.1 的余额线够不够——只报「未回收 12 条」看不出悬念账户是不是空的。
  const headline = debtHeadline(debt);
  if (headline) lines.push(`债务：${headline}`);
  lines.push(`角色：共 ${Object.keys(state.characters).length} 人`);
  lines.push(`专名：已登记 ${terms.items.length} 条${terms.items.length === 0 ? '（铁律 1「名词锁定」靠这本账：提交章节时用 deltas.terms 登记）' : ''}`);

  return { project, state, index, terms, debt, lines, current };
}

/* ------------------------------------------------------------------ *
 * 角色查询
 * ------------------------------------------------------------------ */

/**
 * 主角在 state.protagonist 里，不在 characters 里。
 * 查询必须同时认这两处，否则「主角现在什么境界」会答「查无此人」——
 * 那正是最常被问、也最不能答错的问题。
 */
function protagonistAsCard(state) {
  const p = state.protagonist ?? {};
  if (!p.name) return null;
  return {
    name: p.name,
    role: '主角',
    realm: p.power?.realm ?? '',
    location: p.location ?? '',
    relation: '本人',
    // 主角从第一章就在场——显示「第 ? 章」只会让人以为数据缺了
    firstChapter: 1,
    lastChapter: state.progress?.currentChapter ?? null,
    notes: [p.condition, p.goldenFinger?.name ? `金手指：${p.goldenFinger.name}` : ''].filter(Boolean).join('；'),
    isProtagonist: true,
  };
}

export function queryCharacter(root, name) {
  const { value: state } = readState(root);
  const { value: index } = readIndex(root);
  const current = state.progress.currentChapter;
  const hero = protagonistAsCard(state);

  const key = String(name ?? '').trim();
  if (!key) {
    // 列出全部（主角排最前）
    const all = [
      ...(hero ? [hero] : []),
      ...Object.entries(state.characters).map(([n, c]) => ({ name: n, ...c })),
    ];
    return {
      found: all.length > 0,
      kind: 'list',
      items: all,
      lines: all.length === 0
        ? ['（角色库为空。写完后通过 webnovel_commit 的 deltas.characters 录入）']
        : all.sort((a, b) => Number(b.isProtagonist) - Number(a.isProtagonist)
            || toInt(b.lastChapter) - toInt(a.lastChapter))
          .map((c) => `${c.name}${c.role ? `（${c.role}）` : ''}｜${c.realm || '境界未知'}｜${c.location || '位置未知'}｜${c.lastChapter ? `最后出场第 ${c.lastChapter} 章` : '尚未出场'}`),
    };
  }

  const exact = state.characters[key] ?? (hero && hero.name === key ? hero : null);
  if (exact) {
    const appears = index.chapters.filter((c) => containsIgnoreCase(c.summary ?? '', key)).map((c) => c.chapter);
    const lines = [
      `${key}${exact.role ? `（${exact.role}）` : ''}`,
      `- 境界：${exact.realm || '未记录'}`,
      `- 位置：${exact.location || '未记录'}`,
      `- 关系：${exact.relation || '未记录'}`,
      `- 首次出场：${exact.firstChapter ? `第 ${exact.firstChapter} 章` : '未记录'}`,
      `- 最后出场：${exact.lastChapter ? `第 ${exact.lastChapter} 章（距今 ${current - toInt(exact.lastChapter)} 章）` : '未记录'}`,
    ];
    if (exact.isProtagonist) {
      const p = state.protagonist;
      if (p.condition) lines.push(`- 身体/处境：${p.condition}`);
      if (p.power?.bottleneck) lines.push(`- 瓶颈：${p.power.bottleneck}`);
      if (p.goldenFinger?.name) {
        lines.push(`- 金手指：${p.goldenFinger.name}${p.goldenFinger.level ? ` Lv.${p.goldenFinger.level}` : ''}${p.goldenFinger.note ? `（${p.goldenFinger.note}）` : ''}`);
      }
    }
    if (exact.notes && !exact.isProtagonist) lines.push(`- 备注：${exact.notes}`);
    if (appears.length > 0) lines.push(`- 摘要提及：第 ${appears.slice(-10).join('、')} 章`);
    return { found: true, kind: 'character', character: { name: key, ...exact }, lines };
  }

  // 模糊匹配（含主角）
  const pool = [...Object.entries(state.characters).map(([n, c]) => ({ name: n, ...c })), ...(hero ? [hero] : [])];
  const fuzzy = pool.filter((c) => containsIgnoreCase(c.name, key));
  if (fuzzy.length > 0) {
    return {
      found: true,
      kind: 'fuzzy',
      items: fuzzy,
      lines: [`未找到「${key}」，但找到相近的：`, ...fuzzy.map((c) => `- ${c.name}${c.role ? `（${c.role}）` : ''}`)],
    };
  }

  return {
    found: false,
    kind: 'none',
    lines: [
      `角色库里没有「${key}」。`,
      hero ? `（当前主角是「${hero.name}」）` : '（项目里还没有登记主角）',
      '若这是新角色，请在提交章节时写入 deltas.characters 登记。',
    ],
  };
}

/* ------------------------------------------------------------------ *
 * 伏笔查询
 * ------------------------------------------------------------------ */

export function queryForeshadowing(root, options = {}) {  const { value: ledger } = readForeshadowing(root);
  const { value: state } = readState(root);
  const current = toInt(options.chapter, state.progress.currentChapter);
  const statusFilter = options.status ?? null;

  let items = ledger.items;
  if (statusFilter) items = items.filter((i) => i.status === statusFilter);

  const enriched = items.map((i) => {
    const planned = i.plannedPayoff === null || i.plannedPayoff === undefined ? null : toInt(i.plannedPayoff);
    return {
      ...i,
      overdue: i.status === 'open' && planned !== null && planned > 0 && current >= planned,
      chaptersOpen: current - toInt(i.plantedChapter, current),
    };
  }).sort((a, b) => Number(b.overdue) - Number(a.overdue) || toInt(a.plantedChapter) - toInt(b.plantedChapter));

  const open = enriched.filter((i) => i.status === 'open');
  const overdue = open.filter((i) => i.overdue);
  const lines = [];
  let debt = null;

  if (enriched.length === 0) {
    lines.push('债务台账为空（伏笔 / 悬念 / 支票 / 误导线索都没有在册条目）。埋下时用 webnovel_commit 的 deltas.foreshadowing.planted 登记，'
      + '在线悬念请带 type=suspense + layer，明写的许诺请带 type=cheque + dueChapter。');
  } else {
    // 总账在前、逐条在后：来问这一节的人要的是「还欠读者多少、哪条要爆了」，
    // 逐条清单只是它的凭据。余额线（3 还是 4）由 debtFromProject 从目标字数推，与任务书同源。
    const { value: project } = readProject(root);
    const debt = debtFromProject(project, ledger, current);
    lines.push(...renderDebtReport(debt));
    lines.push('');
    lines.push(`逐条台账：共 ${enriched.length} 条｜未回收 ${open.length} 条｜已回收 ${enriched.filter((i) => i.status === 'paid').length} 条｜已放弃 ${enriched.filter((i) => i.status === 'dropped').length} 条`);
    if (overdue.length > 0) {
      lines.push('');
      lines.push('🔴 已到期未回收：');
      for (const f of overdue) {
        const gap = current - toInt(f.plannedPayoff);
        const verb = payoffVerb(f);
        const when = gap <= 0 ? `本章应${verb}` : `已超期 ${gap} 章`;
        lines.push(`- ${debtTag(f)}${f.name}（第 ${f.plantedChapter} 章埋下，计划第 ${f.plannedPayoff} 章${verb}，${when}）`);
      }
    }
    const pending = open.filter((f) => !f.overdue);
    if (pending.length > 0) {
      lines.push('');
      lines.push('🟡 未回收：');
      for (const f of pending) {
        const eta = f.plannedPayoff ? `计划第 ${f.plannedPayoff} 章` : '未定期';
        const hints = hintsOf(f);
        lines.push(`- ${debtTag(f)}${f.name}（第 ${f.plantedChapter} 章埋下，${eta}）${hints.length > 0 ? `｜暗示 ${hints.length} 次` : ''}`);
      }
    }
    const done = enriched.filter((i) => i.status !== 'open');
    if (done.length > 0 && options.includeClosed) {
      lines.push('');
      lines.push('✅ 已了结：');
      for (const f of done) lines.push(`- ${debtTag(f)}${f.name}（${f.status === 'paid' ? `第 ${f.paidChapter} 章${payoffVerb(f)}` : '已放弃'}）`);
    }
  }

  return { items: enriched, open: open.length, overdue: overdue.length, debt, lines };
}

/* ------------------------------------------------------------------ *
 * 专名查询（铁律 1「名词锁定」的账本）
 * ------------------------------------------------------------------ */

/** 一条专名渲染成一行卡片：名字（类别）｜首现章｜别名｜备注。 */
function termCard(t) {
  const bits = [`${t.name}（${termTypeLabel(t.type)}）`];
  bits.push(t.firstChapter ? `首现第 ${t.firstChapter} 章` : '首现章未记录');
  if (t.aliases?.length > 0) bits.push(`别名：${t.aliases.join('、')}`);
  if (t.note) bits.push(t.note);
  return bits.join('｜');
}

/**
 * 查专名账本。传 `name` 走单条（别名也算命中，命中后强调「只能用这一种写法」），
 * 不传则列全表（可按类别 / 关键词筛）。
 */
export function queryTerm(root, options = {}) {
  const { value: terms } = readTerms(root);
  const key = String(options.name ?? '').trim();
  const type = options.type ? normalizeTermType(options.type) : null;
  const q = String(options.query ?? '').trim();
  const limit = Math.max(1, toInt(options.limit, 60));

  if (key) {
    const exact = findTerm(terms, key);
    if (exact) {
      return {
        found: true,
        term: exact,
        items: [exact],
        total: terms.items.length,
        lines: [
          termCard(exact),
          `已登记写法：${[exact.name, ...exact.aliases].join(' / ')}——正文里请只用其中一种，不要换着写。`,
        ],
      };
    }
    const near = searchTerms(terms, key, null, limit);
    if (near.length > 0) {
      return { found: false, items: near, total: terms.items.length, lines: [`专名账本里没有「${key}」。相近的：`, ...near.map(termCard)] };
    }
    return {
      found: false,
      items: [],
      total: terms.items.length,
      lines: [
        `专名账本里没有「${key}」。`,
        '如果这是本章新出现的专名：先向作者确认用名，再在提交本章时写入 deltas.terms（铁律 1：禁止无声创造新专名）。',
        `类别可写中文：${Object.values(TERM_TYPES).join(' / ')}。`,
      ],
    };
  }

  const items = searchTerms(terms, q, type, limit);
  const lines = [];
  if (terms.items.length === 0) {
    lines.push('专名账本为空。提交章节时用 deltas.terms 登记人名/地名/组织/功法/物品/术语，之后正文只认账本里的写法。');
  } else {
    const counts = {};
    for (const t of terms.items) counts[t.type] = (counts[t.type] ?? 0) + 1;
    const dist = Object.entries(TERM_TYPES)
      .filter(([key2]) => counts[key2])
      .map(([key2, label]) => `${label} ${counts[key2]}`)
      .join('｜');
    lines.push(`专名账本：共 ${terms.items.length} 条${dist ? `｜${dist}` : ''}`);
    if (q || type) {
      lines.push(`筛选${type ? ` 类别=${termTypeLabel(type)}` : ''}${q ? ` 关键词=「${q}」` : ''}：命中 ${items.length} 条${items.length >= limit ? `（到显示上限 ${limit}，请缩小关键词）` : ''}`);
    }
    lines.push(...items.map(termCard));
    if (items.length === 0) lines.push('（没有命中的条目；用 query 传关键词，或 type 传类别再查一次）');
  }
  return { found: items.length > 0, items, total: terms.items.length, lines };
}

/* ------------------------------------------------------------------ *
 * 章节查询
 * ------------------------------------------------------------------ */

export function queryChapter(root, chapter) {
  const num = toInt(chapter);
  if (num <= 0) throw new Error('需要有效的章节号');
  const { value: index } = readIndex(root);
  const entry = findChapter(index, num);
  const commit = readCommit(root, num);
  const outline = readChapterOutline(root, num);

  const lines = [];
  if (!entry && !commit) {
    lines.push(`第 ${num} 章还没有记录（未提交）。`);
    if (outline) lines.push('但已有章纲，可以开写。');
    return { found: false, chapter: num, lines };
  }
  if (entry) {
    lines.push(`第 ${entry.chapter} 章 ${entry.title ?? ''}`);
    lines.push(`- 字数：${entry.words ?? 0}`);
    if (entry.strand) lines.push(`- 线别：${STRANDS[entry.strand]?.label ?? entry.strand}`);
    if (entry.hook?.type) lines.push(`- 章末钩子：${entry.hook.type}${entry.hook.strength ? `（${entry.hook.strength}）` : ''}`);
    if (entry.ending?.location) lines.push(`- 结尾场景：${entry.ending.location}`);
    if (entry.summary) lines.push(`- 摘要：${entry.summary}`);
    lines.push(`- 提交时间：${entry.committedAt ?? '未知'}`);
  }
  if (commit?.deltas && Object.keys(commit.deltas).length > 0) {
    lines.push('');
    lines.push('本章产生的事实变化：');
    lines.push('```json');
    lines.push(JSON.stringify(commit.deltas, null, 2));
    lines.push('```');
  }
  return { found: true, chapter: num, entry, commit, outline, lines };
}

/* ------------------------------------------------------------------ *
 * 设定查询
 * ------------------------------------------------------------------ */

export function querySetting(root, name) {
  const key = String(name ?? '').trim();
  if (!key) {
    const list = listSettings(root);
    return {
      kind: 'list',
      lines: list.length === 0
        ? ['设定集为空。可用 webnovel_init 建骨架，或直接写 设定集/*.md。']
        : [`设定集共 ${list.length} 篇：`, ...list.map((s) => `- ${s}`)],
    };
  }
  const text = readSetting(root, key);
  if (text !== null) return { kind: 'setting', name: key, text, lines: [`## ${key}`, '', text.trim()] };

  const list = listSettings(root);
  const fuzzy = list.filter((s) => containsIgnoreCase(s, key));
  if (fuzzy.length > 0) return { kind: 'fuzzy', lines: [`未找到「${key}」，相近的：${fuzzy.join('、')}`] };
  return { kind: 'none', lines: [`设定集里没有「${key}」。现有：${list.join('、') || '（空）'}`] };
}

/* ------------------------------------------------------------------ *
 * 时间线
 * ------------------------------------------------------------------ */

export function queryTimeline(root, options = {}) {
  const { value: state } = readState(root);
  const limit = toInt(options.limit, 20);
  const items = options.since
    ? state.timeline.filter((t) => toInt(t.chapter) >= toInt(options.since))
    : state.timeline;
  const sliced = items.slice(-limit);
  return {
    items: sliced,
    lines: sliced.length === 0
      ? ['时间线为空。提交章节时用 deltas.timeline 记录（time / location / event）。']
      : sliced.map((t) => `第 ${t.chapter} 章｜${t.time ?? ''}｜${t.location ?? ''}｜${t.event ?? ''}`),
  };
}

/* ------------------------------------------------------------------ *
 * 全文检索
 * ------------------------------------------------------------------ */

/**
 * 在正文、章纲、设定集、摘要中做关键词检索。
 * @returns {{ hits: Array, lines: string[] }}
 */
export function searchAll(root, query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('检索需要非空关键词');
  const limit = toInt(options.limit, 30);
  const scope = options.scope ?? 'all';
  const hits = [];

  const addHits = (label, filePath, text) => {
    const lines = String(text).split(/\r?\n/);
    const pattern = new RegExp(escapeRegExp(q), 'i');
    lines.forEach((line, i) => {
      if (pattern.test(line)) {
        hits.push({
          scope: label,
          file: filePath,
          line: i + 1,
          text: truncate(line.trim(), 160),
        });
      }
    });
  };

  if (scope === 'all' || scope === 'text') {
    for (const { name, abs } of listChapterFiles(root)) {
      addHits('正文', `${DIRS.text}/${name}`.split(path.sep).join('/'), readText(abs) ?? '');
    }
  }
  if (scope === 'all' || scope === 'outline') {
    const dirs = [
      ['章纲', inside(root, DIRS.chapterOutlines)],
      ['卷纲', inside(root, DIRS.volumes)],
      ['总纲', inside(root, DIRS.outline)],
    ];
    for (const [label, dir] of dirs) {
      try {
        for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
          addHits(label, `${path.relative(root, path.join(dir, name)).split(path.sep).join('/')}`, readText(path.join(dir, name)) ?? '');
        }
      } catch { /* 目录不存在 */ }
    }
  }
  if (scope === 'all' || scope === 'setting') {
    const dir = inside(root, DIRS.settings);
    try {
      for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        addHits('设定', `${DIRS.settings}/${name}`.split(path.sep).join('/'), readText(path.join(dir, name)) ?? '');
      }
    } catch { /* 目录不存在 */ }
  }
  if (scope === 'all' || scope === 'summary') {
    const dir = inside(root, DIRS.summaries);
    try {
      for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        addHits('摘要', `${DIRS.summaries}/${name}`.split(path.sep).join('/'), readText(path.join(dir, name)) ?? '');
      }
    } catch { /* 目录不存在 */ }
  }

  const limited = hits.slice(0, limit);
  const lines = limited.length === 0
    ? [`没有找到包含「${q}」的内容。`]
    : [
      `找到 ${hits.length} 处匹配${hits.length > limit ? `（显示前 ${limit} 条）` : ''}：`,
      '',
      ...limited.map((h) => `- [${h.scope}] ${h.file}:${h.line}　${h.text}`),
    ];

  return { hits: limited, total: hits.length, lines };
}

/* ------------------------------------------------------------------ *
 * 统一入口
 * ------------------------------------------------------------------ */

/**
 * 按 kind 分发查询。
 * kind: status | character | foreshadowing | chapter | setting | timeline | term | memory | search
 */
export function runQuery(root, kind, params = {}) {
  switch (String(kind ?? '').trim()) {
    case 'status':
      return { kind: 'status', ...queryStatus(root) };
    case 'character':
      return { kind: 'character', ...queryCharacter(root, params.name) };
    case 'foreshadowing':
      return { kind: 'foreshadowing', ...queryForeshadowing(root, params) };
    case 'chapter':
      return { kind: 'chapter', ...queryChapter(root, params.chapter) };
    case 'setting':
      return { kind: 'setting', ...querySetting(root, params.name) };
    case 'timeline':
      return { kind: 'timeline', ...queryTimeline(root, params) };
    case 'term':
      return { kind: 'term', ...queryTerm(root, params) };
    case 'memory': {
      const { value: memory } = readMemory(root);
      const hits = searchMemory(memory, params.query ?? '', params.tags ?? [], toInt(params.limit, 20));
      return {
        kind: 'memory',
        items: hits,
        lines: hits.length === 0
          ? ['没有匹配的写作记忆。']
          : hits.map((m) => `- 【${m.kind}】${m.title}：${m.content}`),
      };
    }
    case 'search':
      return { kind: 'search', ...searchAll(root, params.query, params) };
    default:
      throw new Error(`未知的查询类型：${kind}。可用：status / character / foreshadowing / chapter / setting / timeline / term / memory / search`);
  }
}
