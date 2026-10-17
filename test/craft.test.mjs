/**
 * craft（提示词切片库）契约与无损性回归网。
 *
 * 这块的风险不是「功能没做」，而是「切片悄悄和原文分了家」——
 * 所以每条断言都拿原文（prompt/CREATIVE-PROMPT.md）当基准，而不是拿 catalog 自己当基准。
 * 判据本身能不能变红由 --selftest 与下面的篡改用例负责，不靠人眼。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTool, TOOL_DEFS } from '../mcp/tools.mjs';
import { TOOL_NAMES } from '../mcp/tool-names.mjs';
import {
  loadCatalog, craftCheck, craftGet, craftBrief, craftSections, expandIds, resolveStage,
  STAGE_PACKS, SETTING_TABLE_MAP,
} from '../lib/features/craft.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SOURCE = path.join(ROOT, 'prompt', 'CREATIVE-PROMPT.md');
const LOCK = path.join(ROOT, 'prompt', 'source-lock.json');
const BUILDER = path.join(ROOT, 'scripts', 'build-prompt-catalog.mjs');

const source = () => readFileSync(SOURCE, 'utf8');

/**
 * 把 prompt/ 整份拷进临时目录，返回一个「假仓库根」。
 * 篡改类用例一律在这里面上手，绝不改工作树：node --test 是并发跑文件的，
 * 改真 catalog 会让兄弟用例偶发读到脏哈希（实测红过一次），脚本半路崩还会把仓库留在脏状态。
 *
 * 逐文件拷，不用 cpSync(recursive)：本机 Node 22.23.3 在 Windows 上 cpSync 整个目录
 * 会把进程直接打挂（0xC0000409 / bash 里表现为 exit 127，连 try-catch 都拦不住）。
 * 这里只有三个已知文件，逐个读写的拷贝方式没有这个雷，也不依赖目录里以后多出什么。
 */
function snapshotPrompt() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wn-craft-tamper-'));
  const dst = path.join(tmp, 'prompt');
  mkdirSync(dst, { recursive: true });
  for (const f of ['CREATIVE-PROMPT.md', 'catalog.json', 'source-lock.json']) {
    writeFileSync(path.join(dst, f), readFileSync(path.join(ROOT, 'prompt', f)));
  }
  return tmp;
}

/** 用假仓库根跑构建器（WEBNOVEL_PROMPT_ROOT 与 craft.js 共用同一个旋钮）。 */
function runBuilder(root, args) {
  return execFileSync(process.execPath, [BUILDER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WEBNOVEL_PROMPT_ROOT: root },
  });
}

test('craft · 切片库与原文三方一致（C5 锁 / C7 还原）', () => {
  const result = craftCheck();
  assert.deepEqual(result.problems, [], `自检问题：\n${result.problems.join('\n')}`);
  assert.equal(result.ok, true);
  assert.equal(result.stats.sections, 19, '顶层节数必须是 19（原文第十九节，一节都不能少）');
});

test('craft · 切片原文逐字来自原文文件，不是二次誊写', () => {
  const { catalog } = loadCatalog();
  const src = source();
  const samples = ['1.2', '6.14.2', '15.8', '19', '2.5', '10.0', '13.2'];
  for (const id of samples) {
    const u = catalog.units.find((x) => x.id === id);
    assert.ok(u, `切片 ${id} 不存在`);
    assert.ok(src.includes(u.text), `切片 ${id}「${u.title.slice(0, 16)}」的正文在原文里找不到逐字对应`);
    assert.equal(u.text, src.split('\n').slice(u.startLine - 1, u.endLine).join('\n').replace(/\s+$/, ''),
      `切片 ${id} 的行区间 [${u.startLine},${u.endLine}] 与正文对不上`);
  }
});

test('craft · 切片拼接 == 原文（无损，允许首尾空白差异）', () => {
  const { catalog } = loadCatalog();
  const got = craftGet(catalog, 'all', {}).text;
  const norm = (s) => s.replace(/\s+$/, '');
  const srcLines = source().split('\n');
  assert.equal(norm(got), norm(srcLines.join('\n')), '全篇切片拼接后与原文不一致');
});

test('craft · 19 节全部可达：每个顶层节都能被 get 取到且非空', () => {
  const { catalog } = loadCatalog();
  const tops = catalog.units.filter((u) => u.level === 2 && u.section > 0);
  assert.equal(tops.length, 19);
  for (const t of tops) {
    const r = craftGet(catalog, t.id);
    assert.ok(r.text.length > 0, `第${t.id}节取不到正文`);
    assert.ok(r.units[0].id === t.id, `第${t.id}节首切片不是自己`);
    assert.ok(source().includes(r.units[0].text), `第${t.id}节正文与原文不逐字一致`);
  }
});

