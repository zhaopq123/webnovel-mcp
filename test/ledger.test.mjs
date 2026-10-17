/**
 * 叙事债务账本测试（v1.3.0 · 实施计划第 11 条）。
 *
 * 一张账管四样债（伏笔 / 悬念账户 / 支票 / 误导线索），判据全部由代码算。
 * 用例分三层，缺一层都可能「绿着但机制是空的」：
 *   ① 纯函数层（narrativeDebt）——四类告警各自能红，且**随阈值常量移动**（口径 3）；
 *   ② 落盘层（commit → foreshadowing.json）——只存非默认值（口径 1），老文件读出缺省；
 *   ③ 渲染层（status / 任务书 / query）——同一笔债在三处报同一个数（口径 2）。
 * 再加一条最要命的：提交链重放必须还原出同样的账（含 hintChapters），
 * 否则 doctor 会对着一张它自己算不出的台账天天报假差异。
 * 全程独立临时目录，不触碰任何真实书。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FILES } from '../lib/core/paths.js';
import { readForeshadowing, defaultForeshadowing } from '../lib/core/state.js';
import { doctorCheck, doctorRebuild } from '../lib/features/doctor.js';
import {
  narrativeDebt, debtFromProject, ledgerTypeLabel, typeOf, layerOf, dueOf, hintsOf,
  readerAwareOf, debtItemLine, LEDGER_THRESHOLDS, LEDGER_TYPES,
} from '../lib/features/ledger.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

/* ------------------------------------------------------------------ *
 * 工具：造一本带债务的书（走 MCP 工具层，保证测的是真实入口而不是内部函数）
 * ------------------------------------------------------------------ */

async function debtBook(env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-debt-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: root, ...env }), token: '' };
  return { root, config };
}

async function initBook(root, config, { targetWords = 1000000, targetChapters = 400 } = {}) {
  await applyTool('webnovel_init', {
    bookId: 'd1', title: '债务测试', genre: '玄幻', targetWords, targetChapters,
  }, config);
  return `第 ${targetChapters} 章`;
}

/** 提交一章（正文/审查都不给，走 warnings 但不阻塞——本文件测的是债务账，不是门禁）。 */
async function commit(root, config, chapter, deltas, extra = {}) {
  return applyTool('webnovel_commit', {
    bookId: 'd1', chapter, title: `第${chapter}章`, summary: `第 ${chapter} 章摘要`, force: true, ...extra,
    ...(deltas ? { deltas } : {}),
  }, config);
}

function readLedger(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'd1', FILES.foreshadowing), 'utf8'));
}

const codes = (debt) => debt.alerts.map((a) => a.code);
const alertOf = (debt, code) => debt.alerts.find((a) => a.code === code) ?? null;

/* ------------------------------------------------------------------ *
 * ① 纯函数层：四类告警能红，且随常量移动
 * ------------------------------------------------------------------ */

test('债务 · 余额线：0 个报「账户清空」，1-2 个报「余额不足」，够线不响', () => {
  const mk = (n) => ({
    items: Array.from({ length: n }, (_, i) => ({
      name: `悬念${i}`, status: 'open', type: 'suspense', layer: '短', plantedChapter: 1,
    })),
  });
  const zero = narrativeDebt(mk(0), { chapter: 10, partsCount: 1 });
  assert.ok(!zero.adopted, '账上一条 suspense 都没有 → 不该执法（老书退回指路，见下一条用例）');

  const one = narrativeDebt(mk(1), { chapter: 10, partsCount: 1 });
  assert.equal(one.balance, 1);
  assert.equal(one.required, LEDGER_THRESHOLDS.minBalance, '1 部书的余额线是 3');
  assert.equal(alertOf(one, 'balance-low').level, 'error');

  const three = narrativeDebt(mk(3), { chapter: 10, partsCount: 1 });
  assert.equal(three.balance, 3);
  assert.equal(alertOf(three, 'balance-low'), null, '刚好够线不该响');

  // 4.1：多部书线更高（≥4）。线从哪来不重要，重要的是同一张账在两本书上报不同的数。
  const multi = narrativeDebt(mk(3), { chapter: 10, partsCount: 2 });
  assert.equal(multi.required, LEDGER_THRESHOLDS.minBalanceMultiPart);
  assert.equal(alertOf(multi, 'balance-low').level, 'error', '3 个在 2 部书里就是不够');
});

