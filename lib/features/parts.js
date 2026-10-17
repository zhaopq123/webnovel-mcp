/**
 * 部（part）结构层：部纲登记 + 部摘要归档 + 部末倒计时（提示词 2.4–2.6 / 13.2 / 17.6）。
 *
 * 为什么结构换算之外还要一张「已建部」表：
 * 换算表是**计划**（目标字数 → 应该有几部、每部几章），部表是**事实**（作者真正建了哪几部、
 * 每部的起止章与标题）。两者可以不一致——短书可能提前收部，改目标字数也要重算计划。
 * 所以：计划只算不存（structure.js），事实才落盘（这里）。状态行优先说事实，
 * 没有事实时退回计划口径并标明是「按目标字数换算」。
 *
 * 硬口径：
 *   · `fromChapter/toChapter` 是部的唯一边界（status 现算部位，不另存 currentPart）；
 *   · 部摘要 ≤15 行（2.5 硬性）——超了当场拒绝，让它压缩，而不是归档一份 40 行没人读的摘要；
 *   · 老书没有 parts 键 → 全部读作空数组，不报错、不硬凑部号。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, inside, partFileName, partSummaryFileName } from '../core/paths.js';
import { readText, writeTextAtomic, exists } from '../core/store.js';
import { readState, writeState } from '../core/state.js';
import { toInt } from '../util.js';
import { STRUCTURE_CONSTANTS, partPositionAt } from './structure.js';

/** 部摘要行数上限（2.5 的唯一口径；测试与渲染都从这里取，别在别处写 15）。 */
export const PART_SUMMARY_MAX_LINES = STRUCTURE_CONSTANTS.partSummaryMaxLines;

/** 部末倒计时起点（17.6：进入倒数 10 章主动启动部收尾流程）。 */
export const PART_COOLDOWN_CHAPTERS = 10;

/**
 * 解析章节范围。认 `1-150` / `1–150`（en dash）/ `1~150` / 单章 `12`。
 * 空值返回 null（范围可以后补）；写错了抛错（静默吞掉＝部表里一条无法核对的记录）。
 */
export function parseChapterRange(range) {
  if (range === null || range === undefined) return null;
  const raw = String(range).trim();
  if (!raw) return null;
  const m = raw.match(/^(\d+)\s*(?:[-–~—]\s*(\d+))?$/);
  if (!m) throw new Error(`chapterRange 要写成「起始-结束」（如 "1-150"），收到：${range}`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from <= 0 || to <= 0) throw new Error(`chapterRange 的章号必须是正整数，收到：${range}`);
  if (to < from) throw new Error(`chapterRange 的结束章不能早于起始章，收到：${range}`);
  return { from, to };
}

const rangeToString = (from, to) => `${from}-${to}`;

function rangeOf(record) {
  const from = toInt(record?.fromChapter);
  const to = toInt(record?.toChapter);
  return from > 0 && to >= from ? { from, to } : null;
}

/**
 * 写部纲并在 `state.progress.parts` 登记。重写同一部＝更新，不新增重复条目。
 * 只写作者真会维护的字段：部号/标题/起止章/跨部钩子；状态只存 planning|done
 * （「写到第几章」不存——章号是唯一真相，存一份 status=active 迟早和进度打架）。
 */
