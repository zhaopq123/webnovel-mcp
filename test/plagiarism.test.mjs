/**
 * AI 味 + 外部查重测试（v1.4.0 · 实施计划第 7 条）。
 *
 * 两条硬口径：
 *   ① AI 味样本必须能红（套话/句长过匀/抽象名词链/伪深刻句式四类判据各自有样本）；
 *   ② 查重必须诚实——未配置/不可达写「未执行」，有结果但无连续相同写「待人工确认」，
 *      只有真执行且未命中才说「未发现」。绿着但没查，比查出来更危险。
 *
 * 查重测试用本机 mock MCP 服务（真 HTTP，不 mock fetch），
 * 顺带锁住 initialize → notifications/initialized → tools/call 三步协议。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { detectAiFlavor, STYLE_THRESHOLDS } from '../lib/features/style.js';
import {
  extractFeatureSentences, checkPlagiarism, renderPlagiarismLines, PLAGIARISM_LIMITS,
} from '../lib/features/plagiarism.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

/* ------------------------------------------------------------------ *
 * 样本文本
 * ------------------------------------------------------------------ */

/** AI 味样本：套话刷屏 + 句长过匀 + 抽象名词链 + 三连「不是…而是」。 */
function aiFlavorText() {
  const parts = [];
  for (let i = 0; i < 30; i += 1) parts.push('他心中涌起一股难以言喻的情绪。');
  parts.push('这一刻空气仿佛凝固，时间仿佛静止。');
  parts.push('他不是害怕而是麻木。');
  parts.push('他不是犹豫而是等待。');
  parts.push('他不是逃避而是沉默。');
  parts.push('命运的无常、时间的残酷、人性的幽暗、欲望的深渊交织在一起。');
  return parts.join('');
}

/** 正常样本：长短句交错、有对话、有具体动作，不含黑名单套话。 */
const NORMAL_TEXT = [
  '林越把门闩放下。',
  '门外的人又敲了三下，不急不缓。',
  '“谁？”他问。',
  '“送水的。”声音隔着门板，闷闷的。',
  '他看了一眼灶台上的碗，碗里还剩半碗凉粥。',
  '门缝底下塞进来一张纸条，边角被雨水泡软了。',
  '林越没捡。',
  '他退后两步，顺手把油灯拨亮。',
  '火光跳了一下，照出墙上一道斜斜的影子。',
  '“你家掌柜的让我来问问，”门外的人清了清嗓子，“这个月的例钱，什么时候交？”',
  '林越把袖子往下拉了拉。他手腕上那道旧伤还没好利索，阴雨天就发痒。',
  '“明天。”他说。',
  '“明天什么时候？”',
  '“午时之前。”',
  '门外安静了片刻。',
  '脚步声往巷子口去，走了七八步，又停住。',
  '“对了，”那人回过头，声音比刚才低了些，“北街的铺子昨夜进了贼，丢了不少东西。你夜里关好门。”',
  '林越没答话。',
  '他站在门后，听着脚步声彻底消失。',
  '巷子里起了一阵风，门缝里的纸条翻了个面，露出背面歪歪扭扭的四个字。',
  '他蹲下去，终于把纸条捡了起来。',
  '纸条上的墨迹被水洇开了一半，仍能认出一个“逃”字。',
  '他把纸条折好，塞进贴身的衣袋里。',
].join('\n');

const SEARCH_TEXT = [
  '林越踩着满地碎瓦走进北街的铺子，脚尖踢到半截烧焦的门闩。',
  '柜台后面没有人，只有一盏没来得及吹灭的油灯，火苗细得像一根线。',
  '他蹲下去，从灰烬里捡起一枚刻着三爪螭纹的铜扣，铜扣背后粘着一小片靛蓝布。',
  '“这料子是城南染坊的。”身后忽然有人开口，声音沙哑。',
  '林越回头，看见周伯倚在门框上，右手缠着发黑的布条，指缝里渗出一点血。',
  '“你昨晚来过。”林越把铜扣收进袖口。',
  '周伯笑了一声，那笑没到眼睛里：“我来的时候，火已经烧到房梁了。”',
  '风从破窗灌进来，卷起地上的纸灰，在两人之间打了个旋。',
].join('\n');

