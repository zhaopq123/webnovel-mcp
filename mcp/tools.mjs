/**
 * MCP 工具层：把「长篇网文写作助手」的能力暴露成 MCP 工具。
 *
 * 两条铁律：
 *  1. 内容进、内容出 —— 服务端只在自己的书库里读写，不接受调用方的任意文件路径。
 *  2. 定位 = 书库根目录 + 受限 bookId —— bookId 只允许中英文/数字/-/_，且解析结果必须落在书库内（含符号链接检查）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { initProject, isInitialized } from '../lib/core/project.js';
import { buildWritingBrief } from '../lib/features/context.js';
import { commitChapter } from '../lib/features/commit.js';
import { runQuery } from '../lib/features/query.js';
import { analyzePacing, renderPacingMarkdown } from '../lib/features/pacing.js';
import { reviewChapter } from '../lib/features/review.js';
import { learnMemory, recallMemory, memoryStats, MEMORY_KINDS, MEMORY_KIND_LABEL } from '../lib/features/memory.js';
import { projectStatus, compactStatusLine } from '../lib/features/status.js';
import { doctorCheck, renderDoctorMarkdown, doctorRebuild } from '../lib/features/doctor.js';
import {
  writeMasterOutline, writeVolumeOutline, writeChapterOutline, writeChapterText, writeNote,
  readMaster, readVolume, readChapter, readChapterText,
} from '../lib/features/outline.js';
import { toInt, countWords, wrapTitle } from '../lib/util.js';

/**
 * bookId 允许：中英文、数字、- 和 _（1-64 字符）。
 * 首字符允许下划线（`_草稿`、`__test__` 是常见习惯），但不允许以 `-` 开头（避免被当成命令行参数）。
 */
export const BOOK_ID_RE = /^[_\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9_-]{0,63}$/;

const BOOK_ID_HINT = '只允许中英文、数字、- 和 _（1-64 字符），不能含 / \\ . 空格，也不能以 - 开头';

const DEFAULT_MAX_BODY = 32 * 1024 * 1024;

/** 从环境变量读配置（部署时用 .env / 启动脚本注入）。 */
export function loadConfig(env = process.env) {
  const rawRoot = String(env.WEBNOVEL_ROOT ?? '').trim();
  const rawMax = Number(env.WEBNOVEL_MAX_BODY);
  return {
    booksRoot: path.resolve(rawRoot || path.join(process.cwd(), 'books')),
    token: String(env.WEBNOVEL_TOKEN ?? '').trim(),
    port: Number(env.WEBNOVEL_PORT || 8400),
    bind: String(env.WEBNOVEL_BIND || '0.0.0.0').trim(),
    maxBody: Number.isFinite(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_BODY,
    // 'off' = 工具返回末尾只留书 id（省 token）；默认 'full' = 附带最新状态行（L0 防忘主通道）
    footer: String(env.WEBNOVEL_STATUS_FOOTER ?? '').trim().toLowerCase() === 'off' ? 'off' : 'full',
  };
}

export function ensureBooksRoot(config) {
  fs.mkdirSync(config.booksRoot, { recursive: true });
  return config.booksRoot;
}

/** 列出书库里所有已初始化的书（目录名 = bookId）。 */
export function listBookIds(config) {
  try {
    return fs.readdirSync(config.booksRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && isInitialized(path.join(config.booksRoot, e.name)))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** 路径守卫：解析后的真实路径必须落在书库真实路径之内（防符号链接逃逸）。 */
function assertInsideReal(booksRoot, dir) {
  const realRoot = fs.realpathSync(booksRoot);
  const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Error('路径越界：bookId 解析到了书库之外（拒绝访问）');
  }
  return dir;
}

/** 解析 bookId：不传时，书库里只有一本就自动选它。 */
export function resolveBookId(config, bookId) {
  const raw = String(bookId ?? '').trim();
  if (!raw) {
    const ids = listBookIds(config);
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) {
      throw new Error('书库里还没有任何书。先用 webnovel_init 建一本（bookId 用中英文短名，例如 changye 或 长夜行）。');
    }
    throw new Error(`书库里有多本书，请指定 bookId：${ids.join(' / ')}`);
  }
  if (!BOOK_ID_RE.test(raw)) {
    throw new Error(`bookId 不合法（收到：${raw}）。${BOOK_ID_HINT}。`);
  }
  return raw;
}

/** 定位书项目目录，并要求已初始化。 */
export function requireBook(config, bookId) {
  ensureBooksRoot(config);
  const id = resolveBookId(config, bookId);
  const dir = assertInsideReal(config.booksRoot, path.join(config.booksRoot, id));
  if (!isInitialized(dir)) {
    const others = listBookIds(config);
    throw new Error(
      `「${id}」还不是书项目（缺少 .webnovel/）。`
      + `先用 webnovel_init 建它，或换一个 bookId。现有书：${others.join(' / ') || '（空）'}`,
    );
  }
  return { id, dir };
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

const BOOK_PARAM = {
  type: 'string',
  description: '书 ID（书库里那本书的目录名）。书库里只有一本书时可以省略；有多本时必须指定，可用 webnovel_books 查看。',
};

function tool(name, description, properties, required, handler) {
  const props = { ...properties };
  if (name !== 'webnovel_init' && name !== 'webnovel_books') props.bookId = BOOK_PARAM;
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: props,
      required: required ?? [],
      additionalProperties: false,
    },
    handler,
  };
}

