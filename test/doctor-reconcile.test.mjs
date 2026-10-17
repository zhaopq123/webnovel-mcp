/**
 * 迁移对账（doctor action=reconcile）测试（v1.4.0 未闭环清零 · 第 1 条）。
 *
 * 要证明的事：
 * 1. 手工维护的机器态（不在提交链里）能让 check 变红/黄，reconcile 后 check 全绿且数据原样保留；
 * 2. reconcile 之后的 rebuild 不会再把手工数据清掉（基线参与重放）；
 * 3. reconcile 之后继续提交新章节，重放仍在基线上叠加，check 依然绿；
 * 4. 索引里的失效正文路径会被修到实际文件（老书改名的情形）；
 * 5. 结构性错误（索引缺章/多章、提交记录损坏）不会被 reconcile 掩盖；
 * 6. 工具层 action=reconcile 可用，未确认一律拒绝。
 *
 * 全程真实文件系统 + 独立临时目录，不触碰任何真实书。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import {
  readState, readIndex, readForeshadowing, readTerms, writeState, writeIndex, writeTerms,
} from '../lib/core/state.js';
import { commitChapter } from '../lib/features/commit.js';
import { doctorCheck, doctorRebuild, doctorReconcile, readBaselines } from '../lib/features/doctor.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

function newProject(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-reconcile-'));
  initProject(root, {
    title: '迁移测试书',
    genre: '都市',
    logline: '老书升级不得丢数据。',
    targetWords: 100_000,
    targetChapters: 50,
    ...overrides,
  });
  return root;
}

async function seedTwoChapters(root) {
  await commitChapter(root, {
    chapter: 1, title: '第一章', summary: 's1', strand: 'quest', wordCount: 100,
    deltas: { protagonist: { name: '林越', location: '旧宅' } },
  });
  await commitChapter(root, {
    chapter: 2, title: '第二章', summary: 's2', strand: 'fire', wordCount: 200,
    deltas: {
      characters: [{ name: '沈九', patch: { role: '师兄' } }],
      foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 5 }] },
      terms: [{ name: '旧宅', type: '地点' }],
    },
  });
}

/** 模拟「提交链之外的人工维护数据」：直接改机器态文件（老书的常见做法）。 */
function simulateManualEdits(root) {
  const st = readState(root).value;
  st.characters['沈九'].desire = '查清灭门真相';
  st.characters['沈九'].note = '18 章起改为暗中保护主角';
  st.protagonist.condition = '左臂旧伤未愈';
  writeState(root, st);

  const ledger = readForeshadowing(root).value;
  ledger.items.push({
    name: '半枚铜钱', type: 'suspense', layer: '卷',
    plantedChapter: 19, plannedPayoff: 24, status: 'open',
    note: '手工补登：第 19 章只给了一个镜头',
  });
  fs.writeFileSync(
    path.join(root, '.webnovel', 'foreshadowing.json'),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );

  const terms = readTerms(root).value;
  terms.items.push({ name: '陆守一', type: 'character', aliases: [], firstChapter: 18, note: '手工补的配角' });
  writeTerms(root, terms);
}

/* ------------------------------------------------------------------ *
 * 核心闭环
 * ------------------------------------------------------------------ */

test('对账 · 手工数据让 check 报黄 → reconcile → 全绿且数据原样保留', async () => {
  const root = newProject();
  await seedTwoChapters(root);
  simulateManualEdits(root);

  const before = doctorCheck(root);
  assert.ok(before.issues.some((i) => i.code === 'replay-characters'), '手改角色表应被告警');
  assert.ok(before.issues.some((i) => i.code === 'replay-foreshadowing'), '手改台账应被告警');
  assert.ok(before.issues.some((i) => i.code === 'replay-terms'), '手改专名账本应被告警');

  const r = await doctorReconcile(root, { confirm: true, reason: '保留 18-19 章手工维护的人物与台账' });
  assert.equal(r.basedOnChapter, 2);
  assert.ok(fs.existsSync(path.join(root, r.baselineFile)), '基线文件应落盘');
  const baseline = JSON.parse(fs.readFileSync(path.join(root, r.baselineFile), 'utf8'));
  assert.equal(baseline.kind, 'state-baseline');
  assert.equal(baseline.basedOnChapter, 2);
  assert.match(baseline.reason, /18-19 章/);

  // 人工数据必须原样在
  const st = readState(root).value;
  assert.equal(st.characters['沈九'].desire, '查清灭门真相', '角色备注应保留');
  assert.equal(st.protagonist.condition, '左臂旧伤未愈', '主角伤病应保留');
  assert.ok(readForeshadowing(root).value.items.some((i) => i.name === '半枚铜钱'), '手工台账应保留');
  assert.ok(readTerms(root).value.items.some((i) => i.name === '陆守一'), '手工专名应保留');

  const after = doctorCheck(root);
  assert.equal(after.ok, true);
  assert.ok(!after.issues.some((i) => i.code.startsWith('replay-')), `对账后不应再有重放差异：${JSON.stringify(after.issues)}`);
  assert.ok(after.issues.some((i) => i.code === 'baseline-applied' && i.severity === 'info'), '体检应说明基线已生效');
});

