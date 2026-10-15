/**
 * 长期记忆：把有效写法沉淀下来，跨章复用。
 *
 * 产品定位（PRD F8）：参考实现的 `/webnovel-learn`。
 * 与「状态」的区别：状态记「发生了什么」（客观事实），记忆记「怎么写更好」（经验）。
 */
import path from 'node:path';
import { FILES } from '../core/paths.js';
import { withProjectLock } from '../core/store.js';
import { readMemory, writeMemory, addMemoryEntry, searchMemory } from '../core/state.js';
import { toInt, isoNow } from '../util.js';

/** 允许的记忆类型。 */
export const MEMORY_KINDS = ['style', 'technique', 'setting', 'feedback', 'character'];

export const MEMORY_KIND_LABEL = {
  style: '文风', technique: '写法', setting: '设定约定', feedback: '读者/编辑反馈', character: '人物把握',
};

const KIND_LABEL = MEMORY_KIND_LABEL;

/**
 * 写一条记忆。
 * @param {object} entry { kind, title, content, tags, chapter }
 */
export async function learnMemory(root, entry = {}) {
  const kind = String(entry.kind ?? 'technique').trim();
  if (!MEMORY_KINDS.includes(kind)) {
    throw new Error(`未知的记忆类型「${kind}」。可用：${MEMORY_KINDS.join(' / ')}`);
  }
  const title = String(entry.title ?? '').trim();
  if (!title) throw new Error('记忆需要 title（一句话概括这条经验）');
  const content = String(entry.content ?? '').trim();
  if (!content) throw new Error('记忆需要 content（具体怎么做）');

  return withProjectLock(root, () => {
    const { value: memory } = readMemory(root);
    const next = addMemoryEntry(memory, {
      kind,
      title,
      content,
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
      chapter: entry.chapter === undefined || entry.chapter === null ? null : toInt(entry.chapter),
      createdAt: isoNow(),
    });
    writeMemory(root, next);
    const saved = next.entries.find((e) => e.title === title && e.kind === kind);
    return {
      id: saved?.id ?? null,
      kind,
      kindLabel: KIND_LABEL[kind] ?? kind,
      title,
      total: next.entries.length,
      path: FILES.memory.split(path.sep).join('/'),
    };
  });
}

/** 检索记忆。 */
export function recallMemory(root, { query = '', tags = [], limit = 20 } = {}) {
  const { value: memory } = readMemory(root);
  const hits = searchMemory(memory, query, Array.isArray(tags) ? tags : [], toInt(limit, 20));
  return {
    total: memory.entries.length,
    hits,
    lines: memory.entries.length === 0
      ? ['还没有沉淀任何写作经验。写完一章后，把有效的写法用 webnovel_memory action=learn 记下来。']
      : hits.length === 0
        ? [`共 ${memory.entries.length} 条记忆，但没有匹配「${query}」的。`]
        : hits.map((m) => `- 【${KIND_LABEL[m.kind] ?? m.kind}】${m.title}：${m.content}${m.chapter ? `（第 ${m.chapter} 章）` : ''}`),
  };
}

/** 记忆统计。 */
export function memoryStats(root) {
  const { value: memory } = readMemory(root);
  const byKind = {};
  for (const e of memory.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return { total: memory.entries.length, byKind };
}
