/**
 * 任务书接入提示词切片（P1 #13）+ 规则不抄第二份（P0 #5 的门禁）。
 *
 * 这两件事是一件事的两面：规则要真的进到每章任务书里（否则原文只是躺在仓库里的资料），
 * 又不能因此把正文抄进 context.js / 专家包（那会变成第四份副本并开始漂移）。
 * 所以断言一头钉「在场」，一头钉「没有第二份」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTool, loadConfig } from '../mcp/tools.mjs';
import { briefRules, briefTriggers, BRIEF_PRIORITY, BRIEF_DEFAULT_CHARS, loadCatalog } from '../lib/features/craft.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const DUP = path.join(ROOT, 'scripts', 'check-rule-duplication.mjs');

const CN_SEC = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三'];
const source = () => readFileSync(path.join(ROOT, 'prompt', 'CREATIVE-PROMPT.md'), 'utf8');

async function freshBook(env = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wn-brief-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: root, ...env }), token: '' };
  await applyTool('webnovel_init', { bookId: 'b1', title: '必守测试', genre: '都市', targetWords: 300000, targetChapters: 100 }, config);
  await applyTool('webnovel_outline', {
    bookId: 'b1', action: 'write_chapter', chapter: 1,
    text: '# 第一章 开场\n- 场景：出租屋\n- 目标：撑过第一夜\n- 钩子：门外有人敲门',
  }, config);
  return { root, config };
}

test('任务书 · 本章必守真的在场，且是原文逐字', async () => {
  const { root, config } = await freshBook();
  try {
    const md = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 }, config);
    assert.match(md, /本章必守（提示词原文/, '任务书里没有「本章必守」区块');
    const src = source();
    for (const key of ['名词锁定：所有专有名词', '只有第二遍通过后才算交付', '重伤未愈的下章不能满状态战斗']) {
      assert.ok(src.includes(key), `基准原文里没有「${key}」——测试自己写错了`);
      assert.ok(md.includes(key), `任务书缺少原文切片内容「${key}」`);
    }
    assert.match(md, /装配口径：/, '没说明装配口径（模型无从知道这是被截取的）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('任务书 · 必守区块不超过预算，且被截掉的切片会被点名', async () => {
  const { root, config } = await freshBook({ WEBNOVEL_BRIEF_RULES_CHARS: '900' });
  try {
    const md = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 }, config);
    const rules = briefRules(loadCatalog().catalog, { maxChars: 900, triggers: [] });
    assert.ok(rules.chars <= 900, `超预算：${rules.chars}`);
    assert.ok(rules.dropped.length > 0, '900 字预算下必然有截断，没截断说明预算没生效');
    assert.match(md, /因超出预算未带/, '截断了却没在任务书里说');
    for (const d of rules.dropped) assert.match(md, new RegExp(d.id.replace('.', '\\.')), `未带清单里缺少 ${d.id}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('任务书 · token 纪律：规则块增幅受预算约束，且有硬上限', async () => {
  const { root, config } = await freshBook();
  try {
    const off = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 },
      { ...config, briefRules: 'off' });
    const on = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 }, config);
    const delta = on.length - off.length;
    // 装配说明（标题 + 口径行 + 已带/未带清单）是固定开销，实测 ≤400 字；规则正文本身受预算约束。
    assert.ok(delta <= BRIEF_DEFAULT_CHARS + 400,
      `规则块增幅失控：${delta} > ${BRIEF_DEFAULT_CHARS}+400（每章固定成本要能算清）`);
    assert.ok(delta > 800, `增幅只有 ${delta} 字，规则八成没装上（这条断言防「空区块也算过」）`);
    const lean = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 },
      { ...config, briefRulesChars: 850 });
    assert.ok(lean.length - off.length <= 850 + 400, '850 预算没压住（预算旋钮是假的）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('任务书 · 章节特殊情况会加塞对应规则（每 10 章报告节点 / 叙事债到期）', () => {
  const { catalog } = loadCatalog();
  const plain = briefRules(catalog, { maxChars: 1700, triggers: [] });
  const atReport = briefRules(catalog, { maxChars: 1700, triggers: briefTriggers({ batchReport: true }) });
  assert.ok(atReport.kept.some((k) => k.id === '17') || atReport.chars >= plain.chars,
    '报告节点没有把第十七节排进优先级');
  const t = briefTriggers({ debtDue: 3, romanceEnabled: true });
  assert.deepEqual(t.map((x) => x.id), ['4.1', '7.2'], '叙事债 3 笔要带 4.1、启用感情线要带 7.2（按紧急度排）');
  assert.match(t[0].why, /3 笔/, '加塞理由要把触发条件说出来');
  assert.ok(t.every((x) => x.why), '加塞条目必须都带理由');
  assert.deepEqual(briefTriggers({}), [], '没有特殊情况就不该加塞');
});

test('任务书 · 报告节点章真的把加塞规则带进任务书（端到端，不只是纯函数）', async () => {
  const { root, config } = await freshBook();
  try {
    const plain = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 }, config);
    const at10 = await applyTool('webnovel_context', { bookId: 'b1', chapter: 10 }, config);
    assert.doesNotMatch(plain, /本章是每 10 章的报告节点/, '第 1 章不该触发报告节点');
    assert.match(at10, /本章是每 10 章的报告节点/, '第 10 章应把报告节点规则排进优先级');
    assert.match(at10, /第十七节\s*连载状态报告/, '触发规则应把第十七节正文带进来');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 在子进程里取任务书。为什么不能用 process.env 就地改：
 * node:test 的顶层用例默认并发跑，本文件改一次全局环境变量就会串到别的用例
 * （实测过一次：这条用例把 WEBNOVEL_PROMPT_ROOT 指向空目录期间，
 * 兄弟用例的 loadCatalog() 抛出「切片库未构建」，红得莫名其妙）。
 * 全局状态只在本进程读，跨进程的隔离交给子进程，测完不留痕。
 */
