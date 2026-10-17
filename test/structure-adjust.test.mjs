/**
 * 2.1「目标体量调整说明」测试（v1.4.0 未闭环清零 · 第 2 条）。
 *
 * 要证明的事：
 * 1. 改 targetWords / targetChapters 时，init 输出「旧 → 新」的结构参数 diff（≥5 个字段）；
 * 2. 同值重跑不输出（没有变化不许制造噪音）；
 * 3. 老项目缺 targetWords/targetChapters 字段时按缺省值补，不算「调整」（不误报）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTool, loadConfig } from '../mcp/tools.mjs';

function newBooksRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-structure-adjust-'));
}

const init = (config, args) => applyTool('webnovel_init', { bookId: 'adjustbook', ...args }, config);

test('调整说明 · 60 万 → 300 万：标题 + 至少 5 个结构字段变化', async () => {
  const booksRoot = newBooksRoot();
  const config = loadConfig({ WEBNOVEL_ROOT: booksRoot });

  const first = await init(config, { title: '调整书', targetWords: 600_000, targetChapters: 171 });
  assert.ok(!first.includes('目标体量调整说明'), '第一次建书没有旧值，不该有调整说明');

  const second = await init(config, { targetWords: 3_000_000, targetChapters: 857 });
  assert.match(second, /## 目标体量调整说明（提示词 2\.1）/);
  assert.match(second, /目标字数：60 万字 → 300 万字/);
  assert.match(second, /部数：2 部 → 6 部/);

  // 至少 5 个字段真的变了（行首是「- 字段：旧 → 新」）
  const changed = second.split('\n').filter((l) => /^- .+：.+ → .+$/.test(l));
  assert.ok(changed.length >= 5, `应至少报 5 个字段变化，实际 ${changed.length}：\n${changed.join('\n')}`);

  // 逐项抽检：章数、每部章数、卷数、大层级、洋葱、悬念层、弧光、归档
  assert.match(second, /全书章数（建议）：171 章 → 857 章/);
  assert.match(second, /每部章数：86 章 → 143 章/);
  assert.match(second, /卷数：3 卷 → 13 卷/);
  assert.match(second, /大层级数：6 层 → 10 层/);
  assert.match(second, /反派洋葱：4 层 → 5 层/);
  assert.match(second, /悬念账户：4 层（短\/卷\/部\/跨部） → 5 层（短\/卷\/部\/跨部\/全书）/);
  assert.match(second, /部阶段弧光：2 段 → 6 段/);
  assert.match(second, /记忆归档：1 次 → 5 次/);

  // 新值确实写进了 project.json
  const meta = JSON.parse(fs.readFileSync(path.join(booksRoot, 'adjustbook', '.webnovel', 'project.json'), 'utf8'));
  assert.equal(meta.targetWords, 3_000_000);
  assert.equal(meta.targetChapters, 857);
});

test('调整说明 · 同值重跑保持静默', async () => {
  const booksRoot = newBooksRoot();
  const config = loadConfig({ WEBNOVEL_ROOT: booksRoot });
  await init(config, { title: '同值书', targetWords: 1_000_000, targetChapters: 400 });

  const same = await init(config, { targetWords: 1_000_000, targetChapters: 400 });
  assert.ok(!same.includes('目标体量调整说明'), `同值重跑不许输出调整说明：\n${same}`);

  const omitted = await init(config, {});
  assert.ok(!omitted.includes('目标体量调整说明'), '不传目标值也不算调整');
});

test('调整说明 · 老项目缺 targetWords/targetChapters 字段按缺省值补，不误报', async () => {
  const booksRoot = newBooksRoot();
  const config = loadConfig({ WEBNOVEL_ROOT: booksRoot });

  const dir = path.join(booksRoot, 'missingbook');
  const projectPath = path.join(dir, '.webnovel', 'project.json');
  fs.mkdirSync(path.join(dir, '.webnovel'), { recursive: true });
  fs.writeFileSync(projectPath, `${JSON.stringify({
    schemaVersion: 1, title: '缺字段书', genre: '未分类', logline: '', createdAt: '2026-01-01 00:00:00',
  }, null, 2)}\n`);

  const out = await applyTool('webnovel_init', { bookId: 'missingbook' }, config);
  assert.ok(!out.includes('目标体量调整说明'), `缺字段按缺省值补不算调整：\n${out}`);
  const meta = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  assert.equal(meta.targetWords, 1_000_000, '应补成缺省目标字数');
  assert.equal(meta.targetChapters, 400, '应补成缺省目标章数');
});

test('调整说明 · 只改目标章数也会报（且不影响结构表主体）', async () => {
  const booksRoot = newBooksRoot();
  const config = loadConfig({ WEBNOVEL_ROOT: booksRoot });
  await init(config, { title: '改章数', targetWords: 1_000_000, targetChapters: 400 });

  const out = await init(config, { targetChapters: 250 });
  assert.match(out, /目标章数：400 章 → 250 章/);
  assert.ok(!out.includes('目标字数：'), '目标字数没变，不该出现在 diff 里');
  assert.match(out, /体量结构换算（提示词第二节）/, '结构全表仍应在场');
});
