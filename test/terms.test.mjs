/**
 * 专名账本测试（v1.3.0 · 实施计划第 9 条：铁律 1「名词锁定」的机械执行）。
 *
 * 计划里的三条验收对应下面前三组用例：
 *   ① 造一章含 3 个新人名，未登记时 commit 的 warnings 必须点名；
 *   ② deltas.terms 登记后同一章不再提醒；
 *   ③ 老书（没有 terms.json）读取不报错、体检全绿。
 * 另外三组守住两个更要命的边界：
 *   · 误报口径——常见泛称被当成新名字，作者就会无视全部提醒，整套机制作废；
 *   · 重放一致——专名账本由提交链推导，手改文件必须被 doctor 抓到（判据要能红）。
 * 全程独立临时目录，不触碰任何真实书。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { FILES } from '../lib/core/paths.js';
import {
  defaultTerms, readTerms, writeTerms, upsertTerm, findTerm, normalizeTerms,
} from '../lib/core/state.js';
import { commitChapter } from '../lib/features/commit.js';
import { doctorCheck, doctorRebuild } from '../lib/features/doctor.js';
import { runQuery } from '../lib/features/query.js';
import { buildWritingBrief } from '../lib/features/context.js';
import { writeChapterText } from '../lib/features/outline.js';
import {
  detectUnregisteredTerms, knownProperNouns, normalizeTermType, termTypeLabel,
} from '../lib/features/terms.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

/**
 * 本章含三个新人名（对话归属锚点）+ 一个宗门（移动锚点，重复提及）+ 一枚丹药（通称命名锚点）。
 * 刻意用「高声应道」这种带情态词的写法：修饰语被当成名字的一半，是最典型的切词事故。
 */
const NEW_TERMS_TEXT = [
  '晨光刚透进窗棂，裴惊鸿说道：“今日必须下山。”',
  '',
  '慕容雪沉声道：“师兄伤势未愈，经不起风。”',
  '',
  '王林高声应道：“我陪你们一道去。”',
  '',
  '三人来到幽冥宗山门外，石阶上的霜还没化。',
  '',
  '裴惊鸿从袖中取出一枚丹药，名为洗髓丹。',
  '',
  '幽冥宗的守山弟子拦住了他们。',
].join('\n');

const FIVE_TERMS = [
  { name: '裴惊鸿', type: '人名', note: '大师兄，伤势未愈' },
  { name: '慕容雪', type: 'person', aliases: ['二师姐'] },
  { name: '王林', type: '人物' },
  { name: '幽冥宗', type: 'org', note: '东域宗门' },
  { name: '洗髓丹', type: 'item' },
];

function newBook(title = '专名测试书') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-terms-'));
  initProject(root, {
    title,
    genre: '玄幻',
    logline: '少年偶得异术，踏上寻亲之路。',
    targetWords: 100_000,
    targetChapters: 50,
  });
  return root;
}

/** 提交一章（带正文、可选 deltas），返回提交结果。 */
async function commitWithText(root, chapter, text, extra = {}) {
  writeChapterText(root, chapter, `第${chapter}章`, text);
  return commitChapter(root, {
    chapter,
    title: `第${chapter}章`,
    summary: extra.summary ?? `第 ${chapter} 章摘要`,
    strand: extra.strand ?? 'quest',
    deltas: extra.deltas,
    force: extra.force,
  });
}

const warnText = (r) => r.warnings.join('\n');

/* ------------------------------------------------------------------ *
 * ① 未登记 → 告警
 * ------------------------------------------------------------------ */

