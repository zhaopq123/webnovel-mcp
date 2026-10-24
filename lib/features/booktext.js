/**
 * 全书正文批量操作：导出 / 批量替换 / 清理同章重复文件。
 *
 * 三条边界：
 * 1. 只读写「正文/」下的章级文件与 .webnovel/ 机器态，不碰设定集/大纲；
 * 2. 批量替换默认 dry-run，且执行后逐章走 writeChapterText 的回读校验；
 * 3. prune 只移动、不删除，目标目录在 .webnovel/trash/ 下，可人工找回。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside, listChapterFiles, listChapterTextFiles, ensureDir } from '../core/paths.js';
import { exists } from '../core/store.js';
import { readIndex, writeIndex } from '../core/state.js';
import { countWords, toInt } from '../util.js';
import { readChapterText, writeChapterText, deriveTitleFromText } from './outline.js';

function pad4(n) {
  return String(Math.floor(Number(n))).padStart(4, '0');
}

function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function titleFromName(name) {
  const m = /^第\d+章-(.+)\.md$/.exec(String(name ?? ''));
  return m ? m[1] : '';
}

/** 去掉正文一级标题里的「第N章」前缀，避免导出标题重复。 */
function cleanTitle(title) {
  return String(title ?? '')
    .replace(/^第\s*(?:\d+|[一二三四五六七八九十百千零两]+)\s*章\s*[·:：\-—]?\s*/, '')
    .trim();
}

function indexTitle(index, chapter) {
  const entry = index.chapters.find((c) => toInt(c.chapter) === toInt(chapter));
  return String(entry?.title ?? '').trim();
}

function stripLeadingHeading(text) {
  return String(text ?? '').replace(/^\s*#\s+[^\n]*\n+/, '');
}

/** 解析要处理的章号：优先 range；缺省取正文目录里实际存在的章。 */
export function chaptersWithText(root, range = null) {
  const available = [...new Set(listChapterFiles(root)
    .map((f) => /^第(\d+)章/.exec(f.name))
    .filter(Boolean)
    .map((m) => Number(m[1])))].sort((a, b) => a - b);
  if (!range || range.length === 0) return { chapters: available, missing: [] };
  const availableSet = new Set(available);
  const missing = range.filter((n) => !availableSet.has(n));
  return { chapters: range.filter((n) => availableSet.has(n)), missing };
}

/**
 * 导出正文。format=txt|md|json；range 为章号数组（null=全部有正文的章）。
 * 返回 { format, chapters:[...], text, missing }。
 */
export function exportBook(root, { format = 'txt', range = null } = {}) {
  const fmt = String(format ?? 'txt').trim().toLowerCase();
  if (!['txt', 'md', 'json'].includes(fmt)) throw new Error(`format 只认 txt / md / json，收到「${format}」`);

  const { value: index } = readIndex(root);
  const { chapters: nums, missing } = chaptersWithText(root, range);
  const chapters = [];
  for (const num of nums) {
    const found = readChapterText(root, num);
    if (!found) continue;
    const title = cleanTitle(indexTitle(index, num) || deriveTitleFromText(found.text) || titleFromName(found.name)) || `第${num}章`;
    chapters.push({
      chapter: num,
      title,
      file: found.file,
      mtime: found.mtime,
      words: countWords(found.text),
      text: found.text,
    });
  }

  if (fmt === 'json') {
    return {
      format: fmt,
      chapters,
      missing,
      text: JSON.stringify({ chapters, missing }, null, 2),
    };
  }

  const blocks = chapters.map((c) => {
    const body = stripLeadingHeading(c.text).trimEnd();
    if (fmt === 'md') {
      return `## 第 ${c.chapter} 章 ${c.title}\n\n${body}\n\n---\n`;
    }
    return `第${c.chapter}章 ${c.title}\n\n${body}\n`;
  });
  return { format: fmt, chapters, missing, text: blocks.join('\n\n') };
}

/** 字面量替换（不做正则，避免作者写的 `$&`/括号被解释）。 */
function countOccurrences(text, find) {
  if (!find) return 0;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const at = text.indexOf(find, cursor);
    if (at < 0) break;
    count += 1;
    cursor = at + find.length;
  }
  return count;
}

function replaceLiteral(text, find, replace) {
  return text.split(find).join(replace);
}

/**
 * 全库批量替换。默认 dryRun=true（只报命中，不落盘）。
 * 返回 { dryRun, totalHits, chapters:[{chapter,file,hits,history?}], missing }。
 */