const CHILD_BRIEF = `
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.env.WN_REPO;
const { applyTool, loadConfig } = await import(pathToFileURL(path.join(repo, 'mcp', 'tools.mjs')).href);
const root = mkdtempSync(path.join(os.tmpdir(), 'wn-child-'));
const cfg = { ...loadConfig({ WEBNOVEL_ROOT: root }), token: '' };
await applyTool('webnovel_init', { bookId: 'b1', title: '隔离测试', genre: '都市', targetWords: 300000, targetChapters: 100 }, cfg);
await applyTool('webnovel_outline', { bookId: 'b1', action: 'write_chapter', chapter: 1,
  text: '# 第一章 开场\\n- 场景：出租屋\\n- 目标：撑过第一夜\\n- 钩子：门外有人敲门' }, cfg);
process.stdout.write(await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 }, cfg));
rmSync(root, { recursive: true, force: true });
`;

function briefFromChild({ promptRoot }) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', CHILD_BRIEF], {
    encoding: 'utf8',
    env: { ...process.env, WN_REPO: ROOT, ...(promptRoot ? { WEBNOVEL_PROMPT_ROOT: promptRoot } : {}) },
  });
}

test('任务书 · 切片库缺失时不拖垮调用，但要把话说清楚', () => {
  const fake = mkdtempSync(path.join(os.tmpdir(), 'wn-nocatalog-'));
  try {
    // 先证明子进程本身能跑出带规则的任务书（否则下面的「没有区块」会因为脚本挂了而假绿）
    const good = briefFromChild({});
    assert.match(good, /本章必守（提示词原文/, '子进程正常路径没带规则 = 测试脚手架坏了');

    // ① 纯函数口径：root 指到空目录必须抛错，不许静默返回空规则
    assert.throws(() => loadCatalog({ root: fake }), /未构建/, '切片库缺失却没报错 = 会静默降级');

    // ② 端到端口径：任务书侧容错 —— 规则拿不到也要出任务书，并把缺的事写进警告
    const md = briefFromChild({ promptRoot: fake });
    assert.match(md, /本章必守规则未加载/, '规则缺失没有暴露到任务书里');
    assert.doesNotMatch(md, /本章必守（提示词原文/, '规则没加载成功却还渲染区块');
    assert.match(md, /硬约束（不可违反）/, '规则库挂了也不能影响产品硬约束');
    assert.match(md, /本书定位/, '规则缺失时本书事实必须照常在场');
    assert.match(md, /本章章纲/, '规则缺失时章纲必须照常在场');
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test('任务书 · rules=off 时整块消失（省 token 的开关是真的）', async () => {
  const { root, config } = await freshBook({ WEBNOVEL_BRIEF_RULES: 'off' });
  try {
    const md = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 }, config);
    assert.doesNotMatch(md, /本章必守（提示词原文/, 'off 了还在带规则块');
    assert.match(md, /硬约束（不可违反）/, '产品四条硬约束与开关无关，必须一直在');
    assert.ok(md.length < 1600, `off 之后任务书仍有 ${md.length} 字，开关没省下东西`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('优先级表引用的切片都必须真实存在且在第十五/三/六/一节内', () => {
  const { catalog } = loadCatalog();
  const src = source();
  for (const item of BRIEF_PRIORITY) {
    const u = catalog.units.find((x) => x.id === item.id);
    assert.ok(u, `BRIEF_PRIORITY 引用了不存在的切片 ${item.id}`);
    assert.ok(src.includes(u.text), `${item.id} 不是原文逐字`);
    assert.ok(item.why, `${item.id} 缺装配理由（任务书要把理由说出来）`);
  }
});

/* ------------------------------------------------------------------ *
 * C1：预算装配的语义是「按优先级截断」，不是「挑能装的装箱」。
 * 这两件事的差别只在一处：装不下的大规则后面若刚好有个小规则，装箱会把它塞进去——
 * 于是每章任务书都缺「文字洁净度」这种工具事后查不出来的规则，而表面上一切正常。
 * 下面几条把语义钉死：改回装箱会当场红。
 * ------------------------------------------------------------------ */

test('装配 · kept 是优先级表的连续前缀，未带清单是它的补集（不变量，非固定数字）', () => {
  const { catalog } = loadCatalog();
  const charsOf = new Map(catalog.units.map((u) => [u.id, u.chars]));
  const table = BRIEF_PRIORITY.map((p) => p.id);
  const budgets = [10, 300, 900, 1000, 1500, 2100, 2314, 2315, 2400, 2936, 4082, 99999];
  for (const budget of budgets) {
    const r = briefRules(catalog, { maxChars: budget, triggers: [] });
    const ids = r.kept.map((k) => k.id);
    // ① 连续前缀：中间不许跳着带（跳着＝装箱）
    assert.deepEqual(ids, table.slice(0, ids.length), `预算 ${budget}：kept 不是表的连续前缀 → ${ids.join(',')}`);
    // ② 相对顺序与表一致（用户口径：优先级表相对顺序 == 实际装配相对顺序）
    assert.deepEqual(ids, table.filter((id) => ids.includes(id)), `预算 ${budget}：kept 相对顺序与优先级表不一致`);
    // ③ 不超预算
    assert.ok(r.chars <= budget, `预算 ${budget}：实带 ${r.chars} 字，超了`);
    // ④ 贪尽：下一条真的装不下（防「提前停」把预算白白浪费掉）
    if (ids.length < table.length) {
      const next = charsOf.get(table[ids.length]);
      assert.ok(r.chars + next > budget,
        `预算 ${budget}：下一条 ${table[ids.length]}(${next} 字) 明明装得下却没带 = 截断点算错`);
    }
    // ⑤ 未带清单＝截断点起的整条尾巴，含「装不下的那一条」本身，一条不许静默消失
    assert.deepEqual(r.dropped.map((d) => d.id), table.slice(ids.length),
      `预算 ${budget}：未带清单与截断点后的条目不符`);
  }
});

test('装配 · 装不下的高优先规则，不许被排在它后面的小规则顶替', () => {
  const { catalog } = loadCatalog();
  const r = briefRules(catalog, { maxChars: 2100, triggers: [] });
  const ids = r.kept.map((k) => k.id);
  const chars = new Map(catalog.units.map((u) => [u.id, u.chars]));
  assert.ok(!ids.includes('15.7'), `2100 装不下 15.7（${chars.get('15.7')} 字）是事实，别硬塞`);
  assert.ok(!ids.includes('15.6'),
    `15.6（${chars.get('15.6')} 字）单独装得下，但它排在 15.7 之后——带它进来就是装箱语义（C1 的原始缺陷）`);
  assert.ok(r.dropped.some((d) => d.id === '15.7'), '15.7 没进未带清单 = 静默丢规则');
});

test('装配 · 默认预算必须真的带上 15.7 文字洁净度（C1 验收）', () => {
  const { catalog } = loadCatalog();
  const r = briefRules(catalog, { maxChars: BRIEF_DEFAULT_CHARS, triggers: [] });
  assert.ok(r.kept.some((k) => k.id === '15.7'),
    `默认预算 ${BRIEF_DEFAULT_CHARS} 字没带上 15.7（洁净度）——工具事后查不出这条，只能写时守`);
  assert.ok(r.chars <= BRIEF_DEFAULT_CHARS, `实带 ${r.chars} 字超过默认预算`);
  // 每章固定成本上限：预算是每章都付的钱，调大必须是有意识的决定（改坏会红）
  assert.ok(BRIEF_DEFAULT_CHARS <= 2600, `默认预算涨到 ${BRIEF_DEFAULT_CHARS} 字，每章固定成本失控`);
});

test('装配 · 报告节点章带第十七节，被挤掉的尾部规则要在任务书里点名指路', async () => {
  const { catalog } = loadCatalog();
  const r = briefRules(catalog, { maxChars: BRIEF_DEFAULT_CHARS, triggers: briefTriggers({ batchReport: true }) });
  assert.ok(r.kept.some((k) => k.id === '17'), '报告节点章必须带第十七节');
  const missing = r.dropped.map((d) => d.id);
  assert.ok(missing.includes('15.7'), '加塞挤掉了 15.7——可以，但必须进未带清单');
  const { root, config } = await freshBook();
  try {
    const md = await applyTool('webnovel_context', { bookId: 'b1', chapter: 10 }, config);
    assert.match(md, /因超出预算未带/, '截断了却没在任务书里说');
    for (const id of missing) {
      assert.match(md, new RegExp(id.replace('.', '\\.')), `未带清单缺少 ${id}`);
    }
    assert.match(md, /webnovel_craft action=get/, '未带规则没给取回路径（等于让模型执行一条它拿不到的规则）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('装配 · 表里写了不存在的切片，无论预算多大都当场炸', () => {
  const { catalog } = loadCatalog();
  // 预算只有 10 字：一条都装不下。低优先级的 id 打错字也必须被发现，否则它会永远静默消失
  assert.throws(() => briefRules(catalog, { maxChars: 10, triggers: [{ id: '99.9', why: '不存在' }] }),
    /引用了不存在的切片/);
  assert.throws(() => briefRules(catalog, { maxChars: 99999, triggers: [{ id: '99.9', why: '不存在' }] }),
    /引用了不存在的切片/);
});

test('门禁 · 规则正文全仓库只有一份（check-rule-duplication）', () => {
  const out = execFileSync(process.execPath, [DUP], { encoding: 'utf8' });
  assert.match(out, /跨文件重复条文数=0/, `发现第二份规则正文：\n${out}`);
  const st = execFileSync(process.execPath, [DUP, '--selftest'], { encoding: 'utf8' });
  assert.match(st, /selftest 通过/, `判据不能变红 = 没有判据：\n${st}`);
  assert.doesNotMatch(st, /FAIL/, st);
});

test('门禁 · 任务书编号仍然连续（加了区块不能跳号）', async () => {
  const { root, config } = await freshBook();
  try {
    const md = await applyTool('webnovel_context', { bookId: 'b1', chapter: 1 }, config);
    const nums = [...md.matchAll(/^## ([一二三四五六七八九十]+)、/gm)].map((m) => m[1]);
    assert.ok(nums.length >= 5, `只识别到 ${nums.length} 个编号区块，正则或渲染改了？`);
    assert.deepEqual(nums, CN_SEC.slice(0, nums.length), `章节编号不连续：${nums.join('、')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
