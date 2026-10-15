/**
 * 项目定位与路径安全。
 *
 * 设计要点：
 * - 项目根 = 含 `.webnovel/` 的目录（向上查找），或显式传入。
 * - 所有写操作必须先过 `assertInside`，防止「章节标题里带 ../..」逃逸出项目。
 */
import fs from 'node:fs';
import path from 'node:path';

export const META_DIR = '.webnovel';

/** 项目的标准目录名（数据契约，勿随意改）。 */
export const DIRS = {
  meta: META_DIR,
  settings: '设定集',
  outline: '大纲',
  volumes: path.join('大纲', '卷纲'),
  chapterOutlines: path.join('大纲', '章纲'),
  text: '正文',
  summaries: path.join(META_DIR, 'summaries'),
  commits: path.join(META_DIR, 'commits'),
  trash: path.join(META_DIR, 'trash'),
};

/** 机器态文件（相对项目根）。 */
export const FILES = {
  project: path.join(META_DIR, 'project.json'),
  state: path.join(META_DIR, 'state.json'),
  index: path.join(META_DIR, 'index.json'),
  foreshadowing: path.join(META_DIR, 'foreshadowing.json'),
  memory: path.join(META_DIR, 'memory.json'),
  lock: path.join(META_DIR, '.lock'),
};

/** 判断某目录是否是书项目根。 */
export function isProjectRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, META_DIR));
  } catch {
    return false;
  }
}

/**
 * 在 startDir 的**直接子目录**里找书项目。
 *
 * 为什么需要这个：最常见的用法是「工作区里放一本小说」——
 * 书项目是工作区的子目录，向上查找永远找不到它。
 * 只扫一层，避免在深层目录树里乱翻；多个命中时按修改时间取最新。
 */
export function findProjectRootInChildren(startDir) {
  const base = path.resolve(startDir ?? process.cwd());
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const candidate = path.join(base, entry.name);
    if (!isProjectRoot(candidate)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(candidate, META_DIR)).mtimeMs;
    } catch { /* 取不到时间就排最后 */ }
    found.push({ root: candidate, mtime });
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.root);
}

/**
 * 定位项目根，按以下顺序：
 *   1. explicitRoot（显式指定，必须已是项目）
 *   2. startDir 自身
 *   3. startDir 的祖先目录
 *   4. startDir 的直接子目录（工作区里放一本小说的情况）
 * 找不到返回 null（由调用方决定报错还是引导初始化）。
 */
export function findProjectRoot(startDir, explicitRoot) {
  if (explicitRoot) {
    const resolved = path.resolve(explicitRoot);
    return isProjectRoot(resolved) ? resolved : null;
  }
  const start = path.resolve(startDir ?? process.cwd());
  let cursor = start;
  for (;;) {
    if (isProjectRoot(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const children = findProjectRootInChildren(start);
  return children.length > 0 ? children[0] : null;
}

/** 规范化路径（统一分隔符、去尾斜杠）。 */
export function normalize(p) {
  return path.resolve(p);
}

/**
 * 路径守卫：target 必须落在 root 之内（含 root 本身）。
 * 返回规范化后的绝对路径；越界抛错。
 */
export function assertInside(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, target);
  const rel = path.relative(rootAbs, targetAbs);
  const escapes = rel.startsWith('..') || path.isAbsolute(rel);
  if (escapes) {
    throw new Error(`路径越界：${target} 不在项目 ${rootAbs} 之内（拒绝写入）`);
  }
  return targetAbs;
}

/** 项目内相对路径（用于展示与存盘）。 */
export function relativeTo(root, target) {
  return path.relative(path.resolve(root), path.resolve(root, target)).split(path.sep).join('/');
}

/** 拼接项目内路径并做守卫。 */
export function inside(root, ...segments) {
  return assertInside(root, path.join(...segments));
}

/** 确保目录存在（递归）。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 读取目录下的文件名（不存在返回空数组）。 */
export function listFiles(dir, predicate = () => true) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 章节正文文件名：第0012章-标题.md */
export function chapterFileName(chapter, title) {
  const num = String(Math.floor(Number(chapter))).padStart(4, '0');
  const safeTitle = String(title ?? '').trim();
  return safeTitle ? `第${num}章-${safeTitle}.md` : `第${num}章.md`;
}

/** 章纲文件名：第0012章.md */
export function chapterOutlineFileName(chapter) {
  return `第${String(Math.floor(Number(chapter))).padStart(4, '0')}章.md`;
}

/** 摘要文件名：ch0012.md */
export function summaryFileName(chapter) {
  return `ch${String(Math.floor(Number(chapter))).padStart(4, '0')}.md`;
}

/** 提交记录文件名：ch0012.json */
export function commitFileName(chapter) {
  return `ch${String(Math.floor(Number(chapter))).padStart(4, '0')}.json`;
}

/** 卷纲文件名：第1卷.md */
export function volumeFileName(volume) {
  return `第${Math.floor(Number(volume))}卷.md`;
}

/**
 * 在候选目录里按「第0012章」前缀找已有正文文件，返回绝对路径。
 * 找不到返回 null（调用方决定是新建还是报错）。
 */
export function findChapterFile(root, chapter) {
  const dir = inside(root, DIRS.text);
  const prefix = `第${String(Math.floor(Number(chapter))).padStart(4, '0')}章`;
  const files = listFiles(dir, (name) => name.endsWith('.md'));
  const hit = files.find((name) => name.startsWith(prefix));
  return hit ? path.join(dir, hit) : null;
}

/** 列出所有正文章节文件（按文件名排序 = 按章节号排序）。 */
export function listChapterFiles(root) {
  const dir = inside(root, DIRS.text);
  return listFiles(dir, (name) => /^第\d+章.*\.md$/.test(name))
    .sort()
    .map((name) => ({ name, abs: path.join(dir, name) }));
}
