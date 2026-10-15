/**
 * 护栏测试（v1.1.0 P0-3 旧章重提防护；P0-2 审查门禁用例在其后追加）。
 *
 * 全程使用真实文件系统（独立临时目录），不触碰任何真实项目。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { readState, readIndex, readForeshadowing, findChapter } from '../lib/core/state.js';
import { commitChapter, readCommit } from '../lib/features/commit.js';
import { writeChapterOutline, writeChapterText } from '../lib/features/outline.js';
import { reviewChapter, readReviewRecord, reviewRecordPath } from '../lib/features/review.js';
import { textHash } from '../lib/util.js';

function newProject(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-guard-'));
  initProject(root, {
    title: '护栏测试书',
    genre: '都市',
    targetWords: 100_000,
    targetChapters: 50,
    ...overrides,
  });
  return root;
}

/* ------------------------------------------------------------------ *
 * P0-3 旧章重提防护
 * ------------------------------------------------------------------ */

test('护栏 · 旧章重提默认阻断，状态零变化', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, title: '第一章', summary: 's1', strand: 'quest',
    deltas: { protagonist: { name: '林越', location: '旧宅' } },
  });
  await commitChapter(root, { chapter: 2, title: '第二章', summary: 's2', strand: 'quest' });
  await commitChapter(root, { chapter: 3, title: '第三章', summary: 's3', strand: 'quest' });

  const before = readState(root).value;
  await assert.rejects(
    commitChapter(root, {
      chapter: 2, title: '篡改', summary: '篡改',
      deltas: { protagonist: { location: '篡改地' } },
    }),
    /早于当前进度.*force=true/s,
    '重提旧章应报错并给出 force 指引',
  );
  const after = readState(root).value;
  assert.equal(after.protagonist.location, before.protagonist.location, '被拒后状态不许有任何变化');
  assert.equal(after.progress.currentChapter, 3);
  assert.equal(JSON.stringify(after.characters), JSON.stringify(before.characters));
  // 索引里的第 2 章也不许被碰
  const idx = readIndex(root).value;
  assert.equal(findChapter(idx, 2).summary, 's2');
});

test('护栏 · force 重提 = 历史修正模式：本次 deltas 全忽略，记录延续仍生效的历史事实', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, title: '旧', summary: 's1', strand: 'quest',
    deltas: { protagonist: { name: '林越', location: '旧宅' } },
  });
  await commitChapter(root, { chapter: 2, title: '第二章', summary: 's2', strand: 'quest' });

  const r = await commitChapter(root, {
    chapter: 1, force: true, title: '旧宅', summary: '修订后的摘要',
    deltas: {
      protagonist: { location: '篡改地' },
      foreshadowing: { planted: [{ name: '硬塞的伏笔' }] },
    },
  });

  const idx = readIndex(root).value;
  assert.equal(findChapter(idx, 1).title, '旧宅', '显式提供的标题应更新');
  assert.equal(findChapter(idx, 1).summary, '修订后的摘要', '显式提供的摘要应更新');
  assert.equal(findChapter(idx, 1).strand, 'quest', '线别沿用原值，修正不许改');

  const st = readState(root).value;
  assert.equal(st.protagonist.location, '旧宅', '本次提交的 deltas 必须被忽略');
  assert.equal(readForeshadowing(root).value.items.length, 0, '伏笔不许被塞进台账');

  assert.ok(r.warnings.some((w) => /历史修正模式/.test(w)), '应明说进入了历史修正模式');

  const rec = readCommit(root, 1);
  assert.equal(rec.mode, 'correction');
  assert.deepEqual([...rec.ignoredDeltas].sort(), ['foreshadowing', 'protagonist']);
  assert.deepEqual(
    rec.deltas,
    { protagonist: { name: '林越', location: '旧宅' } },
    '修正记录必须延续本章此前已生效的事实（doctor 重放依赖），本次提交的 deltas 不许混进来',
  );
  assert.ok(rec.submittedDeltas, '本次提交的 deltas 仍留档可审计');
});

test('护栏 · 已回收伏笔不会被旧章重提弄回魂', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, summary: '埋下玉佩。', strand: 'quest',
    deltas: { foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 5 }] } },
  });
  await commitChapter(root, {
    chapter: 2, summary: '回收玉佩。', strand: 'quest',
    deltas: { foreshadowing: { paid: ['玉佩'] } },
  });
  assert.equal(readForeshadowing(root).value.items[0].status, 'paid');

  await commitChapter(root, {
    chapter: 1, force: true, summary: 's1', strand: 'quest',
    deltas: { foreshadowing: { planted: [{ name: '玉佩' }] } },
  });

  const item = readForeshadowing(root).value.items.find((i) => i.name === '玉佩');
  assert.equal(item.status, 'paid', '回魂必须被拦住');
  assert.equal(item.paidChapter, 2);
});