/* ------------------------------------------------------------------ *
 * ① AI 味
 * ------------------------------------------------------------------ */

test('AI 味 · 四类判据在样本上全部能红', () => {
  const result = detectAiFlavor(aiFlavorText());
  assert.equal(result.checked, true);
  const kinds = result.issues.map((i) => i.kind);
  assert.ok(kinds.includes('cliche'), `应报套话：${kinds.join(',')}`);
  assert.ok(kinds.includes('uniform-sentence'), `应报句长过匀：${kinds.join(',')}`);
  assert.ok(kinds.includes('abstract-chain'), `应报抽象名词链：${kinds.join(',')}`);
  assert.ok(kinds.includes('not-ab'), `应报伪深刻句式：${kinds.join(',')}`);
  for (const issue of result.issues) {
    assert.equal(issue.level ?? 'warning', 'warning');
    assert.ok(issue.message.startsWith('AI 味：'));
  }
  assert.ok(result.stats.cliches >= 30);
});

test('AI 味 · 正常正文不报（判据不能见谁都咬）', () => {
  const result = detectAiFlavor(NORMAL_TEXT);
  assert.equal(result.checked, true);
  assert.deepEqual(result.issues.map((i) => i.kind), []);
});

test('AI 味 · 样本太短不判', () => {
  const result = detectAiFlavor('他心中涌起一股情绪。'.repeat(10));
  assert.equal(result.checked, false);
  assert.equal(result.skipped, 'sample-too-small');
  assert.equal(result.issues.length, 0);
});

test('AI 味 · 阈值只在 STYLE_THRESHOLDS 定义一次', () => {
  assert.ok(STYLE_THRESHOLDS.aiFlavor.cliches.length > 10);
  assert.equal(PLAGIARISM_LIMITS.minMatchChars, 10, '命中口径 10 字是产品口径，不许悄悄改');
});

/* ------------------------------------------------------------------ *
 * ② 特征句抽取
 * ------------------------------------------------------------------ */

test('查重 · 特征句长度在 10–16 字之间，优先包含专名', () => {
  const features = extractFeatureSentences(SEARCH_TEXT, { priorities: ['林越', '周伯', '螭纹铜扣'], max: 3 });
  assert.ok(features.length > 0, '应抽出特征句');
  for (const f of features) {
    assert.ok(f.phrase.length >= PLAGIARISM_LIMITS.minChars, `太短：${f.phrase}`);
    assert.ok(f.phrase.length <= PLAGIARISM_LIMITS.maxChars, `太长：${f.phrase}`);
    assert.ok(!/\s/.test(f.phrase), '特征句不许带空白');
  }
  const joined = features.map((f) => f.phrase).join('|');
  assert.match(joined, /林越|周伯|螭纹/, '专名句应优先入选');
});

test('查重 · 空正文不抽句', () => {
  assert.deepEqual(extractFeatureSentences(''), []);
  assert.deepEqual(extractFeatureSentences('太短。就一句。'), []);
});

/* ------------------------------------------------------------------ *
 * ③ mock MCP 搜索服务
 * ------------------------------------------------------------------ */

async function startMock(mode) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      requests.push(body);
      if (body.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mock-session' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock-websearch', version: '0' } },
        }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body.method === 'tools/call') {
        const query = body.params?.arguments?.query ?? '';
        const results = mode === 'hit'
          ? [{ title: '模拟名作', url: 'https://example.com/mock', snippet: `前文后文${query}前文后文` }]
          : mode === 'miss'
            ? [{ title: '无关页面', url: 'https://example.com/other', snippet: '这里没有你要找的那句话' }]
            : [];
        const payload = { query, results, meta: { coverage: 1 } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload },
        }));
        return;
      }
      res.writeHead(400);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 拿一个「监听过后立刻关闭」的端口，用来制造 connection refused。 */
