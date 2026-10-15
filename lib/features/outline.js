/**
 * 大纲：总纲 / 卷纲 / 章纲的读写，以及正文落盘。
 *
 * 产品定位（PRD F3）：「大纲即法律」。
 * 章纲是写作的前置条件——没有章纲就不该动笔（由 context.js 的 blockers 强制）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside, chapterOutlineFileName, volumeFileName } from '../core/paths.js';
import { readText, writeTextAtomic, exists } from '../core/store.js';
import { readState, writeState } from '../core/state.js';
import { toInt, sanitizeFilename } from '../util.js';

/* ------------------------------------------------------------------ *
 * 总纲
 * ------------------------------------------------------------------ */

export function writeMasterOutline(root, text) {
  const target = inside(root, DIRS.outline, '总纲.md');
  writeTextAtomic(target, `${String(text).trim()}\n`);
  return { path: `${DIRS.outline}/总纲.md`.split(path.sep).join('/'), bytes: Buffer.byteLength(text, 'utf8') };
}

export function readMaster(root) {
  const target = inside(root, DIRS.outline, '总纲.md');
  return exists(target) ? readText(target) : null;
}

/* ------------------------------------------------------------------ *
 * 卷纲
 * ------------------------------------------------------------------ */

/** 写卷纲，并在 state.progress.volumes 里登记该卷。 */
export function writeVolumeOutline(root, volume, text, meta = {}) {
  const num = toInt(volume);
  if (num <= 0) throw new Error('卷号必须是正整数');
  const name = volumeFileName(num);
  const target = inside(root, DIRS.volumes, name);
  writeTextAtomic(target, `${String(text).trim()}\n`);

  const { value: state } = readState(root);
  const volumes = [...state.progress.volumes];
  const idx = volumes.findIndex((v) => toInt(v.volume) === num);
  const existing = idx >= 0 ? volumes[idx] : {};
  const record = {
    volume: num,
    title: meta.title ?? existing.title ?? '',
    chapterRange: meta.chapterRange ?? existing.chapterRange ?? '',
    status: meta.status ?? existing.status ?? 'planning',
  };
  if (idx >= 0) volumes[idx] = { ...existing, ...record };
  else volumes.push(record);
  volumes.sort((a, b) => toInt(a.volume) - toInt(b.volume));
  writeState(root, { ...state, progress: { ...state.progress, volumes } });

  return { path: `${DIRS.volumes}/${name}`.split(path.sep).join('/'), volume: num, registered: record };
}

export function readVolume(root, volume) {
  const target = inside(root, DIRS.volumes, volumeFileName(volume));
  return exists(target) ? readText(target) : null;
}

export function listVolumes(root) {
  const dir = inside(root, DIRS.volumes);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 章纲
 * ------------------------------------------------------------------ */

export function writeChapterOutline(root, chapter, text) {
  const num = toInt(chapter);
  if (num <= 0) throw new Error('章节号必须是正整数');
  const name = chapterOutlineFileName(num);
  const target = inside(root, DIRS.chapterOutlines, name);
  writeTextAtomic(target, `${String(text).trim()}\n`);
  return { path: `${DIRS.chapterOutlines}/${name}`.split(path.sep).join('/'), chapter: num };
}

export function readChapter(root, chapter) {
  const target = inside(root, DIRS.chapterOutlines, chapterOutlineFileName(chapter));
  return exists(target) ? readText(target) : null;
}

export function listChapterOutlines(root) {
  const dir = inside(root, DIRS.chapterOutlines);
  try {
    return fs.readdirSync(dir)
      .map((f) => /^第(\d+)章\.md$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 正文
 * ------------------------------------------------------------------ */

/** 保存正文。返回落盘路径。 */
export function writeChapterText(root, chapter, title, text) {
  const num = toInt(chapter);
  if (num <= 0) throw new Error('章节号必须是正整数');
  const safeTitle = sanitizeFilename(title ?? '', 40);
  const name = safeTitle
    ? `第${String(num).padStart(4, '0')}章-${safeTitle}.md`
    : `第${String(num).padStart(4, '0')}章.md`;
  const target = inside(root, DIRS.text, name);
  writeTextAtomic(target, `${String(text).trim()}\n`);
  return { path: `${DIRS.text}/${name}`.split(path.sep).join('/'), chapter: num, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 读正文（按章节号前缀查找）。 */
export function readChapterText(root, chapter) {
  const dir = inside(root, DIRS.text);
  const prefix = `第${String(toInt(chapter)).padStart(4, '0')}章`;
  try {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.md'));
    return hit ? { name: hit, text: readText(path.join(dir, hit)) } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 当日手记（无人值守日更的验收凭据）
 * ------------------------------------------------------------------ */

const NOTE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 取「今天」的本地日期（YYYY-MM-DD）。
 * 不能用 toISOString——它返回 UTC 日期，UTC+8 的凌晨会整体落到前一天。
 */
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 追加写当日手记：`手记/YYYY-MM-DD.md`。
 * - date 缺省取今天（服务器本地时区）；格式不符拒绝（防「章节标题里带 ../..」式逃逸）。
 * - 同日多次调用在文末追加，带分隔线；不同日期建新文件。
 * - 老书没有手记目录时自动创建（init 之前建的书）。
 */
export function writeNote(root, text, date) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('write_note 需要提供 text 内容');
  const day = date === undefined || date === null || String(date).trim() === ''
    ? todayLocal()
    : String(date).trim();
  if (!NOTE_DATE_RE.test(day)) throw new Error(`date 必须是 YYYY-MM-DD 格式，收到：${day}`);

  const dir = inside(root, DIRS.notes);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const target = path.join(dir, `${day}.md`);

  let prev = '';
  try { prev = exists(target) ? readText(target) : ''; } catch { prev = ''; }
  const block = prev.trim() ? `${prev.trim()}\n\n---\n\n${body}\n` : `${body}\n`;
  writeTextAtomic(target, block);
  return {
    path: `${DIRS.notes}/${day}.md`.split(path.sep).join('/'),
    date: day,
    appended: Boolean(prev.trim()),
    bytes: Buffer.byteLength(body, 'utf8'),
  };
}
