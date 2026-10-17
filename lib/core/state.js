/**
 * 领域状态：state / index / foreshadowing / terms / memory 的读写与领域操作。
 *
 * 约定：读用 read*（返回 { value, warnings }），写用 write*（原子写）。
 * 所有写操作假定调用方已持有项目锁（见 store.withProjectLock）。
 */
import path from 'node:path';
import { FILES, DIRS, inside } from './paths.js';
import { SCHEMA_VERSION, readJsonMigrated, writeJsonAtomic, readText, writeTextAtomic } from './store.js';
import { isoNow, deepMerge, mergeArray, uniqueBy, toInt } from '../util.js';

/* ------------------------------------------------------------------ *
 * 默认值（也是 schema 的活文档）
 * ------------------------------------------------------------------ */

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    progress: {
      currentChapter: 0,
      totalWords: 0,
      currentVolume: 1,
      volumes: [],
      lastUpdated: isoNow(),
    },
    protagonist: {
      name: '',
      power: { realm: '', bottleneck: '' },
      location: '',
      condition: '',
      goldenFinger: { name: '', level: 0, note: '' },
    },
    characters: {},
    world: { powerSystem: [], factions: [], locations: [] },
    strand: {
      lastQuest: 0,
      lastFire: 0,
      lastConstellation: 0,
      dominant: 'quest',
      sinceSwitch: 0,
      history: [],
    },
    timeline: [],
    warnings: [],
  };
}

export function defaultIndex() {
  return { schemaVersion: SCHEMA_VERSION, chapters: [] };
}

export function defaultForeshadowing() {
  return { schemaVersion: SCHEMA_VERSION, items: [] };
}

/**
 * 专名账本（铁律 1「名词锁定」的落点）。
 * 条目形状：{ name, type, aliases[], firstChapter, note }
 * name 就是主键（不像伏笔那样发内部序号 id）——这样 doctor 从提交链重放
 * 出来的结果与实时提交逐字段一致，不会因为「重放顺序不同」产生 id 漂移。
 * 同理**不存登记时间**：重放拿不到当时的墙上时钟，一旦把时间写进条目，
 * doctor 的「重放 == 现役」对账就永远对不上（每条都变成手工编辑）。
 */
export function defaultTerms() {
  return { schemaVersion: SCHEMA_VERSION, items: [] };
}

export function defaultMemory() {
  return { schemaVersion: SCHEMA_VERSION, entries: [] };
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

export function readProject(root) {
  return readJsonMigrated(path.join(root, FILES.project), null, 'project.json');
}

export function readState(root) {
  const { value, warnings } = readJsonMigrated(path.join(root, FILES.state), defaultState(), 'state.json');
  return { value: normalizeState(value), warnings };
}

export function readIndex(root) {
  const { value, warnings } = readJsonMigrated(path.join(root, FILES.index), defaultIndex(), 'index.json');
  return { value: normalizeIndex(value), warnings };
}

export function readForeshadowing(root) {
  const { value, warnings } = readJsonMigrated(path.join(root, FILES.foreshadowing), defaultForeshadowing(), 'foreshadowing.json');
  return { value: normalizeForeshadowing(value), warnings };
}

export function readTerms(root) {
  const { value, warnings } = readJsonMigrated(path.join(root, FILES.terms), defaultTerms(), 'terms.json');
  return { value: normalizeTerms(value), warnings };
}

export function readMemory(root) {
  const { value, warnings } = readJsonMigrated(path.join(root, FILES.memory), defaultMemory(), 'memory.json');
  return { value: normalizeMemory(value), warnings };
}

/* ------------------------------------------------------------------ *
 * 归一化：容忍手改文件造成的字段缺失
 * ------------------------------------------------------------------ */

export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const merged = deepMerge(base, raw);
  merged.progress = deepMerge(base.progress, raw.progress ?? {});
  merged.progress.volumes = Array.isArray(raw.progress?.volumes) ? raw.progress.volumes : [];
  merged.protagonist = deepMerge(base.protagonist, raw.protagonist ?? {});
  merged.world = deepMerge(base.world, raw.world ?? {});
  for (const key of ['powerSystem', 'factions', 'locations']) {
    merged.world[key] = Array.isArray(raw.world?.[key]) ? raw.world[key] : [];
  }
  merged.characters = raw.characters && typeof raw.characters === 'object' && !Array.isArray(raw.characters)
    ? raw.characters : {};
  merged.strand = deepMerge(base.strand, raw.strand ?? {});
  merged.strand.history = Array.isArray(raw.strand?.history) ? raw.strand.history : [];
  merged.timeline = Array.isArray(raw.timeline) ? raw.timeline : [];
  merged.warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  return merged;
}