test('护栏 · 角色 lastChapter 不会被旧章重提拉回', async () => {
  const root = newProject();
  await commitChapter(root, { chapter: 1, summary: 's1', strand: 'quest' });
  await commitChapter(root, {
    chapter: 2, summary: 's2', strand: 'quest',
    deltas: { characters: [{ name: '沈九', patch: { role: '师兄' } }] },
  });

  await commitChapter(root, {
    chapter: 1, force: true, summary: 's1改', strand: 'quest',
    deltas: { characters: [{ name: '沈九', patch: { role: '冒名顶替' } }] },
  });

  const card = readState(root).value.characters['沈九'];
  assert.equal(card.lastChapter, 2, 'lastChapter 不许回退');
  assert.equal(card.firstChapter, 2);
  assert.equal(card.role, '师兄', '角色卡不许被旧章 patch 污染');
});

test('护栏 · 历史修正后总字数按索引重算自愈', async () => {
  const root = newProject();
  await commitChapter(root, { chapter: 1, summary: 's1', strand: 'quest', wordCount: 100 });
  await commitChapter(root, { chapter: 2, summary: 's2', strand: 'quest', wordCount: 200 });
  assert.equal(readState(root).value.progress.totalWords, 300);

  await commitChapter(root, { chapter: 1, force: true, summary: 's1', wordCount: 150 });

  const st = readState(root).value;
  assert.equal(st.progress.totalWords, 350, '总量应=逐章累加（150+200）');
  assert.equal(st.progress.currentChapter, 2, '当前进度不许被拉回');
});

test('护栏 · 同章重提（当前章）照旧应用 deltas，且记录累计生效事实', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, summary: 's1', strand: 'quest',
    deltas: { protagonist: { name: '林越', location: '旧宅' } },
  });
  await commitChapter(root, {
    chapter: 1, summary: 's2', strand: 'quest',
    deltas: { protagonist: { condition: '指腹擦伤' } },
  });

  const st = readState(root).value;
  assert.equal(st.protagonist.location, '旧宅', '上次提交的事实不许丢');
  assert.equal(st.protagonist.condition, '指腹擦伤', '本次提交照常生效');

  const rec = readCommit(root, 1);
  assert.equal(rec.mode, undefined, '同章重提不是修正模式');
  assert.deepEqual(
    rec.deltas.protagonist,
    { name: '林越', location: '旧宅', condition: '指腹擦伤' },
    '记录里的 deltas 应是本章累计生效的事实（doctor 重放依赖）',
  );
  const idx = readIndex(root).value;
  assert.equal(findChapter(idx, 1).summary, 's2');
});

/* ------------------------------------------------------------------ *
 * P0-2 审查落盘 + commit 门禁
 * ------------------------------------------------------------------ */

/** 干净的一章（无 error 级问题）。 */
const CLEAN_TEXT = [
  '林越走进院子，四下无人。',
  '"来了？"屋里传出一声问。',
  '他没有回答，只是把铁盒放在了桌上。',
  '窗外的雨声渐渐大了起来，像是谁在低声念叨着什么。他终于开口："这盒子，是从我母亲手里传下来的。"',
  '对面的人沉默了很久，忽然笑了："有意思。你知道吗，三十七年前的那个晚上，我也在场。"',
].join('\n\n');

/** 会触发 error 级冲突的一章（右臂废了还握剑）。 */
const CONFLICT_TEXT = [
  '林越右手稳稳握住剑柄，挥剑直劈，剑势如虹。',
  '他的右臂经脉尽废？不，此刻他的右手比任何时候都稳。',
  '这一剑，他等了整整三年。',
].join('\n\n');

function seedInjuredProtagonist(root) {
  return commitChapter(root, {
    chapter: 1, summary: '右臂被废。', strand: 'quest',
    deltas: { protagonist: { name: '林越', condition: '右臂经脉尽废，无法持物' } },
    force: true,
  });
}

test('门禁 · 审查结果自动落盘（含正文指纹）', async () => {
  const root = newProject();
  writeChapterText(root, 1, '第一章', CLEAN_TEXT);
  const review = reviewChapter(root, 1);

  assert.ok(review.recordPath, '应返回落盘路径');
  const rec = readReviewRecord(root, 1);
  assert.ok(rec, '审查记录应落盘');
  assert.equal(rec.chapter, 1);
  assert.equal(rec.source, 'file');
  assert.equal(rec.textHash, textHash(CLEAN_TEXT));
  assert.equal(rec.summary.error, review.summary.error);
  assert.deepEqual(rec.summary, review.summary);
});