export function writePartOutline(root, part, text, meta = {}) {
  const num = toInt(part);
  if (num <= 0) throw new Error('部号必须是正整数');
  const range = parseChapterRange(meta.chapterRange); // 先校验再落盘：写错范围不该留下一份没登记的部纲
  const name = partFileName(num);
  const target = inside(root, DIRS.parts, name);
  writeTextAtomic(target, `${String(text).trim()}\n`);

  const { value: state } = readState(root);
  const parts = [...(state.progress.parts ?? [])];
  const idx = parts.findIndex((p) => toInt(p.part) === num);
  const existing = idx >= 0 ? parts[idx] : {};
  const record = {
    part: num,
    title: String(meta.title ?? existing.title ?? '').trim(),
    status: existing.status === 'done' ? 'done' : 'planning',
    ...(range ? { fromChapter: range.from, toChapter: range.to, chapterRange: rangeToString(range.from, range.to) } : {}),
  };
  if (existing.fromChapter && !range) {
    record.fromChapter = existing.fromChapter;
    record.toChapter = existing.toChapter;
    record.chapterRange = existing.chapterRange;
  }
  if (meta.hook !== undefined) record.hook = String(meta.hook).trim();
  else if (existing.hook) record.hook = existing.hook;
  if (existing.summaryPath) record.summaryPath = existing.summaryPath;
  if (existing.completedChapter) record.completedChapter = existing.completedChapter;

  if (idx >= 0) parts[idx] = { ...existing, ...record };
  else parts.push(record);
  parts.sort((a, b) => toInt(a.part) - toInt(b.part));
  writeState(root, { ...state, progress: { ...state.progress, parts } });

  // 范围重叠＝部表自己都说不清「现在在第几部」，当场提醒（不阻断：作者可能正在改结构）
  const overlaps = parts
    .filter((p) => toInt(p.part) !== num)
    .filter((p) => {
      const r = rangeOf(p);
      const mine = rangeOf(record);
      return r && mine && mine.from <= r.to && r.from <= mine.to;
    })
    .map((p) => `第 ${p.part} 部（${p.chapterRange}）`);

  return {
    path: `${DIRS.parts}/${name}`.split(path.sep).join('/'),
    part: num,
    registered: { ...existing, ...record },
    warnings: overlaps.length
      ? [`第 ${num} 部的章节范围与${overlaps.join('、')}重叠——status 会按部号小的优先，请把范围改清。`]
      : [],
  };
}

export function readPart(root, part) {
  const target = inside(root, DIRS.parts, partFileName(part));
  return exists(target) ? readText(target) : null;
}