export function normalizeIndex(raw) {
  const base = defaultIndex();
  if (!raw || typeof raw !== 'object') return base;
  return {
    schemaVersion: SCHEMA_VERSION,
    chapters: Array.isArray(raw.chapters) ? raw.chapters.filter((c) => c && typeof c === 'object') : [],
  };
}

export function normalizeForeshadowing(raw) {
  const base = defaultForeshadowing();
  if (!raw || typeof raw !== 'object') return base;
  return {
    schemaVersion: SCHEMA_VERSION,
    items: Array.isArray(raw.items) ? raw.items.filter((i) => i && typeof i === 'object') : [],
  };
}

/**
 * 专名账本归一化：名字是主键，没名字的条目直接丢（一条空名会让「是否已登记」判断失真）。
 * type 的合法化交给 features/terms.js（core 不认业务词表，避免 core→feature 反向依赖）。
 */
export function normalizeTerms(raw) {
  if (!raw || typeof raw !== 'object') return defaultTerms();
  const byName = new Map();
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? '').trim();
    if (!name) continue;
    const type = String(item.type ?? 'other').trim() || 'other';
    const aliases = (Array.isArray(item.aliases) ? item.aliases : [])
      .map((a) => String(a ?? '').trim()).filter((a) => a && a !== name);
    const firstChapter = item.firstChapter === null || item.firstChapter === undefined ? null : toInt(item.firstChapter);
    const note = String(item.note ?? '');
    const prev = byName.get(name);
    if (!prev) {
      byName.set(name, { name, type, aliases, firstChapter, note });
      continue;
    }
    // 同名条目只可能来自手工编辑（upsert 走的是「名字即主键」的合并）。合并口径：
    // 标量字段后写的说话，但两处例外——别名取并集（别吃掉作者写过的另一种写法）、
    // 首现章取更早的那个（重复条目不许把首现章往后推，那是篡改事实）。
    prev.type = type;
    prev.aliases = [...new Set([...prev.aliases, ...aliases])];
    if (firstChapter !== null) {
      prev.firstChapter = prev.firstChapter === null ? firstChapter : Math.min(prev.firstChapter, firstChapter);
    }
    if (note) prev.note = note;
  }
  return { schemaVersion: SCHEMA_VERSION, items: [...byName.values()] };
}

