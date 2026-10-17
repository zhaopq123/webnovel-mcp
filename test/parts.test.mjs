/**
 * 部（part）结构层测试（v1.3.0 · 实施计划第 14 条：2.4–2.6 / 13.2 / 17.6）。
 *
 * 三层：
 *   ① 纯函数：章节范围解析、当前部判定、部末倒计时（阈值只认常量）；
 *   ② 落盘：写部纲 → state.progress.parts 登记（重写不重复）、归档摘要 ≤15 行硬线；
 *   ③ 出口：status 提「当前部 + 倒计时 + 待办」、任务书带同一行、read 读得回来。
 * 再加两条边界：没建部的新书/老书不硬凑部号；doctor rebuild 不许把部表冲掉。
 * 全程独立临时目录，不碰任何真实书。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FILES } from '../lib/core/paths.js';
import { readState } from '../lib/core/state.js';
import { doctorCheck, doctorRebuild } from '../lib/features/doctor.js';
import { computeStructure, STRUCTURE_CONSTANTS } from '../lib/features/structure.js';
import {
  parseChapterRange, partAt, partProgress, renderPartLine, renderPartCooldown,
  countSummaryLines, PART_SUMMARY_MAX_LINES, PART_COOLDOWN_CHAPTERS,
} from '../lib/features/parts.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

const stateOf = (root) => readState(path.join(root, 'b1')).value;

async function book({ targetWords = 1_000_000, targetChapters = 400 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-part-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: root }), token: '' };
  await applyTool('webnovel_init', {
    bookId: 'b1', title: '部结构测试', genre: '玄幻', targetWords, targetChapters,
  }, config);
  return { root, config };
}

async function commit(root, config, chapter) {
  return applyTool('webnovel_commit', {
    bookId: 'b1', chapter, title: `第${chapter}章`, summary: `第 ${chapter} 章摘要`, force: true,
  }, config);
}

const lines = (n, tag = '事件') => Array.from({ length: n }, (_, i) => `- ${tag}${i + 1}`).join('\n');

/* ------------------------------------------------------------------ *
 * ① 纯函数
 * ------------------------------------------------------------------ */

test('部 · 章节范围解析：三种连字符都认、写错当场抛、空值留给后补', () => {
  assert.deepEqual(parseChapterRange('1-150'), { from: 1, to: 150 });
  assert.deepEqual(parseChapterRange('1–150'), { from: 1, to: 150 }, 'en dash（复制提示词时最常见）');
  assert.deepEqual(parseChapterRange('1~150'), { from: 1, to: 150 });
  assert.deepEqual(parseChapterRange('12'), { from: 12, to: 12 }, '单章范围');
  assert.equal(parseChapterRange(''), null);
  assert.equal(parseChapterRange(null), null);
  assert.throws(() => parseChapterRange('第一部'), /起始-结束/);
  assert.throws(() => parseChapterRange('150-1'), /结束章不能早于起始章/);
  assert.throws(() => parseChapterRange('0-10'), /正整数/);
});

test('部 · 当前部判定：覆盖优先；写过头时取最近开工的部（而不是装作没建部）', () => {
  const parts = [
    { part: 1, fromChapter: 1, toChapter: 150, title: '一' },
    { part: 2, fromChapter: 151, toChapter: 300, title: '二' },
  ];
  assert.equal(partAt(parts, 1).part, 1);
  assert.equal(partAt(parts, 150).part, 1);
  assert.equal(partAt(parts, 151).part, 2);
  assert.equal(partAt(parts, 400).part, 2, '超出全部部末 → 最近开工的部（status 会报超额）');
  assert.equal(partAt([], 10), null);
  assert.equal(partAt(undefined, 10), null, '老书没有 parts 键');
});