test('专名 · 未登记的新人名在提交时被点名告警（只提醒、不拦截）', async () => {
  const root = newBook();
  const r = await commitWithText(root, 1, NEW_TERMS_TEXT);
  const all = warnText(r);

  assert.match(all, /疑似未登记专名/);
  for (const name of ['裴惊鸿', '慕容雪', '王林']) {
    assert.ok(all.includes(name), `告警必须点到「${name}」，实际：${all}`);
  }
  // 三个都要带依据，作者才能一眼判断是真名字还是切歪了
  assert.match(all, /依据「裴惊鸿说道」/);
  assert.match(all, /依据「王林高声应道」/);
  // 承认启发式可能误报 + 给出处置动作，不说空话
  assert.match(all, /可能误报/);
  assert.match(all, /deltas\.terms/);

  // 只提醒不 block：提交本身成功，体检不被搞红，账本也不被偷偷写脏
  assert.equal(r.chapter, 1);
  assert.equal(doctorCheck(root).ok, true);
  assert.deepEqual(readTerms(root).value.items, [], '没登记的词绝不能被系统自作主张记进账本');
});

test('专名 · 情态词不能被并进名字（「王林高声应道」的名字是王林，不是王林高声）', () => {
  const hits = detectUnregisteredTerms('王林高声应道：“我也去。”', new Set());
  assert.deepEqual(hits.map((h) => h.name), ['王林']);
});

/* ------------------------------------------------------------------ *
 * ② 登记后不再告警
 * ------------------------------------------------------------------ */

test('专名 · deltas.terms 登记后同一章不再提醒，且类别/首现章落账', async () => {
  const root = newBook();
  const r = await commitWithText(root, 1, NEW_TERMS_TEXT, { deltas: { terms: FIVE_TERMS } });

  const all = warnText(r);
  assert.ok(!all.includes('疑似未登记专名'), `全部登记后不该再提醒，实际：${all}`);
  assert.deepEqual(r.registered.map((t) => t.name).sort(), FIVE_TERMS.map((t) => t.name).sort());
  assert.equal(r.termsTotal, 5);

  const { value } = readTerms(root);
  assert.equal(value.items.length, 5);
  const of = (name) => value.items.find((t) => t.name === name);
  assert.equal(of('裴惊鸿').type, 'person', '中文类别要归一到英文键（后续按类别过滤靠它）');
  assert.equal(of('王林').type, 'person');
  assert.equal(of('幽冥宗').type, 'org');
  assert.equal(of('裴惊鸿').note, '大师兄，伤势未愈');
  for (const t of value.items) {
    assert.equal(t.firstChapter, 1, '首现章自动填本章号，不用调用方传');
    assert.ok(!('id' in t), '名字就是主键，不再发内部序号（重放才不会漂移）');
    assert.ok(!('registeredAt' in t), '条目不存时间：重放拿不到墙上时钟，存了 doctor 就永远对不上账');
  }
});

test('专名 · 已登记过的写法（含别名）下次出现不再重复提醒', async () => {
  const root = newBook();
  await commitWithText(root, 1, '慕容雪沉声道：“下山。”', { deltas: { terms: [{ name: '慕容雪', type: '人名', aliases: ['二师姐'] }] } });
  // 用别名写：登记过的另一种写法，不该被当成新名字
  const r = await commitWithText(root, 2, '二师姐高声说道：“路上小心。”');
  assert.ok(!warnText(r).includes('疑似未登记专名'), `别名命中不该提醒，实际：${warnText(r)}`);
  assert.equal(readTerms(root).value.items.length, 1, '别名命中同一条，不许新增');
});

/* ------------------------------------------------------------------ *
 * ③ 老书兼容（没有 terms.json）
 * ------------------------------------------------------------------ */

