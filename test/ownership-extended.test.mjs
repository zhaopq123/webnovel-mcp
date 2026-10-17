/**
 * 3.6⑧ 剩余三类归属核对（v1.4.0 · 实施计划第 6 条：患病者 / 受伤者 / 物品持有者）。
 *
 * 这条判据最容易死在两种死法上：
 *   ① 判不出来（绿着但机制是空的）——错位伤病、非持有者使用物品必须能红；
 *   ② 误伤（作者关掉功能）——本人的动作、别人的病历、泛称句、长名字包含短名字都不许报。
 * 所以测试按「能红 / 不误伤 / 老卡兼容 / review 出口」四层写。
 * 全程独立临时目录，不碰任何真实书。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readState } from '../lib/core/state.js';
import { ownershipExtendedCheck, normalizeDossierPatch } from '../lib/features/dossier.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

async function book() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-ownx-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: root }), token: '' };
  await applyTool('webnovel_init', {
    bookId: 'b1', title: '归属扩展测试', genre: '玄幻', targetWords: 600000, targetChapters: 200,
  }, config);
  return { root, config };
}

const stateOf = (root) => readState(path.join(root, 'b1')).value;

function commitDelta(root, config, chapter, deltas, extra = {}) {
  return applyTool('webnovel_commit', {
    bookId: 'b1', chapter, title: `第${chapter}章`, summary: `第 ${chapter} 章摘要`, force: true, ...extra,
    ...(deltas ? { deltas } : {}),
  }, config);
}

/** 陈三右臂骨折；林晚持有青锋剑。周伯无任何 condition/items（老卡形状）。 */
const SEED = {
  protagonist: {
    name: '林晚',
    desire: '查出灭门真相', fear: '连累亲人', secret: '自己是被抱养的',
    contradiction: '既想查清又怕查到自己身上',
  },
  characters: [
    { name: '陈三', patch: { role: '重要配角', condition: '右臂骨折，未愈', items: ['半枚铜钱'] } },
    { name: '周伯', patch: { role: '反派' } },
  ],
};

const stateWithItems = {
  protagonist: { name: '林晚', items: ['青锋剑'] },
  characters: {
    陈三: { name: '陈三', condition: '右臂骨折，未愈', items: ['半枚铜钱'] },
    周伯: { name: '周伯', role: '反派' },
  },
};

/* ------------------------------------------------------------------ *
 * ① 伤病：能红
 * ------------------------------------------------------------------ */

test('归属扩展 · 错位伤病能红：登记右臂骨折，同句却挥剑', () => {
  const r = ownershipExtendedCheck(stateWithItems, '陈三挥剑劈下，将那人逼退三步。');
  const hit = r.issues.find((i) => i.kind === 'condition');
  assert.ok(hit, '应报伤病冲突');
  assert.equal(hit.level, 'error');
  assert.match(hit.message, /陈三/);
  assert.match(hit.message, /右臂骨折/);
});

test('归属扩展 · 伤处与动作不匹配不判：登记右臂骨折，用左手的动作放过', () => {
  // 「站起」只属于腿伤的动作表；右臂伤不约束站起。
  const r = ownershipExtendedCheck(stateWithItems, '陈三站起，慢慢走到窗前。');
  assert.equal(r.issues.filter((i) => i.kind === 'condition').length, 0);
});

test('归属扩展 · 伤已好转不判：「右臂已愈」不是受伤状态', () => {
  const st = {
    protagonist: { name: '林晚' },
    characters: { 陈三: { condition: '右臂已愈，只剩一道浅疤' } },
  };
  const r = ownershipExtendedCheck(st, '陈三挥剑劈下，势大力沉。');
  assert.equal(r.issues.length, 0);
});

/* ------------------------------------------------------------------ *
 * ② 伤病：不误伤
 * ------------------------------------------------------------------ */

test('归属扩展 · 别人的病历不按到本人头上', () => {
  const st = {
    protagonist: { name: '林晚' },
    characters: {
      周伯: { condition: '右臂骨折，未愈' },
      陈三: { role: '重要配角' },
    },
  };
  const r = ownershipExtendedCheck(st, '陈三挥剑劈下，将那人逼退三步。');
  assert.equal(r.issues.length, 0, '伤在周伯身上，陈三的动作不该报');
});

test('归属扩展 · 没点名的泛称句不判', () => {
  const r = ownershipExtendedCheck(stateWithItems, '有人挥剑劈下，又有人握紧了什么。');
  assert.equal(r.issues.length, 0);
});

test('归属扩展 · 长名字包含短名字不误伤（陈三娘 ≠ 陈三）', () => {
  const st = {
    protagonist: { name: '林晚' },
    characters: {
      陈三: { condition: '右臂骨折，未愈' },
      陈三娘: { role: '配角' },
    },
  };
  const r = ownershipExtendedCheck(st, '陈三娘挥剑劈下，护住了身后的人。');
  assert.equal(r.issues.length, 0, '陈三娘的动作不许算到陈三头上');
});

