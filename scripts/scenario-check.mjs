#!/usr/bin/env node
/**
 * 场景验收（产品视角）：验证「长篇不崩」这个核心承诺是否真的成立。
 *
 * 跑的是作者真实会遇到的三件事：
 *   1. 第 1 章把主角写伤 + 埋伏笔 → 第 2 章任务书必须自动带上伤势和伏笔
 *   2. 第 2 章到点不回收伏笔 → 系统必须报「已到期未回收」
 *   3. 第 3 章写出「断手还握剑」→ 审查必须抓出来
 *   4. 重复 init 不许覆盖已经写好的正文
 *
 * 用法：node scripts/scenario-check.mjs <url> [token] [--book=<id>]
 */
const args = process.argv.slice(2);
const url = args[0];
const token = args.find((a) => !a.startsWith('--') && a !== url) ?? process.env.WEBNOVEL_TOKEN ?? '';
const bookId = (args.find((a) => a.startsWith('--book=')) ?? '--book=__scenario__').split('=')[1];

if (!url) {
  console.error('用法: node scripts/scenario-check.mjs <url> [token] [--book=<id>]');
  process.exit(2);
}

let seq = 0;
const lines = [];
let pass = 0;
let fail = 0;

async function rpc(method, params) {
  seq += 1;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: seq, method, params }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* ignore */ }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  if (body?.error) throw new Error(`协议错误: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function call(name, a) {
  const r = await rpc('tools/call', { name, arguments: a });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(text.slice(0, 300));
  return text;
}

async function step(title, fn) {
  try {
    await fn();
    pass += 1;
    lines.push(`  ✓ ${title}`);
  } catch (err) {
    fail += 1;
    lines.push(`  ✗ ${title}\n      ${err.message}`);
  }
}

const must = (text, re, what) => {
  if (!re.test(text)) throw new Error(`${what}未命中 ${re}：\n      ${text.replace(/\n/g, '\n      ').slice(0, 400)}`);
};
const mustNot = (text, re, what) => {
  if (re.test(text)) throw new Error(`${what}不该出现 ${re}：\n      ${text.slice(0, 300)}`);
};

const CH1 = '林越推开铁门。指尖传来震颤。不是风，是这扇门在说话。他挖出母亲留下的铁盒，盒盖割破了指腹。';
const CH2_OK = '林越左手提着灯，慢慢走进巷子。右臂还吊着，一动就疼。他想起母亲留下的铁盒。';
const CH3_BAD = '林越双手握剑，剑势如虹，一招劈开对方的防御。他的右手稳稳压住剑柄，纹丝不动。';

async function main() {
  console.log(`\n=== 场景验收：长篇不崩 ===\n目标: ${url}\n测试书: ${bookId}\n`);

  await step('建书（都市异能，目标 200 万字）', async () => {
    await call('webnovel_init', { bookId, title: '场景验收之书', genre: '都市异能', targetWords: 2_000_000, targetChapters: 800 });
  });

  await step('写总纲 + 第一卷卷纲', async () => {
    await call('webnovel_outline', { bookId, action: 'write_master', text: '# 总纲\n少年听物寻母。' });
    must(await call('webnovel_outline', { bookId, action: 'write_volume', volume: 1, title: '旧城', chapterRange: '1-100', text: '# 第一卷 旧城\n起承转合…' }), /已保存第 1 卷/, '卷纲');
  });

  await step('写第 1-3 章章纲', async () => {
    await call('webnovel_outline', { bookId, action: 'write_chapter', chapter: 1, text: '# 第一章 旧宅\n- 场景：旧宅\n- 事件：听见门的记忆，挖出铁盒' });
    await call('webnovel_outline', { bookId, action: 'write_chapter', chapter: 2, text: '# 第二章 出发\n- 场景：巷子' });
    await call('webnovel_outline', { bookId, action: 'write_chapter', chapter: 3, text: '# 第三章 遭遇\n- 场景：码头\n- 事件：与黑衣人交手' });
  });

  await step('第 1 章：写正文并提交（主角右臂骨裂 + 埋下玉佩伏笔，计划第 2 章回收）', async () => {
    await call('webnovel_outline', { bookId, action: 'write_text', chapter: 1, title: '旧宅', text: CH1 });
    const t = await call('webnovel_commit', {
      bookId,
      chapter: 1,
      title: '旧宅',
      summary: '林越在旧宅听见门的记忆，挖出母亲留下的铁盒，右臂骨裂。',
      strand: 'quest',
      hook: { type: '悬念钩', strength: 'strong' },
      ending: { time: '傍晚', location: '旧宅' },
      deltas: {
        protagonist: { name: '林越', location: '旧宅', power: { realm: '凡人' }, condition: '右臂骨裂，短期内无法用力' },
        world: { locations: ['老城区', '旧宅'] },
        timeline: { time: '傍晚', location: '旧宅', event: '挖出母亲留下的铁盒' },
        foreshadowing: { planted: [{ name: '母亲留下的玉佩', plannedPayoff: 2, importance: 'high' }] },
      },
    });
    must(t, /已提交第 1 章/, '提交');
  });

  await step('第 2 章任务书自动带上伤势 + 未回收伏笔（防遗忘核心）', async () => {
    const t = await call('webnovel_context', { bookId, chapter: 2 });
    must(t, /右臂骨裂/, '主角状态');
    must(t, /母亲留下的玉佩/, '未回收伏笔');
  });

  await step('第 2 章：写正文并提交（到点未回收伏笔 → 必须告警）', async () => {
    await call('webnovel_outline', { bookId, action: 'write_text', chapter: 2, title: '出发', text: CH2_OK });
    const t = await call('webnovel_commit', {
      bookId, chapter: 2, title: '出发', summary: '林越离开旧宅，前往码头。', strand: 'quest', force: true,
      deltas: { protagonist: { location: '码头' }, timeline: { time: '次日', location: '码头', event: '离开旧宅' } },
    });
    must(t, /已提交第 2 章/, '提交');
  });

  await step('伏笔台账显示「已到期未回收」', async () => {
    const t = await call('webnovel_query', { bookId, kind: 'foreshadowing' });
    must(t, /母亲留下的玉佩/, '伏笔条目');
    must(t, /到期|未回收/, '到期告警');
  });

  await step('第 3 章：写出「断手还握剑」→ 审查必须抓出来', async () => {
    await call('webnovel_outline', { bookId, action: 'write_text', chapter: 3, title: '遭遇', text: CH3_BAD });
    const t = await call('webnovel_review', { bookId, chapter: 3 });
    must(t, /状态冲突/, '一致性审查');
    must(t, /双手握剑|右手/, '原文证据');
  });

  await step('合规正文不误报（左手续写）', async () => {
    const t = await call('webnovel_review', { bookId, chapter: 2 });
    mustNot(t, /状态冲突/, '第 2 章审查');
  });

  await step('重复 init 不覆盖已写正文', async () => {
    await call('webnovel_init', { bookId, title: '场景验收之书' });
    const t = await call('webnovel_outline', { bookId, action: 'read', scope: 'text', chapter: 1 });
    must(t, /挖出母亲留下的铁盒/, '第 1 章正文');
  });

  await step('沉淀写作经验并进入下一章任务书', async () => {
    await call('webnovel_memory', { bookId, action: 'learn', kind: 'style', title: '打斗用短句', content: '动作场面用 8-15 字短句，别写长定语。' });
    await call('webnovel_outline', { bookId, action: 'write_chapter', chapter: 4, text: '# 第四章' });
    must(await call('webnovel_context', { bookId, chapter: 4 }), /打斗用短句/, '写作经验注入');
  });

  await step('进度与节奏报告可用', async () => {
    must(await call('webnovel_status', { bookId }), /场景验收之书/, '进度');
    must(await call('webnovel_pacing', { bookId }), /节奏体检报告/, '节奏');
  });

  await step('全文检索能找到正文里的细节', async () => {
    must(await call('webnovel_query', { bookId, kind: 'search', query: '铁盒' }), /铁盒/, '全文检索');
  });

  console.log(lines.join('\n'));
  console.log(`\n场景验收通过 ${pass} / ${pass + fail}\n`);
  console.log(`清账：webnovel-mcp-ctl clean --force ${bookId}   （本轮写过正文，不带 --force 会被护栏拦住）\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n场景验收中断：', err.message);
  console.log(lines.join('\n'));
  process.exit(1);
});
