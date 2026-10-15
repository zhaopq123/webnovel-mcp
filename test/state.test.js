/**
 * 单元测试：领域状态操作。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultState, defaultIndex, defaultForeshadowing, defaultMemory,
  normalizeState, upsertChapter, findChapter, recentChapters,
  upsertForeshadowing, nextForeshadowingId, openForeshadowing,
  addMemoryEntry, searchMemory, applyProtagonistPatch, applyCharacterPatches,
  applyWorldPatch, appendTimeline, applyStrand, staleCharacters, recentCharacters,
  readState, writeState, sortChapters,
} from '../lib/core/state.js';

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-state-'));
  fs.mkdirSync(path.join(root, '.webnovel'), { recursive: true });
  return root;
}

/* ---------------- 归一化容错 ---------------- */

test('normalizeState 对空输入返回默认值', () => {
  const s = normalizeState(null);
  assert.equal(s.progress.currentChapter, 0);
  assert.deepEqual(s.world.factions, []);
});

test('normalizeState 容忍手改文件造成的字段缺失/类型错误', () => {
  const s = normalizeState({ progress: { currentChapter: 5 }, world: { factions: 'not-an-array' }, characters: [] });
  assert.equal(s.progress.currentChapter, 5);
  assert.deepEqual(s.world.factions, [], '非数组应归一化为空数组');
  assert.deepEqual(s.characters, {}, '数组应归一化为对象');
  assert.equal(s.progress.totalWords, 0, '缺失字段应补默认值');
});

/* ---------------- 章节索引 ---------------- */

test('upsertChapter 按章号覆盖且保持排序', () => {
  let index = defaultIndex();
  index = upsertChapter(index, { chapter: 3, title: 'C' });
  index = upsertChapter(index, { chapter: 1, title: 'A' });
  index = upsertChapter(index, { chapter: 2, title: 'B' });
  index = upsertChapter(index, { chapter: 2, title: 'B2' });
  assert.deepEqual(index.chapters.map((c) => c.chapter), [1, 2, 3]);
  assert.equal(findChapter(index, 2).title, 'B2');
  assert.equal(index.chapters.length, 3, '重复提交不应追加');
});

test('recentChapters 返回指定章之前的最近 n 章（倒序）', () => {
  let index = defaultIndex();
  for (let i = 1; i <= 10; i += 1) index = upsertChapter(index, { chapter: i, title: `C${i}` });
  const recent = recentChapters(index, 2, 5);
  assert.deepEqual(recent.map((c) => c.chapter), [4, 3]);
});

test('sortChapters 数值排序（不是字典序）', () => {
  const sorted = sortChapters([{ chapter: 10 }, { chapter: 2 }, { chapter: 1 }]);
  assert.deepEqual(sorted.map((c) => c.chapter), [1, 2, 10]);
});

/* ---------------- 伏笔 ---------------- */

test('nextForeshadowingId 递增', () => {
  let ledger = defaultForeshadowing();
  assert.equal(nextForeshadowingId(ledger), 'fs-001');
  ledger = upsertForeshadowing(ledger, { id: 'fs-001', name: '玉佩', plantedChapter: 1 });
  assert.equal(nextForeshadowingId(ledger), 'fs-002');
});

test('upsertForeshadowing 按名称合并而非重复添加', () => {
  let ledger = defaultForeshadowing();
  ledger = upsertForeshadowing(ledger, { id: 'fs-001', name: '玉佩', plantedChapter: 1, status: 'open' });
  ledger = upsertForeshadowing(ledger, { id: 'fs-001', status: 'paid', paidChapter: 60 });
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].status, 'paid');
  assert.equal(ledger.items[0].plantedChapter, 1, '原字段应保留');
});

test('openForeshadowing 标记超期与临近', () => {
  let ledger = defaultForeshadowing();
  ledger = upsertForeshadowing(ledger, { id: 'fs-001', name: '到期', plantedChapter: 10, plannedPayoff: 60, status: 'open' });
  ledger = upsertForeshadowing(ledger, { id: 'fs-002', name: '临近', plantedChapter: 40, plannedPayoff: 70, status: 'open' });
  ledger = upsertForeshadowing(ledger, { id: 'fs-003', name: '已回收', plantedChapter: 5, plannedPayoff: 20, status: 'paid' });

  const open = openForeshadowing(ledger, 62);
  assert.equal(open.length, 2, '只返回未回收的');
  const overdue = open.filter((f) => f.overdue);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].name, '到期');
  assert.ok(open.find((f) => f.name === '临近').aging, '应标记为临近');
});

test('openForeshadowing 超期项排前面', () => {
  let ledger = defaultForeshadowing();
  ledger = upsertForeshadowing(ledger, { id: 'fs-001', name: '正常', plantedChapter: 50, plannedPayoff: 90, status: 'open' });
  ledger = upsertForeshadowing(ledger, { id: 'fs-002', name: '超期', plantedChapter: 10, plannedPayoff: 20, status: 'open' });
  const open = openForeshadowing(ledger, 60);
  assert.equal(open[0].name, '超期');
});