test('craft · 阶段包只引用真实存在的切片号', () => {
  const { catalog } = loadCatalog();
  for (const [key, pack] of Object.entries(STAGE_PACKS)) {
    for (const id of pack.ids) {
      assert.ok(catalog.units.some((u) => u.id === id), `${key} 引用了不存在的切片 ${id}`);
    }
    assert.ok(pack.label, `${key} 缺中文标签`);
  }
});

test('craft · 阶段别名解析（中文/数字/英文都得认，未知即报错）', () => {
  assert.equal(resolveStage('stage3'), 'stage3');
  assert.equal(resolveStage('阶段3'), 'stage3');
  assert.equal(resolveStage('阶段三'), 'stage3');
  assert.equal(resolveStage('正文'), 'stage6');
  assert.equal(resolveStage('章纲'), 'stage5');
  assert.equal(resolveStage(''), 'stage6', '不传阶段默认正文（最常见的用法）');
  assert.throws(() => resolveStage('阶段9'), /未知阶段/);
});

test('craft · 预算截断是显式声明的，不是静默丢内容', () => {
  const { catalog } = loadCatalog();
  const r = craftBrief(catalog, 'stage6', { maxChars: 1200 });
  assert.ok(r.chars <= 1200, `超预算：${r.chars}`);
  assert.ok(r.skipped.length > 0, 'stage6 全量远超 1200，必须有省略清单');
  assert.match(r.text, /超预算省略/, '截断必须在返回里说出来');
  const g = craftGet(catalog, '15', { maxChars: 300 });
  assert.match(g.text, /因超出 maxChars 省略/);
});

test('craft · 不存在的切片号报错要给出下一步动作', () => {
  const { catalog } = loadCatalog();
  assert.throws(() => expandIds(catalog, ['99.9']), /action=sections/);
});

