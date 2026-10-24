/**
 * 单章正文版本历史。
 *
 * 为什么放 .webnovel/history/ 而不是正文旁：正文目录只放「当前稿」，
 * 导出/上架/查重都按正文目录取文件；历史稿混进去会重新制造「同章多文件」。
 *
 * 口径：
 * - 每次 write_text 覆盖前，若旧稿与新稿不同，先把旧稿存一版；
 * - 每章最多保留最近 5 版（超出的从最旧删，只删本模块自己写的文件）；
 * - version 按「从旧到新」编号 1..N，read/rollback 用的就是这个号；
 * - 文件名带序号与本地时间，序号在每次写入时重新排（最多 5 个，成本可忽略）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside, ensureDir } from '../core/paths.js';
import { exists, readText, writeTextAtomic } from '../core/store.js';

export const HISTORY_KEEP = 5;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

function localStamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
    + `-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function dirFor(root, chapter) {
  return inside(root, DIRS.history, `第${pad4(Number(chapter))}章`);
}

/** 列出某章历史版本（从旧到新）。version 即返回数组下标 + 1。 */
export function listVersions(root, chapter) {
  const dir = dirFor(root, chapter);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^v\d+-.+\.md$/.test(n));
  } catch {
    return [];
  }
  return names
    .sort((a, b) => Number(/^v(\d+)/.exec(a)[1]) - Number(/^v(\d+)/.exec(b)[1]))
    .map((name, i) => {
      const abs = path.join(dir, name);
      let mtimeMs = 0;
      let bytes = 0;
      try {
        const st = fs.statSync(abs);
        mtimeMs = st.mtimeMs;
        bytes = st.size;
      } catch { /* 竞态删除 */ }
      return {
        version: i + 1,
        name,
        mtimeMs,
        mtime: mtimeMs ? new Date(mtimeMs).toISOString() : null,
        bytes,
      };
    });
}

/** 读指定历史版本；version 从 1 开始（1 = 最旧）。 */
export function readVersion(root, chapter, version) {
  const list = listVersions(root, chapter);
  const num = Number(version);
  if (!Number.isInteger(num) || num < 1 || num > list.length) {
    throw new Error(`第 ${chapter} 章没有第 ${version} 版历史（现有 ${list.length} 版）。可用：${list.length ? `1-${list.length}` : '无'}`);
  }
  const hit = list[num - 1];
  return { ...hit, text: readText(path.join(dirFor(root, chapter), hit.name)) ?? '' };
}

/** 删除超过 keep 的最旧版本；只动 history 目录里的 vNNNN-*.md。 */
export function pruneVersions(root, chapter, keep = HISTORY_KEEP) {
  const dir = dirFor(root, chapter);
  const list = listVersions(root, chapter);
  const removed = [];
  for (const item of list.slice(0, Math.max(0, list.length - keep))) {
    try {
      fs.unlinkSync(path.join(dir, item.name));
      removed.push(item.name);
    } catch { /* 删不掉不影响主流程 */ }
  }
  return removed;
}

/**
 * 覆盖前存一版旧稿。返回 { saved, name, mtime, removed }；正文为空/不存在不存。
 * activeName 只用于报错定位，不参与文件名（文件名统一 vNNNN-时间.md）。
 */
export function snapshotChapter(root, chapter, text, activeName = '') {
  if (typeof text !== 'string' || text.trim() === '') return { saved: false, reason: '空稿不存' };
  const dir = dirFor(root, chapter);
  ensureDir(dir);
  const list = listVersions(root, chapter);
  const nextSeq = list.length > 0 ? Number(/^v(\d+)/.exec(list[list.length - 1].name)[1]) + 1 : 1;
  const name = `v${pad4(nextSeq)}-${localStamp()}.md`;
  const target = inside(root, DIRS.history, `第${pad4(Number(chapter))}章`, name);
  writeTextAtomic(target, String(text).endsWith('\n') ? String(text) : `${String(text)}\n`);
  const removed = pruneVersions(root, chapter, HISTORY_KEEP);
  const st = fs.statSync(target);
  return {
    saved: true,
    name,
    activeName: activeName || null,
    mtime: st.mtime.toISOString(),
    removed,
  };
}

/** 某章是否有历史（供 read/rollback 报错前判断）。 */
export function hasHistory(root, chapter) {
  return listVersions(root, chapter).length > 0;
}

/** 历史目录是否存在（doctor 可选检查用）。 */
export function historyExists(root, chapter) {
  return exists(dirFor(root, chapter));
}