test('对账 · reconcile 之后 rebuild 不会清掉人工数据', async () => {
  const root = newProject();
  await seedTwoChapters(root);
  simulateManualEdits(root);
  await doctorReconcile(root, { confirm: true });

  const b = await doctorRebuild(root, { confirm: true });
  assert.ok(fs.existsSync(path.join(root, b.backupDir)), 'rebuild 仍应先备份');

  const st = readState(root).value;
  assert.equal(st.characters['沈九'].desire, '查清灭门真相', 'rebuild 后角色备注仍在');
  assert.equal(st.protagonist.condition, '左臂旧伤未愈', 'rebuild 后主角伤病仍在');
  assert.ok(readForeshadowing(root).value.items.some((i) => i.name === '半枚铜钱'), 'rebuild 后台账仍在');
  assert.ok(readTerms(root).value.items.some((i) => i.name === '陆守一'), 'rebuild 后专名仍在');
  assert.equal(doctorCheck(root).ok, true, 'rebuild 后体检应全绿');
});

test('对账 · 基线之后继续提交新章节，重放仍绿（人工数据不被新提交冲掉）', async () => {
  const root = newProject();
  await seedTwoChapters(root);
  simulateManualEdits(root);
  await doctorReconcile(root, { confirm: true });

  await commitChapter(root, {
    chapter: 3, title: '第三章', summary: 's3', strand: 'quest', wordCount: 300,
    deltas: { characters: [{ name: '沈九', patch: { location: '码头' } }] },
  });

  const r = doctorCheck(root);
  assert.equal(r.ok, true, `新提交后应仍绿：${JSON.stringify(r.issues.filter((i) => i.severity === 'error'))}`);
  assert.ok(!r.issues.some((i) => i.code.startsWith('replay-')), `新提交后不应有重放差异：${JSON.stringify(r.issues)}`);

  const st = readState(root).value;
  assert.equal(st.characters['沈九'].desire, '查清灭门真相', '基线里的人工数据应仍在');
  assert.equal(st.characters['沈九'].location, '码头', '新章节的增量应叠加在基线之上');
  assert.equal(st.progress.currentChapter, 3);
});

/* ------------------------------------------------------------------ *
 * 客观引用修复
 * ------------------------------------------------------------------ */

test('对账 · 索引指向改名前的正文文件 → 修到实际文件，check 回绿', async () => {
  const root = newProject();
  await commitChapter(root, { chapter: 1, title: '第一章', summary: 's1', strand: 'quest', wordCount: 100 });

  // 模拟 moshimianbao：正文文件是「第0002章-规则.md」，索引却还指着「第0002章-未命名.md」
  const textDir = path.join(root, '正文');
  fs.writeFileSync(path.join(textDir, '第0002章-规则.md'), '第二章正文。', 'utf8');
  await commitChapter(root, {
    chapter: 2, title: '规则', summary: 's2', strand: 'quest', wordCount: 120,
  });

  const idx = readIndex(root).value;
  const entry = idx.chapters.find((c) => Number(c.chapter) === 2);
  entry.file = '正文/第0002章-未命名.md';
  writeIndex(root, idx);

  const before = doctorCheck(root);
  assert.equal(before.ok, false);
  assert.ok(before.issues.some((i) => i.code === 'file-missing' && /第 2 章/.test(i.message)));

  const r = await doctorReconcile(root, { confirm: true });
  assert.ok(r.repairs.some((x) => /第 2 章正文路径/.test(x) && /第0002章-规则\.md/.test(x)), `应报告中修复路径：${JSON.stringify(r.repairs)}`);

  const after = readIndex(root).value;
  const fixed = after.chapters.find((c) => Number(c.chapter) === 2);
  assert.equal(fixed.file, '正文/第0002章-规则.md');
  assert.equal(doctorCheck(root).ok, true);
});

test('对账 · 索引字数/进度是陈旧值时按提交链修回（客观事实）', async () => {
  const root = newProject();
  await seedTwoChapters(root);

  const idx = readIndex(root).value;
  idx.chapters[0].words = 9999;
  writeIndex(root, idx);
  const st = readState(root).value;
  st.progress.currentChapter = 1;
  st.progress.totalWords = 1;
  writeState(root, st);

  const before = doctorCheck(root);
  assert.equal(before.ok, false);
  assert.ok(before.issues.some((i) => i.code === 'index-field-mismatch'));

  const r = await doctorReconcile(root, { confirm: true });
  assert.ok(r.repairs.some((x) => /第 1 章字数/.test(x)));
  assert.ok(r.repairs.some((x) => /当前进度/.test(x)));
  assert.ok(r.repairs.some((x) => /总字数/.test(x)));

  assert.equal(readIndex(root).value.chapters[0].words, 100);
  assert.equal(readState(root).value.progress.currentChapter, 2);
  assert.equal(doctorCheck(root).ok, true);
});

