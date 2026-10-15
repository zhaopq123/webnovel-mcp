/**
 * L0 stdio 走查：模拟「没有插件功能的 agent」最朴素的接入方式——
 * 一条命令启动（node server.mjs --stdio），逐行 JSON-RPC 走 stdin/stdout，
 * 无 HTTP、无会话头、无任何框架。验证写作闭环在纯 stdio 下也能一站到底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));

test('L0 · stdio 走查：握手 → 工具 → 写作闭环一站到底', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-stdio-'));
  const child = spawn(process.execPath, [SERVER, '--stdio'], {
    env: { ...process.env, WEBNOVEL_ROOT: booksRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => { /* 日志不参与断言，但必须消费，防止管道阻塞 */ });

  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const settle = pending.get(msg.id);
      if (settle) {
        pending.delete(msg.id);
        settle(msg);
      }
    }
  });

  let seq = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    seq += 1;
    const id = seq;
    pending.set(id, resolve);
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`stdio 无响应：${method}`));
      }
    }, 10_000);
    timer.unref();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.ok(r.result, `${name} 应有 result：${JSON.stringify(r).slice(0, 200)}`);
    return r.result;
  };

  try {
    const hello = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'l0-raw-stdio', version: '0' },
    });
    assert.equal(hello.result.serverInfo.name, 'webnovel-mcp');
    assert.match(hello.result.instructions, /webnovel_context/);

    // 客户端初始化完成通知（无 id，无需应答）——按协议惯例走一遍
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const tools = (await rpc('tools/list', {})).result.tools;
    assert.equal(tools.length, 11);

    await call('webnovel_init', { bookId: 'stdio0', title: '走查书', genre: '都市异能' });
    await call('webnovel_outline', { bookId: 'stdio0', action: 'write_chapter', chapter: 1, text: '# 第一章 开场\n- 场景：出租屋' });

    const brief = await call('webnovel_context', { bookId: 'stdio0', chapter: 1 });
    assert.match(brief.content[0].text, /写作任务书/);
    assert.match(brief.content[0].text, /完稿流程/, '任务书应带完稿流程钉子');

    await call('webnovel_outline', { bookId: 'stdio0', action: 'write_text', chapter: 1, title: '开场', text: '林三推开门，屋里一股旧报纸味。' });
    const review = await call('webnovel_review', { bookId: 'stdio0', chapter: 1 });
    assert.match(review.content[0].text, /审查报告/);

    const commit = await call('webnovel_commit', {
      bookId: 'stdio0',
      chapter: 1,
      title: '开场',
      summary: '林三搬进旧出租屋。',
      strand: 'quest',
      deltas: { protagonist: { name: '林三', location: '出租屋' } },
    });
    assert.match(commit.content[0].text, /已提交第 1 章/);

    const status = await call('webnovel_status', { bookId: 'stdio0' });
    assert.match(status.content[0].text, /走查书/);

    const query = await call('webnovel_query', { bookId: 'stdio0', kind: 'character', name: '林三' });
    assert.match(query.content[0].text, /出租屋/);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on('exit', resolve));
  }
});
