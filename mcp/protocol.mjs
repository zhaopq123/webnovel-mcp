/**
 * JSON-RPC / MCP 协议分发层（HTTP 与 stdio 共用）。
 *
 * 协议版本策略：客户端在 initialize 里报什么版本就回什么版本（本服务只用
 * tools / prompts 这两组稳定能力，各版本请求形状一致）；没报则回默认版本。
 */
import { readFileSync } from 'node:fs';
import { listTools, getTool, applyTool } from './tools.mjs';
import { listPrompts, getPrompt } from './prompts.mjs';

// 版本只有一个真相源：package.json。写死第二份必然漂移（1.0.1 那次 CHANGELOG 已更新、
// 服务自报的还是 1.0.0，排查时看到的就是假版本号）。
const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const SERVER_INFO = {
  name: 'webnovel-mcp',
  version: PKG_VERSION,
  title: '长篇网文写作助手',
};

export const PROTOCOL_DEFAULT = '2025-03-26';
export const PROTOCOL_SUPPORTED = ['2024-11-05', '2025-03-26', '2025-06-18'];
export const PROTOCOL_FLOOR = '2024-11-05';

/**
 * 版本协商：客户端报的版本 ≥ 我们的下限就照原样回（本服务只用 tools/prompts
 * 这两组各版本形状一致的能力，属于版本无关实现，回显可最大化客户端兼容性）；
 * 报的是无效/过老的版本则回默认版本（不谎称支持远古协议）。
 */
export function negotiateProtocol(requested) {
  const v = typeof requested === 'string' ? requested.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return PROTOCOL_DEFAULT;
  return v >= PROTOCOL_FLOOR ? v : PROTOCOL_DEFAULT;
}

export const SERVER_INSTRUCTIONS = [
  '这是「长篇网文写作助手」，为长篇小说提供设定/伏笔/时间线/进度的结构化记忆。',
  '铁律：动笔前先用 webnovel_context 取「写作任务书」；写完用 webnovel_commit 提交本章事实增量；',
  '没有章纲时不要裸写正文（先 webnovel_outline action=write_chapter）。',
  '不确定在写哪本书时先用 webnovel_books 查看；用户问「写到哪了」用 webnovel_status。',
].join('');

const methodNotFound = (method) => ({ error: { code: -32601, message: `Method not found: ${method}` } });

export function createDispatcher({ config, log = () => {} }) {
  return async function dispatch(method, params) {
    const p = params && typeof params === 'object' ? params : {};
    switch (method) {
      case 'initialize': {
        const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion.trim() : '';
        return {
          result: {
            protocolVersion: negotiateProtocol(requested),
            capabilities: {
              tools: { listChanged: false },
              prompts: { listChanged: false },
            },
            serverInfo: SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS,
          },
        };
      }

      case 'ping':
        return { result: {} };

      case 'tools/list':
        return { result: { tools: listTools() } };

      case 'tools/call': {
        const name = String(p.name ?? '');
        const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
        if (!getTool(name)) {
          return {
            error: {
              code: -32602,
              message: `未知工具：${name}。可用工具：${listTools().map((t) => t.name).join(' / ')}`,
            },
          };
        }
        try {
          const text = await applyTool(name, args, config);
          return { result: { content: [{ type: 'text', text: String(text) }] } };
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          log(`[tool] ${name} 失败：${message}`);
          return {
            result: {
              content: [{ type: 'text', text: `【${name} 执行失败】${message}` }],
              isError: true,
            },
          };
        }
      }

      case 'prompts/list':
        return { result: { prompts: listPrompts() } };

      case 'prompts/get': {
        const name = String(p.name ?? '');
        try {
          return { result: getPrompt(name) };
        } catch (err) {
          return { error: { code: -32602, message: err.message } };
        }
      }

      // 本服务不提供资源；回空列表比回错误更兼容（部分客户端会主动拉一次）。
      case 'resources/list':
        return { result: { resources: [] } };
      case 'resources/templates/list':
        return { result: { resourceTemplates: [] } };
      case 'logging/setLevel':
        return { result: {} };
      case 'completion/complete':
        return { result: { completion: { values: [] } } };

      default:
        return methodNotFound(method);
    }
  };
}
