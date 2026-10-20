/**
 * 断点恢复包（webnovel_restore）测试。
 *
 * 三条不变量：
 *   ① 恢复包里的进度段与 status 逐字一致（只拼装、不重算口径）；
 *   ② 待办不重复（status.lines 末尾的「待办：」块被摘掉，第二节结构化重列）；
 *   ③ 硬前置不丢——缺章纲时，恢复包必须明确要求先补章纲，而不是只说「开始写第 N 章」。
 * 另测边界：新书（0 章）、有正文未提交、账本坏掉（完整性不通过）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTool, loadConfig } from '../mcp/tools.mjs';
import { buildRestorePack } from '../lib/features/restore.js';
import { projectStatus } from '../lib/features/status.js';

async function newBook(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-restore-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: root }), token: '' };
  await applyTool('webnovel_init', {
    bookId: 'b1', title: '恢复包测试', genre: '玄幻', targetWords: 1_000_000, targetChapters: 400,
    ...opts,
  }, config);
  return { root, config, dir: path.join(root, 'b1') };
}

const commitOne = (config) => applyTool('webnovel_commit', {
  bookId: 'b1',
  chapter: 1,
  title: '第1章 开局',
  summary: '主角捡到残图。',
  hookType: '悬念',
  wordCount: 2400,
  deltas: {
    names: [{ name: '陆昭', type: 'person', new: true }],
    characters: [{ name: '陆昭', firstChapter: 1 }],
    foreshadow: [{ name: '残图', plantedChapter: 1 }],
    timeline: { chapter: 1, time: '第一日', place: '青石镇', event: '捡到残图' },
  },
  content: '（正文略）',
}, config);

test('恢复包 · 新书（0 章）也能交得出去，且不出现假进度', async () => {
  const { config } = await newBook();
  const text = await applyTool('webnovel_restore', { bookId: 'b1' }, config);

  assert.match(text, /# 断点恢复包 ·《恢复包测试》/, '标题要带书名');
  assert.match(text, /账本完整性：通过/, '新书账本应当是干净的');
  assert.match(text, /已写：0 章/, '新书已写章数必须是 0，不能编');
  assert.match(text, /下一章：第 1 章/);
  assert.match(text, /## 三、下一章怎么接/);
  assert.match(text, /webnovel_context chapter=1/, '要给出可直接照抄的下一步命令');
});

test('恢复包 · 进度段与 status 逐字一致（只拼装不重算）', async () => {
  const { config, dir } = await newBook();
  await commitOne(config);

  const text = await applyTool('webnovel_restore', { bookId: 'b1' }, config);
  const status = projectStatus(dir, { structure: 'summary' });
  const todoAt = status.lines.indexOf('待办：');
  const progress = (todoAt >= 0 ? status.lines.slice(0, todoAt) : status.lines).join('\n');

  assert.ok(text.includes(progress), '恢复包里的进度段必须与 status 输出同源同字');
  assert.match(text, /已写：1 章 \/ 2400 字/);
});

test('恢复包 · 待办不重复，且带工具指引', async () => {
  const { config } = await newBook();
  await commitOne(config);
  const text = await applyTool('webnovel_restore', { bookId: 'b1' }, config);

  assert.equal(text.split('## 二、接手先做这几件').length, 2, '待办小节只能出现一次');
  assert.ok(!text.includes('待办：'), 'status 里的「待办：」整块应被摘掉，避免同一条说两遍');
  assert.match(text, /- (🔴|🟡|ℹ️) /, '待办要带优先级图标');
  assert.match(text, /（用 webnovel_[a-z_]+）/, '待办要指明用哪个工具');
  assert.doesNotMatch(text, /\[object Object\]/, '待办对象必须渲染成文字');
});

test('恢复包 · 缺章纲时必须点明「先补章纲」这个硬前置', async () => {
  const { config } = await newBook();
  await commitOne(config);
  const text = await applyTool('webnovel_restore', { bookId: 'b1' }, config);

  assert.match(text, /还缺章纲|定章纲|write_chapter/, '缺章纲时恢复包必须把这条摆在接手人眼前');
  assert.match(text, /大纲即法律|write_chapter/, '要给出补章纲的具体动作');
});

test('恢复包 · 有正文未提交时要报警', async () => {
  const { config, dir } = await newBook();
  // 直接落一份正文文件但不调 commit，模拟「写了没提交」
  const textDir = path.join(dir, '正文');
  fs.mkdirSync(textDir, { recursive: true });
  fs.writeFileSync(path.join(textDir, '第1章 开局.md'), '正文内容'.repeat(100), 'utf8');

  const out = await applyTool('webnovel_restore', { bookId: 'b1' }, config);
  assert.match(out, /未提交/, '有正文没提交必须显式提示');
});

test('恢复包 · 账本坏掉时如实报「不通过」，不粉饰', async () => {
  const { config, dir } = await newBook();
  await commitOne(config);
  // 把机器态写成坏 JSON（state.json 一定存在，比挑某个 ledger 文件稳）
  fs.writeFileSync(path.join(dir, '.webnovel', 'state.json'), '{broken', 'utf8');

  const pack = buildRestorePack(dir, {});
  assert.ok(pack.issues > 0, '坏账本必须被 doctor 抓出来');
  assert.match(pack.text, /账本完整性：❌/, '不通过就得说不通过');
});

test('恢复包 · structure=off 透传，进度段里不再有结构换算', async () => {
  const { config } = await newBook();
  const text = await applyTool('webnovel_restore', { bookId: 'b1', structure: 'off' }, config);
  assert.doesNotMatch(text, /结构换算/, 'structure=off 时不应出现结构换算块');
});
