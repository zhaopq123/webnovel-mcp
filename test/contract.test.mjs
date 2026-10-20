/**
 * 契约测试：工具清单、提示词与实现三者不许脱节。
 * 这是「文档说调 A，实际只有 B」这类事故的唯一防线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS, listTools, BOOK_ID_RE, NO_BOOK_PARAM } from '../mcp/tools.mjs';
import { TOOL_NAMES } from '../mcp/tool-names.mjs';
import { PROMPTS, PROMPT_NAMES } from '../mcp/prompts.mjs';

test('契约 · 工具名与清单一致且唯一', () => {
  const names = TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, '工具名不能重复');
  assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort(), 'tool-names.mjs 必须与实现同步');
});

test('契约 · 每个工具的 inputSchema 合法', () => {
  for (const t of TOOL_DEFS) {
    assert.equal(typeof t.handler, 'function', `${t.name} 必须有 handler`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} 应禁止额外字段`);
    for (const key of t.inputSchema.required) {
      assert.ok(t.inputSchema.properties[key], `${t.name}.required 里的 ${key} 必须在 properties 中`);
    }
    const json = JSON.stringify(t.inputSchema);
    for (const banned of ['anyOf', 'oneOf', 'allOf', '$ref', 'outputSchema']) {
      assert.ok(!json.includes(banned), `${t.name} 的 schema 不应含 ${banned}`);
    }
  }
});

test('契约 · 除免书工具外所有工具都接受 bookId', () => {
  for (const t of TOOL_DEFS) {
    if (NO_BOOK_PARAM.has(t.name)) continue;
    assert.ok(t.inputSchema.properties.bookId, `${t.name} 应接受 bookId`);
  }
});

test('契约 · 提示词引用的工具都真实存在', () => {
  const known = new Set(TOOL_NAMES);
  for (const p of PROMPTS) {
    const referenced = new Set([...p.content.matchAll(/webnovel_[a-z_]+/g)].map((m) => m[0]));
    for (const name of referenced) {
      assert.ok(known.has(name), `${p.name} 引用了不存在的工具 ${name}`);
    }
  }
});

test('契约 · 专家正文引用的工具都真实存在', () => {
  // README 承诺过这条防线，但一直只覆盖 prompts.mjs——专家正文里写错工具名
  // （如把 outline 的 action=write_text 写成独立的 webnovel_write_text）没人拦。
  // 现在遍历 expert/ 下所有专家的 agents/*.md，写错即红。
  const known = new Set(TOOL_NAMES);
  const expertRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'expert');
  const files = [];
  for (const entry of readdirSync(expertRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentsDir = path.join(expertRoot, entry.name, 'agents');
    if (!existsSync(agentsDir)) continue;
    for (const f of readdirSync(agentsDir)) {
      if (f.endsWith('.md')) files.push(path.join(agentsDir, f));
    }
  }
  assert.ok(files.length > 0, 'expert/ 下没扫到 agents/*.md，扫描逻辑坏了');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const referenced = new Set([...text.matchAll(/webnovel_[a-z_]+/g)].map((m) => m[0]));
    for (const name of referenced) {
      assert.ok(known.has(name), `${path.basename(file)} 引用了不存在的工具 ${name}`);
    }
  }
});

/**
 * 从一段文档里挑出「像工具名但注册表里没有」的引用。
 * `webnovel_*` 这类带通配的写法不算引用（是给读者看的族名，不是让谁去调的接口）。
 */
function findUnknownToolRefs(text, known) {
  const hits = new Set();
  for (const m of text.matchAll(/webnovel_[a-z_]+\*?/g)) {
    if (m[0].endsWith('*')) continue;
    if (!known.has(m[0])) hits.add(m[0]);
  }
  return [...hits];
}