test('专名 · 老书没有 terms.json：读不报错、提交得出、体检全绿', async () => {
  const root = newBook();
  fs.rmSync(path.join(root, FILES.terms), { force: true });   // 模拟 v1.2.x 时代建的书

  const read = readTerms(root);
  assert.deepEqual(read.warnings, [], '文件缺失不是损坏，不该报警告');
  assert.deepEqual(read.value.items, []);

  // 角色卡里已有的名字，绝不能再被提醒一遍——生产四本书第一次提交就被刷屏的话，这套提醒当场作废
  const r = await commitWithText(root, 1, '沈九说道：“进屋。”\n\n沈九抬手推门。', {
    deltas: { protagonist: { name: '林越', location: '旧宅' }, characters: [{ name: '沈九', patch: { role: '师兄' } }] },
  });
  assert.ok(!warnText(r).includes('疑似未登记专名'), `老书零噪声失败，实际：${warnText(r)}`);

  const check = doctorCheck(root);
  assert.equal(check.ok, true, `体检必须全绿，实际：${JSON.stringify(check.issues)}`);
  assert.deepEqual(check.issues.filter((i) => i.code.startsWith('replay')), [], '账本缺失与重放空账必须视为一致');
});

test('专名 · 已知专名的全集不止账本（角色卡/世界设定/金手指都算登记过）', () => {
  const state = defaultTermsStateShim();
  const known = knownProperNouns(state, { items: [{ name: '裴惊鸿', type: 'person', aliases: ['大师兄'], firstChapter: 1, note: '' }] });
  for (const name of ['裴惊鸿', '大师兄', '林越', '吞天魔鼎', '青玄宗', '落雁城']) {
    assert.ok(known.has(name), `已知写法应包含 ${name}，实际：${[...known].join('、')}`);
  }
});

/** 造一份「机器态里已经有各种专名」的 state，用来验 knownProperNouns 的覆盖面。 */
function defaultTermsStateShim() {
  return {
    protagonist: { name: '林越', goldenFinger: { name: '吞天魔鼎' } },
    characters: { 沈九: { role: '师兄' } },
    world: { factions: ['青玄宗'], locations: [{ name: '落雁城' }], powerSystem: ['九转归元功'] },
    timeline: [{ chapter: 1, location: '黑水泽', event: 'e' }],
  };
}

/* ------------------------------------------------------------------ *
 * 误报口径（宁漏报不误伤）
 * ------------------------------------------------------------------ */

test('专名 · 泛称/情态词/场所词一个都不许报（误报会毁掉整套提醒）', () => {
  const text = '少年微微皱眉，老者高声说道：“大殿之外，广场之上，众人等候多时。”\n\n师兄叹了口气，原地不动。';
  assert.deepEqual(detectUnregisteredTerms(text, new Set()), [], '常见词组被报成新名字＝误报');

  const text2 = '白须老者拱手道：“客人里面请。”\n\n林晚说道：“我知道。”';
  assert.deepEqual(detectUnregisteredTerms(text2, new Set()).map((h) => h.name), ['林晚'], '「林晚」是真名字，外貌修饰词「白须」与「我」不许当名字报');
});

test('专名 · 只出现一次的地名不报（一笔带过的位置感太强，等重复提及再提醒）', () => {
  assert.deepEqual(detectUnregisteredTerms('三人来到幽冥宗山门外。', new Set()), []);
  assert.equal(detectUnregisteredTerms('三人来到幽冥宗山门外。\n\n幽冥宗的弟子拦住了他们。', new Set()).length, 1);
});

/* ------------------------------------------------------------------ *
 * 账本语义
 * ------------------------------------------------------------------ */

test('专名 · 名字是主键：重复登记合并、首现章不改、类别只补缺、空备注不清账', () => {
  let terms = defaultTerms();
  terms = upsertTerm(terms, { name: '青玄宗', type: 'org', firstChapter: 3, note: '东域第一大宗' });
  terms = upsertTerm(terms, { name: '青玄宗', type: 'place', firstChapter: 9, note: '' });
  assert.equal(terms.items.length, 1);
  assert.equal(terms.items[0].firstChapter, 3, '重登记不能把首现章往后推（那是篡改事实）');
  assert.equal(terms.items[0].type, 'org', '类别只在缺失（other）时升级，不能被后来说法覆盖');
  assert.equal(terms.items[0].note, '东域第一大宗', '空 note 不许清空已有备注');

  terms = upsertTerm(terms, { name: '东域大宗', type: 'other', aliases: ['青玄宗'], firstChapter: 11 });
  assert.equal(terms.items.length, 1, '别名命中的是同一条，不许新增');
  assert.equal(findTerm(terms, '东域大宗').name, '青玄宗', '别名要能反查到本体');
  assert.deepEqual(findTerm(terms, '青玄宗').aliases, ['东域大宗']);
  assert.equal(findTerm(terms, '查无此名'), null);
});