/**
 * 书行：工具返回末尾的状态尾巴。
 *
 * 这是 L0（无系统提示钩子的客户端）防忘机制的主通道——每轮工具返回都带上
 * 「书名+进度+主角状态+到期伏笔」，模型即使没有任何插件能力也忘不掉。
 * - light=true（如 webnovel_context）：只留书 id，避免与任务书里的状态重复
 * - WEBNOVEL_STATUS_FOOTER=off：全局退回「（书：id）」（省 token）
 * - 任何读取失败都降级为「（书：id）」——不许拖垮工具调用本身
 */
const bookLine = (config, id, dir, light = false) => {
  const bare = `（书：${id}）`;
  if (light || config?.footer === 'off') return bare;
  try {
    const line = compactStatusLine(dir);
    return line ? `（书：${id}｜${line}）` : bare;
  } catch {
    return bare;
  }
};

/**
 * initialize 的开场白（辅助通道）：书库恰好只有一本书时，把最新状态写进
 * instructions——会话级快照，会随书写变旧，真正防忘靠每次工具返回的 footer。
 * 多书/空库/异常一律返回 null（基础铁律文案原样保留）。
 */
export function statusPreamble(config) {
  if (config?.footer === 'off') return null;
  try {
    const ids = listBookIds(config);
    if (ids.length !== 1) return null;
    const id = ids[0];
    const line = compactStatusLine(path.join(config.booksRoot, id));
    if (!line) return null;
    return `\n\n当前书库只有一本书（bookId=${id}，调用工具时可省略 bookId）：${line}。每次工具返回末尾都会附带这行最新状态，写作时以它为准。`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * commit 参数容错
 *
 * 模型很容易把 summary / strand / hook / ending 塞进 deltas 里（deltas 是开放对象，
 * 客户端不会拦），旧实现会静默丢掉这些字段：索引里 strand 变 null、前情提要没了摘要、
 * 节奏统计失真。这里把放错位置的字段提回顶层，并把「提过什么」回给模型，让它下次写对。
 * ------------------------------------------------------------------ */
const COMMIT_TOP_FIELDS = ['summary', 'strand', 'hook', 'ending', 'title', 'wordCount', 'force'];
const DELTA_FIELDS = ['protagonist', 'characters', 'world', 'timeline', 'foreshadowing'];

export function normalizeCommitArgs(args = {}) {
  const normalized = { ...args };
  const notes = [];
  const deltas = args.deltas && typeof args.deltas === 'object' && !Array.isArray(args.deltas)
    ? { ...args.deltas }
    : null;

  if (deltas) {
    for (const key of COMMIT_TOP_FIELDS) {
      if (deltas[key] === undefined) continue;
      if (normalized[key] === undefined) {
        normalized[key] = deltas[key];
        notes.push(`\`${key}\` 属于顶层参数（不该放进 deltas），已自动提到顶层。`);
      } else {
        notes.push(`deltas 里的 \`${key}\` 已忽略——顶层已经有同名参数了。`);
      }
      delete deltas[key];
    }
    const unknown = Object.keys(deltas).filter((k) => !DELTA_FIELDS.includes(k));
    if (unknown.length > 0) {
      notes.push(`deltas 里这些字段系统不认，已忽略：${unknown.join('、')}（deltas 只认：${DELTA_FIELDS.join(' / ')}）`);
      for (const k of unknown) delete deltas[k];
    }
    normalized.deltas = deltas;
  }

  if (!normalized.summary) {
    notes.push('这次没传 `summary`——它会成为下一章的前情提要。建议再提交一次，把摘要补上。');
  }
  return { normalized, notes };
}

export const TOOL_DEFS = [
  tool(
    'webnovel_init',
    '创建或补全一本书的目录骨架（设定集/大纲/正文 + .webnovel 机器态）并写入项目元信息。'
      + '当用户说「开一本新书 / 新建小说 / 帮我建个项目 / 我想写一本 XX 类型的小说」时使用。'
      + '已存在的书只补缺失文件、绝不覆盖已有内容，机器态（状态/索引/伏笔/记忆）原样保留（可安全重复执行）；'
      + '想改书名、目标字数等元信息，显式传新值即可更新（没传的字段保持原样）。返回书 ID 与创建清单。',
    {
      bookId: { type: 'string', description: '书 ID：这本书在书库里的目录名，用中英文短名，例如 changye / 长夜行。不传则自动生成。' },
      title: { type: 'string', description: '书名。用户没说就用「未命名作品」，之后可改。' },
      genre: { type: 'string', description: '题材，例如 都市异能 / 玄幻 / 悬疑 / 古言。' },
      genreTags: { type: 'array', items: { type: 'string' }, description: '细分标签，例如 ["都市","异能","系统流"]。' },
      logline: { type: 'string', description: '一句话故事，用于写作时锚定方向。' },
      targetWords: { type: 'number', description: '目标总字数，默认 1000000。' },
      targetChapters: { type: 'number', description: '目标总章数，默认 400。' },
    },
    [],
    async (args, config) => {
      ensureBooksRoot(config);
      const rawId = String(args.bookId ?? '').trim();
      const id = rawId || `book-${Date.now().toString(36)}`;
      if (!BOOK_ID_RE.test(id)) {
        throw new Error(`bookId 不合法（收到：${rawId}）。${BOOK_ID_HINT}。`);
      }
      const dir = assertInsideReal(config.booksRoot, path.join(config.booksRoot, id));
      fs.mkdirSync(dir, { recursive: true });
      const result = initProject(dir, {
        title: args.title,
        genre: args.genre,
        genreTags: args.genreTags,
        logline: args.logline,
        targetWords: args.targetWords,
        targetChapters: args.targetChapters,
      });
      const lines = [result.existed ? `已在既有书上补全骨架：${id}` : `已建好新书：${id}`];
      if (result.existed) {
        const patched = result.created.slice(1);
        lines.push(patched.length > 0
          ? `本次补全：${patched.join('、')}`
          : '本次没有缺失项需要补全，已有内容一律未动。');
      }
      lines.push(
        '',
        `书名：${result.meta.title}`,
        `题材：${result.meta.genre}`,
        `目标：${result.meta.targetWords} 字 / ${result.meta.targetChapters} 章`,
        '',
        '目录结构：',
        '```',
        '设定集/    世界观、力量体系、主角卡、金手指',
        '大纲/      总纲、卷纲/、章纲/',
        '正文/      章节正文',
        '.webnovel/ 状态、索引、伏笔台账、提交链（机器维护）',
        '```',
        '',
        '下一步：',
        '1. 用 webnovel_outline action=write_master 定总纲（或让 Agent 帮你拟）',
        '2. 再拆第一卷卷纲（action=write_volume）',
        '3. 为第 1 章写章纲（action=write_chapter），然后 webnovel_context 取任务书开写',
      );
      return lines.join('\n');
    },
  ),

  tool(
    'webnovel_status',
    '一句话看清「写到哪了、有什么没做完」：进度、主角状态、下一章、以及按优先级排序的待办清单。'
      + '当用户问「写到哪了 / 什么进度 / 接下来该做什么 / 我还有什么没做」，'
      + '或你刚开始一次写作会话需要建立全局认知时使用。这是最省 token 的入口工具。',
    {},
    [],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const status = projectStatus(dir);
      return [...status.lines, '', bookLine(config, id, dir)].join('\n');
    },
  ),

  tool(
    'webnovel_books',
    '列出书库里所有的书（bookId、书名、进度）。'
      + '当用户说「我有哪几本书 / 切换到另一本 / 现在在写哪本」时使用；'
      + '调用其他工具不确定 bookId 时也先用它。',
    {},
    [],
    async (args, config) => {
      ensureBooksRoot(config);
      const ids = listBookIds(config);
      if (ids.length === 0) {
        return '书库还是空的。用 webnovel_init 建第一本书（例如 bookId=changye，书名《长夜行》）。';
      }
      const lines = [`书库里共 ${ids.length} 本书：`, ''];
      for (const id of ids) {
        let title = '';
        try {
          const p = JSON.parse(fs.readFileSync(path.join(config.booksRoot, id, '.webnovel', 'project.json'), 'utf8'));
          title = wrapTitle(p.title);
        } catch { title = '《未命名作品》'; }
        const bits = [];
        let status = null;
        try { status = projectStatus(path.join(config.booksRoot, id)); } catch { /* 单本坏了不拖垮整张表 */ }
        if (status?.stats) {
          bits.push(`已写 ${status.stats.chaptersCommitted} 章 / ${status.stats.totalWords} 字`);
          if (status.stats.uncommitted?.length) bits.push(`${status.stats.uncommitted.length} 章待提交`);
          if (status.stats.foreshadowingOverdue) bits.push(`${status.stats.foreshadowingOverdue} 条伏笔到期`);
        }
        lines.push(`- ${id}　${title}${bits.length ? `　${bits.join('｜')}` : ''}`);
      }
      lines.push('', `书库目录：${config.booksRoot}`);
      return lines.join('\n');
    },
  ),

  tool(
    'webnovel_outline',
    '读写大纲与正文，按 action 分派：write_master（写总纲）、write_volume（写第 N 卷卷纲）、'
      + 'write_chapter（写第 N 章章纲——写正文前必须先做这步）、write_text（保存第 N 章正文）、'
      + 'write_note（当日手记落盘：追加写 手记/YYYY-MM-DD.md，date 可选）、read（读回任意一项）。'
      + '章纲是写作的前置条件：没有章纲时 webnovel_context 会返回 blocker。'
      + '当用户说「定大纲 / 拆卷 / 写章纲 / 这章要发生什么 / 保存这章 / 记下手记」时使用。',
    {
      action: {
        type: 'string',
        enum: ['write_master', 'write_volume', 'write_chapter', 'write_text', 'write_note', 'read'],
        description: '要执行的动作。',
      },
      text: { type: 'string', description: '要写入的 Markdown 内容（write_* 动作必填）。' },
      chapter: { type: 'number', description: '章节号（write_chapter / write_text / read 时用）。' },
      volume: { type: 'number', description: '卷号（write_volume 时用）。' },
      title: { type: 'string', description: '标题：write_text 时是章节标题；write_volume 时是卷名。' },
      chapterRange: { type: 'string', description: '卷的章节范围，例如 "1-100"（write_volume 时可选）。' },
      date: { type: 'string', description: '手记日期，YYYY-MM-DD（write_note 时可选，缺省今天）。' },
      scope: { type: 'string', enum: ['master', 'volume', 'chapter', 'text'], description: 'read 动作读哪一项。' },
    },
    ['action'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const action = String(args.action ?? '').trim();

      if (action === 'read') {
        const scope = args.scope ?? (args.chapter ? 'chapter' : 'master');
        if (scope === 'master') {
          const content = readMaster(dir);
          return content ? `# 总纲（${id}）\n\n${content.trim()}` : `（《${id}》还没有总纲）`;
        }
        if (scope === 'volume') {
          const v = args.volume ?? 1;
          const content = readVolume(dir, v);
          return content ? content.trim() : `（第 ${v} 卷还没有卷纲）`;
        }
        if (scope === 'chapter') {
          const content = readChapter(dir, args.chapter);
          return content ? content.trim() : `（第 ${args.chapter} 章还没有章纲）`;
        }
        const found = readChapterText(dir, args.chapter);
        return found ? found.text : `（第 ${args.chapter} 章还没有正文）`;
      }

      const content = String(args.text ?? '');
      if (!content.trim()) throw new Error(`${action} 需要提供 text 内容`);

      if (action === 'write_master') {
        const r = writeMasterOutline(dir, content);
        return `已保存《${id}》总纲：${r.path}\n\n下一步：用 action=write_volume 拆第一卷卷纲。`;
      }
      if (action === 'write_volume') {
        const r = writeVolumeOutline(dir, args.volume ?? 1, content, { title: args.title, chapterRange: args.chapterRange });
        return `已保存第 ${r.volume} 卷卷纲：${r.path}`
          + (r.registered?.chapterRange ? `（章节范围 ${r.registered.chapterRange}）` : '')
          + '\n\n下一步：用 action=write_chapter 写该卷第 1 章的章纲。';
      }
      if (action === 'write_chapter') {
        const r = writeChapterOutline(dir, args.chapter, content);
        return `已保存第 ${r.chapter} 章章纲：${r.path}\n\n现在可以用 webnovel_context 取写作任务书，然后动笔。`;
      }
      if (action === 'write_text') {
        const r = writeChapterText(dir, args.chapter, args.title, content);
        return `已保存正文：${r.path}（${countWords(content)} 字）\n\n完稿流程：先 webnovel_review 自审（有 🔴 必须改），再用 webnovel_commit 提交。`;
      }
      if (action === 'write_note') {
        const r = writeNote(dir, content, args.date);
        return `已${r.appended ? '追加' : '写入'}当日手记：${r.path}（${r.bytes} 字节）`
          + '\n\n无人值守日更的验收凭据：每章跑完必须落盘一份，作者凭它终审。';
      }
      throw new Error(`未知的 action：${action}。可用：write_master / write_volume / write_chapter / write_text / write_note / read`);
    },
  ),

  tool(
    'webnovel_context',
    '★ 动笔前必调：生成第 N 章的「写作任务书」——本章章纲、前情提要、主角当前状态（境界/位置/伤势）、'
      + '近期出场角色、到期伏笔、时间线、节奏提示、已沉淀的写作经验、以及不可违反的硬约束。'
      + '这是防止「写到后期忘设定」的核心机制。'
      + '当用户说「写第 N 章 / 继续写 / 下一章」时，这是你要调用的第一个工具。'
      + '若返回 blockers 非空（例如缺章纲），先解决 blocker 再动笔。',
    { chapter: { type: 'number', description: '要写的章节号。' } },
    ['chapter'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const result = buildWritingBrief(dir, args.chapter);
      return `${result.markdown}\n\n${bookLine(config, id, dir, true)}`;
    },
  ),

  tool(
    'webnovel_commit',
    '★ 写完一章后必调：把本章产生的事实变化提交落库，系统据此更新状态卡、章节索引、伏笔台账、时间线。'
      + '不提交 = 这一章发生的事不会被记住，后续章节会当作没发生过。'
      + 'deltas 里写本章的增量：主角状态变化、新角色、新地点/势力、埋下或回收的伏笔、时间线推进。'
      + '提交前系统会核对本章的审查记录：还有未处理的严重问题（🔴）时会被拒绝——'
      + '先用 webnovel_review 审一遍并按建议修改；确认要按原稿提交再传 force=true。'
      + '重复提交同一章是覆盖（幂等）；重提早于当前进度的旧章默认被拒绝（防状态回退），'
      + '确要修正历史章节请传 force=true（历史修正模式：deltas 会被忽略，只更新该章的索引、摘要与字数，线别沿用原值）。'
      + '提交记录本身永久保留。'
      + '当用户说「写完了 / 提交这章 / 记下来 / 更新设定」时使用。',
    {
      chapter: { type: 'number', description: '章节号。' },
      title: { type: 'string', description: '章节标题。不传则从正文文件名推断。' },
      summary: { type: 'string', description: '本章摘要（2-4 句）。会作为下一章的前情提要，务必写。' },
      strand: {
        type: 'string',
        enum: ['quest', 'fire', 'constellation'],
        description: '本章属于哪条线：quest=主线剧情 / fire=感情线 / constellation=世界观扩展。',
      },
      hook: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '钩子类型，例如 危机钩 / 悬念钩 / 情感钩。' },
          strength: { type: 'string', enum: ['weak', 'medium', 'strong'], description: '钩子强度。' },
        },
        description: '章末钩子。',
      },
      ending: {
        type: 'object',
        properties: {
          time: { type: 'string', description: '结尾的时间，例如「三日后」。' },
          location: { type: 'string', description: '结尾地点。' },
        },
        description: '结尾场景，用于下一章的连贯性检查。',
      },
      wordCount: { type: 'number', description: '字数。不传则自动从正文文件统计。' },
      force: {
        type: 'boolean',
        description: '逃生门：跳过「上一章未提交」警告、旧章重提阻断与审查门禁。'
          + '旧章重提（早于当前进度）带 force 时进入历史修正模式：deltas 全部忽略，只更新该章索引、摘要与字数（线别沿用原值）。',
      },
      deltas: {
        type: 'object',
        description:
          '本章的事实增量。子字段：'
          + 'protagonist（主角状态，如 {location, condition, power:{realm}}）、'
          + 'characters（[{name, patch:{role,relation,realm,location,firstChapter,lastChapter,notes}}]，'
          + 'firstChapter/lastChapter 不传会自动填本章号）、'
          + 'world（{factions:[],locations:[],powerSystem:[]}，只增不减）、'
          + 'timeline（{time,location,event}）、'
          + 'foreshadowing（{planted:[{name,plannedPayoff,importance,note}], paid:["名称"], dropped:["名称"]}）。',
      },
    },
    ['chapter'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const { normalized, notes } = normalizeCommitArgs(args);
      const result = await commitChapter(dir, normalized);

      const lines = [`已提交第 ${result.chapter} 章《${result.title}》——${result.words} 字`];
      if (result.strand) lines.push(`线别：${result.strand}`);
      if (result.planted.length > 0) {
        lines.push(`新埋伏笔 ${result.planted.length} 条：${result.planted.map((p) => `${p.name}${p.plannedPayoff ? `（计划第 ${p.plannedPayoff} 章回收）` : ''}`).join('、')}`);
      }
      if (result.paid.length > 0) lines.push(`已回收伏笔：${result.paid.join('、')}`);
      if (result.overdue.length > 0) {
        lines.push(`⚠ 仍有 ${result.overdue.length} 条伏笔到期未回收：${result.overdue.map((f) => f.name).join('、')}`);
      }
      const p = result.progress;
      lines.push(`总进度：${p.currentChapter} 章 / ${p.totalWords} 字（目标 ${p.targetChapters} 章 / ${p.targetWords} 字）`);
      if (result.warnings.length > 0) {
        lines.push('', '注意：');
        for (const w of result.warnings) lines.push(`- ${w}`);
      }
      if (notes.length > 0) {
        lines.push('', '参数位置提醒（已自动处理，下次照右边写）：');
        for (const n of notes) lines.push(`- ${n}`);
      }
      lines.push('', `下一步：用 webnovel_context chapter=${p.currentChapter + 1} 取下一章任务书。`);
      lines.push('', bookLine(config, id, dir));
      return lines.join('\n');
    },
  ),

  tool(
    'webnovel_query',
    '查询书里的任何事实，返回人话而不是 JSON。'
      + 'kind=status（进度概览）、character（角色卡，传 name 查单个、不传列全部）、'
      + 'foreshadowing（伏笔台账）、chapter（某章详情与事实变化）、'
      + 'setting（设定集，传 name 查单篇）、timeline（事件时间线）、'
      + 'memory（写作经验）、search（在正文/大纲/设定/摘要里全文检索关键词）。'
      + '当用户问「主角现在什么境界 / 某某是谁 / 玉佩那条伏笔还开着吗 / 之前哪一章写过 X」时使用。'
      + '注意：动笔前拿上下文应该用 webnovel_context，不是这个工具。',
    {
      kind: {
        type: 'string',
        enum: ['status', 'character', 'foreshadowing', 'chapter', 'setting', 'timeline', 'memory', 'search'],
        description: '查询类型。',
      },
      name: { type: 'string', description: '角色名（kind=character）或设定篇名（kind=setting）。' },
      chapter: { type: 'number', description: '章节号（kind=chapter 时用）。' },
      query: { type: 'string', description: '关键词（kind=search / kind=memory 时用）。' },
      status: { type: 'string', enum: ['open', 'paid', 'dropped'], description: '伏笔状态过滤（kind=foreshadowing）。' },
      limit: { type: 'number', description: '返回条数上限。' },
    },
    ['kind'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const result = runQuery(dir, args.kind, args);
      return `${result.lines.join('\n')}\n\n${bookLine(config, id, dir)}`;
    },
  ),

  tool(
    'webnovel_pacing',
    '节奏体检：统计主线剧情（quest）/ 感情线（fire）/ 世界观（constellation）三条线的占比与断档，'
      + '并按网文经验红线告警（主线连续不超过 5 章、感情线断档不超过 10 章、世界观不超过 15 章）。'
      + '当用户说「节奏怎么样 / 是不是该写感情线了 / 读者说最近不好看 / 编辑说情节单一」时使用。',
    {
      uptoChapter: { type: 'number', description: '统计到第几章（默认全部已提交章节）。' },
      window: { type: 'number', description: '「最近 N 章」窗口大小，默认 20。' },
    },
    [],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const report = analyzePacing(dir, args);
      return `${renderPacingMarkdown(report)}\n\n${bookLine(config, id, dir)}`;
    },
  ),

  tool(
    'webnovel_review',
    '审查某一章的一致性，返回按严重程度排序的问题清单（含原文证据与修改建议）。'
      + '六个维度：设定一致性（状态冲突、境界回退、已死角色出场）、叙事连贯（与前章衔接）、'
      + '节奏（三线断档）、大纲符合度、伏笔（到期未回收/埋了没登记）、追读力（章末钩子、段落长度、对话比例）。'
      + '当用户说「检查一下这章 / 有没有问题 / 帮我审一下 / 会不会崩设定」时使用。'
      + '若不传 text，会自动读取该章正文文件。审查结果会落盘为该章的审查记录；'
      + '提交时凭这份记录放行——改过正文要重新审查（按文本指纹核对）。',
    {
      chapter: { type: 'number', description: '要审查的章节号。' },
      text: { type: 'string', description: '正文内容。不传则从 正文/ 目录读取该章文件。' },
    },
    ['chapter'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const result = reviewChapter(dir, args.chapter, { text: args.text });
      return `${result.markdown}\n\n${bookLine(config, id, dir)}`;
    },
  ),

  tool(
    'webnovel_memory',
    '长期写作记忆：action=learn 沉淀一条有效经验（写法/文风/人物把握/读者反馈），'
      + 'action=recall 检索已沉淀的经验，action=stats 看统计。'
      + '与「状态」的区别：状态记「发生了什么」，记忆记「怎么写更好」。'
      + '沉淀过的经验会自动出现在后续每章的写作任务书里。'
      + '当用户说「记住这个写法 / 以后都这样写 / 上次那个教训 / 读者反馈说要改」时使用。',
    {
      action: { type: 'string', enum: ['learn', 'recall', 'stats'], description: '要执行的动作。' },
      kind: {
        type: 'string',
        enum: MEMORY_KINDS,
        description: '记忆类型：style=文风 / technique=写法 / setting=设定约定 / feedback=读者编辑反馈 / character=人物把握。',
      },
      title: { type: 'string', description: '一句话概括这条经验（learn 必填）。' },
      content: { type: 'string', description: '具体怎么做（learn 必填）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，便于检索。' },
      chapter: { type: 'number', description: '这条经验来自第几章（可选）。' },
      query: { type: 'string', description: '检索关键词（recall 时用）。' },
      limit: { type: 'number', description: '返回条数上限。' },
    },
    ['action'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const action = String(args.action ?? '').trim();

      if (action === 'learn') {
        const result = await learnMemory(dir, args);
        return `已记住【${result.kindLabel}】${result.title}\n\n累计 ${result.total} 条写作记忆，后续每章的写作任务书都会带上。${bookLine(config, id, dir)}`;
      }
      if (action === 'recall') {
        const result = recallMemory(dir, args);
        return `${result.lines.join('\n')}\n\n${bookLine(config, id, dir)}`;
      }
      if (action === 'stats') {
        const stats = memoryStats(dir);
        if (stats.total === 0) return `《${id}》还没有沉淀任何写作经验。`;
        const kindLines = Object.entries(stats.byKind)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `- ${MEMORY_KIND_LABEL[k] ?? k}：${n} 条`);
        return [`写作记忆共 ${stats.total} 条：`, ...kindLines, '', bookLine(config, id, dir)].join('\n');
      }
      throw new Error(`未知的 action：${action}。可用：learn / recall / stats`);
    },
  ),

  tool(
    'webnovel_doctor',
    '机器态体检与重建：action=check（默认）把提交链完整重放一遍，逐项对账状态卡/索引/伏笔台账/'
      + '正文文件/摘要文件，并扫出骨架里未填的占位符；action=rebuild 从提交链重放重建机器态'
      + '（重建前自动备份到 .webnovel/trash/，记忆与审查记录不受影响）。'
      + '提交链是唯一事实来源——怀疑「系统记的」和「实际写过的」对不上时用。'
      + '当用户说「记的怎么对不上 / 状态好像不对 / 帮我校验一下记录 / 数据是不是坏了」时使用。'
      + '注意：检查大纲/正文内容的质量用 webnovel_review，这个工具只管机器态账目。',
    {
      action: {
        type: 'string',
        enum: ['check', 'rebuild'],
        description: 'check=只读体检（默认）/ rebuild=重放重建机器态（写操作，有备份，需 confirm=true 才会执行）。',
      },
      confirm: {
        type: 'boolean',
        description: '重建的确认门：必须显式传 true 才会真正重建（防误触）。check 不需要。',
      },
    },
    [],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const action = String(args.action ?? 'check').trim() || 'check';
      if (action === 'check') {
        const result = doctorCheck(dir);
        return `${renderDoctorMarkdown(dir, result)}\n\n${bookLine(config, id, dir)}`;
      }
      if (action === 'rebuild') {
        const result = await doctorRebuild(dir, { confirm: args.confirm === true });
        return [...result.lines, '', bookLine(config, id, dir)].join('\n');
      }
      throw new Error(`未知的 action：${action}。可用：check / rebuild`);
    },
  ),
];

const TOOL_MAP = new Map(TOOL_DEFS.map((t) => [t.name, t]));

export function getTool(name) {
  return TOOL_MAP.get(name);
}

/** 供 tools/list 使用的纯 schema 列表（不含 handler）。 */
export function listTools() {
  return TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** 直接调用某个工具（测试与内部复用）。返回文本。 */
export async function applyTool(name, args, config) {
  const t = TOOL_MAP.get(name);
  if (!t) throw new Error(`未知工具：${name}。可用：${[...TOOL_MAP.keys()].join(' / ')}`);
  return t.handler(args ?? {}, config);
}
