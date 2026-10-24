/**
 * 大纲：总纲 / 卷纲 / 章纲的读写，以及正文落盘。
 *
 * 产品定位（PRD F3）：「大纲即法律」。
 * 章纲是写作的前置条件——没有章纲就不该动笔（由 context.js 的 blockers 强制）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside, chapterOutlineFileName, volumeFileName, chapterFileName, listChapterTextFiles, findChapterFile } from '../core/paths.js';
import { readText, writeTextAtomic, exists } from '../core/store.js';
import { readState, writeState, readIndex, writeIndex } from '../core/state.js';
import { toInt, sanitizeFilename } from '../util.js';
import { listVersions, readVersion, snapshotChapter } from './history.js';

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

/** 从正文一级标题（`# xxx`）提取章节标题；没有则返回空串。 */
export function deriveTitleFromText(text) {
  const m = String(text ?? '').match(/^#\s*(.+?)\s*$/m);
  return m ? m[1].trim() : '';
}

/** 标题归一化：去章号前缀、书名号/引号/空白/常见分隔符，用于撞车判断。 */
function normalizeTitle(title) {
  return String(title ?? '')
    .replace(/^第\s*(?:\d+|[一二三四五六七八九十百千零两]+)\s*章\s*[·:：\-—]?\s*/, '')
    .replace(/[《》〈〉「」『』“”‘’"'·:：\-—_\s]/g, '')
    .trim();
}

/** 全库标题撞车检查（同一章除外）。返回 [{chapter,title}]。 */
function titleCollisions(root, chapter, title) {
  const key = normalizeTitle(title);
  if (!key) return [];
  const { value: index } = readIndex(root);
  return index.chapters
    .filter((c) => toInt(c.chapter) !== toInt(chapter) && normalizeTitle(c.title) === key)
    .map((c) => ({ chapter: toInt(c.chapter), title: String(c.title ?? '') }));
}

/**
 * 保存正文。返回落盘路径。
 *
 * 硬约束（1.8.2 起，1.9.0 补历史与标题撞车）：
 * 1. **一章只认一个文件**：该章已有正文文件时，覆盖「最新那一份」，不再按新标题
 *    另建文件。旧实现每次标题变化都新建一个，读取却按 readdir 顺序取第一个，
 *    导致写入成功但读回旧文、commit 字数也按旧文统计。
 * 2. **写后逐字回读**：写成功不等于读得到；回读不一致直接报错，不再静默成功。
 * 3. **覆盖前存历史**：旧稿进 .webnovel/history/第NNNN章/，最多 5 版，可 rollback。
 */
export function writeChapterText(root, chapter, title, text) {
  const num = toInt(chapter);
  if (num <= 0) throw new Error('章节号必须是正整数');
  const rawTitle = String(title ?? '').trim() || deriveTitleFromText(text);
  const safeTitle = rawTitle ? sanitizeFilename(rawTitle, 40) : '';
  const body = `${String(text).trim()}\n`;

  const existing = listChapterTextFiles(root, num);
  const targetName = existing.length > 0 ? existing[0].name : chapterFileName(num, safeTitle);
  const target = inside(root, DIRS.text, targetName);

  // 覆盖前留旧稿：内容相同不重复存，避免把历史刷成一堆同文版本。
  let history = { saved: false };
  const prevText = exists(target) ? readText(target) : null;
  if (prevText !== null && prevText !== body && prevText.trim() !== '') {
    history = snapshotChapter(root, num, prevText, targetName);
  }

  writeTextAtomic(target, body);

  // 逐字回读：文件层没落盘、或同章解析仍指向别的文件，都必须在这里暴露。
  let finalTarget = target;
  let finalName = targetName;
  let readBack = readText(target);
  if (readBack !== body) {
    throw new Error(
      `正文写入校验失败：已写入 ${targetName}，但回读内容不一致（期望 ${Buffer.byteLength(body, 'utf8')} 字节，`
      + `实际 ${readBack === null ? '文件不存在' : `${Buffer.byteLength(readBack, 'utf8')} 字节`}）。`
      + '请检查磁盘空间/权限后重试。');
  }

  // 改标题走「重命名」，不再按新标题另建：文件名与当前标题保持一致，且仍是一章一文件。
  // canonical 已被别的同章文件占用时不重命名（避免覆盖），交给 doctor action=prune 处理。
  const canonicalName = safeTitle ? chapterFileName(num, safeTitle) : targetName;
  if (canonicalName !== targetName && !exists(inside(root, DIRS.text, canonicalName))) {
    const canonicalTarget = inside(root, DIRS.text, canonicalName);
    fs.renameSync(target, canonicalTarget);
    finalTarget = canonicalTarget;
    finalName = canonicalName;
    readBack = readText(finalTarget);
    if (readBack !== body) {
      throw new Error(`正文写入校验失败：重命名为 ${canonicalName} 后回读内容不一致。`);
    }
    // 索引若正指向旧文件名，跟着改；指向别的同章文件时不动（那是另一份历史稿）。
    const oldRel = `${DIRS.text}/${targetName}`.split(path.sep).join('/');
    const newRel = `${DIRS.text}/${canonicalName}`.split(path.sep).join('/');
    const { value: index } = readIndex(root);
    const entry = index.chapters.find((c) => toInt(c.chapter) === num);
    if (entry && entry.file === oldRel) {
      entry.file = newRel;
      writeIndex(root, index);
    }
  }

  const resolved = findChapterFile(root, num);
  if (!resolved || path.resolve(resolved) !== path.resolve(finalTarget)) {
    throw new Error(
      `正文写入校验失败：已写入 ${finalName}，但第 ${num} 章的解析结果指向 `
      + `${resolved ? path.basename(resolved) : '(无)'}。正文/ 目录里同章文件的时间戳异常，请先核对。`);
  }

  const st = fs.statSync(finalTarget);
  const duplicates = existing.map((f) => f.name).filter((name) => name !== targetName);
  return {
    path: `${DIRS.text}/${finalName}`.split(path.sep).join('/'),
    name: finalName,
    title: rawTitle,
    chapter: num,
    bytes: Buffer.byteLength(body, 'utf8'),
    mtime: st.mtime.toISOString(),
    mtimeMs: st.mtimeMs,
    duplicates,
    verified: true,
    history,
    titleCollisions: titleCollisions(root, num, rawTitle),
  };
}

/** 读正文（按章节号前缀找最新一份；同章多个文件时按 mtime 取最新）。 */
export function readChapterText(root, chapter) {
  const files = listChapterTextFiles(root, Number(toInt(chapter)));
  for (const file of files) {
    const text = readText(file.abs);
    if (text !== null) {
      return {
        name: file.name,
        file: `${DIRS.text}/${file.name}`.split(path.sep).join('/'),
        text,
        mtimeMs: file.mtimeMs,
        mtime: file.mtimeMs ? new Date(file.mtimeMs).toISOString() : null,
        duplicates: files.filter((f) => f.name !== file.name).map((f) => f.name),
      };
    }
  }
  return null;
}

/** 列某章历史版本（供 outline action=history）。 */
export function listChapterHistory(root, chapter) {
  return listVersions(root, toInt(chapter));
}

/** 读某章历史版本（供 outline read version=N）。 */
export function readChapterHistory(root, chapter, version) {
  return readVersion(root, toInt(chapter), version);
}

/** 回滚到某章历史版本；当前稿先自动入历史。 */
export function rollbackChapterText(root, chapter, version) {
  const num = toInt(chapter);
  const old = readVersion(root, num, version);
  const written = writeChapterText(root, num, undefined, old.text);
  return { ...written, rolledBackTo: old.version, historyName: old.name };
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

/**
 * 读回当日手记（与 writeNote 对称，验收闭环用）。
 * date 缺省今天（服务器本地时区）；格式不符拒绝；无手记返回 null。
 */
export function readNote(root, date) {
  const day = date === undefined || date === null || String(date).trim() === ''
    ? todayLocal()
    : String(date).trim();
  if (!NOTE_DATE_RE.test(day)) throw new Error(`date 必须是 YYYY-MM-DD 格式，收到：${day}`);
  const target = inside(root, DIRS.notes, `${day}.md`);
  if (!exists(target)) return null;
  return {
    path: `${DIRS.notes}/${day}.md`.split(path.sep).join('/'),
    date: day,
    text: readText(target),
  };
}
