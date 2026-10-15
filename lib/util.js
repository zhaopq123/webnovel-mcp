/**
 * 纯函数工具集：无 IO、无状态、可单测。
 */
import { createHash } from 'node:crypto';

/** 当前时间的 ISO 字符串（秒级，去掉毫秒便于阅读与比较）。 */
export function isoNow(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace('T', ' ');
}

/** 章节号 → 4 位零填充（1 → "0001"）。 */
export function padChapter(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) throw new Error(`非法章节号：${n}`);
  return String(Math.floor(num)).padStart(4, '0');
}

/**
 * 中文字数统计：中文/标点按字计，连续的西文字母数字按 1 词计。
 * 与网文平台口径接近：忽略空白与 Markdown 标记。
 */
export function countWords(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const clean = stripMarkdown(text).replace(/\s+/g, '');
  const cjk = clean.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uf900-\ufaff]/g);
  const cjkCount = cjk ? cjk.length : 0;
  const rest = clean.replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uf900-\ufaff]/g, ' ');
  const latinWords = rest.match(/[A-Za-z0-9]+/g);
  const latinCount = latinWords ? latinWords.reduce((sum, w) => sum + w.length, 0) : 0;
  const punct = rest.replace(/[A-Za-z0-9\s]/g, '').length;
  return cjkCount + latinCount + punct;
}

/** 去掉 Markdown 标记，得到可读纯文本。 */
export function stripMarkdown(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')       // frontmatter
    .replace(/```[\s\S]*?```/g, '')              // 代码块
    .replace(/`([^`]*)`/g, '$1')                 // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // 链接
    .replace(/^#{1,6}\s+/gm, '')                 // 标题
    .replace(/^\s*[-*+]\s+/gm, '')               // 列表
    .replace(/^\s*>\s?/gm, '')                   // 引用
    .replace(/[*_~]{1,3}/g, '')                  // 强调
    .replace(/^\s*\|.*\|\s*$/gm, '')             // 表格
    .trim();
}

/** 文件名净化：去掉 Windows 非法字符，压缩空白，限长。 */
export function sanitizeFilename(name, maxLength = 60) {
  const cleaned = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = cleaned.length > 0 ? cleaned : '未命名';
  return safe.slice(0, maxLength).trim();
}

/** 点号路径读取：getPath({a:{b:1}}, 'a.b') → 1。 */
export function getPath(obj, dotted, fallback = undefined) {
  if (!dotted) return obj;
  const parts = String(dotted).split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return fallback;
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) return fallback;
    cursor = cursor[part];
  }
  return cursor === undefined ? fallback : cursor;
}

/** 点号路径写入（就地修改）：setPath(o, 'a.b', 1)。 */
export function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (cursor[part] === null || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  return obj;
}

/** 深合并：patch 覆盖 base；数组整体替换（不做元素级合并）。 */
export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

/** 按 key 去重，后者覆盖前者，保持首次出现顺序。 */
export function uniqueBy(items, keyFn) {
  const seen = new Map();
  for (const item of items) {
    if (item === null || item === undefined) continue;
    seen.set(keyFn(item), item);
  }
  return [...seen.values()];
}

/** 合并数组字段并去重（用于 world.factions 之类的累积）。 */
export function mergeArray(base, additions) {
  const out = Array.isArray(base) ? [...base] : [];
  for (const item of Array.isArray(additions) ? additions : []) {
    if (item === null || item === undefined || item === '') continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** 截断文本到 n 个字符，超出加省略号。 */
export function truncate(text, n) {
  const str = String(text ?? '');
  if (str.length <= n) return str;
  return `${str.slice(0, Math.max(0, n - 1))}…`;
}

/** 转义正则元字符。 */
export function escapeRegExp(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 全文包含判断（大小写不敏感）。 */
export function containsIgnoreCase(haystack, needle) {
  return String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());
}

/**
 * 从 Markdown 里取正文：去掉 frontmatter、代码块与**整行标题**。
 * 注意 stripMarkdown 只去掉 `#` 标记而保留标题文字，所以这里要先删掉整行标题。
 */
export function bodyOf(markdown) {
  const withoutHeadings = String(markdown ?? '').replace(/^#{1,6}\s+.*$/gm, '');
  return stripMarkdown(withoutHeadings).trim();
}

/** 取第一段有内容的文本作为兜底摘要。 */
export function firstParagraph(text, maxLength = 120) {
  const body = bodyOf(text);
  const line = body.split(/\n+/).map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  return truncate(line, maxLength);
}

/** 数值收敛到 [min, max]。 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** 安全整数解析。 */
/** 书名加《》：已经带了书名号就不再套，免得出现《《甲》》。 */
export function wrapTitle(title, fallback = '未命名作品') {
  const t = String(title ?? '').trim();
  if (!t) return `《${fallback}》`;
  if (t.startsWith('《') && t.endsWith('》') && t.length >= 3) return t;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 3) return `《${t.slice(1, -1)}》`;
  return `《${t}》`;
}

/**
 * 卷标渲染：state 里存的是「第 1 卷」+ 卷名，有的作者会把卷名写成「第一卷 旧城」，
 * 直接拼会出现「第 1 卷 第一卷 旧城」。这里统一去掉卷名里重复的前缀。
 */
export function formatVolumeLabel(volume, title) {
  const base = `第 ${volume} 卷`;
  const t = String(title ?? '').trim();
  if (!t) return base;
  const stripped = t.replace(/^第\s*(?:\d+|[零一二三四五六七八九十百千万两]+)\s*卷\s*/, '').trim();
  return stripped ? `${base}${stripped}` : base;
}

export function toInt(value, fallback = 0) {  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * 正文归一化（用于审查-提交的 hash 比对）。
 * 行尾空白、换行符风格、首尾空行属于「编辑器噪音」，不该导致误判「审的是旧稿」。
 */
export function normalizeForHash(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** 正文指纹：归一化后的 sha256 前 16 位（够用且短，便于人眼比对）。 */
export function textHash(text) {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex').slice(0, 16);
}

/** 百分比格式化（保留 1 位小数，整数则不带小数）。 */
export function percent(part, total) {
  if (!total) return '0%';
  const value = (part / total) * 100;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** 按标题切分 Markdown 章节：返回 [{ heading, level, content }]。 */
export function splitSections(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { heading: match[2].trim(), level: match[1].length, content: [] };
    } else if (current) {
      current.content.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ ...s, content: s.content.join('\n').trim() }));
}

/** 从 Markdown 的 YAML-ish frontmatter 取简单标量（不引入 yaml 依赖）。 */
export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(markdown ?? ''));
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    out[kv[1]] = value;
  }
  return out;
}
