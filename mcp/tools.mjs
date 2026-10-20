/**
 * MCP 工具层：把「长篇网文写作助手」的能力暴露成 MCP 工具。
 *
 * 两条铁律：
 *  1. 内容进、内容出 —— 服务端只在自己的书库里读写，不接受调用方的任意文件路径。
 *  2. 定位 = 书库根目录 + 受限 bookId —— bookId 只允许中英文/数字/-/_，且解析结果必须落在书库内（含符号链接检查）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { initProject, isInitialized, loadProject } from '../lib/core/project.js';
import { buildWritingBrief } from '../lib/features/context.js';
import { commitChapter } from '../lib/features/commit.js';
import { runQuery } from '../lib/features/query.js';
import { analyzePacing, renderPacingMarkdown } from '../lib/features/pacing.js';
import { reviewChapter } from '../lib/features/review.js';
import { renderKnowledgeItem } from '../lib/features/knowledge.js';
import { learnMemory, recallMemory, memoryStats, setStyleBaseline, MEMORY_KINDS, MEMORY_KIND_LABEL } from '../lib/features/memory.js';
import { projectStatus, compactStatusLine } from '../lib/features/status.js';
import { buildRestorePack } from '../lib/features/restore.js';
import { doctorCheck, renderDoctorMarkdown, doctorRebuild, doctorReconcile } from '../lib/features/doctor.js';
import { termTypeLabel } from '../lib/features/terms.js';
import { debtItemLine } from '../lib/features/ledger.js';
import { computeStructure, renderStructureTable, renderStructureDiff } from '../lib/features/structure.js';
import { STYLE_THRESHOLDS } from '../lib/features/style.js';
import { checkPlagiarism, PLAGIARISM_LIMITS } from '../lib/features/plagiarism.js';
import {
  writeMasterOutline, writeVolumeOutline, writeChapterOutline, writeChapterText, writeNote,
  readMaster, readVolume, readChapter, readChapterText, readNote,
} from '../lib/features/outline.js';
import {
  writePartOutline, archivePart, readPart, readPartSummary, PART_SUMMARY_MAX_LINES,
} from '../lib/features/parts.js';
import { toInt, countWords, wrapTitle } from '../lib/util.js';
import {
  loadCatalog, craftSections, craftGet, craftBrief, craftMap, craftCheck, renderCheck,
  BRIEF_DEFAULT_CHARS,
} from '../lib/features/craft.js';

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
    // 'off' = 任务书不带「本章必守」提示词切片；默认 on，预算见 craft.js 的 BRIEF_DEFAULT_CHARS（单一真相源）。
    briefRules: String(env.WEBNOVEL_BRIEF_RULES ?? '').trim().toLowerCase() === 'off' ? 'off' : 'on',
    // 结构换算块在 webnovel_status 里的详略：summary（默认，三行）/ full（整张表）/ off（不带）。
    // 默认不给全表：status 是每轮都可能调的省 token 入口，全表在 init 开书报告里给过一次。
    structure: ['full', 'off'].includes(String(env.WEBNOVEL_STRUCTURE ?? '').trim().toLowerCase())
      ? String(env.WEBNOVEL_STRUCTURE).trim().toLowerCase()
      : 'summary',
    briefRulesChars: (() => {
      const n = Number(env.WEBNOVEL_BRIEF_RULES_CHARS);
      return Number.isFinite(n) && n > 0 ? Math.min(6000, Math.round(n)) : BRIEF_DEFAULT_CHARS;
    })(),
    // 外部查重（v1.4.0）：指向 websearch MCP（本机 8300 的 /mcp）。
    // 不配 = 查重功能明示「未执行」，不假装通过；配置了但不可达也如实报错。
    searchUrl: String(env.WEBNOVEL_SEARCH_URL ?? '').trim(),
    searchToken: String(env.WEBNOVEL_SEARCH_TOKEN ?? '').trim(),
    searchTimeoutMs: (() => {
      const n = Number(env.WEBNOVEL_SEARCH_TIMEOUT_MS);
      return Number.isFinite(n) && n > 0 ? n : PLAGIARISM_LIMITS.timeoutMs;
    })(),
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

/** 不接受 bookId 的工具（供契约测试共用同一口径，别在测试里重抄一遍名单）。 */
export const NO_BOOK_PARAM = new Set(['webnovel_init', 'webnovel_books', 'webnovel_craft']);