test('专名 · 归一化：没名字的丢掉、同名合并成一条、别名取并集、缺省补 other/null', () => {
  const t = normalizeTerms({
    items: [
      { name: ' 裴惊鸿 ', type: '人名', aliases: ['裴惊鸿', ' 大师兄 ', '', null] },
      { name: '' },
      { name: '   ' },
      null,
      { name: '裴惊鸿', type: 'org' },
      { name: '幽冥宗' },
    ],
  });
  assert.equal(t.items.length, 2, '同名条目必须合并（重复条目会把「是否已登记」判断搞乱）');
  assert.equal(t.items[0].name, '裴惊鸿', '名字两端空白要修掉，否则同名判不出来');
  assert.deepEqual(t.items[0].aliases, ['大师兄'], '别名取并集：与本体同名的、空值都丢掉');
  assert.equal(t.items[0].type, 'org', '标量字段按「后写的说话」');
  assert.deepEqual(t.items[1], { name: '幽冥宗', type: 'other', aliases: [], firstChapter: null, note: '' });
  assert.deepEqual(normalizeTerms(null).items, []);
  assert.deepEqual(normalizeTerms({ items: '不是数组' }).items, []);
});

test('专名 · 归一化不许把首现章往后推', () => {
  const t = normalizeTerms({
    items: [
      { name: '青玄宗', firstChapter: 3 },
      { name: '青玄宗', firstChapter: 9 },
    ],
  });
  assert.equal(t.items[0].firstChapter, 3, '重复条目里取更早的那个：首现章是事实，不能被改写');
});

test('专名 · 空名字条目在提交层被拒并给出原因（不是静默丢掉）', async () => {
  const root = newBook();
  const r = await commitWithText(root, 1, '慕容雪沉声道：“下山。”', { deltas: { terms: [{ type: '人名' }, { name: '  ' }] } });
  assert.match(warnText(r), /空名字/);
  assert.equal(readTerms(root).value.items.length, 0);
});

test('专名 · 第二章仍带着第一章的账，且历史修正模式不动账本', async () => {
  const root = newBook();
  await commitWithText(root, 1, '慕容雪沉声道：“下山。”', { deltas: { terms: [{ name: '慕容雪', type: 'person' }] } });
  const r2 = await commitWithText(root, 2, '王林高声应道：“我随你去。”', { deltas: { terms: [{ name: '王林', type: '人名' }] } });

  assert.deepEqual(r2.registered.map((t) => t.name), ['王林'], '只有新名字算新登记');
  const { value } = readTerms(root);
  assert.equal(value.items.length, 2, '累计 deltas：第一章的账不能丢');
  assert.equal(value.items.find((t) => t.name === '慕容雪').firstChapter, 1);

  const before = JSON.stringify(readTerms(root).value.items);
  await commitWithText(root, 1, '慕容雪沉声道：“下山。”', { summary: 's1 改', deltas: { terms: [{ name: '凭空多出来的名字', type: 'person' }] } , force: true });
  assert.equal(JSON.stringify(readTerms(root).value.items), before, '修正模式忽略全部 deltas，专名账本一分不动');
  assert.equal(doctorCheck(root).ok, true);
  assert.deepEqual(doctorCheck(root).issues.filter((i) => i.code.startsWith('replay')), []);
});

/* ------------------------------------------------------------------ *
 * 查询 / 任务书 / 体检 / 工具层
 * ------------------------------------------------------------------ */

