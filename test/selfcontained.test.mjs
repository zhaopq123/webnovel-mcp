/**
 * S4 · 描述自足性审计（L0）回归网。
 *
 * 背景：本服务的目标用户是「没有插件功能的 agent」——工具描述、提示词、返回文案
 * 是它唯一的说明书。这组测试钉住三件事：
 *   1. 对外的说明文字里不许再出现开发期测试书（tingwu / 听物）——那是私货，不是文档。
 *   2. 每个工具的 description 要能回答「什么时候用」；关键工具要自带前置/门禁说明。
 *   3. 闭环提示必须写死在返回文案里（write_text → review → commit → 下一章 context）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpServer } from '../server.mjs';
import { loadConfig } from '../mcp/tools.mjs';

function startFresh() {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-l0-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: booksRoot, WEBNOVEL_PORT: '0' }), booksRoot, bind: '127.0.0.1', port: 0 };
  const server = createHttpServer(config, { log: () => {} });
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return ready.then(() => {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    return {
      base,
      config,
      close: () => new Promise((resolve) => server.close(resolve)),
      rpc: async (method, params) => {
        const res = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        return (await res.json()).result;
      },
      call: async (name, args) => {
        const res = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
        });
        return (await res.json()).result;
      },
    };
  });
}

const LEAK = /tingwu|听物/;

test('S4 · 对外文案不泄露开发期测试书（工具清单/提示词/握手/空库错误）', async () => {
  const s = await startFresh();
  try {
    const tools = (await s.rpc('tools/list', {})).tools;
    assert.ok(!LEAK.test(JSON.stringify(tools)), '工具清单不应出现测试书名');

    const prompts = (await s.rpc('prompts/list', {})).prompts;
    assert.ok(!LEAK.test(JSON.stringify(prompts)), '提示词清单不应出现测试书名');
    for (const p of prompts) {
      const full = await s.rpc('prompts/get', { name: p.name });
      assert.ok(!LEAK.test(JSON.stringify(full)), `提示词 ${p.name} 正文不应出现测试书名`);
    }

    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.ok(!LEAK.test(init.instructions), 'initialize 指引不应出现测试书名');

    const books = await s.call('webnovel_books', {});
    assert.ok(!LEAK.test(books.content[0].text), '空库文案不应出现测试书名');
    assert.match(books.content[0].text, /changye/, '空库文案应给中性示例');

    const noBooks = await s.call('webnovel_status', {});
    assert.equal(noBooks.isError, true);
    assert.ok(!LEAK.test(noBooks.content[0].text), '空库报错不应出现测试书名');
  } finally {
    await s.close();
  }
});

test('S4 · 每个工具的描述都能回答「什么时候用」', async () => {
  const s = await startFresh();
  try {
    const tools = (await s.rpc('tools/list', {})).tools;
    assert.equal(tools.length, 11);
    for (const t of tools) {
      assert.match(
        t.description,
        /当用户[说问]|当(你|作者|读者|有人)/,
        `${t.name} 的描述应说明触发场景（「当用户说…」）`,
      );
    }
  } finally {
    await s.close();
  }
});

test('S4 · 关键工具描述自带前置条件与门禁说明（L0 只靠 description 自学）', async () => {
  const s = await startFresh();
  try {
    const tools = (await s.rpc('tools/list', {})).tools;
    const desc = Object.fromEntries(tools.map((t) => [t.name, t.description]));

    assert.match(desc.webnovel_commit, /force/, 'commit 描述应说明 force 逃生门');
    assert.match(desc.webnovel_commit, /审查记录|webnovel_review/, 'commit 描述应说明审查门禁');
    assert.match(desc.webnovel_commit, /旧章|早于当前进度/, 'commit 描述应说明旧章重提会被拒');
    assert.match(desc.webnovel_review, /审查记录/, 'review 描述应说明结果落盘');
    assert.match(desc.webnovel_review, /提交/, 'review 描述应说明与提交的关系');
    assert.match(desc.webnovel_outline, /write_chapter/, 'outline 描述应把 action 说全');
    assert.match(desc.webnovel_outline, /章纲是写作的前置条件/, 'outline 描述应说明章纲前置条件');
    assert.match(desc.webnovel_context, /blockers/, 'context 描述应说明 blocker 处理');
    assert.match(desc.webnovel_memory, /learn/, 'memory 描述应把 action 说全');

    const force = tools.find((t) => t.name === 'webnovel_commit').inputSchema.properties.force;
    assert.match(force.description, /旧章|历史修正/, 'force 参数描述应对齐 S1 语义');
  } finally {
    await s.close();
  }
});

test('S4 · 返回文案里的闭环提示：章纲→context、写稿→review→commit、提交→下一章', async () => {
  const s = await startFresh();
  try {
    await s.call('webnovel_init', { bookId: 'l0', title: 'L0 审计书', genre: '都市异能', targetChapters: 100 });

    const master = await s.call('webnovel_outline', { bookId: 'l0', action: 'write_master', text: '# 总纲' });
    assert.match(master.content[0].text, /write_volume/, '总纲保存后应提示下一步拆卷');

    const volume = await s.call('webnovel_outline', { bookId: 'l0', action: 'write_volume', volume: 1, title: '第一卷', chapterRange: '1-50', text: '# 第一卷' });
    assert.match(volume.content[0].text, /write_chapter/, '卷纲保存后应提示下一步写章纲');

    const outline = await s.call('webnovel_outline', { bookId: 'l0', action: 'write_chapter', chapter: 1, text: '# 第一章' });
    assert.match(outline.content[0].text, /webnovel_context/, '章纲保存后应提示取任务书');

    const text = await s.call('webnovel_outline', { bookId: 'l0', action: 'write_text', chapter: 1, title: '开场', text: '他推开门。' });
    assert.match(text.content[0].text, /webnovel_review/, '正文保存后应提示先自审');
    assert.match(text.content[0].text, /webnovel_commit/, '正文保存后应提示再提交');

    const brief = await s.call('webnovel_context', { bookId: 'l0', chapter: 1 });
    assert.match(brief.content[0].text, /完稿流程/, '任务书末尾应有完稿流程钉子');
    assert.match(brief.content[0].text, /webnovel_review[\s\S]*webnovel_commit/, '流程顺序应为先审后提');

    const commit = await s.call('webnovel_commit', { bookId: 'l0', chapter: 1, title: '开场', summary: '他推开门。', strand: 'quest', wordCount: 50 });
    assert.match(commit.content[0].text, /下一步：用 webnovel_context chapter=2/, '提交后应提示取下一章任务书');
  } finally {
    await s.close();
  }
});

test('S4 · 提示词正文同步携带门禁与新语义（write/review 技能）', async () => {
  const s = await startFresh();
  try {
    const write = await s.rpc('prompts/get', { name: 'webnovel-write' });
    const writeText = write.messages[0].content.text;
    assert.match(writeText, /审查记录/, 'write 技能应说明提交时会核对审查记录');
    assert.match(writeText, /force/, 'write 技能应说明 force 逃生门');
    assert.match(writeText, /历史修正|旧章/, 'write 技能应说明旧章重提规则');

    const review = await s.rpc('prompts/get', { name: 'webnovel-review' });
    assert.match(review.messages[0].content.text, /审查记录/, 'review 技能应说明结果落盘');
  } finally {
    await s.close();
  }
});