test('债务 · 账户清零只在真的登记过悬念后才报 account-empty', () => {
  // adopted 的判据是「账上有过 suspense 条目（含已回收的）」——只看在线的会漏判「刚收干净」那一次
  const paid = { items: [{ name: '旧悬念', status: 'paid', type: 'suspense', layer: '短', plantedChapter: 1, paidChapter: 9 }] };
  const debt = narrativeDebt(paid, { chapter: 10, partsCount: 1 });
  assert.ok(debt.adopted, '回收过的悬念要算「用过账户」，否则清空那次永远抓不到');
  assert.equal(debt.balance, 0);
  assert.equal(alertOf(debt, 'account-empty').level, 'error');
  assert.match(alertOf(debt, 'account-empty').message, /终章/, '4.1 的例外（全书终章允许清零一次）要说给作者');
});

test('债务 · 老书没用过账户：不报警，只给一条指路（判据不吵才有人看）', () => {
  const legacy = { items: [{ name: '玉佩', status: 'open', plantedChapter: 1, plannedPayoff: 50 }] };
  const debt = narrativeDebt(legacy, { chapter: 20, partsCount: 1 });
  assert.equal(debt.adopted, false);
  assert.equal(debt.errors.length, 0, '没登记过 suspense 的老书不能被 🔴 余额不足');
  assert.equal(codes(debt).filter((c) => c === 'account-not-adopted').length, 1);
  assert.match(alertOf(debt, 'account-not-adopted').message, /deltas\.foreshadowing/, '指路要说清去哪儿登记');
  // 第 0 章（新书一本没写）连指路都不给：那时报「账户没启用」是纯噪音
  assert.equal(codes(narrativeDebt(legacy, { chapter: 0, partsCount: 1 })).length, 0);
});

test('债务 · 悬置章数：40 章预警、50 章硬线报警、补一次暗示就把计时归零', () => {
  const mk = (hints) => ({
    items: [{ name: '灭门之谜', status: 'open', type: 'suspense', layer: '短', plantedChapter: 1, hintChapters: hints }],
  });
  const aging = narrativeDebt(mk([1]), { chapter: 1 + LEDGER_THRESHOLDS.idleWarn, partsCount: 1 });
  assert.equal(alertOf(aging, 'suspense-aging').level, 'warn');
  const hard = narrativeDebt(mk([1]), { chapter: 1 + LEDGER_THRESHOLDS.idleHard, partsCount: 1 });
  assert.equal(alertOf(hard, 'suspense-idle').level, 'error');
  assert.equal(hard.idle[0].silentChapters, LEDGER_THRESHOLDS.idleHard);
  // 刚暗示过：既不进 idle 清单，也不许留一条「有但没超标」的空壳（清单只装真超标的）
  const fresh = narrativeDebt(mk([1, 45]), { chapter: 46, partsCount: 1 });
  assert.deepEqual(fresh.idle, [], '埋下 45 章但第 45 章刚露过脸 → 不算悬置');
  assert.equal(alertOf(fresh, 'suspense-idle'), null);
  // 计时基准是「最后一次暗示」而不是「埋下章」：同一章号、只差一次中途暗示，一边红一边不响
  const cold = narrativeDebt(mk([1]), { chapter: 65, partsCount: 1 });
  assert.equal(alertOf(cold, 'suspense-idle').level, 'error');
  assert.equal(cold.idle[0].silentChapters, 64);
  const reHeated = narrativeDebt(mk([1, 30]), { chapter: 65, partsCount: 1 });
  assert.equal(alertOf(reHeated, 'suspense-idle'), null, '按埋下章算是 64 章（该报 🔴），按最后暗示算是 35 章（不该报）');
  assert.deepEqual(codes(reHeated).filter((c) => c.startsWith('suspense-')), []);
  // 只对悬念账户执法：暗埋的伏笔按 2.3 喊「你 40 章没暗示」等于逼作者剧透（4.4 明令不提前剧透）
  const fsOnly = narrativeDebt({ items: [{ name: '暗线', status: 'open', plantedChapter: 1 }] }, { chapter: 200, partsCount: 1 });
  assert.ok(!codes(fsOnly).includes('suspense-idle') && !codes(fsOnly).includes('suspense-aging'),
    '伏笔不该吃悬置判据');
});

