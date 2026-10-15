#!/usr/bin/env node
/**
 * webnovel-mcp 服务入口。
 *
 * 两种运行方式：
 *   node server.mjs            → MCP Streamable HTTP，POST /mcp（默认 0.0.0.0:8400）
 *   node server.mjs --stdio    → 标准输入输出（本机 stdio 客户端）
 *
 * 零运行时依赖：只用 node: 内置模块，不需要 npm install。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, ensureBooksRoot, listBookIds } from './mcp/tools.mjs';
import { createDispatcher, SERVER_INFO } from './mcp/protocol.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过上限（${limit} 字节）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 创建 HTTP 服务（导出给测试用，不自动 listen）。 */
export function createHttpServer(config, { log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  ensureBooksRoot(config);
  const dispatch = createDispatcher({ config, log });
  const startedAt = Date.now();

  const authed = (req) => {
    if (!config.token) return true;
    return String(req.headers.authorization || '') === `Bearer ${config.token}`;
  };

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'bad url' });
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      let books = 0;
      try { books = listBookIds(config).length; } catch { /* 书库不可读时只报 0 */ }
      return sendJson(res, 200, {
        status: 'ok',
        server: SERVER_INFO.name,
        version: SERVER_INFO.version,
        books,
        booksRoot: config.booksRoot,
        auth: config.token ? 'bearer' : 'none',
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }

    if (url.pathname !== '/mcp') {
      return sendJson(res, 404, { error: 'not found', hint: 'MCP 端点是 POST /mcp；健康检查是 GET /health' });
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, {
        error: 'method not allowed',
        hint: 'MCP Streamable HTTP 只接受 POST /mcp（本服务不提供 GET 事件流）',
      }, { allow: 'POST' });
    }
    if (!authed(req)) {
      return sendJson(res, 401, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: '未授权：缺少或错误的 Authorization: Bearer <token>' },
      });
    }

    let raw;
    try {
      raw = await readBody(req, config.maxBody);
    } catch (err) {
      return sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: err.message } });
    }

    let body;
    try {
      body = JSON.parse(raw || 'null');
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
    }

    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    const responses = [];
    const sessionId = String(req.headers['mcp-session-id'] || '').trim() || randomUUID();

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
        if (msg && typeof msg === 'object' && 'id' in msg) {
          responses.push({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
        }
        continue;
      }
      if (!('id' in msg)) {
        // 通知（notifications/initialized 等）：不返回响应体。
        try { await dispatch(msg.method, msg.params); } catch { /* 通知失败不影响会话 */ }
        continue;
      }
      const t0 = Date.now();
      const out = await dispatch(msg.method, msg.params);
      const ms = Date.now() - t0;
      if (out.error) log(`[mcp] ${msg.method} ${ms}ms ERROR ${out.error.message}`);
      else if (msg.method === 'tools/call') log(`[mcp] ${msg.method} ${ms}ms ${String(msg.params?.name ?? '')}`);
      responses.push({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        ...(out.error ? { error: out.error } : { result: out.result ?? {} }),
      });
    }

    if (responses.length === 0) {
      res.writeHead(202, { 'mcp-session-id': sessionId });
      return res.end();
    }
    return sendJson(res, 200, batch ? responses : responses[0], { 'mcp-session-id': sessionId });
  });
}

/** stdio 模式：逐行 JSON-RPC（给本机 stdio 客户端用）。 */
export function runStdio(config) {
  ensureBooksRoot(config);
  const dispatch = createDispatcher({ config, log: (m) => process.stderr.write(`${m}\n`) });
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })}\n`);
        continue;
      }
      const handle = async () => {
        if (!('id' in msg)) {
          try { await dispatch(msg.method, msg.params); } catch { /* 忽略通知错误 */ }
          return;
        }
        const out = await dispatch(msg.method, msg.params);
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          ...(out.error ? { error: out.error } : { result: out.result ?? {} }),
        })}\n`);
      };
      handle().catch((err) => process.stderr.write(`[stdio] ${err.message}\n`));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function main() {
  const config = loadConfig();
  if (process.argv.includes('--stdio')) {
    runStdio(config);
    return;
  }
  const server = createHttpServer(config);
  server.listen(config.port, config.bind, () => {
    process.stderr.write(
      `[webnovel-mcp] v${SERVER_INFO.version} listening http://${config.bind}:${config.port}/mcp`
      + `  books=${config.booksRoot}  auth=${config.token ? 'bearer' : 'none'}\n`,
    );
  });
  server.on('error', (err) => {
    process.stderr.write(`[webnovel-mcp] 启动失败：${err.message}\n`);
    process.exit(1);
  });
  const shutdown = () => {
    process.stderr.write('[webnovel-mcp] 收到退出信号，正在关闭…\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