test('craft · 切片库陈旧时必须拒绝服务，不返回旧规则', () => {
  const tmp = snapshotPrompt();
  try {
    const catPath = path.join(tmp, 'prompt', 'catalog.json');
    const mutated = JSON.parse(readFileSync(catPath, 'utf8'));
    mutated.units[3].text = mutated.units[3].text + '\n（伪造）';
    writeFileSync(catPath, JSON.stringify(mutated, null, 2) + '\n', 'utf8');
    assert.throws(() => loadCatalog({ root: tmp }), /哈希不符/);
    assert.equal(craftCheck({ root: tmp }).ok, false, 'craftCheck 没把篡改判成红');
    assert.ok(craftCheck({ root: tmp }).problems.length > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // 真仓库自始至终没被碰过（这条断言防的就是「测试改完没还原」这种自污）
  assert.equal(craftCheck().ok, true, '真仓库的切片库自检不绿 —— 测试污染了工作树');
});

test('craft · 原文被改而未重锁：--check 当场红（在临时副本上证明）', () => {
  const tmp = snapshotPrompt();
  try {
    const srcPath = path.join(tmp, 'prompt', 'CREATIVE-PROMPT.md');
    writeFileSync(srcPath, source().replace('### 4.3 开篇还债规则', '### 4.3 开篇还债规则（临时）'), 'utf8');
    assert.throws(() => runBuilder(tmp, ['--check']), /--check 失败/, '改了原文 --check 竟然还是绿的');
    // 重建后回绿 = 「改原文 → 重锁」这条路真的走得通，不只是一个会红的判据
    runBuilder(tmp, []);
    assert.match(runBuilder(tmp, ['--check']), /一致/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const real = execFileSync(process.execPath, [BUILDER, '--check'], { encoding: 'utf8' });
  assert.match(real, /一致/, `真仓库的 --check 不该被测试带红：${real}`);
});

test('craft · 构建器 selftest 证明判据可红可绿（闸门本身要能被证明失效）', () => {
  const out = execFileSync(process.execPath, [BUILDER, '--selftest'], { encoding: 'utf8' });
  assert.match(out, /判据可红可绿/);
  assert.doesNotMatch(out, /FAIL/, `selftest 里有失效项：\n${out}`);
});

test('craft · 锁文件与原文哈希对齐（唯一事实来源可核验）', () => {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  assert.equal(createHash('sha256').update(source()).digest('hex'), lock.sourceSha256,
    '原文哈希与锁不一致：改原文后必须重跑 build-prompt-catalog.mjs');
  assert.equal(lock.sections, 19);
  assert.equal(lock.lines, source().split('\n').length);
});

test('craft · 设定记录落点表覆盖 20 表且状态取值合法', () => {
  assert.equal(SETTING_TABLE_MAP.length, 20, '【设定记录】原文列了 20 张表，落点表必须一一对应');
  const allowed = new Set(['state', 'partial', 'new', 'agent']);
  for (const r of SETTING_TABLE_MAP) {
    assert.ok(r.table && r.target && r.note, `落点表 ${r.table} 字段缺失`);
    assert.ok(allowed.has(r.status), `${r.table} 状态取值非法：${r.status}`);
  }
  const names = SETTING_TABLE_MAP.map((r) => r.table);
  assert.equal(new Set(names).size, names.length, '落点表有重名');
});

/**
 * 落点表会被 agent 当成「往哪个键里塞东西」的说明书（action=map 原样输出），
 * 所以它必须跟着数据模型一起长。这张表写一个不存在的键＝工具撒谎，
 * 而撒谎的落点比空白更糟：agent 会照着写，写完查不到，账就散了。
 * 这一条把「计划第 9-12 条已落地」的字段名钉死，并把早期设计稿里那几个假键钉回黑名单。
 */
test('craft · 落点表只认真实存在的键（假键进黑名单）', () => {
  const joined = SETTING_TABLE_MAP.map((r) => `${r.table} ${r.target} ${r.note}`).join('\n');
  for (const real of [
    'terms.json', 'structure.js', 'desire', 'fear', 'secret', 'contradiction',
    'voice', 'fingerprint', 'meltdown', 'humanFlaws', 'errorPlan',
    'knows', 'notKnows', 'mistaken', 'relationLevel', 'arcProgress',
    'type=suspense', 'type=foreshadow', 'type=cheque', 'type=red_herring',
    'plannedPayoff', 'hintChapters', 'realExplanation', 'falseAssumption', 'layer',
    'state.progress.parts', '大纲/部纲', '.webnovel/parts',
  ]) {
    assert.ok(joined.includes(real), `落点表丢了真实字段「${real}」——它现在是工具能力的一部分`);
  }
  for (const fake of [
    '.speech', 'villainPlan', 'type=misdirect', 'type=promise', 'state.romance',
    'protagonist.motivation', 'memory.json(kind=rule)', '（未落地）',
  ]) {
    assert.ok(!joined.includes(fake), `落点表出现假键「${fake}」：那个名字从来没有落盘实现过`);
  }
  // 部摘要已在 #14 落地：必须指到真路径，不许再标 agent/未落地
  const parts = SETTING_TABLE_MAP.find((r) => r.table === '部N摘要（历史区）');
  assert.equal(parts.status, 'new', '部摘要已落地，状态该是 new');
  assert.match(parts.target, /\.webnovel\/parts/);
  assert.match(parts.target, /state\.progress\.parts/);
});

test('craft · 工具已注册为第 12 个且不带 bookId', async () => {
  assert.equal(TOOL_NAMES.length, TOOL_DEFS.length);
  assert.ok(TOOL_NAMES.includes('webnovel_craft'));
  const t = TOOL_DEFS.find((x) => x.name === 'webnovel_craft');
  assert.ok(t, 'webnovel_craft 未注册进 TOOL_DEFS');
  assert.equal(t.inputSchema.properties.bookId, undefined, 'craft 不该接受 bookId（它操作的是规则库不是某本书）');
  assert.deepEqual(t.inputSchema.properties.action.enum, ['sections', 'get', 'brief', 'map', 'check']);
});

test('craft · 五个 action 经工具层真跑一遍', async () => {
  const sections = await applyTool('webnovel_craft', { action: 'sections' }, {});
  assert.match(sections, /第十九节/);
  assert.match(sections, /阶段包/);

  const got = await applyTool('webnovel_craft', { action: 'get', ids: '15.8' }, {});
  assert.match(got, /两遍交付制/);
  assert.match(source(), new RegExp('两遍交付制'), '基准原文应含该标题');

  const brief = await applyTool('webnovel_craft', { action: 'brief', stage: '正文', maxChars: 1000 }, {});
  assert.match(brief, /创作规则包 · 阶段6/);

  const map = await applyTool('webnovel_craft', { action: 'map' }, {});
  assert.match(map, /【设定记录】20 表/);

  const check = await applyTool('webnovel_craft', { action: 'check' }, {});
  assert.match(check, /✓ 原文 \/ 切片库 \/ 锁 三方一致/);

  await assert.rejects(() => applyTool('webnovel_craft', { action: 'nope' }, {}), /未知的 action/);
});