test('专名查询 · 单条命中、别名命中、类别筛、查无此名给下一步动作', async () => {
  const root = newBook();
  await commitWithText(root, 1, NEW_TERMS_TEXT, { deltas: { terms: FIVE_TERMS } });

  const one = runQuery(root, 'term', { name: '裴惊鸿' });
  assert.equal(one.found, true);
  assert.match(one.lines.join('\n'), /裴惊鸿（人名）/);
  assert.match(one.lines.join('\n'), /只能用这一种写法|只用其中一种/, '命中后要强调写法统一');

  const byAlias = runQuery(root, 'term', { name: '二师姐' });
  assert.equal(byAlias.found, true);
  assert.equal(byAlias.term.name, '慕容雪');

  const byType = runQuery(root, 'term', { type: '宗门' });
  assert.deepEqual(byType.items.map((t) => t.name), ['幽冥宗'], '中文类别说法要认');
  assert.match(byType.lines.join('\n'), /类别=组织/);

  const keyword = runQuery(root, 'term', { query: '东域' });
  assert.deepEqual(keyword.items.map((t) => t.name), ['幽冥宗'], '备注也参与关键词匹配');

  const all = runQuery(root, 'term', {});
  assert.match(all.lines.join('\n'), /专名账本：共 5 条/);

  const none = runQuery(root, 'term', { name: '凌霄宗' });
  assert.equal(none.found, false);
  assert.match(none.lines.join('\n'), /deltas\.terms/);
  assert.match(none.lines.join('\n'), /禁止无声创造/, '查无此名时必须把铁律说全');

  const status = runQuery(root, 'status', {});
  assert.match(status.lines.join('\n'), /专名：已登记 5 条/);

  assert.throws(() => runQuery(root, 'nonsense', {}), /term/, '未知 kind 的指路里也要有 term');
});

test('专名查询 · 空账本给出登记指引而不是「共 0 条」这种废话', () => {
  const root = newBook();
  const out = runQuery(root, 'term', {});
  assert.equal(out.found, false);
  assert.match(out.lines.join('\n'), /专名账本为空/);
  assert.match(out.lines.join('\n'), /deltas\.terms/);
});

test('任务书 · 已锁定专名进任务书（按类别计数并指路 query）', async () => {
  const root = newBook();
  await commitWithText(root, 1, NEW_TERMS_TEXT, { deltas: { terms: FIVE_TERMS } });
  const { markdown, brief } = buildWritingBrief(root, 2);
  assert.equal(brief.lockedTerms.total, 5);
  assert.match(markdown, /已锁定专名（只能用这些写法）/);
  assert.match(markdown, /人名 3：/);
  assert.match(markdown, /铁律 1：/);
  assert.match(markdown, /webnovel_query kind=term/);
  assert.match(markdown, /慕容雪（亦作二师姐）/, '别名要在任务书里露出来，否则作者不知道另一种写法也合法');
});

test('任务书 · 没登记过专名时区块仍在场，并说清本章要登记（不许静默跳过）', () => {
  const root = newBook();
  const { markdown } = buildWritingBrief(root, 1);
  assert.match(markdown, /已锁定专名（只能用这些写法）/);
  assert.match(markdown, /专名账本为空/);
  assert.match(markdown, /deltas\.terms/);
});

test('体检 · 绕过工具手改 terms.json 会被 replay-terms 抓到，rebuild 归一后回绿', async () => {
  const root = newBook();
  await commitWithText(root, 1, '慕容雪沉声道：“下山。”', { deltas: { terms: [{ name: '慕容雪', type: 'person' }] } });

  const live = readTerms(root);
  writeTerms(root, {
    ...live.value,
    items: [...live.value.items, { name: '凌霄宗', type: 'org', aliases: [], firstChapter: 1, note: '手写的' }],
  });

  const dirty = doctorCheck(root);
  assert.equal(dirty.ok, true, '账本漂移是警告级：不能因为一条手写记录就把体检判死');
  const codes = dirty.issues.map((i) => i.code);
  assert.ok(codes.includes('replay-terms'), `应报 replay-terms，实际：${codes.join(',') || '（无）'}`);
  assert.match(dirty.issues.find((i) => i.code === 'replay-terms').message, /专名账本/);

  const rebuilt = await doctorRebuild(root, { confirm: true });
  assert.match(rebuilt.lines.join('\n'), /专名账本：重建后 1 条/);
  assert.deepEqual(readTerms(root).value.items.map((t) => t.name), ['慕容雪'], '重建把提交链里没有的手写条目清掉');
  assert.deepEqual(doctorCheck(root).issues.filter((i) => i.code.startsWith('replay')), [], '归一后重放必须与现役一致');
});

