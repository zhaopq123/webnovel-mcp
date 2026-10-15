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