test('契约 · 全仓库文档（含未来的 skills/ 与 prompt/）引用的工具名都真实存在', () => {
  // 为什么覆盖面要比上一条更宽：分发给别的 agent 的每一份 .md 都是「接口文档」，
  // 里面写一个不存在的工具名，对面的 agent 就会去调、调不通、然后开始瞎编。
  // 工具加到第 12 个之后，文档侧是最后补的一环 —— 门禁先就位，新文件一落地就被管。
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const known = new Set(TOOL_NAMES);
  const SKIP = new Set(['.git', 'node_modules', 'books', 'logs', 'test-artifacts']);
  // CHANGELOG 是事故留痕，不是操作指引：里面出现过「webnovel_write_text」这种根本不存在的
  // 名字，正是因为有人写错过才被记下来 —— 把它扫出来只会逼人把历史改掉。
  const SKIP_FILES = new Set(['CHANGELOG.md']);
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name)); }
      else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) files.push(path.join(dir, entry.name));
    }
  })(root);
  // 扫描面本身要能被证明非空：某一类目录漏了，上面的绿就没有意义。
  // 这里只断言「每个区都有文件」这种不变量，不写死总数 —— 上一版写了 10，实际仓库只有 9 个 .md，
  // 门禁红在「文件数」上而不是「引用错名字」上，就是把口径冻成了快照。
  const ZONES = ['expert', 'docs', 'prompt'];
  for (const zone of ZONES) {
    assert.ok(files.some((f) => f.split(path.sep).includes(zone)), `扫描面漏了 ${zone}/`);
  }
  assert.ok(files.length >= ZONES.length + 1, `只扫到 ${files.length} 个 .md，少于分区数`);
  assert.ok(files.some((f) => path.basename(f) === 'README.md'), 'README 不在扫描面里');
  assert.ok(!files.some((f) => path.basename(f) === 'CHANGELOG.md'), 'CHANGELOG 该豁免却没豁免');
  const bad = [];
  for (const file of files) {
    for (const name of findUnknownToolRefs(readFileSync(file, 'utf8'), known)) {
      bad.push(`${path.relative(root, file).replace(/\\/g, '/')} → ${name}`);
    }
  }
  assert.deepEqual(bad, [], `文档里有不存在的工具名：\n${bad.join('\n')}`);

  // 判据自证（没有这段，上面的绿可能只是「扫了个空目录」或正则根本不匹配）
  assert.deepEqual(findUnknownToolRefs('先调 webnovel_wri 再 webnovel_context', known), ['webnovel_wri']);
  assert.deepEqual(findUnknownToolRefs('工具族 webnovel_* 共 12 个', known), [], '通配写法不该当成引用');
  assert.deepEqual(findUnknownToolRefs('webnovel_craft action=map', known), []);
  assert.ok(TOOL_NAMES.length >= 12, `工具数 ${TOOL_NAMES.length} 少于 12，注册表或本断言过期了`);
});

test('契约 · README 的工具数与工具表和注册表逐一对应（少一行不再靠人记住）', () => {
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const heading = /^## (\d+) 个工具\s*$/m.exec(readme);
  assert.ok(heading, 'README 里找不到「N 个工具」标题——加了工具请连本断言一起改，别让它假绿');
  assert.equal(Number(heading[1]), TOOL_NAMES.length,
    `README 标题写 ${heading[1]} 个，注册表是 ${TOOL_NAMES.length} 个（新增/改名工具时标题必须跟着改）`);

  // 两族都要数：webnovel_* 是本体，wm_* 是附带的 WritingMaster 套件（同一服务暴露）
  const rows = [...readme.matchAll(/^\| `((?:webnovel|wm)_[a-z_]+)`\s*\|/gm)].map((m) => m[1]);
  assert.equal(new Set(rows).size, rows.length, `README 工具表有重复行：${rows.join(',')}`);
  assert.deepEqual(rows.filter((n) => !TOOL_NAMES.includes(n)), [], 'README 表里列了不存在的工具');
  assert.deepEqual(TOOL_NAMES.filter((n) => !rows.includes(n)), [], '有工具没进 README 的表（读者不知道有这条路）');
  assert.equal(rows.length, TOOL_NAMES.length);
});

test('契约 · 提示词 6 个、字段完整', () => {
  assert.equal(PROMPTS.length, 6);
  for (const p of PROMPTS) {
    assert.match(p.name, /^[a-z0-9-]+$/);
    assert.ok(p.description.length > 10);
    assert.ok(p.whenToUse && p.whenToUse.length > 10);
    assert.ok(p.content.length > 200);
  }
  assert.deepEqual(PROMPT_NAMES.length, 6);
});

test('契约 · bookId 规则：允许中文/下划线，拒绝路径与命令行样式', () => {
  const allow = ['_草稿', '__scenario__', 'tingwu', '听物', 'a-b_c', 'A1'];
  const deny = ['-bad', '../evil', '..\\evil', 'a/b', 'a\\b', '.hidden', '', 'a b', 'x'.repeat(65), '/etc/passwd', 'C:\\Windows'];
  for (const v of allow) assert.ok(BOOK_ID_RE.test(v), `${v} 应被允许`);
  for (const v of deny) assert.ok(!BOOK_ID_RE.test(v), `${JSON.stringify(v)} 应被拒绝`);
});

test('契约 · listTools 返回的 schema 与 TOOL_DEFS 一致', () => {
  const listed = listTools();
  assert.equal(listed.length, TOOL_DEFS.length);
  for (const t of listed) {
    const def = TOOL_DEFS.find((d) => d.name === t.name);
    assert.ok(def);
    assert.deepEqual(t.inputSchema, def.inputSchema);
    assert.equal(t.handler, undefined, 'listTools 不应泄露 handler');
  }
});
