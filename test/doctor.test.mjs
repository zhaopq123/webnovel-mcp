/**
 * doctor 体检与重建测试（v1.1.0 P1-1）。
 *
 * 核心不变量：提交链是唯一事实来源，「重放结果 == 现役机器态」才叫健康。
 * 全程使用真实文件系统（独立临时目录），不触碰任何真实项目。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { readState, readIndex, readForeshadowing, readMemory, writeState, writeIndex } from '../lib/core/state.js';
import { commitChapter } from '../lib/features/commit.js';
import { doctorCheck, doctorRebuild } from '../lib/features/doctor.js';
import { learnMemory } from '../lib/features/memory.js';
import { writeMasterOutline, writeChapterText } from '../lib/features/outline.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

function newProject(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-doctor-'));
  initProject(root, {
    title: '体检测试书',
    genre: '都市',
    logline: '少年偶得异术，踏上寻亲之路。',
    targetWords: 100_000,
    targetChapters: 50,
    ...overrides,
  });
  return root;
}

const CHAPTER_TEXT = '夜里，他推开旧宅的门。\n\n屋里的灰尘在灯下浮着，像一层没人碰过的雪。';

/* ------------------------------------------------------------------ *
 * check
 * ------------------------------------------------------------------ */

test('体检 · 全新项目的机器态与提交链重放全绿、零问题', async () => {
  const root = newProject();
  writeMasterOutline(root, '# 总纲\n\n少年偶得异术，踏上寻亲之路。\n');
  await commitChapter(root, {
    chapter: 1, title: '第一章', summary: 's1', strand: 'quest', wordCount: 100,
    deltas: { protagonist: { name: '林越', location: '旧宅' } },
  });
  await commitChapter(root, {
    chapter: 2, title: '第二章', summary: 's2', strand: 'fire', wordCount: 200,
    hook: { type: '悬念', strength: 'strong' }, ending: { time: '夜', location: '旧宅' },
    deltas: {
      characters: [{ name: '沈九', patch: { role: '师兄' } }],
      foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 5 }] },
    },
  });

  const r = doctorCheck(root);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, [], `应零问题，实际：${JSON.stringify(r.issues)}`);
  assert.equal(r.stats.chapters, 2);
  assert.equal(r.stats.brokenCommits, 0);
});

test('体检 · 手删伏笔台账 → replay 告警；rebuild 恢复原样并留备份', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, summary: '埋下玉佩。', strand: 'quest',
    deltas: { foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 5 }] } },
  });
  await commitChapter(root, {
    chapter: 2, summary: '回收玉佩。', strand: 'quest',
    deltas: { foreshadowing: { paid: ['玉佩'] } },
  });

  // 手工把台账清空（模拟误操作）
  fs.writeFileSync(
    path.join(root, '.webnovel', 'foreshadowing.json'),
    `${JSON.stringify({ schemaVersion: 1, items: [] }, null, 2)}\n`,
  );

  const r = doctorCheck(root);
  assert.equal(r.ok, true, '台账差异是 warn 级，不阻断');
  assert.ok(
    r.issues.some((i) => i.code === 'replay-foreshadowing' && i.severity === 'warn'),
    `应有 replay-foreshadowing 告警：${JSON.stringify(r.issues)}`,
  );

  const b = await doctorRebuild(root, { confirm: true });
  assert.equal(b.applied, 2);
  assert.ok(fs.existsSync(path.join(root, b.backupDir)), '备份目录应存在');
  assert.ok(fs.existsSync(path.join(root, b.backupDir, 'foreshadowing.json')), '备份里应有原台账');

  const ledger = readForeshadowing(root).value;
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].name, '玉佩');
  assert.equal(ledger.items[0].status, 'paid', '已回收状态应被重放恢复');
  assert.equal(ledger.items[0].paidChapter, 2);

  const r2 = doctorCheck(root);
  assert.ok(!r2.issues.some((i) => i.code.startsWith('replay')), '重建后不应再有重放差异');
});

test('体检 · 索引缺账报 error；rebuild 从提交链补齐', async () => {
  const root = newProject();
  await commitChapter(root, { chapter: 1, summary: 's1', strand: 'quest', wordCount: 100 });
  await commitChapter(root, { chapter: 2, summary: 's2', strand: 'quest', wordCount: 200 });

  const idx = readIndex(root).value;
  idx.chapters = idx.chapters.filter((c) => c.chapter !== 2);
  writeIndex(root, idx);

  const r = doctorCheck(root);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'index-missing' && /第 2 章/.test(i.message)));
  assert.ok(r.issues.some((i) => i.code === 'progress-words'), '总字数与索引合计对不上应报错');

  const b = await doctorRebuild(root, { confirm: true });
  assert.equal(b.indexBefore, 1);
  assert.equal(b.indexAfter, 2);

  const r2 = doctorCheck(root);
  assert.equal(r2.ok, true);
  assert.equal(readIndex(root).value.chapters.length, 2);
});