test('债务 · 判据随阈值常量移动（阈值只有 LEDGER_THRESHOLDS 一处，写死数字会红）', () => {
  const item = { items: [{ name: 'X', status: 'open', type: 'suspense', layer: '短', plantedChapter: 1 }] };
  const at = (idleHard) => codes(narrativeDebt(item, { chapter: 30, partsCount: 1, thresholds: { idleHard } }));
  assert.ok(!at(50).includes('suspense-idle'), '29 章悬置在 50 章线下不该报');
  assert.ok(at(10).includes('suspense-idle'), '把线调到 10 章就必须报——判据吃的是常量');
  const msg = alertOf(narrativeDebt(item, { chapter: 30, partsCount: 1, thresholds: { idleHard: 10 } }), 'suspense-idle').message;
  assert.match(msg, /10 章/, '告警正文里引用的章数也要跟着常量走，不能印死「50」');

  const cheque = { items: [{ name: 'C', status: 'open', type: 'cheque', plantedChapter: 1, plannedPayoff: 10 }] };
  const grace = (chequeGrace) => codes(narrativeDebt(cheque, { chapter: 13, partsCount: 1, thresholds: { chequeGrace } }));
  assert.deepEqual(grace(5).filter((c) => c.startsWith('cheque-')), ['cheque-late'], '拖 3 章在 5 章宽限内 → 🟡');
  assert.deepEqual(grace(1).filter((c) => c.startsWith('cheque-')), ['cheque-breached'], '宽限调成 1 → 同样数据变 🔴');
});

test('债务 · 支票：到期前提醒、宽限内逾期、超宽限违约、没写期限单独报', () => {
  const mk = (due) => ({ items: [{ name: '三日后决战', status: 'open', type: 'cheque', plantedChapter: 1, plannedPayoff: due }] });
  const soon = narrativeDebt(mk(13), { chapter: 11, partsCount: 1 });
  assert.equal(alertOf(soon, 'cheque-due-soon').level, 'warn');
  assert.match(soon.cheques.dueSoon[0].name, /决战/);
  const late = narrativeDebt(mk(10), { chapter: 12, partsCount: 1 });
  assert.equal(late.cheques.grace[0].late, 2);
  assert.equal(alertOf(late, 'cheque-late').level, 'warn');
  const breach = narrativeDebt(mk(10), { chapter: 10 + LEDGER_THRESHOLDS.chequeGrace + 1, partsCount: 1 });
  assert.equal(alertOf(breach, 'cheque-breached').level, 'error');
  assert.match(alertOf(breach, 'cheque-breached').message, /利息/, '4.4 的出路（付利息补偿）要写在告警里');
  const undated = narrativeDebt(mk(null), { chapter: 12, partsCount: 1 });
  assert.equal(undated.cheques.undated.length, 1);
  assert.equal(undated.cheques.undated[0].dueChapter, null, '没期限就别硬算逾期');
  assert.match(alertOf(undated, 'cheque-undated').message, /dueChapter/);
});

test('债务 · 误导线索：没真实解释是 🔴（骗读者不可挽回），没写错误假设是 🟡', () => {
  const bare = { items: [{ name: '鬼祟的二师兄', status: 'open', type: 'red_herring', plantedChapter: 1 }] };
  const debt = narrativeDebt(bare, { chapter: 5, partsCount: 1 });
  assert.equal(alertOf(debt, 'herring-unexplained').level, 'error');
  assert.equal(alertOf(debt, 'herring-no-assumption').level, 'warn');
  const filled = {
    items: [{
      name: '鬼祟的二师兄', status: 'open', type: 'red_herring', plantedChapter: 1,
      realExplanation: '他在偷偷给家里寄钱', falseAssumption: '他是内奸',
    }],
  };
  const ok = narrativeDebt(filled, { chapter: 5, partsCount: 1 });
  assert.equal(ok.errors.length, 0, '补齐两格之后不该再有 🔴');
});

