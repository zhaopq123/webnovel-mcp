/**
 * wm-bridge：在 webnovel-mcp 进程内调 WritingMaster 的 MCP 子进程（stdio）。
 *
 * 为什么不把 13 个 wm 工具的校验逻辑抄一份过来：
 * 上游 `suites/writing-master/.../scripts/mcp-server.mjs` 是唯一事实源（schema 与 wm.js 参数一一对应，
 * wm-verify V3 会校验 CLI↔MCP 一致）。抄一遍必然漂移，所以这里只做**协议转发**：
 * 每次调用拉一个子进程，走 initialize → tools/call，拿到文本就返回。
 *
 * 代价：每次调用约 150–250ms（Node 冷启动）。写书是分钟级操作，这点开销可以忽略；
 * 换来的是上游改一个参数，这边跑生成脚本 + CI 对账就能跟上，不会出现两套 schema 各说各话。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
export const WM_SERVER = path.join(
  REPO_ROOT, 'suites', 'writing-master', 'writing-master-mcp-suite', 'scripts', 'mcp-server.mjs',
);

/** 单次调用的上限：wm 的全链路命令（首章初始化）最慢，给足 60 秒。 */
const CALL_TIMEOUT_MS = Number(process.env.WM_CALL_TIMEOUT_MS) || 60_000;

/**
 * 拉起 wm 子进程，把 requests 逐行写进去，收集响应直到收到 stopAfter 个响应或超时。
 * @returns {Promise<Map<number, object>>} id → 响应
 */
function talk(requests, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WM_SERVER], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const got = new Map();
    let buf = '';
    let stderr = '';
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      if (err) reject(err); else resolve(got);
    };

    const timer = setTimeout(() => {
      finish(new Error(`wm 子进程超时（${timeoutMs}ms）：${stderr.slice(-300)}`));
    }, timeoutMs);

    child.on('error', (err) => finish(new Error(`拉不起 wm 子进程：${err.message}（找不到 ${WM_SERVER}？）`)));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', () => {
      // 没等到响应就退出了：把 stderr 带出去，别只报一句「失败」
      finish(new Error(`wm 子进程提前退出。stderr: ${stderr.slice(-500) || '（空）'}`));
    });

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && typeof msg.id === 'number') got.set(msg.id, msg);
        if (got.size >= requests.length) finish(null);
      }
    });

    for (const req of requests) child.stdin.write(JSON.stringify(req) + '\n');
    child.stdin.end();
  });
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'webnovel-mcp-bridge', version: '1' } },
};

/** 取上游工具清单（生成脚本与漂移门禁都用它）。 */
export async function fetchWmTools() {
  const got = await talk([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
  const res = got.get(2);
  if (!res || !res.result || !Array.isArray(res.result.tools)) {
    throw new Error(`wm 工具清单格式异常：${JSON.stringify(res).slice(0, 200)}`);
  }
  return res.result.tools;
}

/**
 * 调一个 wm 工具，返回它的文本输出。
 * 失败（isError / 协议错误）直接抛——MCP 层会转成 isError，调用方能看到原因。
 */
export async function callWmTool(name, args = {}) {
  const got = await talk([
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args ?? {} } },
  ], { timeoutMs: Number(process.env.WM_CALL_TIMEOUT_MS) || CALL_TIMEOUT_MS });
  const res = got.get(2);
  if (!res) throw new Error(`wm 工具 ${name} 无响应`);
  if (res.error) throw new Error(`wm 工具 ${name} 出错：${res.error.message ?? JSON.stringify(res.error)}`);
  const content = res.result?.content ?? [];
  const text = content.map((c) => c.text ?? '').join('\n').trim();
  if (res.result?.isError) throw new Error(text || `wm 工具 ${name} 返回 isError`);
  return text || `（${name} 执行成功，无文本输出）`;
}