test('门禁 · 审出 error 后提交被阻断，文案给出修法与 force 指引', async () => {
  const root = newProject();
  await seedInjuredProtagonist(root);
  writeChapterText(root, 2, '第二章', CONFLICT_TEXT);

  const review = reviewChapter(root, 2);
  assert.ok(review.summary.error > 0, `样例应审出 error，实际：${JSON.stringify(review.summary)}`);

  await assert.rejects(
    commitChapter(root, { chapter: 2, summary: '战斗。', strand: 'quest' }),
    /审查未过.*严重问题.*force=true/s,
    'error 未处理时应阻断提交',
  );
  // 被阻断时不许留下半成品
  assert.equal(readCommit(root, 2), null, '被拒提交不许写记录');
  assert.equal(findChapter(readIndex(root).value, 2), null, '被拒提交不许进索引');
});

test('门禁 · 修复重审后提交放行，提交记录带上审查摘要', async () => {
  const root = newProject();
  await seedInjuredProtagonist(root);
  writeChapterText(root, 2, '第二章', CONFLICT_TEXT);
  reviewChapter(root, 2); // 先审出问题

  writeChapterText(root, 2, '第二章', CLEAN_TEXT); // 修稿
  const recheck = reviewChapter(root, 2);
  assert.equal(recheck.summary.error, 0);

  const r = await commitChapter(root, { chapter: 2, summary: '安静的一夜。', strand: 'quest' });
  assert.equal(r.chapter, 2);
  const rec = readCommit(root, 2);
  assert.ok(rec.review, '提交记录应带审查摘要');
  assert.equal(rec.review.stale, false);
  assert.equal(rec.review.summary.error, 0);
  assert.equal(rec.review.textHash, textHash(CLEAN_TEXT));
});

test('门禁 · 没审过不阻断，但给出明确提醒', async () => {
  const root = newProject();
  writeChapterText(root, 1, '第一章', CLEAN_TEXT);
  const r = await commitChapter(root, { chapter: 1, summary: 's', strand: 'quest' });
  assert.ok(r.warnings.some((w) => /没有审查记录/.test(w)), '应提醒先审查');
  assert.equal(readCommit(root, 1).review, undefined);
});

test('门禁 · 审后改稿（旧稿）不阻断，标记 stale', async () => {
  const root = newProject();
  writeChapterText(root, 1, '第一章', CLEAN_TEXT);
  reviewChapter(root, 1);

  writeChapterText(root, 1, '第一章', `${CLEAN_TEXT}\n\n他又想起那半张地图。`);
  const r = await commitChapter(root, { chapter: 1, summary: 's', strand: 'quest' });
  assert.ok(r.warnings.some((w) => /旧稿/.test(w)), '应提醒审的是旧稿');
  const rec = readCommit(root, 1);
  assert.equal(rec.review.stale, true);
});

test('门禁 · force 可越过 error 阻断，但留痕', async () => {
  const root = newProject();
  await seedInjuredProtagonist(root);
  writeChapterText(root, 2, '第二章', CONFLICT_TEXT);
  reviewChapter(root, 2);

  const r = await commitChapter(root, { chapter: 2, summary: 's', strand: 'quest', force: true });
  assert.ok(r.warnings.some((w) => /force 提交/.test(w)), 'force 越过门禁应留痕');
  const rec = readCommit(root, 2);
  assert.ok(rec.review.summary.error > 0, '记录里仍能看到当时的严重问题数');
});

test('门禁 · 行尾空白/换行风格差异不误判旧稿', async () => {
  const root = newProject();
  writeChapterText(root, 1, '第一章', CLEAN_TEXT);
  reviewChapter(root, 1);

  // 给每行加行尾空白 + 文件尾部空行——编辑器噪音，不算改稿
  const file = fs.readdirSync(path.join(root, '正文'))
    .find((f) => f.startsWith('第0001章'));
  const raw = fs.readFileSync(path.join(root, '正文', file), 'utf8');
  fs.writeFileSync(path.join(root, '正文', file), `${raw.split('\n').map((l) => `${l}  `).join('\n')}\n\n`);

  const r = await commitChapter(root, { chapter: 1, summary: 's', strand: 'quest' });
  assert.ok(!r.warnings.some((w) => /旧稿/.test(w)), '行尾空白不该被判成旧稿');
  assert.equal(readCommit(root, 1).review.stale, false);
});

test('门禁 · 直接传文本审查（inline）也落盘', async () => {
  const root = newProject();
  writeChapterText(root, 1, '第一章', CLEAN_TEXT);
  reviewChapter(root, 1, { text: CLEAN_TEXT });
  const rec = readReviewRecord(root, 1);
  assert.equal(rec.source, 'inline');
  assert.equal(rec.textHash, textHash(CLEAN_TEXT));
});

test('门禁 · 落盘路径的章节号补零与读回一致', async () => {
  const root = newProject();
  writeChapterText(root, 12, '第十二章', CLEAN_TEXT);
  reviewChapter(root, 12);
  assert.ok(reviewRecordPath(root, 12).endsWith('ch0012.json'));
  assert.ok(readReviewRecord(root, 12), '第 12 章记录应能读回');
  assert.equal(readReviewRecord(root, 11), null);
});
