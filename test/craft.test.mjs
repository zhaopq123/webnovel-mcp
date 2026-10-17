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
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
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
const CATALOG = path.join(ROOT, 'prompt', 'catalog.json');
const LOCK = path.join(ROOT, 'prompt', 'source-lock.json');
const BUILDER = path.join(ROOT, 'scripts', 'build-prompt-catalog.mjs');

const source = () => readFileSync(SOURCE, 'utf8');

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
  const before = readFileSync(CATALOG, 'utf8');
  const mutated = JSON.parse(before);
  mutated.units[3].text = mutated.units[3].text + '\n（伪造）';
  writeFileSync(CATALOG, JSON.stringify(mutated, null, 2) + '\n', 'utf8');
  try {
    assert.throws(() => loadCatalog(), /哈希不符/);
    assert.equal(craftCheck().ok, false, 'craftCheck 没把篡改判成红');
    assert.ok(craftCheck().problems.length > 0);
  } finally {
    writeFileSync(CATALOG, before, 'utf8');
  }
  assert.equal(craftCheck().ok, true, '还原后自检没回绿（测试自己漏了清理）');
});

test('craft · 原文被改而未重锁：--check 当场红（防止只改原文忘了重建）', () => {
  const bak = `${SOURCE}.bak-hygt`;
  const before = source();
  copyFileSync(SOURCE, bak);
  try {
    writeFileSync(SOURCE, before.replace('### 4.3 开篇还债规则', '### 4.3 开篇还债规则（临时）'), 'utf8');
    assert.throws(() => execFileSync(process.execPath, [BUILDER, '--check'], { encoding: 'utf8' }), /./,
      '改了原文 --check 竟然还是绿的');
  } finally {
    copyFileSync(bak, SOURCE);
    rmSync(bak, { force: true });
  }
  const r = execFileSync(process.execPath, [BUILDER, '--check'], { encoding: 'utf8' });
  assert.match(r, /一致/, `还原后 --check 没回绿：${r}`);
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
