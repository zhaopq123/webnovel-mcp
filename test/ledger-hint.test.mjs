/**
 * hinted 证据核对 + 悬念层级递进测试（v1.4.0 未闭环清零 · 第 3 条）。
 *
 * 要证明的事：
 * 1. 带 evidence 的暗示：正文里找得到才登记，找不到拒绝并警告；
 * 2. 旧字符串格式继续兼容，但回执明确提示「补 evidence 才能机械核对」；
 * 3. 落盘仍是 hintChapters，提交记录里的 hinted 归一为字符串（重放形状不变）；
 * 4. 悬念层按 短→卷→部→跨部→全书 逐级加，跳级报 suspense-layer-skip；
 * 5. 1 部书用跨部/全书层仍由 suspense-layer-off 拦（沿用换算表）；
 * 6. 合法阶梯不响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { readForeshadowing } from '../lib/core/state.js';
import { commitChapter } from '../lib/features/commit.js';
import { narrativeDebt } from '../lib/features/ledger.js';
import { writeChapterText } from '../lib/features/outline.js';

function newBook(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-hint-'));
  initProject(root, {
    title: '暗示核对书',
    genre: '悬疑',
    logline: '证据必须真的在正文里。',
    targetWords: 300_000,
    targetChapters: 86,
    ...overrides,
  });
  return root;
}

/** 建一条悬念（短层）作为 hinted 的目标。 */
async function seedSuspense(root) {
  await commitChapter(root, {
    chapter: 1, title: '第一章', summary: '门口有脚步声。', strand: 'quest', wordCount: 100,
    deltas: {
      foreshadowing: {
        planted: [{
          name: '门后的脚步', type: 'suspense', layer: '短',
          plannedPayoff: 8, note: '每晚三下敲门声',
        }],
      },
    },
  });
}

const hintsOf = (root, name) => readForeshadowing(root).value.items.find((i) => i.name === name)?.hintChapters ?? [];

test('暗示证据 · 正文里找得到才登记（去空白比对）', async () => {
  const root = newBook();
  writeChapterText(root, 2, '第二章', '夜深了。\n\n门外传来三下敲门声，不轻不重。\n\n他没有开门。');
  await seedSuspense(root);

  const r = await commitChapter(root, {
    chapter: 2, title: '第二章', summary: '又响了三下。', strand: 'quest',
    deltas: {
      foreshadowing: {
        // 证据跨了换行、带缩进，仍应命中（比对前统一去空白）
        hinted: [{ name: '门后的脚步', evidence: '门外传来三下敲门声，\n  不轻不重' }],
      },
    },
  });
  assert.deepEqual(r.hinted, ['门后的脚步'], '证据命中应登记');
  assert.deepEqual(hintsOf(root, '门后的脚步'), [1, 2], '埋下即暗示（悬念对读者可见），再加本章一次');

  // 提交记录里的 hinted 归一成字符串（重放形状不变）
  const rec = JSON.parse(fs.readFileSync(path.join(root, '.webnovel', 'commits', 'ch0002.json'), 'utf8'));
  assert.deepEqual(rec.deltas.foreshadowing.hinted, ['门后的脚步'], '记录的 hinted 应是字符串键');
});

test('暗示证据 · 正文里找不到 → 拒绝登记并警告（不写进提交记录）', async () => {
  const root = newBook();
  writeChapterText(root, 2, '第二章', '夜深了。门外什么也没有。');
  await seedSuspense(root);

  const r = await commitChapter(root, {
    chapter: 2, title: '第二章', summary: '什么都没有。', strand: 'quest',
    deltas: {
      foreshadowing: {
        hinted: [{ name: '门后的脚步', evidence: '玻璃窗自己裂开了一道缝' }],
      },
    },
  });
  assert.ok(!r.hinted.includes('门后的脚步'), '证据不在正文里不许登记');
  assert.ok(
    r.warnings.some((w) => /证据在本章正文里找不到/.test(w) && /门后的脚步/.test(w)),
    `应点名拒绝原因：${JSON.stringify(r.warnings)}`,
  );
  assert.deepEqual(hintsOf(root, '门后的脚步'), [1], '台账不该多出本章的暗示（埋下章本来就有）');

  const rec = JSON.parse(fs.readFileSync(path.join(root, '.webnovel', 'commits', 'ch0002.json'), 'utf8'));
  assert.equal(rec.deltas.foreshadowing, undefined, '被拒绝的 hinted 不该留在提交记录里');
});