function tool(name, description, properties, required, handler) {
  const props = { ...properties };
  // craft 操作的是仓库里的提示词切片库，与具体某本书无关，塞 bookId 只会诱导模型乱传。
  if (!NO_BOOK_PARAM.has(name)) props.bookId = BOOK_PARAM;
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
const COMMIT_TOP_FIELDS = ['summary', 'strand', 'hook', 'ending', 'title', 'wordCount', 'force', 'pov'];
const DELTA_FIELDS = ['protagonist', 'characters', 'world', 'timeline', 'foreshadowing', 'terms', 'knowledge'];

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
      const prevMeta = loadProject(dir);
      const result = initProject(dir, {
        title: args.title,
        genre: args.genre,
        genreTags: args.genreTags,
        logline: args.logline,
        targetWords: args.targetWords,
        targetChapters: args.targetChapters,
      });

      // 2.1「输出调整说明」：改目标体量是写操作，必须告诉作者哪些结构参数被重算。
      // 同值重跑、老项目缺字段（按缺省值补）都不输出——没有变化就不许制造噪音。
      const adjustment = [];
      if (result.existed && prevMeta) {
        const nextWords = Number(result.meta.targetWords);
        const nextChapters = Number(result.meta.targetChapters);
        const prevWordsRaw = Number(prevMeta.targetWords);
        const prevChaptersRaw = Number(prevMeta.targetChapters);
        const oldWords = Number.isFinite(prevWordsRaw) && prevWordsRaw > 0 ? prevWordsRaw : nextWords;
        const oldChapters = Number.isFinite(prevChaptersRaw) && prevChaptersRaw > 0 ? prevChaptersRaw : nextChapters;
        if (oldWords !== nextWords || oldChapters !== nextChapters) {
          adjustment.push(...renderStructureDiff(
            computeStructure({ targetWords: oldWords, targetChapters: oldChapters }),
            computeStructure({ targetWords: nextWords, targetChapters: nextChapters }),
            { prevTargetChapters: oldChapters, nextTargetChapters: nextChapters },
          ));
        }
      }

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
        ...(adjustment.length > 0 ? ['', ...adjustment] : []),
        '',
        '目录结构：',
        '```',
        '设定集/    世界观、力量体系、主角卡、金手指',
        '大纲/      总纲、卷纲/、章纲/',
        '正文/      章节正文',
        '.webnovel/ 状态、索引、伏笔台账、提交链（机器维护）',
        '```',
        '',
        ...renderStructureTable(computeStructure({
          targetWords: result.meta.targetWords,
          targetChapters: result.meta.targetChapters,
        })),
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
    '一句话看清「写到哪了、有什么没做完」：进度、主角状态、下一章、体量结构换算、以及按优先级排序的待办清单。'
      + '当用户问「写到哪了 / 什么进度 / 接下来该做什么 / 我还有什么没做 / 这本书该分几部」，'
      + '或你刚开始一次写作会话需要建立全局认知时使用。这是最省 token 的入口工具。'
      + '结构部分由目标字数按提示词第二节公式现算（部数/卷数/大层级数/反派洋葱层数/悬念账户层数/弧光段数/归档次数），'
      + '不需要用户配置；默认只给三行摘要，要逐项依据的整张换算表传 structure=full。',
    {
      structure: {
        type: 'string',
        enum: ['summary', 'full', 'off'],
        description: '体量结构换算块的详略：summary（默认三行）/ full（整张表，含恒定区间与节号）/ off（不带）。',
      },
    },
    [],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const status = projectStatus(dir, { structure: args.structure ?? config?.structure ?? 'summary' });
      return [...status.lines, '', bookLine(config, id, dir)].join('\n');
    },
  ),

  tool(
    'webnovel_restore',
    '断点恢复包：把「写到哪了 / 手里有什么 / 下一章怎么接」拼成一份可以直接贴给新会话的交接文档。'
      + '当用户说「换会话了 / 接着上次写 / 别人接手 / 你先看看现在什么情况」，'
      + '或你自己刚接手上一次别人的活时使用。'
      + '内容就是 status + doctor 的结果按接手顺序排好，口径与单独调用完全一致，不会多算也不会少算。',
    {
      structure: {
        type: 'string',
        enum: ['summary', 'full', 'off'],
        description: '进度块里的体量结构换算详略：summary（默认）/ full / off。',
      },
    },
    [],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const pack = buildRestorePack(dir, { structure: args.structure ?? config?.structure });
      return [pack.text, '', bookLine(config, id, dir)].join('\n');
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
      + 'write_part（写第 N 部部纲并登记起止章——多部书在拆卷前先定部）、'
      + 'archive_part（部完结时归档【部总结包】压缩后的摘要，≤15 行）、'
      + 'write_chapter（写第 N 章章纲——写正文前必须先做这步）、write_text（保存第 N 章正文）、'
      + 'write_note（当日手记落盘：追加写 手记/YYYY-MM-DD.md，date 可选）、read（读回任意一项）。'
      + '章纲是写作的前置条件：没有章纲时 webnovel_context 会返回 blocker。'
      + '当用户说「定大纲 / 拆部 / 拆卷 / 写章纲 / 这章要发生什么 / 保存这章 / 记下手记」时使用。',
    {
      action: {
        type: 'string',
        enum: ['write_master', 'write_volume', 'write_part', 'archive_part', 'write_chapter', 'write_text', 'write_note', 'read'],
        description: '要执行的动作。',
      },
      text: { type: 'string', description: '要写入的 Markdown 内容（write_* 动作必填）。' },
      chapter: { type: 'number', description: '章节号（write_chapter / write_text / read 时用）。' },
      volume: { type: 'number', description: '卷号（write_volume 时用）。' },
      part: { type: 'number', description: '部号（write_part / archive_part 时用）。' },
      title: { type: 'string', description: '标题：write_text 时是章节标题；write_volume 时是卷名；write_part 时是部名。' },
      chapterRange: { type: 'string', description: '章节范围，例如 "1-150"（write_volume / write_part 时可选；部的边界以它为准）。' },
      summary: { type: 'string', description: 'archive_part 的部摘要正文（≤15 个非空行；按 2.5 的部总结包压缩）。' },
      hook: { type: 'string', description: 'write_part / archive_part 的跨部钩子（2.6：指向下一部的具体诱因，禁止「远方有大事」）。' },
      date: { type: 'string', description: '手记日期，YYYY-MM-DD（write_note 时可选，缺省今天）。' },
      scope: { type: 'string', enum: ['master', 'part', 'volume', 'chapter', 'text', 'note', 'part_summary'], description: 'read 动作读哪一项。强烈建议显式传：省略会默认落 master（总纲）或 chapter（章纲），静默读不到你要的那一项。master=总纲／part=部纲(part=N)／volume=卷纲(volume=N)／chapter=章纲(chapter=N)／text=正文(chapter=N)／note=当日手记(date=YYYY-MM-DD，缺省今天)／part_summary=已归档的部摘要(part=N)。' },
    },
    ['action'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const action = String(args.action ?? '').trim();

      if (action === 'read') {
        const explicitScope = args.scope != null && String(args.scope).trim() !== '';
        const scope = explicitScope ? String(args.scope).trim()
          : (args.chapter ? 'chapter' : 'master');
        const hint = explicitScope ? '' : `\n\n（未指定 scope，本次读的是${scope === 'chapter' ? '章纲' : '总纲'}。要读别的请显式传 scope：master 总纲 / part 部纲(part=N) / volume 卷纲(volume=N) / chapter 章纲(chapter=N) / text 正文(chapter=N) / note 手记(date=YYYY-MM-DD，缺省今天) / part_summary 部摘要(part=N)）`;
        if (scope === 'master') {
          const content = readMaster(dir);
          return (content ? `# 总纲（${id}）\n\n${content.trim()}` : `（《${id}》还没有总纲）`) + hint;
        }
        if (scope === 'part') {
          const p = args.part ?? 1;
          const content = readPart(dir, p);
          return (content ? content.trim() : `（第 ${p} 部还没有部纲）`) + hint;
        }
        if (scope === 'part_summary') {
          const p = args.part ?? 1;
          const content = readPartSummary(dir, p);
          return (content ? content.trim() : `（第 ${p} 部还没有归档摘要）`) + hint;
        }
        if (scope === 'volume') {
          const v = args.volume ?? 1;
          const content = readVolume(dir, v);
          return (content ? content.trim() : `（第 ${v} 卷还没有卷纲）`) + hint;
        }
        if (scope === 'chapter') {
          const content = readChapter(dir, args.chapter);
          return (content ? content.trim() : `（第 ${args.chapter} 章还没有章纲）`) + hint;
        }
        if (scope === 'note') {
          const found = readNote(dir, args.date);
          return (found ? found.text.trim() : `（${args.date ? args.date : '今天'} 还没有当日手记）`) + hint;
        }
        const found = readChapterText(dir, args.chapter);
        return (found ? found.text : `（第 ${args.chapter} 章还没有正文）`) + hint;
      }

      const content = String(args.text ?? '');
      if (action !== 'archive_part' && !content.trim()) throw new Error(`${action} 需要提供 text 内容`);

      if (action === 'write_master') {
        const r = writeMasterOutline(dir, content);
        return `已保存《${id}》总纲：${r.path}\n\n下一步：用 action=write_volume 拆第一卷卷纲。`;
      }
      if (action === 'write_part') {
        const r = writePartOutline(dir, args.part ?? 1, content, {
          title: args.title, chapterRange: args.chapterRange, hook: args.hook,
        });
        return `已保存第 ${r.part} 部部纲：${r.path}`
          + (r.registered?.chapterRange ? `（章节范围 ${r.registered.chapterRange}）` : '（未给 chapterRange：部末倒计时无法计算，建议补上）')
          + (r.warnings.length ? `\n\n⚠ ${r.warnings.join('\n⚠ ')}` : '')
          + '\n\n下一步：用 action=write_volume 拆本部的卷纲，再用 action=write_chapter 写章纲。';
      }
      if (action === 'archive_part') {
        const r = archivePart(dir, args.part ?? 1, args.summary, { hook: args.hook });
        return `已归档第 ${r.part} 部摘要：${r.path}（${r.lines}/${r.maxLines} 行）`
          + '\n\n历史区只留摘要：此后引用已完结部只依据它（2.5）。';
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
      const result = buildWritingBrief(dir, args.chapter, {
        rules: config.briefRules,
        rulesMaxChars: config.briefRulesChars,
      });
      return `${result.markdown}\n\n${bookLine(config, id, dir, true)}`;
    },
  ),

  tool(
    'webnovel_commit',
    '★ 写完一章后必调：把本章产生的事实变化提交落库，系统据此更新状态卡、章节索引、伏笔台账、时间线。'
      + '不提交 = 这一章发生的事不会被记住，后续章节会当作没发生过。'
      + 'deltas 里写本章的增量：主角状态变化、新角色、新地点/势力、埋下或回收的伏笔、时间线推进、本章新出现的专名（terms）。'
      + '提交时系统会扫一遍正文，把「像是专名但账本里查无此名」的词作为提醒列出来（铁律 1 名词锁定，只提醒不拦截），'
      + '确认是新名字就用 deltas.terms 登记，是误报就忽略。'
      + '提交前系统会核对本章的审查记录：还有未处理的严重问题（🔴）时会被拒绝——'
      + '先用 webnovel_review 审一遍并按建议修改；确认要按原稿提交再传 force=true。'
      + '多视角章节可传 pov（本章视角人物）与 deltas.knowledge（谁得知/使用/透露了什么）：'
      + '8.2 信息隔离会核对「得知必须有来源、使用/透露必须先知道」，违反默认拦截（force 可过）。'
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
      pov: {
        type: 'string',
        description: '本章视角人物（8.2 信息隔离）。必须是已登记角色（角色表或主角卡）。',
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
          + 'protagonist（主角状态与档案，如 {location, condition, power:{realm}, '
          + 'desire, fear, secret, contradiction, voice:{fingerprint,profanity,...}, '
          + 'humanFlaws:{habits:[],selfishMotive,errorPlan}}；desire/fear/secret/contradiction 是第六节三维，'
          + 'humanFlaws 是 6.14 主角人味三项，缺项由 webnovel_status 报待办）、'
          + 'characters（[{name, patch:{role,relation,realm,location,firstChapter,lastChapter,notes,'
          + 'desire,fear,secret,contradiction,plan,goal,arcProgress,relationLevel,relationStage,'
          + 'voice,knows,notKnows,mistaken,condition,items}}]，'
          + 'condition 是伤病/身体状态（自由文本，如「右臂骨折，未愈」）、items 是持有物品名数组（如 ["青锋剑"]），'
          + '审查拿它们做 3.6⑧ 伤病/物品归属核对；'
          + 'firstChapter/lastChapter 不传会自动填本章号；relationLevel 认 1-5 也认五级名（陌生/共事/信任/依赖/托付），'
          + 'knows/notKnows/mistaken 是 6.13 信息表、跨章累积去重，审查 3.6⑧ 拿它逐条台词核对归属，'
          + 'voice 是对象（6.5 语言指纹 + 6.13 口语档位），深合并不整份覆盖）、'
          + 'world（{factions:[],locations:[],powerSystem:[]}，只增不减）、'
          + 'timeline（{time,location,event}，每章一条；传数组会被合并为一条，多事件用「；」写在 event 里）、'
          + 'foreshadowing（{planted:[{name,plannedPayoff,importance,note,type,layer,dueChapter,readerAware,'
          + 'realExplanation,falseAssumption}], paid:["名称"], dropped:["名称"], hinted:["名称"]}）：'
          + 'type 四类债务（伏笔 foreshadow／悬念 suspense／支票 cheque／红鲱鱼 red_herring，认中文），'
          + 'layer 悬念所属层（短/卷/部/跨部/全书，本书启用哪几层看 webnovel_status 的换算表），'
          + 'dueChapter 与 plannedPayoff 同义（支票的应兑现章，落库归一进 plannedPayoff），'
          + 'readerAware=false 表示读者还没意识到（4.1：不计入悬念余额），'
          + 'hinted=本章让某条在线问题又露了一次脸（2.3 的「悬置 50 章无暗示＝警报」只看它）；'
          + 'red_herring 必须配 realExplanation（揭晓后这条线索的真实解释），否则审查会 🔴，'
          + 'terms（[{name,type,aliases?,note?}]，本章出现的新专名登记；type 认中文也认英文：'
          + '人名/地名/组织/物品/功法·技术/术语/案件/其它，firstChapter 自动填本章号，重名是合并不是新增）、'
          + 'knowledge（[{who,fact,mode:"learn"|"use"|"reveal",witnessedBy?,toldBy?,evidence?}]，8.2 信息隔离：'
          + 'learn=谁得知了什么（必须有 witnessedBy 亲眼所见或 toldBy 谁告诉的，toldBy 必须自己先知道）；'
          + 'use/reveal=谁使用/透露了什么（必须先登记 knows，且不在 notKnows）。违反默认拦截，force 可过）。'
          + '要每张【设定记录】表落在哪个键：webnovel_craft action=map。',
      },
    },
    ['chapter'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      const { normalized, notes } = normalizeCommitArgs(args);
      const result = await commitChapter(dir, normalized);

      const lines = [`已提交第 ${result.chapter} 章《${result.title}》——${result.words} 字`];
      if (result.strand) lines.push(`线别：${result.strand}`);
      // 文风基准只在首次提交建立时播一行；日常对比安静，漂移走下面的警告区。
      if (result.style?.baselineCreated) {
        lines.push(`文风基准已建立（第 ${result.style.baselineAtChapter} 章；之后每 ${STYLE_THRESHOLDS.compareEvery} 章自动对比，可用 webnovel_memory action=baseline 重设）`);
      }
      if (result.planted.length > 0) {
        lines.push(`新登记 ${result.planted.length} 条：${result.planted.map((p) => debtItemLine(p, { chapter: result.chapter })).join('、')}`);
      }
      if (result.paid.length > 0) lines.push(`已回收：${result.paid.join('、')}`);
      // 暗示登记单独播一行：它不改状态、只推 hintChapters，回执里不写出来作者会以为没生效
      // （而 2.3 的「悬置 50 章无暗示」判据吃的就是它）。
      if (result.hinted?.length > 0) lines.push(`暗示登记（第 ${result.chapter} 章露脸）：${result.hinted.join('、')}`);
      if (result.pov) lines.push(`本章视角：${result.pov}`);
      if (result.knowledge) {
        if (result.knowledge.learned?.length > 0) {
          lines.push(`认知变更（得知）：${result.knowledge.learned.map((k) => `${k.who}「${k.fact}」`).join('、')}`);
        }
        if (result.knowledge.used?.length > 0) {
          lines.push(`认知核对（使用）：${result.knowledge.used.map((k) => renderKnowledgeItem({ ...k, mode: 'use' })).join('、')}`);
        }
        if (result.knowledge.revealed?.length > 0) {
          lines.push(`认知核对（透露）：${result.knowledge.revealed.map((k) => renderKnowledgeItem({ ...k, mode: 'reveal' })).join('、')}`);
        }
      }
      if (result.overdue.length > 0) {
        lines.push(`⚠ 仍有 ${result.overdue.length} 条到期未回收：${result.overdue.map((f) => f.name).join('、')}`);
      }
      // 专名登记结果单独播报一行：作者要能看见「这次系统记住了哪些新名字」，
      // 疑似漏登记的名字由 warnings 里那条提醒负责（两者别混成一行，混了就看不出哪个要处理）。
      if (result.registered?.length > 0) {
        lines.push(`新登记专名 ${result.registered.length} 条（账本共 ${result.termsTotal} 条）：${result.registered.map((t) => `${t.name}（${termTypeLabel(t.type)}）`).join('、')}`);
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
      + 'term（专名账本：传 name 查单个名字（别名也算命中）、传 type 按类别筛、都不传列全表）、'
      + 'memory（写作经验）、search（在正文/大纲/设定/摘要里全文检索关键词）。'
      + '当用户问「主角现在什么境界 / 某某是谁 / 玉佩那条伏笔还开着吗 / 幽冥宗这个名字登记过吗 / 之前哪一章写过 X」时使用。'
      + '注意：动笔前拿上下文应该用 webnovel_context，不是这个工具。',
    {
      kind: {
        type: 'string',
        enum: ['status', 'character', 'foreshadowing', 'chapter', 'setting', 'timeline', 'term', 'memory', 'search'],
        description: '查询类型。',
      },
      name: { type: 'string', description: '角色名（kind=character）、设定篇名（kind=setting）或专名（kind=term）。' },
      type: {
        type: 'string',
        description: '专名类别过滤（kind=term 时用）。英文键 person/place/org/item/skill/term/case/other，'
          + '传中文说法也认：人名/地名/组织/物品/法宝/功法/技术/术语/案件/其它。',
      },
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
      + '维度：设定一致性（状态冲突、境界回退、已死角色出场、3.6⑧ 台词归属核对——说了他登记为「不知道」的事，以及别人的秘密被非主人说出口）、叙事连贯（与前章衔接）、'
      + '信息隔离（8.2，传 pov/knowledge 时核对得知路径与知情状态）、节奏（三线断档）、文风（15.6 漂移）、'
      + '大纲符合度、伏笔（到期未回收/埋了没登记）、追读力（章末钩子、段落长度、对话比例）、AI 味（套话/句长过于均匀/抽象名词链/伪深刻句式）。'
      + '传 plagiarism=true 时再做外部查重：抽 10–16 字特征句去 websearch MCP 比对，'
      + '命中报 🔴、有结果但无连续相同报 🟡 待人工确认；未配置 WEBNOVEL_SEARCH_URL 时明示「未执行」而不是假装通过。'
      + '当用户说「检查一下这章 / 有没有问题 / 帮我审一下 / 会不会崩设定 / 查一下有没有抄」时使用。'
      + '若不传 text，会自动读取该章正文文件。审查结果会落盘为该章的审查记录；'
      + '提交时凭这份记录放行——改过正文要重新审查（按文本指纹核对）。',
    {
      chapter: { type: 'number', description: '要审查的章节号。' },
      text: { type: 'string', description: '正文内容。不传则从 正文/ 目录读取该章文件。' },
      pov: { type: 'string', description: '本章视角人物（可选，8.2 信息隔离预检）。' },
      knowledge: {
        type: 'array',
        items: { type: 'object' },
        description: '同 commit 的 deltas.knowledge（可选，8.2 信息隔离预检）：'
          + '[{who,fact,mode,witnessedBy?,toldBy?,evidence?}]。',
      },
      plagiarism: {
        type: 'boolean',
        description: '是否执行外部查重（默认 false）。需要配置 WEBNOVEL_SEARCH_URL / WEBNOVEL_SEARCH_TOKEN；'
          + '未配置或服务不可达时报告会写「外部查重未执行」，不会当作通过。',
      },
    },
    ['chapter'],
    async (args, config) => {
      const { id, dir } = requireBook(config, args.bookId);
      // 查重的网络调用放在工具层（reviewChapter 保持同步，单测不需要起服务）。
      // 不传 text 时先读正文文件，保证「查重对象」与「审查对象」是同一份文本。
      let text = args.text;
      if (args.plagiarism && (text === undefined || text === null)) {
        text = readChapterText(dir, args.chapter)?.text;
      }
      const plagiarism = args.plagiarism
        ? await checkPlagiarism(dir, text ?? '', {
          url: config.searchUrl,
          token: config.searchToken,
          timeoutMs: config.searchTimeoutMs,
        })
        : null;
      const result = reviewChapter(dir, args.chapter, {
        text,
        pov: args.pov,
        knowledge: args.knowledge,
        plagiarism,
      });
      return `${result.markdown}\n\n${bookLine(config, id, dir)}`;
    },
  ),

  tool(
    'webnovel_memory',
    '长期写作记忆：action=learn 沉淀一条有效经验（写法/文风/人物把握/读者反馈），'
      + 'action=recall 检索已沉淀的经验，action=stats 看统计，'
      + 'action=baseline 设置文风基准（content 传 JSON 指标=人工设定；传 auto 或留空=从正文重建）。'
      + '文风基准有则优先：人工设定后，commit 的自动采样不再覆盖它；每 30 章对比一次，漂移会写审查报告并报警。'
      + '与「状态」的区别：状态记「发生了什么」，记忆记「怎么写更好」。'
      + '沉淀过的经验会自动出现在后续每章的写作任务书里。'
      + '当用户说「记住这个写法 / 以后都这样写 / 上次那个教训 / 读者反馈说要改 / 文风就按这个基准」时使用。',
    {
      action: { type: 'string', enum: ['learn', 'recall', 'stats', 'baseline'], description: '要执行的动作。' },
      kind: {
        type: 'string',
        enum: MEMORY_KINDS,
        description: '记忆类型：style=文风 / technique=写法 / setting=设定约定 / feedback=读者编辑反馈 / character=人物把握。',
      },
      title: { type: 'string', description: '一句话概括这条经验（learn 必填）。' },
      content: { type: 'string', description: '具体怎么做（learn 必填）。baseline 时：JSON 指标（如 {"avgSentence":18,"dialogueRatio":0.35}）或 auto（从正文重建）；留空等同 auto。' },
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
        let extra = '';
        if (result.baseline) {
          if (result.baseline.error) {
            extra = `\n\n⚠ 文风基准未更新：${result.baseline.error}`;
          } else {
            const b = result.baseline.baseline;
            extra = `\n\n文风基准已按这条记忆${result.baseline.kind === 'rebuild' ? '从正文重建' : '人工覆盖'}`
              + `（第 ${b.calibratedAtChapter} 章，source=${b.source}）。`;
          }
        }
        return `已记住【${result.kindLabel}】${result.title}\n\n累计 ${result.total} 条写作记忆，后续每章的写作任务书都会带上。${extra}\n\n${bookLine(config, id, dir)}`;
      }
      if (action === 'baseline') {
        const result = await setStyleBaseline(dir, args);
        const b = result.baseline;
        const metrics = Object.entries(b.metrics ?? {})
          .filter(([k]) => !['sentences', 'paragraphs'].includes(k))
          .map(([k, v]) => `${k}=${v}`)
          .join('，');
        return `文风基准已${result.kind === 'rebuild' ? '从正文重建' : '按人工值设定'}：`
          + `第 ${b.calibratedAtChapter} 章（source=${b.source}）\n指标：${metrics}\n`
          + `之后每 ${STYLE_THRESHOLDS.compareEvery} 章对比一次；漂移会写 .webnovel/reviews/style-chNNNN.json 并在提交/状态/审查里报警。`
          + `\n\n${bookLine(config, id, dir)}`;
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
      throw new Error(`未知的 action：${action}。可用：learn / recall / stats / baseline`);
    },
  ),

  tool(
    'webnovel_doctor',
    '机器态体检与重建：action=check（默认）把提交链完整重放一遍，逐项对账状态卡/索引/伏笔台账/'
      + '正文文件/摘要文件，并扫出骨架里未填的占位符；action=rebuild 从提交链重放重建机器态'
      + '（重建前自动备份到 .webnovel/trash/，记忆与审查记录不受影响）；'
      + 'action=reconcile 把「提交链之外人工维护的数据」登记成迁移基线（老书升级用，不删数据）。'
      + '提交链是唯一事实来源——怀疑「系统记的」和「实际写过的」对不上时用。'
      + '当用户说「记的怎么对不上 / 状态好像不对 / 帮我校验一下记录 / 数据是不是坏了 / 老书升级对账」时使用。'
      + '注意：检查大纲/正文内容的质量用 webnovel_review，这个工具只管机器态账目。',
    {
      action: {
        type: 'string',
        enum: ['check', 'rebuild', 'reconcile'],
        description: 'check=只读体检（默认）/ rebuild=重放重建机器态（写操作，有备份，需 confirm=true 才会执行）/ reconcile=把当前人工维护的机器态登记为迁移基线（写操作，有备份，需 confirm=true；只修正文路径/字数/进度这类客观引用，不掩盖缺章多账）。',
      },
      confirm: {
        type: 'boolean',
        description: '写操作（rebuild / reconcile）的确认门：必须显式传 true 才会执行（防误触）。check 不需要。',
      },
      reason: {
        type: 'string',
        description: '仅 reconcile：登记迁移基线的原因（写进基线文件，便于以后回查，如「手工补了 18-19 章人物备注与 4 条专名」）。',
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
      if (action === 'reconcile') {
        const result = await doctorReconcile(dir, { confirm: args.confirm === true, reason: args.reason });
        return [...result.lines, '', bookLine(config, id, dir)].join('\n');
      }
      throw new Error(`未知的 action：${action}。可用：check / rebuild / reconcile`);
    },
  ),

  tool(
    'webnovel_craft',
    '创作规则库：仓库里逐字保存的《小说创作全流程协作提示词》（19 节）按阶段切片供给。'
      + '它回答「这个阶段该怎么干」，与 webnovel_context（回答「这本书现在是什么状态」）互补，两者不重复。'
      + 'action=sections 看切片目录与阶段包大小；get 按切片号取原文（ids="15.8" 单片、ids="15" 整节、ids="all" 全篇）；'
      + 'brief 按创作阶段组包（stage=negotiate/stage1..stage7/report/record/protocol，也认「正文」「章纲」「阶段3」这类中文说法）；'
      + 'map 看【设定记录】20 表落到本书哪些账本；check 校验原文/切片库/哈希锁三方一致。'
      + '当用户问「规则怎么定的 / 这个阶段该交什么 / 设定记录怎么写 / 把提示词给我」时使用。'
      + '注意：规则原文只在本工具与 prompt/CREATIVE-PROMPT.md 一处，别抄进大纲、正文或自己的提示词文件。',
    {
      action: {
        type: 'string',
        enum: ['sections', 'get', 'brief', 'map', 'check'],
        description: 'sections=切片目录（默认）/ get=按切片号取原文 / brief=按创作阶段组包 / map=设定记录落点表 / check=完整性自检。',
      },
      ids: {
        type: 'string',
        description: 'action=get 用：切片号，逗号分隔。例："15.8,19"、"15"（整节含子节）、"all"（全篇，慎用，2.2 万字）。',
      },
      stage: {
        type: 'string',
        description: 'action=brief 用：negotiate / stage1 / stage2 / stage3 / stage4 / stage5 / stage6 / stage7 / report / record / protocol。默认 stage6（正文）。',
      },
      maxChars: {
        type: 'number',
        description: '输出预算（字数）。get 默认不限；brief 默认不限，接进自己的系统提示词时建议传 800-1200 只取最关键的切片。',
      },
      extra: {
        type: 'array',
        items: { type: 'string' },
        description: 'action=brief 用：在阶段包之外追加的切片号，例如 ["19"] 把设定记录格式一起带上。',
      },
    },
    [],
    async (args) => {
      const action = String(args.action ?? 'sections').trim() || 'sections';
      if (action === 'check') return renderCheck(craftCheck());
      if (action === 'map') return craftMap();
      const { catalog } = loadCatalog();
      if (action === 'sections') return craftSections(catalog);
      if (action === 'get') {
        const r = craftGet(catalog, args.ids, { maxChars: toInt(args.maxChars, 0) });
        const head = `原文切片 ${r.units.map((u) => u.id).join('、')}（${r.chars} 字，逐字来自 prompt/CREATIVE-PROMPT.md）：`;
        return `${head}\n\n${r.text}`;
      }
      if (action === 'brief') {
        const r = craftBrief(catalog, args.stage, {
          maxChars: toInt(args.maxChars, 0),
          extra: Array.isArray(args.extra) ? args.extra : [],
        });
        return r.text;
      }
      throw new Error(`未知的 action：${action}。可用：sections / get / brief / map / check`);
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