test('债务 · 到期未回收合并成一条汇总（同一件事不在两处各自报警）', () => {
  const many = {
    items: Array.from({ length: 7 }, (_, i) => ({
      name: `线${i}`, status: 'open', plantedChapter: 1, plannedPayoff: 10,
    })),
  };
  const debt = narrativeDebt(many, { chapter: 20, partsCount: 1 });
  assert.equal(debt.overdue.length, 7);
  assert.equal(codes(debt).filter((c) => c === 'overdue-open').length, 1, '逐条各报一次 = 噪音');
  assert.match(alertOf(debt, 'overdue-open').message, /另有 2 条/, '超出 5 条要收口并指路 query');
});

test('债务 · 层名与体量换算表同源：本书没启用的层要被点名', () => {
  const mk = (layer) => ({ items: [{ name: 'S', status: 'open', type: 'suspense', layer, plantedChapter: 1 }] });
  const onePart = narrativeDebt(mk('全书'), { chapter: 5, partsCount: 1 });
  assert.deepEqual(onePart.enabledLayers, ['短', '卷', '部'], '1 部书只有三层（2.3）');
  assert.equal(alertOf(onePart, 'suspense-layer-off').level, 'warn');
  const fourParts = narrativeDebt(mk('全书'), { chapter: 5, partsCount: 4 });
  assert.ok(fourParts.enabledLayers.includes('全书'));
  assert.equal(alertOf(fourParts, 'suspense-layer-off'), null, '同一笔债在 4 部书里合法——层表只有一份');
  const unlayered = narrativeDebt(mk(null), { chapter: 5, partsCount: 1 });
  assert.equal(alertOf(unlayered, 'suspense-unlayered').level, 'warn', '没标 layer 的悬念没法按层核对');
});

test('债务 · readerAware=false 不算余额（4.1：读者没意识到的问题不在线）', () => {
  const ledger = {
    items: [
      { name: '明写的', status: 'open', type: 'suspense', layer: '短', plantedChapter: 1 },
      { name: '暗埋的疑问', status: 'open', type: 'suspense', layer: '短', plantedChapter: 1, readerAware: false },
    ],
  };
  const debt = narrativeDebt(ledger, { chapter: 5, partsCount: 1 });
  assert.equal(debt.balance, 1, '只有读者意识到的那条进余额');
  assert.equal(debt.byType.suspense, 2, '但在线数不变：它是两条，只是一条不顶账');
});

/* ------------------------------------------------------------------ *
 * ② 落盘层：只存非默认值 + 老数据读出缺省
 * ------------------------------------------------------------------ */

