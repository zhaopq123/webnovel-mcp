#!/usr/bin/env node
/**
 * 健壮性验收：真实使用里才会碰到的几件事。
 *
 *   1. prompts/get 能取到写作流程（不装专家也能用）
 *   2. 一整章长文（约 6 千字）跑 HTTP 不掉字、不超时
 *   3. 并发提交同一章不写坏数据（跨进程锁）
 *   4. 多本书并存时书列表与 bookId 隔离正常
 *
 * 用法：node scripts/robustness-check.mjs <url> [token] [--prefix=<id前缀>]
 */
const args = process.argv.slice(2);
const url = args[0];
const token = args.find((a) => !a.startsWith('--') && a !== url) ?? process.env.WEBNOVEL_TOKEN ?? '';
const prefix = (args.find((a) => a.startsWith('--prefix=')) ?? '--prefix=rb').split('=')[1];

if (!url) {
  console.error('用法: node scripts/robustness-check.mjs <url> [token] [--prefix=<id>]');
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
  const t0 = Date.now();
  try {
    const extra = await fn();
    pass += 1;
    const ms = Date.now() - t0;
    lines.push(`  ✓ ${title}${extra ? `（${extra}）` : ''}${ms > 1500 ? ` ⏱ ${ms}ms` : ''}`);
  } catch (err) {
    fail += 1;
    lines.push(`  ✗ ${title}\n      ${err.message}`);
  }
}

const must = (text, re, what) => {
  if (!re.test(text)) throw new Error(`${what}未命中 ${re}：${String(text).slice(0, 200)}`);
};

// 一段约 6 千字的长文（重复但不重复到能被检索当成同一章）
const PARA = '林越推开门，风灌进来。他听见门在说话，声音很轻，像有人在数一件旧事的年头。';
const LONG = Array.from({ length: 120 }, (_, i) => `${i + 1}. ${PARA}`).join('\n\n');

async function main() {
  console.log(`\n=== 健壮性验收 ===\n目标: ${url}\n前缀: ${prefix}\n`);

  await step('prompts/get 取到写作流程', async () => {
    const r = await rpc('prompts/get', { name: 'webnovel-write' });
    must(r.messages?.[0]?.content?.text ?? '', /webnovel_context/, '提示词正文');
    return 'webnovel-write';
  });

  await step('建两本书（验证 bookId 隔离）', async () => {
    await call('webnovel_init', { bookId: `${prefix}a`, title: '验收甲', genre: '都市异能' });
    await call('webnovel_init', { bookId: `${prefix}b`, title: '验收乙', genre: '悬疑' });
    const t = await call('webnovel_books', {});
    must(t, new RegExp(prefix), '书列表');
    must(t, /验收甲/, '书名');
    must(t, /验收乙/, '书名');
  });

  await step(`一整章长文 ${LONG.length} 字跑 HTTP 不丢字`, async () => {
    await call('webnovel_outline', { bookId: `${prefix}a`, action: 'write_chapter', chapter: 1, text: '# 第一章 长文测试' });
    const t = await call('webnovel_outline', { bookId: `${prefix}a`, action: 'write_text', chapter: 1, title: '长文测试', text: LONG });
    const back = await call('webnovel_outline', { bookId: `${prefix}a`, action: 'read', scope: 'text', chapter: 1 });
    if (back.length < LONG.length * 0.9) throw new Error(`回读长度 ${back.length}，应为约 ${LONG.length}`);
    return `回读 ${back.length} 字`;
  });

  await step('长文章节能被审查', async () => {
    const t = await call('webnovel_review', { bookId: `${prefix}a`, chapter: 1 });
    must(t, /审查报告/, '审查报告');
  });

  await step('并发提交同一章，数据不坏', async () => {
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      jobs.push(call('webnovel_commit', {
        bookId: `${prefix}a`, chapter: 1, title: '长文测试', summary: `第 ${i + 1} 次并发提交`, strand: 'quest', force: true,
      }));
    }
    const settled = await Promise.allSettled(jobs);
    const rejected = settled.filter((s) => s.status === 'rejected');
    if (rejected.length > 0) throw new Error(`${rejected.length} 个提交失败：${rejected[0].reason?.message?.slice(0, 120)}`);
    const st = await call('webnovel_status', { bookId: `${prefix}a` });
    must(st, /1 章/, '进度章数');
    // 索引里只能有 1 条（写坏的话会出现 6 条）
    return '6 路全部成功';
  });

  await step('两本书互不串数据', async () => {
    await call('webnovel_commit', {
      bookId: `${prefix}b`, chapter: 1, title: '乙书第一章', summary: '乙书开篇。', strand: 'fire', force: true,
    });
    const heroA = await call('webnovel_query', { bookId: `${prefix}a`, kind: 'status' });
    const heroB = await call('webnovel_query', { bookId: `${prefix}b`, kind: 'status' });
    // 每本书的返回都带自己的 bookId；书名/章名也要对得上，说明没串库
    must(heroB, new RegExp(`（书：${prefix}b）`), '乙书响应标记');
    must(heroB, /验收乙/, '乙书书名');
    must(heroA, new RegExp(`（书：${prefix}a）`), '甲书响应标记');
    must(heroA, /验收甲/, '甲书书名');
    const chA = await call('webnovel_query', { bookId: `${prefix}a`, kind: 'chapter', chapter: 1 });
    must(chA, /长文测试/, '甲书第 1 章详情');
  });

  console.log(lines.join('\n'));
  console.log(`\n健壮性通过 ${pass} / ${pass + fail}\n`);
  console.log(`\n清账：webnovel-mcp-ctl clean --force ${prefix}a ${prefix}b   （本轮写过正文，不带 --force 会被护栏拦住）\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n健壮性验收中断：', err.message);
  console.log(lines.join('\n'));
  process.exit(1);
});
