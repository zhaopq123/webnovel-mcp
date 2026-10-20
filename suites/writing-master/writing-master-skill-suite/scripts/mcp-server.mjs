#!/usr/bin/env node
// mcp-server.mjs — WritingMaster MCP 服务器（stdio，零第三方依赖）
// 用法: node scripts/mcp-server.mjs [--root <作品目录>]
// 协议: Model Context Protocol（JSON-RPC 2.0，行分帧，2024-11-05 子集）
// 设计: 薄壳层——全部业务逻辑在 scripts/wm.js（单一事实源），本文件只做
//       协议适配（initialize/ping/tools/list/tools/call），不重复实现任何校验。
// 与 CLI 双形态一致：13 个命令 = 13 个 MCP 工具（wm-verify.sh V3 会校验一致性）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WMJS = path.join(__dirname, 'wm.js');
const args = process.argv.slice(2);
let defaultRoot = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) { defaultRoot = path.resolve(args[i + 1]); i++; }
}

/* ── 工具定义：与 wm.js parseArgs 的参数规格一一对应 ── */
const BOOL = { type: 'boolean', description: '开关（无值参数）' };
const TOOLS = [
  {
    name: 'wm_init', description: '初始化作品项目（创建 .wm/ 账本）。track 五大赛道：novel 长篇小说 / romance 言情网文 / screenplay 剧本 / jubensha 剧本杀 / toolbook 工具书',
    inputSchema: { type: 'object', required: ['track', 'title', 'target_words'], properties: {
      track: { type: 'string', enum: ['novel', 'romance', 'screenplay', 'jubensha', 'toolbook'] },
      title: { type: 'string' }, target_words: { type: 'number', minimum: 1 },
      mode: { type: 'string', enum: ['auto', 'collab'] },
      dir: { type: 'string' }, no_outline_gate: BOOL } },
    map: a => ['--track', a.track, '--title', a.title, '--target-words', String(a.target_words),
      ...(a.mode ? ['--mode', a.mode] : []), ...(a.dir ? ['--dir', a.dir] : []),
      ...(a.no_outline_gate ? ['--no-outline-gate'] : [])]
  },
  {
    name: 'wm_context', description: '动笔前上下文装配。含章纲门禁（outline_gate 启用时无章纲将 BLOCKER 拦截）、写作记忆自动注入、本章章纲展示、状态尾锚点 [state]',
    inputSchema: { type: 'object', properties: {
      dir: { type: 'string' }, task: { type: 'string', enum: ['plan', 'write', 'review', 'report'] },
      chapter: { type: 'number', minimum: 1 }, budget: { type: 'number', minimum: 200 } } },
    map: a => ['--dir', a.dir || defaultRoot || '.', ...(a.task ? ['--task', a.task] : []),
      ...(a.chapter ? ['--chapter', String(a.chapter)] : []), ...(a.budget ? ['--budget', String(a.budget)] : [])]
  },
  {
    name: 'wm_commit', description: '事实增量提交（名词锁校验 + 三线 strand 标记）。更新 JSON 支持 names/characters/foreshadow/timeline/suspense/info_gap/plotlines/summary/words_count',
    inputSchema: { type: 'object', required: ['file'], properties: { dir: { type: 'string' }, file: { type: 'string' } } },
    map: a => ['--dir', a.dir || defaultRoot || '.', '--file', a.file]
  },
  {
    name: 'wm_review', description: '稿件机械审查门禁：AI味黑名单/英繁混排/标点/句长/专名笔误/引号专名/伏笔超期/钩子承接。红级打回 exit≠0',
    inputSchema: { type: 'object', required: ['file'], properties: { dir: { type: 'string' }, file: { type: 'string' }, chapter: { type: 'number' } } },
    map: a => ['--dir', a.dir || defaultRoot || '.', '--file', a.file, ...(a.chapter ? ['--chapter', String(a.chapter)] : [])]
  },
  {
    name: 'wm_status', description: '进度面板：字数进度条 + 台账健康红绿灯',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    map: a => ['--dir', a.dir || defaultRoot || '.']
  },
  {
    name: 'wm_archive', description: '部归档：压缩活跃区台账/摘要至 .wm/archive/part-N/，开启新部',
    inputSchema: { type: 'object', required: ['part'], properties: { dir: { type: 'string' }, part: { type: 'number', minimum: 1 } } },
    map: a => ['--dir', a.dir || defaultRoot || '.', '--part', String(a.part)]
  },
  {
    name: 'wm_restore', description: '断点恢复包：新会话开工前重建上下文',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    map: a => ['--dir', a.dir || defaultRoot || '.']
  },
  {
    name: 'wm_doctor', description: '账本体检 D01-D08（结构/JSON/引用/伏笔/部链/流水一致性）',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    map: a => ['--dir', a.dir || defaultRoot || '.']
  },
  {
    name: 'wm_outline', description: '四级大纲管理（master 总纲/part 部纲/volume 卷纲/chapter 章纲）+ 无章纲不动笔门禁开关（--enable/--disable）。context --task write 前须先存章纲',
    inputSchema: { type: 'object', properties: {
      dir: { type: 'string' }, save: { type: 'string', enum: ['master', 'part', 'volume', 'chapter'] },
      show: { type: 'string', enum: ['master', 'part', 'volume', 'chapter'] },
      file: { type: 'string' }, num: { type: 'number', minimum: 1 },
      list: BOOL, enable: BOOL, disable: BOOL } },
    map: a => ['--dir', a.dir || defaultRoot || '.',
      ...(a.save ? ['--save', a.save] : []), ...(a.show ? ['--show', a.show] : []),
      ...(a.file ? ['--file', a.file] : []), ...(a.num ? ['--num', String(a.num)] : []),
      ...(a.list ? ['--list'] : []), ...(a.enable ? ['--enable'] : []), ...(a.disable ? ['--disable'] : [])]
  },
  {
    name: 'wm_query', description: '七类台账查询 + 全文检索（归档区感知）：characters/foreshadow/suspense/info-gap/plotlines/timeline/names/fulltext。支持 --name/--id/--keyword 定点查询',
    inputSchema: { type: 'object', required: ['what'], properties: {
      dir: { type: 'string' },
      what: { type: 'string', enum: ['characters', 'foreshadow', 'suspense', 'info-gap', 'plotlines', 'timeline', 'names', 'fulltext'] },
      name: { type: 'string' }, id: { type: 'string' }, keyword: { type: 'string' }, top: { type: 'number' } } },
    map: a => ['--dir', a.dir || defaultRoot || '.', '--what', a.what,
      ...(a.name ? ['--name', a.name] : []), ...(a.id ? ['--id', a.id] : []),
      ...(a.keyword ? ['--keyword', a.keyword] : []), ...(a.top ? ['--top', String(a.top)] : [])]
  },
  {
    name: 'wm_pacing', description: '三线节奏体检：quest 主线/fire 感情线/constellation 世界观 占比与断档检测，按赛道换算理想配比，输出修复建议',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, window: { type: 'number', minimum: 3 } } },
    map: a => ['--dir', a.dir || defaultRoot || '.', ...(a.window ? ['--window', String(a.window)] : [])]
  },
  {
    name: 'wm_memory', description: '长期写作记忆（五类 style/technique/setting/feedback/character）：--add 沉淀 / --list 列举（可 --kind/--tag 过滤）/ --search 检索。context 装配时自动注入最近 5 条',
    inputSchema: { type: 'object', properties: {
      dir: { type: 'string' }, add: { type: 'string' }, list: BOOL, search: { type: 'string' },
      kind: { type: 'string' }, tag: { type: 'string' } } },
    map: a => ['--dir', a.dir || defaultRoot || '.',
      ...(a.add ? ['--add', a.add] : []), ...(a.list ? ['--list'] : []),
      ...(a.search ? ['--search', a.search] : []), ...(a.kind ? ['--kind', a.kind] : []), ...(a.tag ? ['--tag', a.tag] : [])]
  },
  {
    name: 'wm_verify', description: '包完整性门禁：V1 知识切片 sha 锁（以 index.json 当前内容动态计算，--update-lock 生成/刷新锁）/ V2 模板引用 / V3 命令齐备+CLI↔MCP 双形态一致 / V4 全链路冒烟',
    inputSchema: { type: 'object', properties: { root: { type: 'string' }, update_lock: BOOL, no_smoke: BOOL } },
    map: a => [...(a.root ? ['--root', a.root] : []), ...(a.update_lock ? ['--update-lock'] : []), ...(a.no_smoke ? ['--no-smoke'] : [])]
  }
];