test('债务 · 落盘只存非默认值（口径 1：老条目形状不随升级漂移）', async () => {
  const { root, config } = await debtBook();
  try {
    await initBook(root, config);
    await commit(root, config, 1, {
      foreshadowing: {
        planted: [
          { name: '玉佩', note: '母亲的遗物' },
          { name: '灭门之谜', type: '悬念', layer: '短', plannedPayoff: 30 },
          { name: '决战', type: '支票', dueChapter: 4 },
          { name: '暗疑问', type: 'suspense', layer: '卷', readerAware: false },
        ],
      },
    });
    const items = readLedger(root).items;
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    // 伏笔是默认类型：不写 type、不写 layer、不写 hintChapters、不写 readerAware
    assert.deepEqual(Object.keys(by['玉佩']).sort(),
      ['id', 'importance', 'name', 'note', 'paidChapter', 'plannedPayoff', 'plantedChapter', 'status']);
    assert.equal(by['玉佩'].type, undefined, '默认值写进 JSON = 老书形状漂移，doctor 整表对账会假红');
    // 悬念：type/layer 存，readerAware=true 不存
    assert.equal(by['灭门之谜'].type, 'suspense');
    assert.equal(by['灭门之谜'].layer, '短');
    assert.equal(by['灭门之谜'].readerAware, undefined, 'true 是默认，省略不存');
    assert.equal(by['灭门之谜'].hintChapters[0], 1, '明写的悬念：埋下章就是第一次暗示');
    // readerAware=false 不是默认，必须存下来
    assert.equal(by['暗疑问'].readerAware, false);
    // dueChapter 归一进 plannedPayoff，不另存一份（两份真相迟早打架）
    assert.equal(by['决战'].plannedPayoff, 4);
    assert.equal(by['决战'].dueChapter, undefined, '同一件事只存一个字段');
    assert.equal(by['决战'].type, 'cheque');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('债务 · 老 foreshadowing.json（一个新字段都没有）读出缺省值且体检全绿', async () => {
  const { root, config } = await debtBook();
  try {
    await initBook(root, config);
    await commit(root, config, 1, { foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 5 }] } });
    // 手工退回 v1.2.x 的形状：删掉所有新键
    const ledger = readLedger(root);
    ledger.items = ledger.items.map(({ type, layer, hintChapters, readerAware, ...rest }) => rest);
    fs.writeFileSync(path.join(root, 'd1', FILES.foreshadowing), JSON.stringify(ledger, null, 2));

    // 注意读的是书目录（root/d1）：传错目录会读到「空账本」，
    // 于是「缺省值」断言全绿但其实一条数据都没读——这类「绿着但空」必须防住。
    const bookDir = path.join(root, 'd1');
    const read = readForeshadowing(bookDir);
    assert.equal(read.warnings.length, 0, '老文件不该被读成「有问题」');
    assert.equal(read.value.items.length, 1, '读回的条目数＝1，否则下面全是在断言 undefined');
    const item = read.value.items[0];
    assert.equal(item.name, '玉佩');
    assert.equal(typeOf(item), 'foreshadow');
    assert.equal(layerOf(item), null);
    assert.deepEqual(hintsOf(item), []);
    assert.equal(readerAwareOf(item), true, '没标注按「读者已意识到」处理');
    assert.equal(dueOf(item), 5);
    assert.equal(ledgerTypeLabel(item), '伏笔');

    const check = doctorCheck(bookDir);
    assert.equal(check.ok, true, `老书体检必须全绿：${JSON.stringify(check.issues)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('债务 · 空账本（没有文件的新书）不炸，defaultForeshadowing 可直接算', () => {
  const debt = narrativeDebt(defaultForeshadowing(), { chapter: 12, partsCount: 1 });
  assert.equal(debt.balance, 0);
  assert.equal(debt.errors.length, 0);
  assert.equal(debt.adopted, false);
  assert.equal(debtItemLine({ name: 'x', type: 'cheque', plannedPayoff: 3 }, { chapter: 5 }).includes('兑现'), true);
});

test('债务 · 认不出来的 type/layer 当场说，不静默存成伏笔', async () => {
  const { root, config } = await debtBook();
  try {
    await initBook(root, config);
    const out = await commit(root, config, 1, {
      foreshadowing: {
        planted: [
          { name: '奇怪的分类', type: '金手指' },
          { name: '乱填的层', type: '悬念', layer: '宇宙' },
          { name: '什么都没写' },
        ],
      },
    });
    assert.match(out, /type="金手指" 系统不认/, '把支票静默存成伏笔＝这笔债从总账里消失');
    assert.match(out, /layer="宇宙"/);
    const by = Object.fromEntries(readLedger(root).items.map((i) => [i.name, i]));
    // 作者显式写了类别 → 照存归一值（认不出来时存默认 foreshadow，等于「按伏笔登记」这件事写在账上）；
    // 没写类别的条目 → 不落 type 键。两者的区别是「作者确认过」vs「老书从没提过类别」。
    assert.equal(by['奇怪的分类'].type, 'foreshadow', '认不出来 → 按伏笔登记，且当场已经警告过');
    assert.equal(by['什么都没写'].type, undefined, '没写就不占位：老书条目形状不随升级漂移（口径 1）');
    assert.equal(by['乱填的层'].layer, undefined, '认不出来的层不写脏数据');
    assert.equal(by['乱填的层'].type, 'suspense', 'layer 认不出不影响 type 认出来');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('债务 · 中文类别都认（伏笔/悬念/支票/红鲱鱼/误导线索）', async () => {
  const { root, config } = await debtBook();
  try {
    await initBook(root, config);
    await commit(root, config, 1, {
      foreshadowing: {
        planted: [
          { name: 'A', type: '伏笔' }, { name: 'B', type: '悬念' },
          { name: 'C', type: '支票' }, { name: 'D', type: '误导线索' },
        ],
      },
    });
    const map = Object.fromEntries(readLedger(root).items.map((i) => [i.name, i.type]));
    assert.equal(map.A, 'foreshadow', '中文类别要归一成英文键存（写了就照存，见上一条用例的口径）');
    assert.deepEqual([map.B, map.C, map.D], ['suspense', 'cheque', 'red_herring']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * ③ 渲染层与重放：三处同一个数；hintChapters 能被重放还原
 * ------------------------------------------------------------------ */

test('债务 · status / 任务书 / query 三处报同一个余额（判据只有一份）', async () => {
  const { root, config } = await debtBook();
  try {
    await initBook(root, config);
    await commit(root, config, 1, {
      foreshadowing: {
        planted: [
          { name: '悬念一', type: '悬念', layer: '短', plannedPayoff: 30 },
          { name: '悬念二', type: '悬念', layer: '卷', plannedPayoff: 60 },
          { name: '决战', type: '支票', dueChapter: 4 },
        ],
      },
    });
    const dir = path.join(root, 'd1');
    const ledger = readForeshadowing(dir).value;
    const expected = debtFromProject({ targetWords: 1000000, targetChapters: 400 }, ledger, 1);
    assert.equal(expected.balance, 2);
    assert.equal(expected.required, 4, '100 万字 → 2 部 → 线是 4（不是硬编码 3）');

    const status = await applyTool('webnovel_status', { bookId: 'd1' }, config);
    const query = await applyTool('webnovel_query', { bookId: 'd1', kind: 'foreshadowing' }, config);
    assert.match(status, /叙事债务：悬念余额 2\/4/, `status 没带总账：\n${status.slice(0, 400)}`);
    assert.match(query, /悬念账户余额：\*\*2\*\* 个（要求≥4）/, 'query 的余额要和 status 同一个数');

    await applyTool('webnovel_outline', { bookId: 'd1', action: 'write_chapter', chapter: 2, text: '# 第二章\n- 场景：山门\n- 目标：立问题\n- 钩子：门外有人' }, config);
    const brief = await applyTool('webnovel_context', { bookId: 'd1', chapter: 2 }, config);
    // 三处排版口径本来就不同（status 一行、query 详版、任务书告警版），要锁的是「同一个数 + 同一条线」
    assert.match(brief, /悬念账户余额 2 个，低于 4 个的线/, `任务书没带同一笔账：\n${brief.slice(0, 600)}`);
    assert.match(brief, /叙事债务（悬念账户 \/ 支票 \/ 误导线索）/);
    assert.match(brief, /未回收债务（共 3 条）/);
    assert.match(brief, /支票｜决战（计划第 4 章兑现/, '债务类别要进逐条清单，作者才知道第 4 章必须兑现');
    // 债务类待办必须排在最前：弃书是因为总账爆了，不是因为某个角色 30 章没出场
    const posDebt = status.indexOf('补足悬念账户余额');
    const posStale = status.indexOf('久未出场');
    assert.ok(posDebt > 0, `status 待办里没有债务行动：\n${status}`);
    assert.ok(posStale < 0 || posDebt < posStale, '债务待办要排在角色出场提醒之前');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('债务 · 暗示登记推进 hintChapters，重放能还原；手改必须被体检抓到', async () => {
  const { root, config } = await debtBook();
  try {
    await initBook(root, config);
    await commit(root, config, 1, {
      foreshadowing: { planted: [{ name: '灭门之谜', type: '悬念', layer: '短', plannedPayoff: 120 }] },
    });
    for (const ch of [2, 3]) {
      await applyTool('webnovel_outline', { bookId: 'd1', action: 'write_chapter', chapter: ch, text: `# 第${ch}章\n- 场景：山中\n- 目标：让悬念露脸\n- 钩子：又出事了` }, config);
      const out = await commit(root, config, ch, { foreshadowing: { hinted: ['灭门之谜'] } });
      assert.match(out, /暗示登记（第 /, `hinted 的回执没说：\n${out}`);
    }
    // 同章重复登记不许把数组撑大（累积的是事实，不是次数）
    await commit(root, config, 3, { foreshadowing: { hinted: ['灭门之谜'] } });
    const item = readLedger(root).items[0];
    assert.deepEqual(item.hintChapters, [1, 2, 3]);

    const before = doctorCheck(path.join(root, 'd1'));
    assert.equal(before.ok, true, JSON.stringify(before.issues));

    // 手改台账：加一次没发生过的暗示 → 重放对账必须点名（判据能红）。
    // 与专名账本同口径：漂移是「警告 + rebuild 可修」，不因为一条手写记录把体检判死。
    const tampered = readLedger(root);
    tampered.items[0].hintChapters = [1, 2, 3, 9];
    fs.writeFileSync(path.join(root, 'd1', FILES.foreshadowing), JSON.stringify(tampered, null, 2));
    const after = doctorCheck(path.join(root, 'd1'));
    assert.ok(after.issues.map((i) => i.code).includes('replay-foreshadowing'),
      `手改 hintChapters 没被抓到＝这本账不可信，实际：${after.issues.map((i) => i.code).join(',') || '（无）'}`);
    assert.match(after.issues.find((i) => i.code === 'replay-foreshadowing').message, /伏笔台账/);

    const rebuilt = await doctorRebuild(path.join(root, 'd1'), { confirm: true });
    assert.match(rebuilt.lines.join('\n'), /伏笔|台账/);
    assert.deepEqual(readLedger(root).items[0].hintChapters, [1, 2, 3], 'rebuild 按提交链把多出来的暗示 9 清掉');
    assert.deepEqual(doctorCheck(path.join(root, 'd1')).issues.filter((i) => i.code.startsWith('replay')), [],
      '归一后重放必须与现役一致');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('债务 · 回收与放弃按类别措辞，且不再进余额', async () => {
  const { root, config } = await debtBook();
  try {
    await initBook(root, config);
    await commit(root, config, 1, {
      foreshadowing: {
        planted: [
          { name: '决战', type: '支票', dueChapter: 4 },
          { name: '灭门之谜', type: '悬念', layer: '短' },
        ],
      },
    });
    const out = await commit(root, config, 2, { foreshadowing: { paid: ['决战'], dropped: ['灭门之谜'] } });
    assert.match(out, /已回收：决战/);
    assert.match(out, /红鲱鱼|悬念「灭门之谜」已标记为放弃/, '放弃告警要按真实类别说话');
    const debt = debtFromProject({ targetWords: 1000000, targetChapters: 400 }, readLedger(root), 2);
    assert.equal(debt.balance, 0);
    assert.equal(debt.byType.cheque, 0, '已兑现的支票不该还在清单上');
    assert.equal(debt.cheques.open.length, 0);
    assert.ok(codes(debt).includes('account-empty'), '悬念全没了 → 报账户清空（不是沉默）');
    // 不存在的名字：提醒，不静默新建
    const miss = await commit(root, config, 3, { foreshadowing: { hinted: ['没登记过的东西'] } });
    assert.match(miss, /不在台账中/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('债务 · 类别词在 ledger.js 只定义一次（label 与四类值同源于 LEDGER_TYPES）', () => {
  assert.deepEqual(Object.keys(LEDGER_TYPES), ['foreshadow', 'suspense', 'cheque', 'red_herring']);
  for (const key of Object.keys(LEDGER_TYPES)) {
    assert.equal(typeOf({ type: key }), key, `${key} 自己认不出自己`);
    assert.ok(['伏笔', '悬念', '支票', '红鲱鱼'].includes(ledgerTypeLabel({ type: key })));
  }
  // 阈值不许在别处再抄一份数字：本文件的断言全从 LEDGER_THRESHOLDS 取
  for (const [k, v] of Object.entries(LEDGER_THRESHOLDS)) {
    assert.ok(Number.isInteger(v) && v > 0, `阈值 ${k} 不是正整数：${v}`);
  }
});
