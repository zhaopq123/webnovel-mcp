/**
 * MCP 协议层测试：真起一个 HTTP 服务，用 fetch 走真实协议。
 * 覆盖：握手、工具清单、提示词、完整写作闭环、错误路径、鉴权、通知、批量、越权。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpServer } from '../server.mjs';
import { loadConfig } from '../mcp/tools.mjs';

function tempConfig(extra = {}) {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-mcp-'));
  return {
    ...loadConfig({ WEBNOVEL_ROOT: booksRoot, WEBNOVEL_PORT: '0' }),
    booksRoot,
    bind: '127.0.0.1',
    port: 0,
    ...extra,
  };
}

async function start(config) {
  const server = createHttpServer(config, { log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
    /** 任意 JSON-RPC 方法。 */
    rpc: async (method, params, opts = {}) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 1, method, params }),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* 保留 null */ }
      return { status: res.status, body, text, headers: res.headers };
    },
    /** tools/call 便捷封装。 */
    call: (name, args, opts = {}) => base_rpc(base, name, args, opts),
  };
}

async function base_rpc(base, name, args, opts = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 7, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 保留 null */ }
  return { status: res.status, body, text, headers: res.headers };
}

test('MCP · initialize 握手返回协议版本与能力', async () => {
  const s = await start(tempConfig());
  try {
    const r = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.protocolVersion, '2025-06-18');
    assert.ok(r.body.result.capabilities.tools, '应声明 tools 能力');
    assert.ok(r.body.result.capabilities.prompts, '应声明 prompts 能力');
    assert.equal(r.body.result.serverInfo.name, 'webnovel-mcp');
    assert.match(r.body.result.instructions, /webnovel_context/, 'initialize 应带上写作流程指引');
    assert.ok(r.headers.get('mcp-session-id'), '应下发 session id');
  } finally {
    await s.close();
  }
});