export function normalizeMemory(raw) {
  const base = defaultMemory();
  if (!raw || typeof raw !== 'object') return base;
  return {
    schemaVersion: SCHEMA_VERSION,
    entries: Array.isArray(raw.entries) ? raw.entries.filter((e) => e && typeof e === 'object') : [],
  };
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

export function writeProject(root, project) {
  return writeJsonAtomic(path.join(root, FILES.project), { ...project, schemaVersion: SCHEMA_VERSION, updatedAt: isoNow() });
}

export function writeState(root, state) {
  const next = { ...state, schemaVersion: SCHEMA_VERSION };
  next.progress = { ...next.progress, lastUpdated: isoNow() };
  writeJsonAtomic(path.join(root, FILES.state), next);
  return next;
}

export function writeIndex(root, index) {
  const next = { ...index, schemaVersion: SCHEMA_VERSION, chapters: sortChapters(index.chapters) };
  writeJsonAtomic(path.join(root, FILES.index), next);
  return next;
}

export function writeForeshadowing(root, ledger) {
  writeJsonAtomic(path.join(root, FILES.foreshadowing), { ...ledger, schemaVersion: SCHEMA_VERSION });
  return ledger;
}

export function writeTerms(root, terms) {
  writeJsonAtomic(path.join(root, FILES.terms), { ...terms, schemaVersion: SCHEMA_VERSION });
  return terms;
}

export function writeMemory(root, memory) {
  writeJsonAtomic(path.join(root, FILES.memory), { ...memory, schemaVersion: SCHEMA_VERSION });
  return memory;
}

export function sortChapters(chapters) {
  return [...chapters].sort((a, b) => toInt(a.chapter) - toInt(b.chapter));
}

/* ------------------------------------------------------------------ *
 * 摘要文件（正文旁的人类可读摘要）
 * ------------------------------------------------------------------ */

export function readSummary(root, chapter) {
  const name = `ch${String(toInt(chapter)).padStart(4, '0')}.md`;
  return readText(path.join(root, DIRS.summaries, name));
}

export function writeSummary(root, chapter, markdown) {
  const name = `ch${String(toInt(chapter)).padStart(4, '0')}.md`;
  const target = inside(root, DIRS.summaries, name);
  writeTextAtomic(target, `${String(markdown).trim()}\n`);
  return target;
}

/* ------------------------------------------------------------------ *
 * 领域操作
 * ------------------------------------------------------------------ */

/** 章节索引：按章号 upsert。 */
export function upsertChapter(index, entry) {
  const chapter = toInt(entry.chapter);
  const others = index.chapters.filter((c) => toInt(c.chapter) !== chapter);
  return { ...index, chapters: sortChapters([...others, { ...entry, chapter }]) };
}

export function findChapter(index, chapter) {
  const num = toInt(chapter);
  return index.chapters.find((c) => toInt(c.chapter) === num) ?? null;
}

/** 最近 n 章（按章号倒序）。 */
export function recentChapters(index, n, before) {
  const limit = toInt(before, Number.MAX_SAFE_INTEGER);
  return sortChapters(index.chapters)
    .filter((c) => toInt(c.chapter) < limit)
    .slice(-Math.max(0, toInt(n)))
    .reverse();
}

/** 伏笔：按 id 或名称 upsert。 */
export function upsertForeshadowing(ledger, item) {
  const items = [...ledger.items];
  const idx = items.findIndex((i) => (item.id && i.id === item.id) || (item.name && i.name === item.name));
  if (idx >= 0) {
    items[idx] = deepMerge(items[idx], item);
  } else {
    items.push({ status: 'open', importance: 'normal', paidChapter: null, ...item });
  }
  return { ...ledger, items };
}

/** 生成下一个伏笔 id。 */
export function nextForeshadowingId(ledger) {
  const used = ledger.items
    .map((i) => /^fs-(\d+)$/.exec(String(i.id ?? '')))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const next = used.length > 0 ? Math.max(...used) + 1 : 1;
  return `fs-${String(next).padStart(3, '0')}`;
}

/** 未回收伏笔（含超期判定）。 */
export function openForeshadowing(ledger, currentChapter) {
  const now = toInt(currentChapter);
  return ledger.items
    .filter((i) => i.status === 'open')
    .map((i) => {
      const planned = i.plannedPayoff === null || i.plannedPayoff === undefined ? null : toInt(i.plannedPayoff);
      const overdue = planned !== null && planned > 0 && now >= planned;
      const aging = planned !== null && planned > 0 && !overdue && now >= planned - 10;
      return { ...i, overdue, aging, chaptersOpen: now - toInt(i.plantedChapter, now) };
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.importance === 'high') - Number(a.importance === 'high'));
}

/* ------------------------------------------------------------------ *
 * 专名账本（铁律 1「名词锁定」）
 * ------------------------------------------------------------------ */

/**
 * 登记或合并一个专名。主键是 name，aliases 也算「这个写法已经被占用」。
 *
 * 命中已有条目时：
 * - firstChapter 不动（「哪一章首次出现」是事实，重复登记不该改写它）；
 * - type 只允许从 other 升级（作者显式分类优先于启发式的兜底值）；
 * - note 传了才覆盖。
 * 条目里刻意不存时间戳：doctor 从提交链重放时拿不到「当时是几点」，
 * 存了就会让「现役账本 vs 重放账本」永远对不上账（体检误报）。审计时间看 commits/。
 */
export function upsertTerm(terms, term = {}) {
  const name = String(term.name ?? '').trim();
  if (!name) return terms;
  const aliases = (Array.isArray(term.aliases) ? term.aliases : [])
    .map((a) => String(a ?? '').trim())
    .filter((a) => a && a !== name);
  const items = [...terms.items];
  const wanted = new Set([name, ...aliases]);
  const idx = items.findIndex((i) => wanted.has(i.name) || i.aliases.some((a) => wanted.has(a)));
  if (idx >= 0) {
    const prev = items[idx];
    const merged = {
      ...prev,
      type: term.type && prev.type === 'other' ? String(term.type) : prev.type,
      note: term.note ? String(term.note) : prev.note,
      aliases: [...new Set([...prev.aliases, ...aliases.filter((a) => a !== prev.name)])],
    };
    if (name !== prev.name && !merged.aliases.includes(name)) merged.aliases.push(name);
    items[idx] = merged;
  } else {
    items.push({
      name,
      type: String(term.type ?? 'other').trim() || 'other',
      aliases,
      firstChapter: term.firstChapter === null || term.firstChapter === undefined ? null : toInt(term.firstChapter),
      note: String(term.note ?? ''),
    });
  }
  return { ...terms, items };
}

/** 按名字或别名精确命中条目；查不到返回 null。 */
export function findTerm(terms, key) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  return terms.items.find((i) => i.name === k || i.aliases.includes(k)) ?? null;
}