test('暗示证据 · 旧字符串格式仍登记，但回执提示补 evidence', async () => {
  const root = newBook();
  writeChapterText(root, 2, '第二章', '门外传来三下敲门声。');
  await seedSuspense(root);

  const r = await commitChapter(root, {
    chapter: 2, title: '第二章', summary: '敲门声。', strand: 'quest',
    deltas: { foreshadowing: { hinted: ['门后的脚步'] } },
  });
  assert.deepEqual(r.hinted, ['门后的脚步']);
  assert.ok(
    r.warnings.some((w) => /没带 evidence/.test(w) && /机械核对/.test(w)),
    `旧格式应提示补证据：${JSON.stringify(r.warnings)}`,
  );
  assert.deepEqual(hintsOf(root, '门后的脚步'), [1, 2], '埋下即暗示，再加上本章一次');
});

test('悬念层级 · 只开「部」层 → 报跳级（缺短/卷）', () => {
  const ledger = {
    items: [
      { name: 'A', type: 'suspense', layer: '部', status: 'open', plantedChapter: 1 },
      { name: 'B', type: 'suspense', layer: '部', status: 'open', plantedChapter: 2 },
      { name: 'C', type: 'suspense', layer: '部', status: 'open', plantedChapter: 3 },
    ],
  };
  const debt = narrativeDebt(ledger, { chapter: 3, partsCount: 1 });
  const skip = debt.alerts.find((a) => a.code === 'suspense-layer-skip');
  assert.ok(skip, `应报 suspense-layer-skip：${JSON.stringify(debt.alerts)}`);
  assert.match(skip.message, /「部」层（缺 短\/卷）/);
  assert.equal(skip.level, 'warn', '跳级是规划问题，不该直接判死');
});

test('悬念层级 · 短→卷→部 逐级开 → 不报跳级', () => {
  const ledger = {
    items: [
      { name: 'A', type: 'suspense', layer: '短', status: 'paid', plantedChapter: 1 },
      { name: 'B', type: 'suspense', layer: '卷', status: 'open', plantedChapter: 2 },
      { name: 'C', type: 'suspense', layer: '部', status: 'open', plantedChapter: 3 },
    ],
  };
  const debt = narrativeDebt(ledger, { chapter: 3, partsCount: 1 });
  assert.ok(!debt.alerts.some((a) => a.code === 'suspense-layer-skip'), JSON.stringify(debt.alerts));
});

test('悬念层级 · 短→部（跳过卷）→ 报缺卷', () => {
  const ledger = {
    items: [
      { name: 'A', type: 'suspense', layer: '短', status: 'open', plantedChapter: 1 },
      { name: 'B', type: 'suspense', layer: '部', status: 'open', plantedChapter: 2 },
      { name: 'C', type: 'suspense', layer: '部', status: 'open', plantedChapter: 3 },
    ],
  };
  const debt = narrativeDebt(ledger, { chapter: 3, partsCount: 1 });
  const skip = debt.alerts.find((a) => a.code === 'suspense-layer-skip');
  assert.ok(skip);
  assert.match(skip.message, /短→卷→部/);
  assert.match(skip.message, /「部」层（缺 卷）/);
});

test('悬念层级 · 1 部书用跨部/全书层由 suspense-layer-off 拦', () => {
  const ledger = {
    items: [
      { name: 'A', type: 'suspense', layer: '短', status: 'open', plantedChapter: 1 },
      { name: 'B', type: 'suspense', layer: '跨部', status: 'open', plantedChapter: 2 },
    ],
  };
  const debt = narrativeDebt(ledger, { chapter: 2, partsCount: 1 });
  const off = debt.alerts.find((a) => a.code === 'suspense-layer-off');
  assert.ok(off, `应报 suspense-layer-off：${JSON.stringify(debt.alerts)}`);
  assert.match(off.message, /跨部/);
  assert.match(off.message, /短\/卷\/部/, '1 部书只启用前三层');
});

test('悬念层级 · 4 部书开全书层是合法的（层数随体量）', () => {
  const ledger = {
    items: [
      { name: 'A', type: 'suspense', layer: '短', status: 'open', plantedChapter: 1 },
      { name: 'B', type: 'suspense', layer: '卷', status: 'open', plantedChapter: 2 },
      { name: 'C', type: 'suspense', layer: '部', status: 'open', plantedChapter: 3 },
      { name: 'D', type: 'suspense', layer: '跨部', status: 'open', plantedChapter: 4 },
      { name: 'E', type: 'suspense', layer: '全书', status: 'open', plantedChapter: 5 },
    ],
  };
  const debt = narrativeDebt(ledger, { chapter: 5, partsCount: 4 });
  assert.ok(!debt.alerts.some((a) => a.code === 'suspense-layer-skip'), JSON.stringify(debt.alerts));
  assert.ok(!debt.alerts.some((a) => a.code === 'suspense-layer-off'), JSON.stringify(debt.alerts));
});