test('MCP · initialize 对未知协议版本回退到默认版本', async () => {
  const s = await start(tempConfig());
  try {
    const r = await s.rpc('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.protocolVersion, '2025-03-26');
  } finally {
    await s.close();
  }
});

test('MCP · tools/list 返回 10 个工具且 schema 干净', async () => {
  const s = await start(tempConfig());
  try {
    const r = await s.rpc('tools/list', {});
    const tools = r.body.result.tools;
    assert.equal(tools.length, 10);
    for (const t of tools) {
      assert.ok(t.name.startsWith('webnovel_'), `${t.name} 应以 webnovel_ 开头`);
      assert.ok(t.description.length > 30, `${t.name} 的描述应足够说明何时使用`);
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(Array.isArray(t.inputSchema.required));
      const json = JSON.stringify(t.inputSchema);
      for (const banned of ['anyOf', 'oneOf', 'allOf', '$ref', 'outputSchema']) {
        assert.ok(!json.includes(banned), `${t.name} 的 schema 不应含 ${banned}`);
      }
    }
  } finally {
    await s.close();
  }
});

test('MCP · prompts/list 返回 6 个写作流程提示词', async () => {
  const s = await start(tempConfig());
  try {
    const r = await s.rpc('prompts/list', {});
    const prompts = r.body.result.prompts;
    assert.equal(prompts.length, 6);
    const names = prompts.map((p) => p.name).sort();
    assert.deepEqual(names, ['webnovel-init', 'webnovel-learn', 'webnovel-plan', 'webnovel-query', 'webnovel-review', 'webnovel-write']);
    const one = await s.rpc('prompts/get', { name: 'webnovel-write' });
    assert.match(one.body.result.messages[0].content.text, /webnovel_context/);
  } finally {
    await s.close();
  }
});

test('MCP · 完整写作闭环（工具层真实调用）', async () => {
  const s = await start(tempConfig());
  try {
    const call = (name, args) => base_rpc(s.base, name, args).then((r) => {
      assert.equal(r.status, 200, `${name} 应返回 200`);
      return r.body.result;
    });

    const init = await call('webnovel_init', { bookId: 'tingwu', title: '听物', genre: '都市异能', targetChapters: 100 });
    assert.match(init.content[0].text, /已建好新书：tingwu/);

    const books = await call('webnovel_books', {});
    assert.match(books.content[0].text, /tingwu/);

    const status0 = await call('webnovel_status', { bookId: 'tingwu' });
    assert.match(status0.content[0].text, /听物/);

    // 没章纲时 context 应给出 blocker
    const blocked = await call('webnovel_context', { bookId: 'tingwu', chapter: 1 });
    assert.match(blocked.content[0].text, /章纲/);

    await call('webnovel_outline', { bookId: 'tingwu', action: 'write_chapter', chapter: 1, text: '# 第一章 旧宅\n- 场景：旧宅，黄昏\n- 事件：听见门的记忆，挖出铁盒' });

    const brief = await call('webnovel_context', { bookId: 'tingwu', chapter: 1 });
    assert.match(brief.content[0].text, /写作任务书/);

    const body = '林越推开铁门。指尖传来震颤。不是风。是这扇门在说话。他蹲下身，手掌贴上地面。冰凉的水泥底下，有什么东西在低鸣。他挖出了那个铁盒。';
    await call('webnovel_outline', { bookId: 'tingwu', action: 'write_text', chapter: 1, title: '旧宅', text: body });

    const review = await call('webnovel_review', { bookId: 'tingwu', chapter: 1 });
    assert.match(review.content[0].text, /审查报告/);

    const commit = await call('webnovel_commit', {
      bookId: 'tingwu',
      chapter: 1,
      title: '旧宅',
      summary: '林越在旧宅听见门的记忆，挖出母亲留下的铁盒。',
      strand: 'quest',
      deltas: {
        protagonist: { name: '林越', location: '旧宅', condition: '指腹擦伤' },
        foreshadowing: { planted: [{ name: '母亲留下的铁盒', plannedPayoff: 30, importance: 'high' }] },
      },
    });
    assert.match(commit.content[0].text, /已提交第 1 章/);

    const hero = await call('webnovel_query', { bookId: 'tingwu', kind: 'character', name: '林越' });
    assert.match(hero.content[0].text, /指腹擦伤/, '状态应能查回来');

    await call('webnovel_memory', { bookId: 'tingwu', action: 'learn', kind: 'style', title: '短句打斗', content: '动作用 8-15 字短句。' });

    await call('webnovel_outline', { bookId: 'tingwu', action: 'write_chapter', chapter: 2, text: '# 第二章 出发' });
    const brief2 = await call('webnovel_context', { bookId: 'tingwu', chapter: 2 });
    assert.match(brief2.content[0].text, /指腹擦伤/, '第 2 章任务书必须延续第 1 章的主角状态');
    assert.match(brief2.content[0].text, /母亲留下的铁盒/, '第 2 章任务书必须带上未回收伏笔');
    assert.match(brief2.content[0].text, /短句打斗/, '沉淀的写作经验应自动进入任务书');

    const pacing = await call('webnovel_pacing', { bookId: 'tingwu' });
    assert.match(pacing.content[0].text, /节奏体检报告/);
  } finally {
    await s.close();
  }
});

test('MCP · 书库里只有一本书时可省略 bookId，多本时必须指定', async () => {
  const config = tempConfig();
  const s = await start(config);
  try {
    const call = (name, args) => base_rpc(s.base, name, args).then((r) => r.body.result);
    await call('webnovel_init', { bookId: 'onlyone', title: '唯一' });
    const auto = await call('webnovel_status', {});
    assert.match(auto.content[0].text, /唯一/);

    await call('webnovel_init', { bookId: 'second', title: '第二本' });
    const ambiguous = await call('webnovel_status', {});
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /请指定 bookId/);
  } finally {
    await s.close();
  }
});

test('MCP · 工具报错走 isError 而不是协议错误', async () => {
  const s = await start(tempConfig());
  try {
    const r = await base_rpc(s.base, 'webnovel_context', { bookId: 'nope', chapter: 1 });
    assert.equal(r.status, 200, '工具错误不应变成 HTTP 错误');
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /还不是书项目/);
  } finally {
    await s.close();
  }
});

test('MCP · 未知工具返回 -32602，未知方法返回 -32601', async () => {
  const s = await start(tempConfig());
  try {
    const bad = await base_rpc(s.base, 'no_such_tool', {});
    assert.equal(bad.body.error.code, -32602);
    const m = await s.rpc('no/such/method', {});
    assert.equal(m.body.error.code, -32601);
  } finally {
    await s.close();
  }
});