/** 账本里出现过的全部写法（名字 + 别名）。用于「这个词登记过没有」的判断。 */
export function termKeys(terms) {
  const keys = new Set();
  for (const item of terms.items) {
    keys.add(item.name);
    for (const alias of item.aliases) keys.add(alias);
  }
  return keys;
}

/** 专名检索：类别过滤 + 关键词（名字/别名/备注）。账本按登记顺序返回。 */
export function searchTerms(terms, query, type = null, limit = 60) {
  const q = String(query ?? '').trim().toLowerCase();
  const kind = type ? String(type) : null;
  let hits = terms.items;
  if (kind) hits = hits.filter((i) => i.type === kind);
  if (q) {
    hits = hits.filter((i) => [i.name, i.note, ...i.aliases].join(' ').toLowerCase().includes(q));
  }
  return hits.slice(0, Math.max(1, toInt(limit)));
}

/** 长期记忆：追加（按 title 去重，同题更新）。 */
export function addMemoryEntry(memory, entry) {
  const entries = [...memory.entries];
  const idx = entries.findIndex((e) => e.title === entry.title && e.kind === entry.kind);
  const record = { id: `m-${String(entries.length + 1).padStart(3, '0')}`, createdAt: isoNow(), tags: [], ...entry };
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...record, id: entries[idx].id };
  } else {
    entries.push(record);
  }
  return { ...memory, entries };
}

/** 按关键词/标签检索长期记忆。 */
export function searchMemory(memory, query, tags = [], limit = 20) {
  const q = String(query ?? '').trim().toLowerCase();
  let hits = memory.entries;
  if (tags.length > 0) {
    hits = hits.filter((e) => tags.some((t) => (e.tags ?? []).includes(t)));
  }
  if (q) {
    hits = hits.filter((e) => [e.title, e.content, ...(e.tags ?? [])].join(' ').toLowerCase().includes(q));
  }
  return hits.slice(-limit).reverse();
}

/** 应用主角增量（支持 'power.realm' 这类点号路径）。 */
export function applyProtagonistPatch(state, patch) {
  if (!patch || typeof patch !== 'object') return state;
  const protagonist = deepMerge(state.protagonist, patch);
  if (patch.power) protagonist.power = deepMerge(state.protagonist.power, patch.power);
  if (patch.goldenFinger) protagonist.goldenFinger = deepMerge(state.protagonist.goldenFinger, patch.goldenFinger);
  return { ...state, protagonist };
}