export function replaceAllInBook(root, { find, replace = '', range = null, dryRun = true } = {}) {
  const needle = String(find ?? '');
  if (!needle) throw new Error('replace_all 需要 find（要替换的原文片段）');
  const to = String(replace ?? '');
  const { chapters: nums, missing } = chaptersWithText(root, range);
  const hits = [];
  let totalHits = 0;

  for (const num of nums) {
    const found = readChapterText(root, num);
    if (!found) continue;
    const count = countOccurrences(found.text, needle);
    if (count === 0) continue;
    const row = { chapter: num, file: found.file, hits: count };
    if (!dryRun) {
      const next = replaceLiteral(found.text, needle, to);
      if (next.trim() === '' && found.text.trim() !== '') {
        throw new Error(`第 ${num} 章替换后正文会变空（find 命中整章）——已拒绝。若确实要清空，请先手工处理并保留备份。`);
      }
      const written = writeChapterText(root, num, undefined, next);
      row.history = written.history;
      row.file = written.path;
      row.mtime = written.mtime;
    }
    totalHits += count;
    hits.push(row);
  }
  return { dryRun, find: needle, replace: to, totalHits, chapters: hits, missing };
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function uniqueDir(parent, base) {
  let dir = path.join(parent, base);
  for (let n = 1; exists(dir); n += 1) dir = path.join(parent, `${base}-${n}`);
  return dir;
}

/**
 * 清理同章重复正文：保留 read 解析器当前选中的那一份（mtime 最新），
 * 其余移动到 .webnovel/trash/正文-prune-<时间戳>/。
 *
 * dryRun 默认 true；confirm=true 才移动。移动后把 index.chapters[ch].file
 * 指向保留文件（否则 doctor 会报 file-missing）。
 */
export function pruneDuplicateTexts(root, { confirm = false, chapters = null } = {}) {
  const groups = new Map();
  for (const f of listChapterFiles(root)) {
    const m = /^第(\d+)章/.exec(f.name);
    if (!m) continue;
    const num = Number(m[1]);
    if (chapters && chapters.length > 0 && !chapters.includes(num)) continue;
    if (!groups.has(num)) groups.set(num, []);
    groups.get(num).push(f.name);
  }

  const { value: index } = readIndex(root);
  const byChapter = new Map(index.chapters.map((c) => [toInt(c.chapter), c]));
  const plan = [];
  for (const num of [...groups.keys()].sort((a, b) => a - b)) {
    const all = listChapterTextFiles(root, num);
    if (all.length <= 1) continue;
    const keep = all[0];
    const move = all.slice(1);
    const entry = byChapter.get(num);
    const keepRel = `${DIRS.text}/${keep.name}`.split(path.sep).join('/');
    plan.push({
      chapter: num,
      keep: { name: keep.name, mtime: new Date(keep.mtimeMs).toISOString(), bytes: fs.statSync(keep.abs).size },
      move: move.map((f) => ({
        name: f.name,
        mtime: new Date(f.mtimeMs).toISOString(),
        bytes: fs.statSync(f.abs).size,
      })),
      indexFile: entry?.file ?? null,
      indexWillUpdate: Boolean(entry && entry.file && entry.file !== keepRel),
      keepRel,
    });
  }

  if (!confirm) return { dryRun: true, chapters: plan, movedCount: 0, trashDir: null };
  if (plan.length === 0) return { dryRun: false, chapters: [], movedCount: 0, trashDir: null };

  const trashDir = uniqueDir(inside(root, DIRS.trash), `正文-prune-${stamp()}`);
  ensureDir(trashDir);
  // 先把索引指到保留文件（它一定存在），再移动其余文件：
  // 即使移动到一半失败，索引也不会指向已移走的路径。
  const indexChanged = [];
  for (const row of plan) {
    const entry = byChapter.get(row.chapter);
    if (entry && row.indexWillUpdate) {
      entry.file = row.keepRel;
      indexChanged.push(row.chapter);
    }
  }
  if (indexChanged.length > 0) writeIndex(root, index);

  let movedCount = 0;
  for (const row of plan) {
    for (const item of row.move) {
      moveFile(inside(root, DIRS.text, item.name), path.join(trashDir, item.name));
      movedCount += 1;
    }
  }
  return {
    dryRun: false,
    chapters: plan,
    movedCount,
    trashDir: path.relative(root, trashDir).split(path.sep).join('/'),
    indexUpdated: indexChanged,
  };
}