test('体检 · 正文文件丢失报 error（file-missing）', async () => {
  const root = newProject();
  writeChapterText(root, 1, '第一章', CHAPTER_TEXT);
  await commitChapter(root, { chapter: 1, title: '第一章', summary: 's1', strand: 'quest' });

  const dir = path.join(root, '正文');
  const file = fs.readdirSync(dir).find((f) => f.startsWith('第0001章'));
  fs.unlinkSync(path.join(dir, file));

  const r = doctorCheck(root);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'file-missing' && /第 1 章/.test(i.message)));
});

test('体检 · 有未提交的正文只提示（info），不算病', async () => {
  const root = newProject();
  await commitChapter(root, { chapter: 1, summary: 's1', strand: 'quest' });
  writeChapterText(root, 5, '第五章', '还没提交的一章。');

  const r = doctorCheck(root);
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => i.code === 'text-uncommitted' && i.severity === 'info' && /第 5 章/.test(i.message)));
});

test('体检 · 提交记录损坏报 error；rebuild 跳过损坏章并如实报告', async () => {
  const root = newProject();
  await commitChapter(root, { chapter: 1, summary: 's1', strand: 'quest' });
  await commitChapter(root, { chapter: 2, summary: 's2', strand: 'quest' });

  fs.writeFileSync(path.join(root, '.webnovel', 'commits', 'ch0002.json'), '{broken json');

  const r = doctorCheck(root);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'commit-broken' && /第 2 章/.test(i.message)));

  const b = await doctorRebuild(root, { confirm: true });
  assert.deepEqual(b.skipped, [2], '损坏的章应被跳过');
  assert.equal(b.indexAfter, 1);
  assert.ok(b.lines.some((l) => /第 2 章/.test(l)), '报告里应如实说明跳过了哪章');
});

test('体检 · 骨架占位符会被扫出来（info）', async () => {
  const root = newProject({ logline: '' });
  const r = doctorCheck(root);
  assert.equal(r.ok, true, '占位符不阻断');
  const hits = r.issues.filter((i) => i.code === 'placeholder');
  assert.ok(hits.some((i) => /总纲\.md/.test(i.message)), `总纲应有占位符：${JSON.stringify(hits)}`);
  assert.ok(hits.some((i) => /世界观\.md/.test(i.message)), '世界观（缺 logline 时）应有占位符');
});

test('体检 · 是只读的：check 前后机器态文件零变化', async () => {
  const root = newProject();
  await commitChapter(root, { chapter: 1, summary: 's1', strand: 'quest', deltas: { protagonist: { name: '林越' } } });
  const files = [
    path.join(root, '.webnovel', 'state.json'),
    path.join(root, '.webnovel', 'index.json'),
    path.join(root, '.webnovel', 'foreshadowing.json'),
  ];
  const before = files.map((f) => fs.readFileSync(f, 'utf8'));

  doctorCheck(root);
  doctorCheck(root);

  files.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), before[i], `${path.basename(f)} 不许被 check 改动`));
});

/* ------------------------------------------------------------------ *
 * rebuild 的门与边界
 * ------------------------------------------------------------------ */

test('重建 · 不传 confirm 一律拒绝（防误触）', async () => {
  const root = newProject();
  await commitChapter(root, { chapter: 1, summary: 's1', strand: 'quest' });
  await assert.rejects(doctorRebuild(root, {}), /confirm=true/, '不传 confirm 应拒绝');
  await assert.rejects(doctorRebuild(root), /confirm=true/, '默认参数也应拒绝');
});

test('重建 · 空提交链拒绝重建（没有可重放的依据）', async () => {
  const root = newProject();
  await assert.rejects(doctorRebuild(root, { confirm: true }), /没有任何章节/, '空链应拒绝');
});

test('重建 · 只重建提交链能推导的部分：卷登记与写作记忆保持不动', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, title: '第一章', summary: 's1', strand: 'quest',
    deltas: { protagonist: { name: '林越', location: '旧宅' } },
  });
  await learnMemory(root, { kind: 'style', title: '短句推进', content: '打斗多用短句。' });

  // 手改：篡改主角位置 + 手工登记的卷信息
  const st = readState(root).value;
  st.protagonist.location = '篡改地';
  st.progress.volumes = [{ volume: 1, title: '第一卷·夜航', chapterRange: '1-50', status: 'planning' }];
  writeState(root, st);

  const r = doctorCheck(root);
  assert.ok(r.issues.some((i) => i.code === 'replay-protagonist'), '篡改应被告警');

  await doctorRebuild(root, { confirm: true });

  const after = readState(root).value;
  assert.equal(after.protagonist.location, '旧宅', '重放应恢复事实');
  assert.equal(after.progress.volumes[0].title, '第一卷·夜航', '卷登记不属于提交链，必须原地保留');
  assert.equal(readMemory(root).value.entries.length, 1, '写作记忆不许被动');
});

