#!/usr/bin/env node
/**
 * 黑盒验收：以真实 MCP 客户端身份，对一个已部署的 webnovel-mcp 跑完整写作闭环。
 *
 * 用法：
 *   node scripts/live-check.mjs <url> [token] [--book=<bookId>]
 *   node scripts/live-check.mjs http://<部署主机>:8600/mcp <token>
 *
 * 退出码 0 = 全部通过；1 = 有失败项。测试书留在服务端书库里（MCP 没有删书的工具，
 * 客户端删不掉），跑完照最后一行打印的命令清账。
 */
import { TOOL_NAMES } from '../mcp/tool-names.mjs';

const args = process.argv.slice(2);
const url = args[0];
const token = args.find((a) => !a.startsWith('--') && a !== url) ?? process.env.WEBNOVEL_TOKEN ?? '';
const bookId = (args.find((a) => a.startsWith('--book=')) ?? '--book=livecheck').split('=')[1];

if (!url) {
  console.error('用法: node scripts/live-check.mjs <url> [token] [--book=<id>]');
  process.exit(2);
}

let id = 0;
let pass = 0;
let fail = 0;
const results = [];

async function rpc(method, params) {
  id += 1;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 保留 null */ }
  return { status: res.status, body, text };
}

async function call(name, a) {
  const r = await rpc('tools/call', { name, arguments: a });
  if (r.status !== 200) throw new Error(`${name} HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  if (r.body.error) throw new Error(`${name} 协议错误: ${JSON.stringify(r.body.error)}`);
  const result = r.body.result;
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(`${name} 工具报错: ${text}`);
  return text;
}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; results.push(`  ✓ ${name}`); })
    .catch((err) => { fail += 1; results.push(`  ✗ ${name}\n      ${err.message}`); });
}

const expectMatch = (text, re, what) => {
  if (!re.test(text)) throw new Error(`${what ?? ''}未匹配 ${re}：${text.slice(0, 160)}`);
};

async function main() {
  console.log(`\n=== webnovel-mcp 黑盒验收 ===\n目标: ${url}\n测试书: ${bookId}\n`);

  await check('initialize 握手', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-check', version: '1' } });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (r.body.result.serverInfo.name !== 'webnovel-mcp') throw new Error('serverInfo 不对');
  });

  await check(`tools/list 返回 ${TOOL_NAMES.length} 个工具`, async () => {
    const r = await rpc('tools/list', {});
    const tools = r.body.result.tools;
    const got = tools.map((t) => t.name).sort().join(',');
    const want = [...TOOL_NAMES].sort().join(',');
    if (got !== want) throw new Error(`工具清单与本地期望不一致\n      线上: ${got}\n      期望: ${want}`);
    const json = JSON.stringify(tools.map((t) => t.inputSchema));
    for (const banned of ['anyOf', 'oneOf', '$ref']) {
      if (json.includes(banned)) throw new Error(`schema 含 ${banned}`);
    }
  });

  await check('prompts/list 返回 6 个流程提示词', async () => {
    const r = await rpc('prompts/list', {});
    if (r.body.result.prompts.length !== 6) throw new Error(`实际 ${r.body.result.prompts.length}`);
  });

  await check('建书', async () => {
    const t = await call('webnovel_init', { bookId, title: '验收之书', genre: '都市异能', targetWords: 300000, targetChapters: 100 });
    expectMatch(t, /已建好新书|已在既有书上补全骨架/, '建书返回');
    // 第 10 条体量引擎：开书第一屏就要给结构换算表，不能等写到一半才发现部数不对。
    expectMatch(t, /体量结构换算（提示词第二节）/, '建书结构表');
    expectMatch(t, /1 部（约 86 章\/部/, '30 万字应为 1 部');
  });

  await check('创作规则库：19 节切片目录', async () => {
    const t = await call('webnovel_craft', { action: 'sections' });
    expectMatch(t, /19 节 \/ 92 切片/, '切片目录');
  });

  await check('创作规则库：按切片号取原文', async () => {
    const t = await call('webnovel_craft', { action: 'get', ids: '15.5' });
    expectMatch(t, /原文切片 15\.5/, '切片头');
    expectMatch(t, /去 ?AI ?味|AI 味/, '15.5 正文');
  });

  await check('创作规则库：按阶段组包', async () => {
    const t = await call('webnovel_craft', { action: 'brief', stage: 'stage6' });
    expectMatch(t, /创作规则包 · 阶段6/, '阶段包标题');
    expectMatch(t, /15\.8/, '正文阶段必须带两遍交付制');
  });

  await check('创作规则库：20 表落点 + 三方自检', async () => {
    expectMatch(await call('webnovel_craft', { action: 'map' }), /20 表 → 工具包数据模型落点/, '落点表');
    expectMatch(await call('webnovel_craft', { action: 'check' }), /原文 \/ 切片库 \/ 锁 三方一致/, '自检');
  });

  await check('书列表包含该书', async () => {
    expectMatch(await call('webnovel_books', {}), new RegExp(bookId), '书列表');
  });

  await check('无章纲时给出 blocker（护栏生效）', async () => {
    const t = await call('webnovel_context', { bookId, chapter: 1 });
    expectMatch(t, /章纲/, '任务书');
  });

  await check('写章纲', async () => {
    expectMatch(await call('webnovel_outline', { bookId, action: 'write_chapter', chapter: 1, text: '# 第一章 旧宅\n- 场景：旧宅，黄昏\n- 事件：听见门的记忆，挖出铁盒' }), /已保存第 1 章章纲/, '章纲');
  });

  await check('取写作任务书', async () => {
    expectMatch(await call('webnovel_context', { bookId, chapter: 1 }), /写作任务书/, '任务书');
  });

  const body = '林越推开铁门。指尖传来震颤。不是风。是这扇门在说话。他蹲下身，手掌贴上地面。冰凉的水泥底下，有什么东西在低鸣。他挖出了那个铁盒。';

  await check('保存正文', async () => {
    expectMatch(await call('webnovel_outline', { bookId, action: 'write_text', chapter: 1, title: '旧宅', text: body }), /已保存正文/, '保存正文');
  });

  await check('审查章节', async () => {
    expectMatch(await call('webnovel_review', { bookId, chapter: 1 }), /审查报告/, '审查');
  });

  // v1.4.0 新维度：AI 味与外部查重必须由服务端真实走通，不能只在单测里绿。
  const AI_SAMPLE = ('他心中涌起一股难以言喻的情绪。'.repeat(30))
    + '这一刻空气仿佛凝固。命运的无常、时间的残酷、人性的幽暗、欲望的深渊交织在一起。'
    + '他不是害怕而是麻木。他不是犹豫而是等待。他不是逃避而是沉默。';

  await check('审查：AI 味四类判据（15.6）', async () => {
    const t = await call('webnovel_review', { bookId, chapter: 2, text: AI_SAMPLE });
    expectMatch(t, /AI 味/, 'AI 味维度');
    expectMatch(t, /套话|句长|抽象名词|不是/, 'AI 味证据');
  });

  await check('审查：外部查重三态必须明示（plagiarism=true）', async () => {
    const t = await call('webnovel_review', {
      bookId,
      chapter: 2,
      text: '陈三把油灯放在窗台上，火苗晃了两下，照亮墙角那只落了灰的木箱。\n他蹲下去，从木箱底下摸出一枚刻着三爪螭纹的铜扣。',
      plagiarism: true,
    });
    expectMatch(t, /外部查重/, '查重段');
    expectMatch(t, /未执行|待人工确认|疑似撞车|未发现/, '查重三态之一');
  });

  await check('文风基准：人工设定（15.6）', async () => {
    const t = await call('webnovel_memory', {
      bookId,
      action: 'baseline',
      content: '{"avgSentence":16,"sentenceSd":9,"avgParagraph":120,"dialogueRatio":0.2,"punctuationDensity":0.14}',
    });
    expectMatch(t, /文风基准已按人工值设定/, '基准回执');
  });

  await check('提交事实增量', async () => {
    const t = await call('webnovel_commit', {
      bookId,
      chapter: 1,
      title: '旧宅',
      summary: '林越在旧宅听见门的记忆，挖出母亲留下的铁盒。',
      strand: 'quest',
      deltas: {
        protagonist: { name: '林越', location: '旧宅', condition: '指腹擦伤' },
        terms: [
          { name: '林越', type: '人物' },
          { name: '铁盒', type: '物品' },
        ],
        foreshadowing: { planted: [{ name: '母亲留下的铁盒', plannedPayoff: 30, importance: 'high' }] },
      },
    });
    expectMatch(t, /已提交第 1 章/, '提交');
    expectMatch(t, /新登记专名 2 条/, '专名登记回执');
  });

  await check('审查：8.2 信息隔离能拦（pov + knowledge）', async () => {
    // 放在提交之后：主角「林越」已登记，才能证明拦截是因为「还没登记知道」，
    // 而不是把「角色不存在」误当成信息隔离生效。
    const t = await call('webnovel_review', {
      bookId,
      chapter: 2,
      text: '林越皱眉，没有接话。',
      pov: '林越',
      knowledge: [{ who: '林越', fact: '周伯欠他三百两', mode: 'use' }],
    });
    expectMatch(t, /信息隔离/, '信息隔离维度');
    expectMatch(t, /还没登记知道/, '拦截理由');
  });

  await check('专名账本可查（铁律 1）', async () => {
    const t = await call('webnovel_query', { bookId, kind: 'term', name: '铁盒' });
    expectMatch(t, /铁盒/, '专名卡片');
    expectMatch(t, /已登记写法/, '专名写法提示');
  });

  await check('查询主角状态', async () => {
    expectMatch(await call('webnovel_query', { bookId, kind: 'character', name: '林越' }), /指腹擦伤/, '角色查询');
  });

  await check('沉淀写作经验', async () => {
    expectMatch(await call('webnovel_memory', { bookId, action: 'learn', kind: 'style', title: '短句打斗', content: '动作场面用 8-15 字短句。' }), /已记住/, '记忆');
  });

  await check('第 2 章任务书延续状态/伏笔/经验（防遗忘核心）', async () => {
    await call('webnovel_outline', { bookId, action: 'write_chapter', chapter: 2, text: '# 第二章 出发' });
    const t = await call('webnovel_context', { bookId, chapter: 2 });
    expectMatch(t, /指腹擦伤/, '主角状态');
    expectMatch(t, /母亲留下的铁盒/, '未回收伏笔');
    expectMatch(t, /短句打斗/, '写作经验');
  });

  await check('节奏体检', async () => {
    expectMatch(await call('webnovel_pacing', { bookId }), /节奏体检报告/, '节奏');
  });

  await check('进度查询', async () => {
    const t = await call('webnovel_status', { bookId });
    expectMatch(t, /验收之书/, '进度');
    expectMatch(t, /结构换算（提示词第二节/, '状态结构块');
  });

  await check('部结构：登记本部后状态显示当前位置', async () => {
    expectMatch(await call('webnovel_outline', {
      bookId,
      action: 'write_part',
      part: 1,
      title: '旧宅',
      chapterRange: '1-86',
      text: '# 第一部 旧宅\n\n- 本部落点：铁盒的来源与母亲的过去\n- 部末钩子：铁盒里不是遗物，是一把钥匙',
    }), /已保存第 1 部部纲/, '部纲');
    const t = await call('webnovel_status', { bookId });
    expectMatch(t, /本部：第 1 部《旧宅》/, '部位置');
    expectMatch(t, /共 86 章/, '部长度');
  });

  await check('路径安全：非法 bookId 被拒', async () => {
    const r = await rpc('tools/call', { name: 'webnovel_init', arguments: { bookId: '../evil', title: 'X' } });
    if (!r.body.result?.isError) throw new Error('穿越型 bookId 未被拒绝');
  });

  await check('鉴权：错误 token 被拒（未配 token 时跳过）', async () => {
    if (!token) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list', params: {} }),
    });
    if (res.status !== 401) throw new Error(`期望 401，实际 ${res.status}`);
  });

  console.log(results.join('\n'));
  console.log(`\n通过 ${pass} / ${pass + fail}\n`);

  console.log(`\n清账：webnovel-mcp-ctl clean --force ${bookId}   （本轮写过正文，不带 --force 会被护栏拦住）\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n验收中断：', err.message);
  console.log(results.join('\n'));
  process.exit(1);
});