/* ── 调用 wm.js（业务单一事实源） ── */
function callWM(argv) {
  const r = spawnSync(process.execPath, [WMJS, ...argv], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000,
    cwd: defaultRoot && path.isAbsolute(defaultRoot) ? defaultRoot : process.cwd()
  });
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout || '') + (r.stderr ? `\n[stderr]\n${r.stderr}` : ''),
    err: r.error ? String(r.error.message) : ''
  };
}

/* map 产物补上子命令名（工具名 wm_xxx → 子命令 xxx） */
for (const t of TOOLS) {
  const sub = t.name.slice(3);
  const raw = t.map;
  t.map = a => [sub, ...raw(a)];
}

function rpcResult(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function rpcError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

/* ── 主循环：行分帧 JSON-RPC ── */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) { return rpcError(null, -32700, 'Parse error'); }  /* 坏 JSON 按协议回 -32700，不崩溃 */
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'writing-master', version: '1.2.0' }
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return rpcError(id, -32602, `未知工具: ${name}`);
    let argv;
    try { argv = tool.map(params?.arguments || {}); }
    catch (e) { return rpcResult(id, { content: [{ type: 'text', text: `参数构造失败: ${e.message}` }], isError: true }); }
    const r = callWM(argv);
    const text = r.out.trim() || (r.ok ? '(无输出)' : `命令失败（exit=${r.code}）${r.err}`);
    return rpcResult(id, { content: [{ type: 'text', text }], isError: !r.ok });
  }
  if (id !== undefined) return rpcError(id, -32601, `未知方法: ${method}`);
}
