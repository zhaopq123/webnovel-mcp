/**
 * 契约测试：工具清单、提示词与实现三者不许脱节。
 * 这是「文档说调 A，实际只有 B」这类事故的唯一防线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFS, listTools, BOOK_ID_RE } from '../mcp/tools.mjs';
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

test('契约 · 除 init/books 外所有工具都接受 bookId', () => {
  for (const t of TOOL_DEFS) {
    if (t.name === 'webnovel_init' || t.name === 'webnovel_books') continue;
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
