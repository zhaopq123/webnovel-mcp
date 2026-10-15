/**
 * 领域状态：state / index / foreshadowing / memory 的读写与领域操作。
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
