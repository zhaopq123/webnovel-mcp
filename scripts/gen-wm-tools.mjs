#!/usr/bin/env node
/**
 * 从 WritingMaster 的 MCP 子进程拉取 13 个 wm_* 工具定义，生成 mcp/wm-tools.generated.mjs。
 *
 *   node scripts/gen-wm-tools.mjs            # 生成/更新
 *   node scripts/gen-wm-tools.mjs --check    # 只比对，不一致就红（CI 用）
 *
 * 为什么要生成而不是手抄：上游 mcp-server.mjs 的 schema 与 wm.js 的参数一一对应，
 * 手抄必然漂移；生成 + 对账门禁能保证「webnovel-mcp 暴露的 wm_* 与上游永远同源」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWmTools } from '../lib/features/wm-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'mcp', 'wm-tools.generated.mjs');

const HEADER = `/**
 * 自动生成，请勿手改：\`node scripts/gen-wm-tools.mjs\`
 * 来源：suites/writing-master/writing-master-mcp-suite/scripts/mcp-server.mjs（唯一的 schema 事实源）
 * 门禁：test/wm-bridge.test.mjs 会重新拉一次上游清单与本文件逐字段比对，漂移即红。
 */
`;

function render(tools) {
  const items = tools.map((t) => {
    const lines = [
      '  {',
      `    name: ${JSON.stringify(t.name)},`,
      `    description: ${JSON.stringify(t.description ?? '')},`,
      `    inputSchema: ${JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} }, null, 2)
        .split('\n').map((l, i) => (i === 0 ? l : `    ${l}`)).join('\n')},`,
      '  },',
    ];
    return lines.join('\n');
  });
  return `${HEADER}
/** WritingMaster 的 13 个工具（wm_*），由上游 mcp-server.mjs 生成。 */
export const WM_TOOLS = [
${items.join('\n')}
];

/** 按上游顺序的工具名清单。 */
export const WM_TOOL_NAMES = WM_TOOLS.map((t) => t.name);

export default WM_TOOLS;
`;
}

const tools = await fetchWmTools();
const text = render(tools);

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '(缺失)';
  if (cur !== text) {
    console.error('✗ wm 工具清单与上游不一致（上游改了 schema 却没重新生成）');
    console.error('  修法：node scripts/gen-wm-tools.mjs');
    process.exit(1);
  }
  console.log(`✓ wm 工具清单与上游一致：${tools.length} 个（${tools.map((t) => t.name).join(' ')}）`);
  process.exit(0);
}

fs.writeFileSync(OUT, text);
console.log(`已生成 ${path.relative(ROOT, OUT)}：${tools.length} 个工具`);