test('部 · 换算表口径（没建部时）：100 万字 → 2 部，每部 143 章，倒数 10 章触发', () => {
  const s = computeStructure({ targetWords: 1_000_000, targetChapters: 400, currentChapter: 10 });
  const p = partProgress({ progress: { parts: [] } }, s, 10);
  assert.equal(p.source, 'structure');
  assert.equal(p.part, 1);
  assert.equal(p.totalChapters, 143);
  assert.equal(p.remainingInPart, 133);
  assert.equal(p.cooldown, false);
  const near = partProgress({ progress: { parts: [] } }, s, 143 - PART_COOLDOWN_CHAPTERS + 1);
  assert.equal(near.cooldown, true, `剩 ${PART_COOLDOWN_CHAPTERS} 章必须进倒计时（17.6）`);
  assert.equal(partProgress({ progress: { parts: [] } }, s, 143).cooldown, false, '部末当章不再喊倒计时');
});

test('部 · 已建部（事实）覆盖换算（计划），并由 from/to 现算进度', () => {
  const state = { progress: { parts: [{ part: 1, title: '风起', fromChapter: 1, toChapter: 150, status: 'planning' }] } };
  const s = computeStructure({ targetWords: 1_000_000, currentChapter: 141 });
  const p = partProgress(state, s, 141);
  assert.equal(p.source, 'authored', '部表是事实，优先级高于按字数均分的计划');
  assert.equal(p.chaptersIntoPart, 141);
  assert.equal(p.remainingInPart, 9);
  assert.equal(p.cooldown, true);
  assert.match(renderPartLine(p), /第 1 部《风起》第 141 章 \/ 共 150 章/);
  assert.match(renderPartLine(p), /剩 9 章/);
  assert.match(renderPartCooldown(p), /archive_part/);

  const overdue = partProgress(state, s, 151);
  assert.equal(overdue.overdue, true);
  assert.match(renderPartLine(overdue), /已超出部末第 150 章/);
  assert.equal(renderPartCooldown(overdue), null, '超额了就不是「倒计时」而是「该收部」');

  const done = partProgress({ progress: { parts: [{ ...state.progress.parts[0], status: 'done' }] } }, null, 100);
  assert.equal(done.done, true);
  assert.match(renderPartLine(done), /已归档/);
  assert.equal(renderPartCooldown(done), null);
  assert.equal(partProgress({ progress: {} }, null, 100), null, '既没建部也没结构信息 → null，不造数');
});

test('部 · 摘要行数只数非空行，上限与 2.5 常量同源', () => {
  assert.equal(PART_SUMMARY_MAX_LINES, STRUCTURE_CONSTANTS.partSummaryMaxLines);
  assert.equal(countSummaryLines('- a\n\n- b\n\n\n- c\n'), 3, '空行不占额度');
  assert.equal(countSummaryLines(''), 0);
});

/* ------------------------------------------------------------------ *
 * ② 落盘：部纲登记 + 摘要归档
 * ------------------------------------------------------------------ */