async function closedUrl() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/* ------------------------------------------------------------------ *
 * ④ 查重三态（诚实性）
 * ------------------------------------------------------------------ */

test('查重 · 未配置 → executed=false，明确写「未执行」且不说通过', async () => {
  const result = await checkPlagiarism(null, SEARCH_TEXT, { url: '' });
  assert.equal(result.executed, false);
  assert.match(result.reason, /未配置/);
  const lines = renderPlagiarismLines(result).join('\n');
  assert.match(lines, /未执行/);
  assert.match(lines, /不等于通过/);
  assert.doesNotMatch(lines, /未发现连续相同/);
});

test('查重 · mock 命中 → 🔴 命中项带连续相同片段', async () => {
  const mock = await startMock('hit');
  try {
    const result = await checkPlagiarism(null, SEARCH_TEXT, { url: mock.url, timeoutMs: 4000 });
    assert.equal(result.executed, true);
    assert.ok(result.hits.length > 0, '应命中');
    assert.equal(result.hits[0].title, '模拟名作');
    assert.ok(result.hits[0].matched.length >= PLAGIARISM_LIMITS.minMatchChars);
    assert.equal(result.pending.length, 0);
    // 协议三步都走到了
    const methods = mock.requests.map((r) => r.method);
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('notifications/initialized'));
    assert.ok(methods.includes('tools/call'));
    assert.equal(mock.requests.find((r) => r.method === 'tools/call').params.name, 'web_search');
  } finally {
    await mock.close();
  }
});

test('查重 · mock 有结果但无连续相同 → 只报待人工确认', async () => {
  const mock = await startMock('miss');
  try {
    const result = await checkPlagiarism(null, SEARCH_TEXT, { url: mock.url, timeoutMs: 4000 });
    assert.equal(result.executed, true);
    assert.equal(result.hits.length, 0);
    assert.ok(result.pending.length > 0, '应进待人工确认');
    const lines = renderPlagiarismLines(result).join('\n');
    assert.match(lines, /待人工确认/);
    assert.doesNotMatch(lines, /未发现连续相同/);
  } finally {
    await mock.close();
  }
});

test('查重 · 服务不可达 → executed=false，如实报不可达', async () => {
  const url = await closedUrl();
  const result = await checkPlagiarism(null, SEARCH_TEXT, { url, timeoutMs: 2000 });
  assert.equal(result.executed, false);
  assert.match(result.reason, /不可达/);
  const lines = renderPlagiarismLines(result).join('\n');
  assert.match(lines, /未执行/);
  assert.match(lines, /不等于通过/);
});

/* ------------------------------------------------------------------ *
 * ⑤ 工具层出口：review plagiarism=true
 * ------------------------------------------------------------------ */

async function book() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-plag-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: root }), token: '' };
  await applyTool('webnovel_init', {
    bookId: 'b1', title: '查重测试', genre: '悬疑', targetWords: 600000, targetChapters: 200,
  }, config);
  return { root, config };
}

test('review · plagiarism=true 未配置时明示「未执行」', async () => {
  const { config } = await book();
  const report = await applyTool('webnovel_review', {
    bookId: 'b1', chapter: 1, text: SEARCH_TEXT, plagiarism: true,
  }, config);
  assert.match(report, /外部查重/);
  assert.match(report, /未执行/);
  assert.match(report, /不等于通过/);
  assert.doesNotMatch(report, /未发现 10 字以上连续相同/);
});

test('review · plagiarism=true 命中时进 🔴 榜', async () => {
  const { config } = await book();
  const mock = await startMock('hit');
  try {
    const report = await applyTool('webnovel_review', {
      bookId: 'b1', chapter: 1, text: SEARCH_TEXT, plagiarism: true,
    }, { ...config, searchUrl: mock.url, searchTimeoutMs: 4000 });
    assert.match(report, /外部查重/);
    assert.match(report, /疑似撞车/);
    assert.match(report, /模拟名作/);
    assert.match(report, /🔴/);
  } finally {
    await mock.close();
  }
});