/* ------------------------------------------------------------------ *
 * ③ 物品持有：能红 / 不误伤
 * ------------------------------------------------------------------ */

test('归属扩展 · 非持有者使用物品能红', () => {
  const r = ownershipExtendedCheck(stateWithItems, '陈三握住青锋剑，剑尖直指周伯。');
  const hit = r.issues.find((i) => i.kind === 'item');
  assert.ok(hit, '应报物品持有冲突');
  assert.equal(hit.level, 'warning');
  assert.match(hit.message, /青锋剑/);
  assert.match(hit.message, /陈三/);
});

test('归属扩展 · 持有者本人使用不报', () => {
  const r = ownershipExtendedCheck(stateWithItems, '林晚握住青锋剑，剑尖直指周伯。');
  assert.equal(r.issues.length, 0);
});

test('归属扩展 · 持有者在场时放过（分不清谁在动手就不猜）', () => {
  const r = ownershipExtendedCheck(stateWithItems, '林晚把青锋剑递过去，陈三握住青锋剑。');
  assert.equal(r.issues.length, 0, '林晚在场且是持有者时不判');
});

test('归属扩展 · 只是看着物品不算使用', () => {
  const r = ownershipExtendedCheck(stateWithItems, '陈三看着青锋剑，沉默了很久。');
  assert.equal(r.issues.length, 0);
});

test('归属扩展 · 物品名不出现不判（只说剑，不说青锋剑）', () => {
  // 用没有伤病的周伯，避免伤病规则先命中（陈三「握紧」会撞上右臂骨折那条，属正确告警）。
  const r = ownershipExtendedCheck(stateWithItems, '周伯握紧了剑。');
  assert.equal(r.issues.length, 0);
});

/* ------------------------------------------------------------------ *
 * ④ 老卡兼容 + 字段归一
 * ------------------------------------------------------------------ */

test('归属扩展 · 没有 condition/items 的老卡不参与、不报错', () => {
  const oldState = {
    protagonist: { name: '林晚' },
    characters: {
      陈三: { role: '重要配角', notes: '老卡，从没填过 condition/items' },
      周伯: { role: '反派' },
    },
  };
  const r = ownershipExtendedCheck(oldState, '陈三挥剑劈下。周伯握住一把刀。');
  assert.equal(r.issues.length, 0);
  assert.ok(r.checked > 0);
  assert.equal(ownershipExtendedCheck(oldState, '').issues.length, 0);
});

test('归属扩展 · condition 必须是文本、items 必须是去重数组', () => {
  const a = normalizeDossierPatch({ condition: '  左腿骨裂  ' });
  assert.equal(a.patch.condition, '左腿骨裂');
  const b = normalizeDossierPatch({ condition: { note: '腿伤' } });
  assert.equal(b.patch.condition, undefined);
  assert.ok(b.warnings.some((w) => w.includes('condition')));
  const c = normalizeDossierPatch({ items: ['青锋剑', '青锋剑', '  ', '半枚铜钱'] });
  assert.deepEqual(c.patch.items, ['青锋剑', '半枚铜钱']);
  const d = normalizeDossierPatch({ items: '青锋剑' });
  assert.equal(d.patch.items, undefined);
  assert.ok(d.warnings.some((w) => w.includes('items')));
});

/* ------------------------------------------------------------------ *
 * ⑤ 落盘 + review 出口（工具层真实入口）
 * ------------------------------------------------------------------ */

test('归属扩展 · 提交落盘保留 condition/items，review 能红能黄', async () => {
  const { root, config } = await book();
  await commitDelta(root, config, 1, SEED);
  const st = stateOf(root);
  assert.equal(st.characters['陈三'].condition, '右臂骨折，未愈');
  assert.deepEqual(st.characters['陈三'].items, ['半枚铜钱']);
  assert.equal(st.characters['周伯'].condition, undefined, '老卡不许被补出空字段');

  const report = await applyTool('webnovel_review', {
    bookId: 'b1',
    chapter: 2,
    text: '陈三挥剑劈下，将那人逼退三步。\n\n陈三握住青锋剑，剑尖直指周伯。',
  }, config);

  assert.match(report, /🔴/, '伤病冲突应进红榜');
  assert.match(report, /右臂骨折/);
  assert.match(report, /🟡/, '物品持有冲突应进黄榜');
  assert.match(report, /青锋剑/);
  assert.match(report, /归属核对（3\.6⑧）/);
});

test('归属扩展 · review 对干净正文不报这两类', async () => {
  const { root, config } = await book();
  await commitDelta(root, config, 1, SEED);
  const report = await applyTool('webnovel_review', {
    bookId: 'b1',
    chapter: 2,
    text: '陈三用左手按住桌沿，慢慢坐下。周伯站在门外，没有进来。',
  }, config);
  assert.doesNotMatch(report, /登记伤病/);
  assert.doesNotMatch(report, /持有清单/);
});