test('部 · write_part 落盘并登记；重写同一部＝更新，不新增重复条目', async () => {
  const { root, config } = await book();
  try {
    const out = await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_part', part: 1, title: '风起', chapterRange: '1-150', text: '# 第一部大纲\n- 第一幕：…',
    }, config);
    assert.match(out, /已保存第 1 部部纲/);
    assert.match(out, /章节范围 1-150/);
    assert.ok(fs.existsSync(path.join(root, 'b1', '大纲', '部纲', '第1部.md')), '部纲要落在 大纲/部纲/');

    let parts = stateOf(root).progress.parts;
    assert.equal(parts.length, 1);
    assert.deepEqual(
      { part: parts[0].part, title: parts[0].title, from: parts[0].fromChapter, to: parts[0].toChapter, status: parts[0].status },
      { part: 1, title: '风起', from: 1, to: 150, status: 'planning' },
    );
    assert.equal(parts[0].chapterRange, '1-150', '范围字符串留一份，read/status 直接可读');

    // 建了部但一章都还没写：说「尚未开写」，不报「第 0 章」
    const fresh = await applyTool('webnovel_status', { bookId: 'b1' }, config);
    assert.match(fresh, /第 1 部《风起》尚未开写 \/ 共 150 章/);
    assert.doesNotMatch(fresh, /第 0 章/);

    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_part', part: 1, title: '风起（改）', chapterRange: '1-140', text: '# 改过的第一部大纲',
    }, config);
    parts = stateOf(root).progress.parts;
    assert.equal(parts.length, 1, '重写同一部不该变成两条');
    assert.equal(parts[0].title, '风起（改）');
    assert.equal(parts[0].toChapter, 140);

    // 范围重叠：写第 2 部时范围压在第 1 部上，当场提醒（作者正在改结构，不阻断）
    const overlap = await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_part', part: 2, title: '重叠', chapterRange: '100-260', text: '# 第二部',
    }, config);
    assert.match(overlap, /与第 1 部.*重叠/);

    // 不给范围也允许（后补），但回执要提醒倒计时算不了
    const noRange = await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_part', part: 3, title: '待定', text: '# 第三部',
    }, config);
    assert.match(noRange, /未给 chapterRange/);
    assert.equal(stateOf(root).progress.parts.find((p) => p.part === 3).fromChapter, undefined);

    // 范围写错：当场报错，且不该留下一份「有部纲、没登记」的半成品文件
    await assert.rejects(
      () => applyTool('webnovel_outline', {
        bookId: 'b1', action: 'write_part', part: 4, title: '写错', chapterRange: '第一部', text: '# 第四部',
      }, config),
      /起始-结束/,
    );
    assert.ok(!fs.existsSync(path.join(root, 'b1', '大纲', '部纲', '第4部.md')), '校验失败不落盘');
    assert.equal(stateOf(root).progress.parts.find((p) => p.part === 4), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('部 · archive_part：没登记不许归档；超 15 行拒绝；15 行收下并落 .webnovel/parts/', async () => {
  const { root, config } = await book();
  try {
    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_part', part: 1, title: '风起', chapterRange: '1-3', text: '# 第一部大纲',
    }, config);
    await commit(root, config, 1);

    await assert.rejects(
      () => applyTool('webnovel_outline', { bookId: 'b1', action: 'archive_part', part: 2, summary: '- x' }, config),
      /还没登记部纲/,
    );
    await assert.rejects(
      () => applyTool('webnovel_outline', { bookId: 'b1', action: 'archive_part', part: 1, summary: lines(PART_SUMMARY_MAX_LINES + 1) }, config),
      new RegExp(`超过 2\\.5 的硬上限 ${PART_SUMMARY_MAX_LINES} 行`),
      '超行数必须拒绝：归档一份没人读的长摘要等于没归档',
    );

    const out = await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'archive_part', part: 1, summary: lines(PART_SUMMARY_MAX_LINES), hook: '下一部：北境来信，点名要林晚的命',
    }, config);
    assert.match(out, new RegExp(`${PART_SUMMARY_MAX_LINES}/${PART_SUMMARY_MAX_LINES} 行`));

    const file = path.join(root, 'b1', '.webnovel', 'parts', 'part01.md');
    assert.ok(fs.existsSync(file), '部摘要要落在 .webnovel/parts/part01.md');
    const archived = fs.readFileSync(file, 'utf8');
    assert.match(archived, /^# 第 1 部《风起》（第 1-3 章） · 部摘要/);
    assert.match(archived, /事件15/);

    const rec = stateOf(root).progress.parts[0];
    assert.equal(rec.status, 'done');
    assert.equal(rec.summaryPath, '.webnovel/parts/part01.md');
    assert.equal(rec.summaryLines, PART_SUMMARY_MAX_LINES);
    assert.equal(rec.completedChapter, 1, '缺省按当前进度章记');
    assert.equal(rec.hook, '下一部：北境来信，点名要林晚的命');

    // read 对称：部纲与部摘要都读得回来
    const outline = await applyTool('webnovel_outline', { bookId: 'b1', action: 'read', scope: 'part', part: 1 }, config);
    assert.match(outline, /第一部大纲/);
    const summary = await applyTool('webnovel_outline', { bookId: 'b1', action: 'read', scope: 'part_summary', part: 1 }, config);
    assert.match(summary, /部摘要/);
    const missing = await applyTool('webnovel_outline', { bookId: 'b1', action: 'read', scope: 'part_summary', part: 9 }, config);
    assert.match(missing, /还没有归档摘要/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * ③ 出口：status / 任务书
 * ------------------------------------------------------------------ */

test('部 · status 提部位与倒计时，且不再重复报换算表的估算行', async () => {
  const { root, config } = await book();
  try {
    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_part', part: 1, title: '风起', chapterRange: '1-3', text: '# 第一部',
    }, config);
    await commit(root, config, 1);

    const status = await applyTool('webnovel_status', { bookId: 'b1' }, config);
    assert.match(status, /本部：第 1 部《风起》第 1 章 \/ 共 3 章｜剩 2 章/);
    assert.match(status, /部末倒计时：剩 2 章/);
    assert.match(status, /按 2\.5 准备【部总结包】/);
    assert.match(status, /启动第 1 部收尾/);
    assert.ok(!status.split('\n').some((l) => l.startsWith('当前：')),
      `已建部时换算表的估算行会打架，要收起来：\n${status}`);

    // 任务书带同一行（写第 2 章时就知道本部快完了）
    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_chapter', chapter: 2, text: '# 第二章\n- 场景：山门\n- 目标：收尾铺垫\n- 钩子：信使到',
    }, config);
    const brief = await applyTool('webnovel_context', { bookId: 'b1', chapter: 2 }, config);
    assert.match(brief, /本部：第 1 部《风起》第 2 章 \/ 共 3 章｜剩 1 章/);
    assert.match(brief, /部末倒计时：剩 1 章/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('部 · 写超部末：status 报超额并给红待办（不是装作还在部内）', async () => {
  const { root, config } = await book();
  try {
    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_part', part: 1, title: '短部', chapterRange: '1-1', text: '# 第一部',
    }, config);
    await commit(root, config, 1);
    await commit(root, config, 2);
    const status = await applyTool('webnovel_status', { bookId: 'b1' }, config);
    assert.match(status, /已超出部末第 1 章/);
    assert.match(status, /先收部并归档部摘要/);
    assert.ok(status.split('\n').filter((l) => l.startsWith('🔴')).some((l) => /收部/.test(l)),
      `超额要有 🔴 级待办：\n${status}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * ④ 边界：没建部的老书 / doctor rebuild 不许冲掉部表
 * ------------------------------------------------------------------ */

test('部 · 没建部的新书与老书：不硬凑部号，status/任务书/体检都不报错', async () => {
  const { root, config } = await book();
  try {
    const status = await applyTool('webnovel_status', { bookId: 'b1' }, config);
    assert.doesNotMatch(status, /本部：/, '一本书没建过部时不许编部号');
    assert.doesNotMatch(status, /部末倒计时/);

    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_chapter', chapter: 1, text: '# 第一章\n- 场景：山门\n- 目标：开篇\n- 钩子：来人',
    }, config);
    const brief = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 }, config);
    assert.doesNotMatch(brief, /本部：/);

    // 手工退回 v1.2.x 的形状：state.json 里没有 progress.parts
    const statePath = path.join(root, 'b1', FILES.state);
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete raw.progress.parts;
    fs.writeFileSync(statePath, JSON.stringify(raw, null, 2));
    assert.deepEqual(stateOf(root).progress.parts, [], '老书读出空部表，不是 undefined');
    assert.equal(doctorCheck(path.join(root, 'b1')).ok, true);
    const again = await applyTool('webnovel_status', { bookId: 'b1' }, config);
    assert.doesNotMatch(again, /本部：/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('部 · doctor rebuild 不许冲掉部表（部纲/摘要不属于提交链，重建后原样在）', async () => {
  const { root, config } = await book();
  try {
    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_part', part: 1, title: '风起', chapterRange: '1-3', text: '# 第一部',
    }, config);
    await commit(root, config, 1);
    await applyTool('webnovel_outline', { bookId: 'b1', action: 'archive_part', part: 1, summary: lines(3) }, config);
    const before = stateOf(root).progress.parts;
    assert.equal(before.length, 1);

    await doctorRebuild(path.join(root, 'b1'), { confirm: true });
    const after = stateOf(root).progress.parts;
    assert.deepEqual(after, before, '重建只从提交链重放，部表不在链里——必须原样保留');
    assert.ok(fs.existsSync(path.join(root, 'b1', '.webnovel', 'parts', 'part01.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
