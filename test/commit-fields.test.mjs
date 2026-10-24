/**
 * 提交字段语义 / 补录 / 线别补登 / 全书机检 / 完本状态 回归（1.9.0）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { commitChapter, readCommit } from '../lib/features/commit.js';
import { readIndex, readState, readBackfills, writeState } from '../lib/core/state.js';
import { setChapterStrand } from '../lib/features/pacing.js';
import { projectStatus } from '../lib/features/status.js';
import { scanBook, renderScanMarkdown } from '../lib/features/scan.js';
import { queryBackfills } from '../lib/features/query.js';
import { doctorCheck } from '../lib/features/doctor.js';
import { writeChapterText, readChapterText } from '../lib/features/outline.js';

function newProject(targetChapters = 50) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-fields-'));
  initProject(root, {
    title: '字段语义测试书',
    genre: '悬疑',
    logline: '只改一个字，不许把摘要抹掉。',
    targetWords: 100_000,
    targetChapters,
  });
  return root;
}

function writeText(root, chapter, body) {
  return writeChapterText(root, chapter, `标题${chapter}`, `# 第${chapter}章 标题${chapter}\n\n${body}\n`);
}

const HOOK = { type: '悬念钩', strength: 'strong' };
const ENDING = { time: '当晚', location: '旧宅' };

test('字段语义：不传=保留，空串/null=清空', async () => {
  const root = newProject();
  writeText(root, 1, '他推开门，屋里只有一盏灯。');
  await commitChapter(root, {
    chapter: 1, title: '灯影', summary: '主角推门进屋，发现灯下有人。', strand: 'quest',
    hook: HOOK, ending: ENDING, force: true, deltas: {},
  });

  const again = await commitChapter(root, { chapter: 1, force: true, deltas: {} });
  assert.equal(again.fields.summary, 'kept');
  assert.equal(again.fields.hook, 'kept');
  assert.equal(again.fields.ending, 'kept');
  assert.equal(again.fields.strand, 'kept');
  let entry = readIndex(root).value.chapters.find((c) => c.chapter === 1);
  assert.match(entry.summary, /灯下有人/);
  assert.equal(entry.hook.type, '悬念钩');
  assert.equal(entry.ending.location, '旧宅');
  assert.equal(entry.strand, 'quest');

  const cleared = await commitChapter(root, {
    chapter: 1, summary: '', hook: null, ending: null, force: true, deltas: {},
  });
  assert.equal(cleared.fields.summary, 'cleared');
  assert.equal(cleared.fields.hook, 'cleared');
  assert.equal(cleared.fields.ending, 'cleared');
  entry = readIndex(root).value.chapters.find((c) => c.chapter === 1);
  assert.equal(entry.summary, '');
  assert.equal(entry.hook, null);
  assert.equal(entry.ending, null);
});

test('标题撞车：write_text 与 commit 都告警', async () => {
  const root = newProject();
  writeText(root, 1, '正文一');
  await commitChapter(root, { chapter: 1, title: '纸坊', summary: '摘要', force: true, deltas: {} });
  const w = writeChapterText(root, 2, '纸坊', '# 第二章 纸坊\n\n正文二\n');
  assert.deepEqual(w.titleCollisions.map((c) => c.chapter), [1]);
  const c = await commitChapter(root, { chapter: 2, title: '纸坊', summary: '摘要', force: true, deltas: {} });
  assert.ok(c.warnings.some((x) => /标题「纸坊」与第 1 章重复/.test(x)));
});

test('摘要校验：长度与内部术语只告警不阻塞', async () => {
  const root = newProject();
  writeText(root, 3, '正文三');
  const r = await commitChapter(root, {
    chapter: 3, title: '摘要测试', summary: 'quest force paid', force: true, deltas: {},
  });
  assert.ok(r.warnings.some((x) => /摘要 \d+ 字，超出建议区间 100–400/.test(x)));
  assert.ok(r.warnings.some((x) => /内部术语：quest、force、paid/.test(x)));
});

test('backfill：历史章 deltas 进补录区，不改当前状态', async () => {
  const root = newProject();
  writeText(root, 1, '正文一');
  writeText(root, 2, '正文二');
  await commitChapter(root, { chapter: 1, title: '一', summary: '摘要一', strand: 'quest', force: true, deltas: {} });
  await commitChapter(root, { chapter: 2, title: '二', summary: '摘要二', strand: 'quest', force: true, deltas: {} });

  const r = await commitChapter(root, {
    chapter: 1,
    force: true,
    backfill: true,
    note: '补 103-119 章漏记角色',
    deltas: { characters: [{ name: '补录角色', patch: { role: '路人' } }] },
  });
  assert.deepEqual(r.backfill.keys, ['characters']);
  assert.equal(r.backfill.note, '补 103-119 章漏记角色');

  const bf = readBackfills(root).value;
  assert.equal(bf.items.length, 1);
  assert.equal(bf.items[0].chapter, 1);
  assert.equal(bf.items[0].deltas.characters[0].name, '补录角色');

  const state = readState(root).value;
  assert.equal(state.characters['补录角色'], undefined, '补录不参与状态');
  const q = queryBackfills(root, { chapter: 1 });
  assert.match(q.lines.join('\n'), /补录角色|事实：characters/);
  assert.equal(doctorCheck(root).issues.filter((i) => i.severity === 'error').length, 0);
});

test('set_strand：提交记录 / 索引 / 三线状态三处同步且 doctor 对账不飘', async () => {
  const root = newProject();
  writeText(root, 1, '正文一');
  writeText(root, 2, '正文二');
  await commitChapter(root, { chapter: 1, title: '一', summary: '摘要一', strand: 'quest', force: true, deltas: {} });
  await commitChapter(root, { chapter: 2, title: '二', summary: '摘要二', strand: 'fire', force: true, deltas: {} });

  const r = setChapterStrand(root, 1, '世界观');
  assert.equal(r.old, 'quest');
  assert.equal(r.strand, 'constellation');
  assert.equal(readCommit(root, 1).strand, 'constellation');
  assert.equal(readIndex(root).value.chapters.find((c) => c.chapter === 1).strand, 'constellation');
  const hist = readState(root).value.strand.history.find((h) => h.chapter === 1);
  assert.equal(hist.strand, 'constellation');
  assert.equal(doctorCheck(root).issues.filter((i) => i.code === 'replay-strand').length, 0);
});

test('status：进度指针超过目标章数时显示已完本', async () => {
  const root = newProject(300);
  writeText(root, 1, '正文一');
  writeText(root, 2, '正文二');
  await commitChapter(root, { chapter: 1, title: '一', summary: '摘要一', force: true, deltas: {} });
  await commitChapter(root, { chapter: 2, title: '二', summary: '摘要二', force: true, deltas: {} });
  const { value: state } = readState(root);
  state.progress.currentChapter = 723;
  writeState(root, state);

  const status = projectStatus(root);
  assert.equal(status.stats.finished, true);
  assert.ok(status.lines.some((l) => /下一章：已完本/.test(l)));
  assert.ok(!status.lines.some((l) => /下一章：第 724 章/.test(l)));
});

test('全书机检：禁词/长句/段内重复/标点/引号/空行都能报出', () => {
  const root = newProject();
  writeChapterText(root, 1, '测试', [
    '# 第一章 测试',
    '',
    '他勾起唇角，眼底闪过一丝光，心脏猛地一缩。',
    '',
    '',
    '这是一段重复重复重复重复的段落，重复重复重复重复又来了。',
    '他说：ok, very good. 然后转身。',
    '“没有闭合的引号。',
    '这是一个非常非常非常非常非常非常非常非常非常非常非常非常长的句子，长到超过四十个字还要继续写下去才能停。',
  ].join('\n'));
  writeChapterText(root, 2, '测试二', '# 第二章 测试二\n\n这是一段重复重复重复重复的段落，重复重复重复重复又来了。\n');

  const result = scanBook(root);
  assert.equal(result.stats.chapters, 2);
  assert.ok(result.issues.banned.count >= 2);
  assert.ok(result.issues.longSentences.count >= 1);
  assert.ok(result.issues.repeat6.count >= 1);
  assert.ok(result.issues.latin.count >= 2);
  assert.ok(result.issues.halfWidth.count >= 2);
  assert.ok(result.issues.blankLines.count >= 1);
  assert.ok(result.issues.quoteBalance.imbalanced.length >= 1);
  assert.ok(result.issues.crossChapter.count >= 1);
  const md = renderScanMarkdown(result);
  assert.match(md, /全书机检报告/);
  assert.match(md, /15\.5 禁词/);
});
