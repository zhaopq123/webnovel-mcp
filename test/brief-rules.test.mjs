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