/** 应用角色增量（角色卡 upsert）。 */
export function applyCharacterPatches(state, patches, currentChapter = null) {
  if (!Array.isArray(patches) || patches.length === 0) return state;
  const characters = { ...state.characters };
  const chapter = Number.isFinite(Number(currentChapter)) ? Number(currentChapter) : null;
  for (const { name, patch } of patches) {
    if (!name) continue;
    const existed = characters[name];
    const merged = deepMerge(existed ?? {
      role: '', realm: '', location: '', relation: '', firstChapter: null, lastChapter: null, notes: '',
    }, patch ?? {});
    // 首次出场/最后出场系统自己知道：不传就按当前章自动填，省得作者手工维护
    if (chapter !== null) {
      if (merged.firstChapter === null || merged.firstChapter === undefined || !existed) {
        merged.firstChapter = merged.firstChapter ?? chapter;
      }
      if (patch?.lastChapter === undefined) merged.lastChapter = chapter;
    }
    characters[name] = merged;
  }
  return { ...state, characters };
}

/** 应用世界设定增量（数组累积去重）。 */
export function applyWorldPatch(state, patch) {
  if (!patch || typeof patch !== 'object') return state;
  const world = { ...state.world };
  for (const key of ['powerSystem', 'factions', 'locations']) {
    if (Array.isArray(patch[key])) world[key] = mergeArray(world[key], patch[key]);
  }
  return { ...state, world };
}

/** 追加时间线条目（同章覆盖）。 */
export function appendTimeline(state, entry) {
  if (!entry || typeof entry !== 'object') return state;
  const chapter = toInt(entry.chapter);
  const timeline = state.timeline.filter((t) => toInt(t.chapter) !== chapter);
  timeline.push({ ...entry, chapter });
  timeline.sort((a, b) => toInt(a.chapter) - toInt(b.chapter));
  return { ...state, timeline };
}

/**
 * 更新三线状态：记录本章属于哪条线，维护断档计数。
 * 线名：quest（主线）/ fire（感情线）/ constellation（世界观）。
 */
export function applyStrand(state, chapter, strand) {
  const key = { quest: 'lastQuest', fire: 'lastFire', constellation: 'lastConstellation' }[strand];
  if (!key) return state;
  const num = toInt(chapter);
  const prev = state.strand;
  const strandState = { ...prev, [key]: num };
  // 首次记录或换线都从 0 起算；同线才累加。
  // 已记录过同一章（同章重提）时不重复累加——保证与 doctor 重放结果一致。
  const alreadyRecorded = (prev.history ?? []).some((h) => toInt(h.chapter) === num);
  const isFirstRecord = (prev.history ?? []).length === 0;
  const changed = prev.dominant !== strand;
  strandState.dominant = strand;
  strandState.sinceSwitch = (changed || isFirstRecord)
    ? 0
    : (alreadyRecorded ? toInt(prev.sinceSwitch) : toInt(prev.sinceSwitch) + 1);
  strandState.history = uniqueBy(
    [...(prev.history ?? []).filter((h) => toInt(h.chapter) !== num), { chapter: num, strand }],
    (h) => toInt(h.chapter),
  ).sort((a, b) => toInt(a.chapter) - toInt(b.chapter));
  return { ...state, strand: strandState };
}

/** 未出场过久的角色（用于任务书提示）。 */
export function staleCharacters(state, currentChapter, threshold = 30) {
  const now = toInt(currentChapter);
  return Object.entries(state.characters)
    .map(([name, card]) => ({ name, ...card }))
    .filter((c) => c.lastChapter !== null && c.lastChapter !== undefined && now - toInt(c.lastChapter) >= threshold)
    .sort((a, b) => toInt(a.lastChapter) - toInt(b.lastChapter));
}

/** 最近出场角色。 */
export function recentCharacters(state, currentChapter, window = 15) {
  const now = toInt(currentChapter);
  return Object.entries(state.characters)
    .map(([name, card]) => ({ name, ...card }))
    .filter((c) => c.lastChapter !== null && c.lastChapter !== undefined && now - toInt(c.lastChapter) <= window)
    .sort((a, b) => toInt(b.lastChapter) - toInt(a.lastChapter));
}
