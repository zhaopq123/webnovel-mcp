/**
 * WritingMaster 套件融合测试。
 *
 * 两条不变量：
 *   ① 漂移门禁：`mcp/wm-tools.generated.mjs` 必须与上游 mcp-server.mjs 的 tools/list 逐字段一致
 *      （上游改了 schema 而这边没重新生成 → 红，CI 里另有 --check 兜一道）；
 *   ② 真能跑：通过 applyTool 调 wm_init / wm_status，必须真的建出 `.wm/` 账本并读回进度。
 *
 * 这里不复制 wm 的校验逻辑——桥接层只做协议转发，业务正确性由上游自己的 655 条用例保证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTool, loadConfig, listTools } from '../mcp/tools.mjs';
import { WM_TOOLS, WM_TOOL_NAMES } from '../mcp/wm-tools.generated.mjs';
import { fetchWmTools, callWmTool, WM_SERVER } from '../lib/features/wm-bridge.mjs';

const tmpRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-wmbridge-'));
  return { root, config: { ...loadConfig({ WEBNOVEL_ROOT: root }), token: '' } };
};

test('融合 · 上游 mcp-server.mjs 在仓内（桥接的前提）', () => {
  assert.ok(fs.existsSync(WM_SERVER), `找不到上游服务：${WM_SERVER}`);
});

test('融合 · 生成的 wm 工具清单与上游逐字段一致（漂移即红）', async () => {
  const upstream = await fetchWmTools();
  assert.equal(WM_TOOLS.length, upstream.length, '工具数不一致');
  assert.deepEqual(WM_TOOL_NAMES, upstream.map((t) => t.name), '工具名或顺序不一致');

  for (const up of upstream) {
    const mine = WM_TOOLS.find((t) => t.name === up.name);
    assert.ok(mine, `生成文件缺少 ${up.name}`);
    assert.equal(mine.description, up.description ?? '', `${up.name} 的 description 与上游不一致`);
    assert.deepEqual(mine.inputSchema, up.inputSchema, `${up.name} 的 inputSchema 与上游不一致`);
  }
});

test('融合 · 服务暴露 26 个工具（13 本体 + 13 套件），wm_ 不带 bookId', () => {
  const tools = listTools();
  assert.equal(tools.length, 26, `实际 ${tools.length} 个：${tools.map((t) => t.name).join(',')}`);
  assert.equal(tools.filter((t) => t.name.startsWith('wm_')).length, 13);
  for (const t of tools.filter((x) => x.name.startsWith('wm_'))) {
    assert.ok(!t.inputSchema.properties.bookId, `${t.name} 不该有 bookId（wm 用的是 dir）`);
  }
});

test('融合 · wm_init 经 applyTool 真的建出 .wm/ 账本，wm_status 读得回来', async () => {
  const { root, config } = tmpRoot();
  const dir = path.join(root, 'novel-a');
  try {
    const init = await applyTool('wm_init', {
      track: 'novel', genre: 'romance', title: '融合冒烟', target_words: 120000, dir,
    }, config);
    assert.match(init, /初始化完成/, 'wm_init 应报告初始化完成');
    assert.ok(fs.existsSync(path.join(dir, '.wm', 'state.json')), '.wm/state.json 应被创建');

    const status = await applyTool('wm_status', { dir }, config);
    assert.match(status, /WritingMaster 进度面板/);
    assert.match(status, /融合冒烟/, '状态里应能读回书名');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('融合 · 上游报错要原样透出，不要吞成「成功」', async () => {
  const { root, config } = tmpRoot();
  const dir = path.join(root, 'empty-dir');
  try {
    fs.mkdirSync(dir, { recursive: true });
    await assert.rejects(
      () => applyTool('wm_status', { dir }, config),
      (err) => /未初始化|初始化|\.wm/i.test(err.message),
      '没有 .wm/ 的作品目录，wm_status 应当报错',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('桥接 · 直接调 callWmTool 也行（内部复用路径）', async () => {
  const { root } = tmpRoot();
  try {
    await assert.rejects(() => callWmTool('wm_nope', {}), /未知工具|unknown/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