test('体检 · 备份里带上专名账本（改坏了还能从 trash 找回）', async () => {
  const root = newBook();
  await commitWithText(root, 1, '慕容雪沉声道：“下山。”', { deltas: { terms: [{ name: '慕容雪', type: 'person' }] } });
  const rebuilt = await doctorRebuild(root, { confirm: true });
  const backupDir = path.join(root, rebuilt.backupDir);
  assert.ok(fs.existsSync(path.join(backupDir, 'terms.json')), `备份缺 terms.json：${fs.readdirSync(backupDir).join('、')}`);
});

test('工具层 · commit 播报新登记专名、未登记名字进警告、kind=term 走得通', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-terms-books-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: booksRoot }), footer: 'full' };
  await applyTool('webnovel_init', {
    bookId: 'termbook', title: '工具书', genre: '玄幻', logline: '一句话。', targetWords: 100_000, targetChapters: 50,
  }, config);

  await applyTool('webnovel_outline', {
    bookId: 'termbook', action: 'write_text', chapter: 1, title: '第一章', text: '慕容雪沉声道：“下山。”',
  }, config);
  const committed = await applyTool('webnovel_commit', {
    bookId: 'termbook', chapter: 1, title: '第一章', summary: 's', strand: 'quest',
    deltas: { terms: [{ name: '慕容雪', type: '人名' }] },
  }, config);
  assert.match(committed, /新登记专名 1 条（账本共 1 条）：慕容雪（人名）/);

  const q = await applyTool('webnovel_query', { bookId: 'termbook', kind: 'term' }, config);
  assert.match(q, /专名账本：共 1 条/);
  const single = await applyTool('webnovel_query', { bookId: 'termbook', kind: 'term', name: '慕容雪' }, config);
  assert.match(single, /慕容雪（人名）/);

  // 没登记的名字：警告出现在「注意」区，但提交照样成功（只提醒不拦截）
  await applyTool('webnovel_outline', {
    bookId: 'termbook', action: 'write_text', chapter: 2, title: '第二章', text: '石中火高声应道：“我也去。”',
  }, config);
  const second = await applyTool('webnovel_commit', {
    bookId: 'termbook', chapter: 2, title: '第二章', summary: 's2', strand: 'quest',
  }, config);
  assert.match(second, /已提交第 2 章/);
  assert.match(second, /疑似未登记专名/);
  assert.match(second, /石中火/);

  // deltas 里的 terms 字段必须被系统认（否则会被当成未知字段静默丢掉）
  const withTerms = await applyTool('webnovel_commit', {
    bookId: 'termbook', chapter: 3, title: '第三章', summary: 's3', strand: 'constellation',
    deltas: { terms: [{ name: '藏剑阁', type: 'org' }] },
  }, config);
  assert.ok(!withTerms.includes('系统不认'), `terms 不该被判为未知字段：${withTerms}`);
  assert.match(withTerms, /新登记专名 1 条/);
});

test('初始化 · 骨架里就建好 terms.json（新书开箱就有账本）', () => {
  const root = newBook();
  assert.ok(fs.existsSync(path.join(root, FILES.terms)), 'init 应创建 .webnovel/terms.json');
  assert.equal(readTerms(root).value.items.length, 0);
});