test('MCP · 通知返回 202 且无响应体', async () => {
  const s = await start(tempConfig());
  try {
    const res = await fetch(`${s.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  } finally {
    await s.close();
  }
});

test('MCP · 坏 JSON 返回 -32700，GET /mcp 返回 405', async () => {
  const s = await start(tempConfig());
  try {
    const res = await fetch(`${s.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);

    const get = await fetch(`${s.base}/mcp`);
    assert.equal(get.status, 405);
  } finally {
    await s.close();
  }
});

test('MCP · 配了 token 就必须带 Bearer，/health 不需要', async () => {
  const config = tempConfig({ token: 'secret-token-123' });
  const s = await start(config);
  try {
    const denied = await s.rpc('tools/list', {});
    assert.equal(denied.status, 401);

    const wrong = await s.rpc('tools/list', {}, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    const ok = await s.rpc('tools/list', {}, { headers: { authorization: 'Bearer secret-token-123' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result.tools.length, 10);

    const health = await fetch(`${s.base}/health`);
    assert.equal(health.status, 200);
    const h = await health.json();
    assert.equal(h.status, 'ok');
    assert.equal(h.auth, 'bearer');
  } finally {
    await s.close();
  }
});

test('MCP · /health 报告书库状态', async () => {
  const config = tempConfig();
  const s = await start(config);
  try {
    await base_rpc(s.base, 'webnovel_init', { bookId: 'a', title: 'A' });
    const h = await (await fetch(`${s.base}/health`)).json();
    assert.equal(h.books, 1);
    assert.equal(h.booksRoot, config.booksRoot);
  } finally {
    await s.close();
  }
});

test('MCP · 路径安全：bookId 不能穿越、不能用绝对路径', async () => {
  const config = tempConfig();
  const s = await start(config);
  try {
    for (const bad of ['../evil', '..\\evil', '/etc/passwd', 'C:\\Windows', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65), '']) {
      if (bad === '') continue; // 空 bookId 是「自动选择」，不是攻击
      const r = await base_rpc(s.base, 'webnovel_init', { bookId: bad, title: 'X' });
      assert.equal(r.body.result.isError, true, `bookId=${JSON.stringify(bad)} 应被拒绝`);
      assert.match(r.body.result.content[0].text, /不合法|越界/);
    }
    // 书库里不应该多出任何东西
    assert.deepEqual(fs.readdirSync(config.booksRoot).filter((n) => !n.startsWith('.')), []);
  } finally {
    await s.close();
  }
});

test('MCP · 路径安全：书库内的符号链接指向外部时被拒绝', async () => {
  const config = tempConfig();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  const link = path.join(config.booksRoot, 'escape');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    return; // 无权限创建符号链接时跳过（Windows 非管理员可能受限）
  }
  const s = await start(config);
  try {
    const r = await base_rpc(s.base, 'webnovel_init', { bookId: 'escape', title: 'X' });
    assert.equal(r.body.result.isError, true, '符号链接逃逸必须被拒绝');
    assert.match(r.body.result.content[0].text, /越界/);
    assert.equal(fs.existsSync(path.join(outside, '.webnovel')), false, '外部目录不应被写入');
  } finally {
    await s.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('MCP · 并发提交同一章不损坏数据', async () => {
  const config = tempConfig();
  const s = await start(config);
  try {
    await base_rpc(s.base, 'webnovel_init', { bookId: 'race', title: '并发' });
    const tasks = [];
    for (let i = 0; i < 8; i += 1) {
      tasks.push(base_rpc(s.base, 'webnovel_commit', {
        bookId: 'race', chapter: 1, title: '并发章', summary: `第 ${i} 次提交`, strand: 'quest', force: true,
      }));
    }
    const results = await Promise.all(tasks);
    for (const r of results) assert.notEqual(r.body.result?.isError, true, JSON.stringify(r.body).slice(0, 200));
    const idx = JSON.parse(fs.readFileSync(path.join(config.booksRoot, 'race', '.webnovel', 'index.json'), 'utf8'));
    assert.equal(idx.chapters.length, 1, '并发提交后索引里只应有一条');
    const state = JSON.parse(fs.readFileSync(path.join(config.booksRoot, 'race', '.webnovel', 'state.json'), 'utf8'));
    assert.equal(state.progress.currentChapter, 1);
  } finally {
    await s.close();
  }
});