test('重建 · 中文书目录也要能备份（回归：cpSync 在 Windows 非 ASCII 路径上会打挂进程）', async () => {
  // 本机实测：Node 22.23.3 对含中文的源目录调 fs.cpSync(recursive) → 进程直接 fastfail，
  // try/catch 拦不住、退出码 127。makeBackup 正是「恢复动作」，崩在这里代价最大。
  // 修法：store.copyTree。这条用例钉住「备份真的产出文件」，改回去就红（而且是整文件红）。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-体检中文-'));
  const root = path.join(base, '書架', '中文书名');
  fs.mkdirSync(root, { recursive: true });
  initProject(root, { title: '中文书名', genre: '都市', logline: '测试', targetWords: 50_000, targetChapters: 20 });
  await commitChapter(root, { chapter: 1, title: '第一章', summary: '推开旧宅的门。', strand: 'quest', wordCount: 120 });
  await commitChapter(root, { chapter: 2, title: '第二章', summary: '门后有脚印。', strand: 'quest', wordCount: 130 });

  const b = await doctorRebuild(root, { confirm: true });
  const backupAbs = path.join(root, b.backupDir);
  assert.ok(fs.existsSync(path.join(backupAbs, 'state.json')), '备份里应有 state.json');
  const summaries = path.join(backupAbs, 'summaries');
  assert.ok(fs.existsSync(summaries), '备份里应有 summaries/（cpSync 崩在这一步）');
  assert.deepEqual(fs.readdirSync(summaries).sort(), ['ch0001.md', 'ch0002.md'], '备份的摘要篇数不对');
  assert.equal(doctorCheck(root).ok, true, '重建后体检应全绿');

  fs.rmSync(base, { recursive: true, force: true });
});

test('体检 · 历史修正模式的章可被完整重放（修正记录参与对账）', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, title: '旧题', summary: 's1', strand: 'quest', wordCount: 100,
    deltas: {
      protagonist: { name: '林越', location: '旧宅' },
      foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 5 }] },
    },
  });
  await commitChapter(root, {
    chapter: 2, summary: 's2', strand: 'quest', wordCount: 200,
    deltas: { foreshadowing: { paid: ['玉佩'] } },
  });

  // force 重提旧章 = 历史修正模式（本次 deltas 忽略，只更索引与摘要）
  await commitChapter(root, {
    chapter: 1, force: true, title: '新题', summary: '修订摘要',
    deltas: { protagonist: { location: '篡改地' } },
  });

  const r = doctorCheck(root);
  assert.equal(r.ok, true, `修正后应健康：${JSON.stringify(r.issues)}`);
  assert.ok(!r.issues.some((i) => i.code.startsWith('replay')), `修正记录重放不应产生差异：${JSON.stringify(r.issues)}`);

  // 修正后重建：历史事实（主角位置 / 已回收伏笔）必须原样恢复
  await doctorRebuild(root, { confirm: true });
  const st = readState(root).value;
  assert.equal(st.protagonist.name, '林越');
  assert.equal(st.protagonist.location, '旧宅', '修正不许把历史事实从链上抹掉');
  const ledger = readForeshadowing(root).value;
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].status, 'paid', '已回收伏笔在重建后仍是已回收');
  assert.equal(ledger.items[0].paidChapter, 2);

  const r2 = doctorCheck(root);
  assert.ok(!r2.issues.some((i) => i.code.startsWith('replay')), '重建后对账应依然全绿');
});

/* ------------------------------------------------------------------ *
 * 工具层走查
 * ------------------------------------------------------------------ */

test('医生工具 · 经工具层可调 check / rebuild，返回带书行状态尾', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-doctor-tool-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: booksRoot }), footer: 'full' };
  await applyTool('webnovel_init', { bookId: 'toolbook', title: '工具书', logline: '一句话。' }, config);
  await applyTool('webnovel_commit', {
    bookId: 'toolbook', chapter: 1, title: '第一章', summary: 's', strand: 'quest', wordCount: 100,
  }, config);

  const check = await applyTool('webnovel_doctor', { bookId: 'toolbook' }, config);
  assert.match(check, /体检报告 · 《工具书》/);
  assert.match(check, /（书：toolbook｜/, 'check 返回应带状态尾');

  await assert.rejects(
    applyTool('webnovel_doctor', { bookId: 'toolbook', action: 'rebuild' }, config),
    /confirm=true/,
    '工具层 rebuild 未确认也应被拒',
  );

  const rebuilt = await applyTool('webnovel_doctor', { bookId: 'toolbook', action: 'rebuild', confirm: true }, config);
  assert.match(rebuilt, /已从提交链重建机器态/);
  assert.match(rebuilt, /（书：toolbook｜/);

  await assert.rejects(
    applyTool('webnovel_doctor', { bookId: 'toolbook', action: 'nonsense' }, config),
    /未知的 action/,
  );
});