/* ---------------- 长期记忆 ---------------- */

test('addMemoryEntry 追加并生成 id', () => {
  const m = addMemoryEntry(defaultMemory(), { kind: 'style', title: '短句', content: '用短句' });
  assert.equal(m.entries.length, 1);
  assert.ok(m.entries[0].id.startsWith('m-'));
});

test('addMemoryEntry 同 kind+title 更新而非重复', () => {
  let m = addMemoryEntry(defaultMemory(), { kind: 'style', title: '短句', content: '旧' });
  m = addMemoryEntry(m, { kind: 'style', title: '短句', content: '新' });
  assert.equal(m.entries.length, 1);
  assert.equal(m.entries[0].content, '新');
});

test('searchMemory 按关键词与标签检索', () => {
  let m = defaultMemory();
  m = addMemoryEntry(m, { kind: 'style', title: '打斗短句', content: '动作场面用短句', tags: ['打斗'] });
  m = addMemoryEntry(m, { kind: 'style', title: '对话', content: '对话要口语化', tags: ['对话'] });
  assert.equal(searchMemory(m, '短句').length, 1);
  assert.equal(searchMemory(m, '', ['对话']).length, 1);
  assert.equal(searchMemory(m, '不存在').length, 0);
});

/* ---------------- 状态增量 ---------------- */

test('applyProtagonistPatch 支持嵌套与点号语义', () => {
  const s = applyProtagonistPatch(defaultState(), {
    location: '青云宗', condition: '右臂受伤', power: { realm: '炼气四层' },
  });
  assert.equal(s.protagonist.location, '青云宗');
  assert.equal(s.protagonist.power.realm, '炼气四层');
  assert.equal(s.protagonist.name, '', '未提及字段应保留默认');
});

test('applyCharacterPatches upsert 角色卡', () => {
  let s = applyCharacterPatches(defaultState(), [{ name: '苏晚', patch: { role: '女主', lastChapter: 12 } }]);
  assert.equal(s.characters['苏晚'].role, '女主');
  s = applyCharacterPatches(s, [{ name: '苏晚', patch: { lastChapter: 15 } }]);
  assert.equal(s.characters['苏晚'].lastChapter, 15);
  assert.equal(s.characters['苏晚'].role, '女主', '应合并而非覆盖');
});

test('applyWorldPatch 数组累积去重', () => {
  let s = applyWorldPatch(defaultState(), { factions: ['青云宗'], locations: ['青石镇'] });
  s = applyWorldPatch(s, { factions: ['青云宗', '魔教'] });
  assert.deepEqual(s.world.factions, ['青云宗', '魔教']);
});

test('appendTimeline 同章覆盖并排序', () => {
  let s = appendTimeline(defaultState(), { chapter: 5, event: 'E5' });
  s = appendTimeline(s, { chapter: 3, event: 'E3' });
  s = appendTimeline(s, { chapter: 5, event: 'E5-new' });
  assert.deepEqual(s.timeline.map((t) => t.chapter), [3, 5]);
  assert.equal(s.timeline[1].event, 'E5-new');
});

test('applyStrand 记录断档与切换', () => {
  let s = applyStrand(defaultState(), 10, 'quest');
  assert.equal(s.strand.lastQuest, 10);
  assert.equal(s.strand.dominant, 'quest');
  s = applyStrand(s, 11, 'quest');
  assert.equal(s.strand.sinceSwitch, 1, '同线累加');
  s = applyStrand(s, 12, 'fire');
  assert.equal(s.strand.sinceSwitch, 0, '换线归零');
  assert.equal(s.strand.lastFire, 12);
  assert.equal(s.strand.history.length, 3);
});

test('applyStrand 忽略未知线别', () => {
  const s = applyStrand(defaultState(), 1, 'bogus');
  assert.equal(s.strand.dominant, 'quest', '应保持默认');
});

test('staleCharacters 找出久未出场角色', () => {
  let s = applyCharacterPatches(defaultState(), [
    { name: '老角色', patch: { lastChapter: 10 } },
    { name: '新角色', patch: { lastChapter: 95 } },
  ]);
  const stale = staleCharacters(s, 100, 30);
  assert.deepEqual(stale.map((c) => c.name), ['老角色']);
});

test('recentCharacters 找出近期出场角色', () => {
  const s = applyCharacterPatches(defaultState(), [
    { name: '老角色', patch: { lastChapter: 10 } },
    { name: '新角色', patch: { lastChapter: 95 } },
  ]);
  const recent = recentCharacters(s, 100, 15);
  assert.deepEqual(recent.map((c) => c.name), ['新角色']);
});

/* ---------------- 读写往返 ---------------- */

test('writeState / readState 往返并更新时间戳', () => {
  const root = tmpProject();
  const s = defaultState();
  s.progress.currentChapter = 7;
  writeState(root, s);
  const { value } = readState(root);
  assert.equal(value.progress.currentChapter, 7);
  assert.ok(value.progress.lastUpdated, '应写入时间戳');
});