export function listParts(root) {
  const dir = inside(root, DIRS.parts);
  try {
    return fs.readdirSync(dir)
      .map((f) => /^第(\d+)部\.md$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** 数「非空行」——空行不占摘要额度，否则作者为了压行数会把段落糊成一团。 */
export function countSummaryLines(summary) {
  return String(summary ?? '').split(/\r?\n/).filter((l) => l.trim()).length;
}

/**
 * 归档部摘要（2.5）：写完最后一部以外的每一部都要做。
 * `summary` 是【部总结包】压缩后的正文（≤15 个非空行），落到 `.webnovel/parts/partNN.md`。
 */
export function archivePart(root, part, summary, meta = {}) {
  const num = toInt(part);
  if (num <= 0) throw new Error('部号必须是正整数');
  const body = String(summary ?? '').trim();
  if (!body) throw new Error('archive_part 需要提供 summary（部总结包压缩后的摘要）');
  const lines = countSummaryLines(body);
  if (lines > PART_SUMMARY_MAX_LINES) {
    throw new Error(`部摘要 ${lines} 行，超过 2.5 的硬上限 ${PART_SUMMARY_MAX_LINES} 行——`
      + '历史区只留摘要，超了就不是摘要了。请按「主要事件（按卷）/人物结局与退场/未回收伏笔移交/世界观增量/遗留钩子/主角弧光当前格」压到 15 行内。');
  }

  const { value: state } = readState(root);
  const parts = [...(state.progress.parts ?? [])];
  const idx = parts.findIndex((p) => toInt(p.part) === num);
  if (idx < 0) {
    throw new Error(`第 ${num} 部还没登记部纲——先 action=write_part 建部（含 chapterRange），再归档摘要。`);
  }
  const existing = parts[idx];
  const name = partSummaryFileName(num);
  const header = `# 第 ${num} 部${existing.title ? `《${existing.title}》` : ''}`
    + (existing.chapterRange ? `（第 ${existing.chapterRange} 章）` : '') + ' · 部摘要';
  const target = inside(root, DIRS.partArchives, name);
  writeTextAtomic(target, `${header}\n\n${body}\n`);

  const record = {
    ...existing,
    status: 'done',
    summaryPath: `${DIRS.partArchives}/${name}`.split(path.sep).join('/'),
    summaryLines: lines,
    completedChapter: toInt(meta.completedChapter) || toInt(state.progress.currentChapter),
  };
  if (meta.hook !== undefined) record.hook = String(meta.hook).trim();
  parts[idx] = record;
  writeState(root, { ...state, progress: { ...state.progress, parts } });

  return {
    path: record.summaryPath,
    part: num,
    lines,
    maxLines: PART_SUMMARY_MAX_LINES,
    registered: record,
  };
}

export function readPartSummary(root, part) {
  const target = inside(root, DIRS.partArchives, partSummaryFileName(part));
  return exists(target) ? readText(target) : null;
}

/**
 * 找「当前部」：覆盖当前章的已建部；没有覆盖的就取起始章最靠后的未完结部
 * （作者写过了头，status 要说「部已超额」而不是装作没建部）。
 */
export function partAt(parts, chapter) {
  const list = (Array.isArray(parts) ? parts : [])
    .map((p) => ({ ...p, ...(rangeOf(p) ?? {}) }))
    .filter((p) => toInt(p.part) > 0);
  if (list.length === 0) return null;
  const ch = toInt(chapter);
  const covering = list.filter((p) => p.from && ch >= p.from && ch <= p.to);
  if (covering.length > 0) return covering.sort((a, b) => toInt(a.part) - toInt(b.part))[0];
  const started = list.filter((p) => p.from && ch >= p.from).sort((a, b) => toInt(b.part) - toInt(a.part));
  return started[0] ?? list.sort((a, b) => toInt(a.part) - toInt(b.part))[0];
}

/**
 * 部进度（status / 任务书共用一份算术）：
 *   authored = 已建部（事实），structure = 按目标字数换算的同一条战线（计划）。
 * 返回 null 表示「既没建部、也没结构信息」——新书/老书都走这条，不许硬凑。
 */
export function partProgress(state, structure, chapter) {
  const currentChapter = toInt(chapter);
  const authored = partAt(state?.progress?.parts, currentChapter);
  const r = rangeOf(authored);
  if (r) {
    const into = Math.max(0, currentChapter - r.from + 1);
    const total = r.to - r.from + 1;
    const remaining = Math.max(0, r.to - currentChapter);
    return {
      source: 'authored',
      part: toInt(authored.part),
      title: String(authored.title ?? ''),
      fromChapter: r.from,
      toChapter: r.to,
      totalChapters: total,
      chaptersIntoPart: into,
      remainingInPart: remaining,
      overdue: currentChapter > r.to,
      done: authored.status === 'done',
      cooldown: authored.status !== 'done' && remaining > 0 && remaining <= PART_COOLDOWN_CHAPTERS,
      hook: String(authored.hook ?? ''),
    };
  }
  const p = structure ? partPositionAt(structure, currentChapter) : null;
  if (p) {
    const per = toInt(structure.parts?.chaptersPerPart, p.totalChapters);
    return {
      source: 'structure',
      part: p.part,
      title: '',
      fromChapter: (p.part - 1) * per + 1,
      toChapter: p.partEndChapter,
      totalChapters: p.totalChapters,
      chaptersIntoPart: p.chaptersIntoPart,
      remainingInPart: p.remainingInPart,
      overdue: currentChapter > p.partEndChapter,
      done: false,
      cooldown: p.remainingInPart > 0 && p.remainingInPart <= PART_COOLDOWN_CHAPTERS,
      hook: '',
    };
  }
  return null;
}

/** 状态/任务书共用的一行（口径只在这一处拼）。 */
export function renderPartLine(progress) {
  if (!progress) return null;
  const title = progress.title ? `《${progress.title}》` : '';
  const source = progress.source === 'structure' ? '（按目标字数换算）' : '';
  const head = progress.chaptersIntoPart > 0
    ? `本部：第 ${progress.part} 部${title}第 ${progress.chaptersIntoPart} 章 / 共 ${progress.totalChapters} 章`
    : `本部：第 ${progress.part} 部${title}尚未开写 / 共 ${progress.totalChapters} 章`;
  if (progress.overdue) return `${head}${source}｜🔴 已超出部末第 ${progress.toChapter} 章——该收部并归档摘要了`;
  if (progress.done) return `${head}${source}｜已归档`;
  return `${head}${source}｜剩 ${progress.remainingInPart} 章（部末第 ${progress.toChapter} 章）`;
}

/** 部末倒计时提示（17.6：进入倒数 10 章主动启动收尾）。不在倒计时窗口返回 null。 */
export function renderPartCooldown(progress) {
  if (!progress || progress.done || progress.overdue || !progress.cooldown) return null;
  return `⏳ 部末倒计时：剩 ${progress.remainingInPart} 章——按 2.5 准备【部总结包】（摘要 ≤${PART_SUMMARY_MAX_LINES} 行，`
    + '用 webnovel_outline action=archive_part 归档），按 2.6 备好跨部钩子（指向下一部的具体诱因）。';
}
