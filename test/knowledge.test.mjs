/**
 * 多视角信息隔离（8.2）测试（v1.4.0 未闭环清零 · 第 5 条）。
 *
 * 要证明的事：
 * 1. 无见证的 learn、非知情者的 use/reveal、未登记的 pov 都能让 review 变红；
 * 2. commit 默认拦截，force 可过且「被拒条目」不会写进状态；
 * 3. 合法「目击→得知→使用→转述」链绿，且同章先 learn 后 use 不被误伤；
 * 4. 信息变更能跨章重放（doctor check 仍绿）；
 * 5. 老书不填 pov/knowledge 不报错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { chapterFileName } from '../lib/core/paths.js';
import { commitChapter, readCommit } from '../lib/features/commit.js';
import { reviewChapter } from '../lib/features/review.js';
import { doctorCheck } from '../lib/features/doctor.js';
import { readState } from '../lib/core/state.js';

function newProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-knowledge-'));
  initProject(root, {
    title: '信息隔离测试书',
    genre: '悬疑',
    logline: '谁知道什么，必须说得清。',
    targetWords: 100_000,
    targetChapters: 50,
  });
  return root;
}

function writeText(root, chapter, text = '他推开门，屋里只有一盏灯亮着。') {
  const dir = path.join(root, '正文');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, chapterFileName(chapter, '测试')), text, 'utf8');
}

async function seedCast(root) {
  await commitChapter(root, {
    chapter: 1,
    title: '第一章',
    summary: '人物登场',
    strand: 'quest',
    force: true,
    wordCount: 100,
    deltas: {
      protagonist: { name: '林越' },
      characters: [{ name: '沈九', patch: { role: '师兄' } }],
    },
  });
}

function knowledgeErrors(result) {
  return result.issues.filter((i) => i.dimension === 'knowledge' && i.severity === 'error');
}

async function commitChapter2(root, extra = {}) {
  writeText(root, 2);
  return commitChapter(root, {
    chapter: 2,
    title: '第二章',
    summary: '得知与使用',
    strand: 'quest',
    ...extra,
  });
}

test('无见证的 learn：review 🔴，commit 默认拦截', async () => {
  const root = newProject();
  await seedCast(root);
  const knowledge = [{ who: '林越', fact: '城主是内奸', mode: 'learn' }];

  const reviewed = reviewChapter(root, 2, { text: '……', pov: '林越', knowledge });
  const errors = knowledgeErrors(reviewed);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /没有来源/);

  await assert.rejects(
    () => commitChapter2(root, { pov: '林越', deltas: { knowledge } }),
    /信息隔离校验未过.*没有来源/s,
  );
});

test('非知情者使用 / 透露：都能红', async () => {
  const root = newProject();
  await seedCast(root);

  const used = reviewChapter(root, 2, {
    text: '……',
    knowledge: [{ who: '沈九', fact: '城主是内奸', mode: 'use' }],
  });
  assert.match(knowledgeErrors(used)[0].message, /还没登记知道/);

  const revealed = reviewChapter(root, 2, {
    text: '……',
    knowledge: [{ who: '沈九', fact: '城主是内奸', mode: 'reveal' }],
  });
  assert.match(knowledgeErrors(revealed)[0].message, /还没登记知道/);
});

test('pov 不是已登记角色：能红', async () => {
  const root = newProject();
  await seedCast(root);
  const reviewed = reviewChapter(root, 2, { text: '……', pov: '路人甲' });
  assert.match(knowledgeErrors(reviewed)[0].message, /不在角色表/);
});

test('toldBy 自己不知道：转述链断裂能红', async () => {
  const root = newProject();
  await seedCast(root);
  const reviewed = reviewChapter(root, 2, {
    text: '……',
    knowledge: [{ who: '林越', fact: '城主是内奸', mode: 'learn', toldBy: '沈九' }],
  });
  assert.match(knowledgeErrors(reviewed)[0].message, /自己并不知道/);
});

test('合法链：目击→得知→使用→转述→透露，同章顺序推进，跨章可重放', async () => {
  const root = newProject();
  await seedCast(root);

  const knowledge = [
    { who: '林越', fact: '城主是内奸', mode: 'learn', witnessedBy: '密信' },
    { who: '林越', fact: '城主是内奸', mode: 'use', evidence: '林越把密信按在桌上' },
    { who: '沈九', fact: '城主是内奸', mode: 'learn', toldBy: '林越' },
    { who: '沈九', fact: '城主是内奸', mode: 'reveal' },
  ];
  const reviewed = reviewChapter(root, 2, { text: '……', pov: '林越', knowledge });
  assert.equal(knowledgeErrors(reviewed).length, 0, JSON.stringify(reviewed.issues));

  const result = await commitChapter2(root, { pov: '林越', deltas: { knowledge } });
  assert.equal(result.pov, '林越');
  assert.deepEqual(result.knowledge.learned, [
    { who: '林越', fact: '城主是内奸' },
    { who: '沈九', fact: '城主是内奸' },
  ]);
  assert.equal(result.knowledge.used.length, 1);
  assert.equal(result.knowledge.revealed.length, 1);

  const state = readState(root).value;
  assert.ok(state.protagonist.knows.includes('城主是内奸'));
  assert.ok(state.characters['沈九'].knows.includes('城主是内奸'));

  const record = readCommit(root, 2);
  assert.equal(record.pov, '林越');
  assert.equal(record.deltas.knowledge.length, 4);

  const doctor = doctorCheck(root);
  assert.equal(doctor.ok, true, JSON.stringify(doctor.issues));
});

test('learn 会同步移出 notKnows（反转后不再判「不知道」）', async () => {
  const root = newProject();
  await seedCast(root);
  await commitChapter(root, {
    chapter: 2,
    title: '第二章',
    summary: '起初不知道',
    strand: 'quest',
    force: true,
    wordCount: 100,
    deltas: { characters: [{ name: '沈九', patch: { notKnows: ['城主是内奸'] } }] },
  });

  // 反转为「其实知道」：learn 后 notKnows 必须移除，否则下一章使用会被自己拦住
  await commitChapter(root, {
    chapter: 3,
    title: '第三章',
    summary: '反转',
    strand: 'quest',
    force: true,
    wordCount: 100,
    deltas: {
      knowledge: [{ who: '沈九', fact: '城主是内奸', mode: 'learn', witnessedBy: '暗格里的账本' }],
    },
  });
  const state = readState(root).value;
  assert.ok(state.characters['沈九'].knows.includes('城主是内奸'));
  assert.equal(state.characters['沈九'].notKnows.includes('城主是内奸'), false);

  const reviewed = reviewChapter(root, 4, {
    text: '……',
    knowledge: [{ who: '沈九', fact: '城主是内奸', mode: 'use' }],
  });
  assert.equal(knowledgeErrors(reviewed).length, 0);
});

test('force 提交：被拒条目不会写进状态，回执保留告警', async () => {
  const root = newProject();
  await seedCast(root);
  const result = await commitChapter2(root, {
    force: true,
    deltas: {
      knowledge: [
        { who: '沈九', fact: '城主是内奸', mode: 'use' },
        { who: '林越', fact: '城门巳时关闭', mode: 'learn', witnessedBy: '城门口告示' },
      ],
    },
  });
  assert.equal(result.knowledge.rejected, 1);
  assert.ok(result.warnings.some((w) => /force 提交.*信息隔离/.test(w)));
  assert.deepEqual(result.knowledge.learned, [{ who: '林越', fact: '城门巳时关闭' }]);
  const state = readState(root).value;
  assert.equal((state.characters['沈九'].knows ?? []).includes('城主是内奸'), false);
  assert.ok(state.protagonist.knows.includes('城门巳时关闭'));
});

test('老书不填 pov/knowledge：review 与 commit 都不报错', async () => {
  const root = newProject();
  await seedCast(root);
  const reviewed = reviewChapter(root, 2, { text: '……' });
  assert.equal(reviewed.issues.filter((i) => i.dimension === 'knowledge').length, 0);
  const result = await commitChapter2(root, {});
  assert.equal(result.knowledge, null);
  assert.equal(result.pov, null);
  assert.equal(doctorCheck(root).ok, true);
});