/* ------------------------------------------------------------------ *
 * 门与拒绝
 * ------------------------------------------------------------------ */

test('对账 · 不传 confirm 一律拒绝；全绿的书不需要 reconcile', async () => {
  const root = newProject();
  await seedTwoChapters(root);

  await assert.rejects(doctorReconcile(root, {}), /confirm=true/);
  await assert.rejects(doctorReconcile(root, { confirm: true }), /没有发现可用 reconcile 解决的差异/);
  assert.ok(!fs.existsSync(path.join(root, '.webnovel', 'commits', '_baseline.json')), '被拒绝时不许落基线');
});

test('对账 · 索引缺章/多章属于数据缺失，拒绝掩盖', async () => {
  const root = newProject();
  await seedTwoChapters(root);

  const idx = readIndex(root).value;
  idx.chapters = idx.chapters.filter((c) => Number(c.chapter) !== 2);
  writeIndex(root, idx);

  await assert.rejects(doctorReconcile(root, { confirm: true }), /章节集合对不上/);
  assert.ok(!fs.existsSync(path.join(root, '.webnovel', 'commits', '_baseline.json')));
});

test('对账 · 损坏的旧基线：check 报错、rebuild 与 reconcile 都拒绝', async () => {
  const root = newProject();
  await seedTwoChapters(root);
  fs.writeFileSync(path.join(root, '.webnovel', 'commits', '_baseline.json'), '{broken');

  const r = doctorCheck(root);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'baseline-broken'));

  await assert.rejects(doctorRebuild(root, { confirm: true }), /迁移基线损坏/);
  await assert.rejects(doctorReconcile(root, { confirm: true }), /迁移基线损坏/);
});

test('对账 · 二次 reconcile 归档旧基线，避免不同章号的基线互相覆盖', async () => {
  const root = newProject();
  await seedTwoChapters(root);
  simulateManualEdits(root);
  const first = await doctorReconcile(root, { confirm: true, reason: '第一次登记' });

  // 再手改一处，然后提交第 3 章之前再登记一次（模拟升级中途又手工补数据）
  const st = readState(root).value;
  st.protagonist.condition = '右肩新伤';
  writeState(root, st);

  const second = await doctorReconcile(root, { confirm: true, reason: '第二次登记' });
  assert.equal(second.basedOnChapter, first.basedOnChapter, '同章号直接覆盖，不产生归档');
  assert.equal(second.archivedBaseline, null);

  await commitChapter(root, { chapter: 3, summary: 's3', strand: 'quest', wordCount: 300 });

  // 提交完再人工补一处（模拟升级过程中又手工维护了一次），然后登记到新章号
  const st3 = readState(root).value;
  st3.protagonist.condition = '右肩新伤复发';
  writeState(root, st3);

  const third = await doctorReconcile(root, { confirm: true, reason: '新章节后再登记' });
  assert.equal(third.basedOnChapter, 3);
  assert.ok(third.archivedBaseline, '不同章号应归档旧基线');
  assert.ok(fs.existsSync(path.join(root, third.archivedBaseline)), '归档文件应存在');

  const { records } = readBaselines(root);
  assert.equal(records.length, 2, '新旧两条基线都应可读');
  assert.equal(doctorCheck(root).ok, true);
});

/* ------------------------------------------------------------------ *
 * 工具层走查
 * ------------------------------------------------------------------ */

test('医生工具 · action=reconcile 可调、未确认被拒、返回带书行状态尾', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-reconcile-tool-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: booksRoot }), footer: 'full' };
  await applyTool('webnovel_init', { bookId: 'legacybook', title: '老书', logline: '一句话。' }, config);
  await applyTool('webnovel_commit', {
    bookId: 'legacybook', chapter: 1, title: '第一章', summary: 's', strand: 'quest', wordCount: 100,
  }, config);

  // 手工改角色表（模拟老书人工维护）
  const statePath = path.join(booksRoot, 'legacybook', '.webnovel', 'state.json');
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  raw.characters = { 沈九: { name: '沈九', role: '师兄', note: '手工备注' } };
  fs.writeFileSync(statePath, `${JSON.stringify(raw, null, 2)}\n`);

  await assert.rejects(
    applyTool('webnovel_doctor', { bookId: 'legacybook', action: 'reconcile' }, config),
    /confirm=true/,
  );

  const out = await applyTool('webnovel_doctor', {
    bookId: 'legacybook', action: 'reconcile', confirm: true, reason: '老书人工备注',
  }, config);
  assert.match(out, /已登记迁移基线/);
  assert.match(out, /（书：legacybook｜/, 'reconcile 返回应带状态尾');

  const check = await applyTool('webnovel_doctor', { bookId: 'legacybook' }, config);
  assert.match(check, /✅ 结论/);
  assert.match(check, /迁移基线/);
});
