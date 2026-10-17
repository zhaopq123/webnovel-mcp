/**
 * 体量自适应引擎测试（v1.3.0 · 实施计划第 10 条）。
 *
 * 判据不是「跑通就行」，而是**逐项等于按提示词第二节手算的结果**——
 * 这套公式一旦算错，作者会照错误的部数去排弧光、排反派洋葱层，返工成本是整部书。
 * 四个参数化案例（30 万 / 100 万 / 300 万 / 1000 万）覆盖：
 *   · 向上取整（部数、每部章数）
 *   · 上限封顶（大层级 4+N ≤ 10、洋葱 min(2+N,5) ≤ 5）
 *   · 分段加层（悬念账户 1 部 3 层 → 2 部加跨部 → 4 部加全书）
 *   · 冲突轮次在 N=3/4 处翻转
 * 另外三组守结构性问题：目标字数与目标章数不自洽时必须能红（不能只算不查）、
 * 结构表必须真的进 status/init 输出、结构参数必须是「只算不存」（防第二份真相）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject, loadProject } from '../lib/core/project.js';
import { projectStatus } from '../lib/features/status.js';
import {
  computeStructure, renderStructureTable, STRUCTURE_CONSTANTS,
} from '../lib/features/structure.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

/** 按提示词 2.2/2.3/2.4/2.5 手算出来的期望值（改公式必须同时改这里，且要有理由）。 */
const CASES = [
  {
    label: '30 万字（比一个部还短的书）',
    targetWords: 300_000,
    parts: 1,
    chapters: { min: 75, suggested: 86, max: 100 },
    chaptersPerPart: 86,
    volumes: 2,
    chaptersPerVolume: 43,
    tiers: 5,            // 4+1
    onion: 3,            // min(2+1,5)
    suspense: 3,         // 短/卷/部
    conflict: { mode: '一轮', rounds: 1 },
    arcSegments: 1,
    archiveTimes: 0,
  },
  {
    label: '100 万字（默认体量）',
    targetWords: 1_000_000,
    parts: 2,            // ceil(100/55)=2
    chapters: { min: 250, suggested: 286, max: 334 },
    chaptersPerPart: 143,
    volumes: 4,
    chaptersPerVolume: 72,
    tiers: 6,            // 4+2
    onion: 4,            // min(2+2,5)
    suspense: 4,         // + 跨部
    conflict: { mode: '一轮', rounds: 1 },
    arcSegments: 2,
    archiveTimes: 1,     // N−1
  },
  {
    label: '300 万字',
    targetWords: 3_000_000,
    parts: 6,            // ceil(300/55)=5.45→6
    chapters: { min: 750, suggested: 857, max: 1000 },
    chaptersPerPart: 143,
    volumes: 13,
    chaptersPerVolume: 66,
    tiers: 10,           // 4+6=10（正好触顶）
    onion: 5,            // min(2+6,5)=5（封顶）
    suspense: 5,         // + 全书（N≥4）
    conflict: { mode: '多轮', rounds: 2 },
    arcSegments: 6,
    archiveTimes: 5,
  },
  {
    label: '1000 万字',
    targetWords: 10_000_000,
    parts: 19,           // ceil(1000/55)=18.18→19
    chapters: { min: 2500, suggested: 2857, max: 3334 },
    chaptersPerPart: 151,
    volumes: 44,
    chaptersPerVolume: 65,
    tiers: 10,           // 4+19=23 → 上限 10
    onion: 5,
    suspense: 5,
    conflict: { mode: '多轮', rounds: 7 },
    arcSegments: 19,
    archiveTimes: 18,
  },
];

for (const c of CASES) {
  test(`换算 · ${c.label}`, () => {
    const s = computeStructure({ targetWords: c.targetWords });
    assert.equal(s.parts.count, c.parts, '部数 = 总字数÷55万 向上取整');
    assert.deepEqual(s.chapters, c.chapters, '章数区间按 3000–4000 字/章换算');
    assert.equal(s.parts.chaptersPerPart, c.chaptersPerPart, '每部章数');
    assert.equal(s.volumes.count, c.volumes, '卷数');
    assert.equal(s.volumes.chaptersPerVolume, c.chaptersPerVolume, '每卷章数');
    assert.equal(s.tiers.count, c.tiers, `大层级数 = 4+N（上限 ${STRUCTURE_CONSTANTS.bigTier.cap}）`);
    assert.equal(s.onion.layers, c.onion, `反派洋葱 = min(2+N, ${STRUCTURE_CONSTANTS.onion.cap})`);
    assert.equal(s.suspense.layers, c.suspense, '悬念账户层数');
    assert.equal(s.suspense.layers, s.suspense.names.length, '层数与层名必须对得上');
    assert.equal(s.conflict.mode, c.conflict.mode, '冲突轮次口径');
    assert.equal(s.conflict.rounds, c.conflict.rounds, '冲突轮数');
    assert.equal(s.arc.segments, c.arcSegments, '部阶段弧光段数 = N（2.4）');
    assert.equal(s.archive.times, c.archiveTimes, '归档次数 = N−1（2.5）');
    assert.equal(s.conflict.selfLayerIrreversible, true, '自我层成长不可逆是硬性规则');
  });
}

test('换算 · 向上取整的边界（55 万整是 1 部，多 1 字就是 2 部）', () => {
  assert.equal(computeStructure({ targetWords: 550_000 }).parts.count, 1);
  assert.equal(computeStructure({ targetWords: 550_001 }).parts.count, 2);
  assert.equal(computeStructure({ targetWords: 1_100_000 }).parts.count, 2);
  assert.equal(computeStructure({ targetWords: 1_100_001 }).parts.count, 3);
  // 「至少 1 部」：小于 55 万不能算出 0 部
  assert.equal(computeStructure({ targetWords: 30_000 }).parts.count, 1);
});

test('换算 · 封顶与分段的翻转点', () => {
  assert.equal(computeStructure({ targetWords: 1_100_000 }).tiers.count, 6);   // N=2
  assert.equal(computeStructure({ targetWords: 3_300_000 }).tiers.count, 10);  // N=6 → 4+6 正好触顶
  assert.equal(computeStructure({ targetWords: 3_850_000 }).tiers.count, 10);  // N=7 → 11 必须被截到 10
  assert.equal(computeStructure({ targetWords: 1_100_000 }).onion.layers, 4);
  assert.equal(computeStructure({ targetWords: 1_650_000 }).onion.layers, 5);  // N=3 → 2+3 正好封顶
  assert.equal(computeStructure({ targetWords: 2_200_000 }).onion.layers, 5);  // N=4 不许超 5
  // 悬念账户：1 部 3 层、2 部加跨部、4 部加全书
  assert.deepEqual(computeStructure({ targetWords: 550_000 }).suspense.names, ['短', '卷', '部']);
  assert.deepEqual(computeStructure({ targetWords: 1_100_000 }).suspense.names, ['短', '卷', '部', '跨部']);
  assert.deepEqual(computeStructure({ targetWords: 1_650_000 }).suspense.names, ['短', '卷', '部', '跨部']);   // N=3：还不加全书
  assert.deepEqual(computeStructure({ targetWords: 2_200_000 }).suspense.names, ['短', '卷', '部', '跨部', '全书']); // N=4：加全书
  // 冲突轮次在 N=3/4 处翻转（2.3：N≤3 一轮，N≥4 多轮）
  assert.equal(computeStructure({ targetWords: 1_650_000 }).conflict.mode, '一轮');  // N=3
  assert.equal(computeStructure({ targetWords: 2_200_000 }).conflict.mode, '多轮');  // N=4
  assert.equal(computeStructure({ targetWords: 1_650_000 }).conflict.rounds, 1);
  assert.equal(computeStructure({ targetWords: 2_200_000 }).conflict.rounds, 2, '多轮时按约 3 部一轮给建议值');
});

test('换算 · 没给目标字数时按 2.1 用 100 万，并如实标注是假设值', () => {
  const s = computeStructure({});
  assert.equal(s.targetWords, STRUCTURE_CONSTANTS.defaultTargetWords);
  assert.equal(s.assumedWords, true);
  assert.ok(s.notes.some((n) => n.level === 'info' && n.text.includes('100 万字')), '要告诉用户这是假设的体量');
  assert.equal(computeStructure({ targetWords: 0 }).assumedWords, true, '0 字等于没给，不能算出 0 章');
});

test('不自洽要能红 · 目标字数与目标章数打架时报警（只算不查等于没查）', () => {
  // 100 万字 ≈ 250–334 章，项目却写 400 章（≈120–160 万字）
  const bad = computeStructure({ targetWords: 1_000_000, targetChapters: 400 });
  const warn = bad.notes.find((n) => n.level === 'warn' && n.text.includes('口径不一致'));
  assert.ok(warn, `应出现字数/章数口径告警，实际 notes：${bad.notes.map((n) => n.text).join(' | ') || '（空）'}`);
  assert.match(warn.text, /250–334 章/);
  assert.match(warn.text, /400 章/);

  // 口径自洽时不许乱叫（否则作者会连正常提醒一起无视）
  const good = computeStructure({ targetWords: 1_000_000, targetChapters: 286 });
  assert.equal(good.notes.filter((n) => n.level === 'warn' && n.text.includes('口径不一致')).length, 0);
});

test('不自洽要能红 · 每部章数溢出恒定区间时给出可执行的重算值', () => {
  const s = computeStructure({ targetWords: 10_000_000 });
  assert.ok(s.parts.chaptersPerPart > STRUCTURE_CONSTANTS.partChapters[1], '本用例前提：1000 万按 19 部确实溢出');
  const warn = s.notes.find((n) => n.level === 'warn' && n.text.includes('超出部的恒定上限'));
  assert.ok(warn, `应提示按更多部重算，实际：${s.notes.map((n) => n.text).join(' | ')}`);
  assert.match(warn.text, /建议按 20 部/, '要把重算结果直接给出，不能只说「超了」');

  // 100 万这种正好落在区间里的，不许报同一条
  const ok = computeStructure({ targetWords: 1_000_000 });
  assert.equal(ok.notes.filter((n) => n.text.includes('超出部的恒定上限')).length, 0);
});

test('换算 · 当前章号能落到「第几部的第几章、离部末还剩几章」', () => {
  const s = computeStructure({ targetWords: 1_000_000, currentChapter: 200 });
  assert.equal(s.progress.part, 2, '143 章/部 → 第 200 章在第 2 部');
  assert.equal(s.progress.chaptersIntoPart, 57);
  assert.equal(s.progress.remainingInPart, 86);
  assert.equal(s.progress.partEndChapter, 286, '末部止于换算章数上限内');
  assert.equal(s.progress.nextPartStartChapter, null, '已是最后一部，不该编出下一部');
  assert.deepEqual(s.progress.partBoundaryChapters, [143], '部边界章号给出来才排得出部末事件');
  assert.equal(s.progress.volume, 3);

  const mid = computeStructure({ targetWords: 1_000_000, currentChapter: 100 });
  assert.equal(mid.progress.part, 1);
  assert.equal(mid.progress.partEndChapter, 143);
  assert.equal(mid.progress.nextPartStartChapter, 144, '下一部起始章要能给出来（部末倒计时靠它）');

  const first = computeStructure({ targetWords: 1_000_000, currentChapter: 1 });
  assert.equal(first.progress.part, 1);
  assert.equal(first.progress.chaptersIntoPart, 1);
  assert.equal(computeStructure({ targetWords: 1_000_000 }).progress, null, '没章号就不编造进度');

  // 写得比目标还长：这是「该收部/该改体量」的信号，必须响
  const over = computeStructure({ targetWords: 1_000_000, currentChapter: 400 });
  assert.ok(over.notes.some((n) => n.level === 'warn' && n.text.includes('超出')), '超换算区间要报警');
});

test('渲染 · 结构表把恒定单元与换算结果一起摆出来，且节号可追溯', () => {
  const lines = renderStructureTable(computeStructure({ targetWords: 1_000_000, currentChapter: 100 }));
  const text = lines.join('\n');
  assert.match(text, /体量结构换算/);
  assert.match(text, /N=2 部/);
  assert.match(text, /3000–4000 字（恒定）/);
  assert.match(text, /\| 部 \| 2 部（约 143 章\/部/);
  assert.match(text, /min\(2\+N, 5\)/);
  assert.match(text, /短\/卷\/部\/跨部/);
  assert.match(text, /自我层成长不可逆/);
  assert.match(text, /归档 1 次/);
  assert.match(text, /第 1 部第 100 章/, '当前进度落点');
  assert.match(text, /本部止于第 143 章，距部末 43 章/);
  assert.match(text, /下一部自第 144 章起/, '跨部接缝要提前给章号');
  assert.match(text, /重建局面 \+ 引入本部新变量 \+ 回收上部钩子的回响/, '2.6 部首章规则要跟着倒计时出现');
  assert.match(text, /自动重算/, '要说明这是现算的，不是配置项');
  for (const l of lines) assert.ok(!/\t/.test(l), '表里不许出现制表符');
  // 末部不该再喊「下一部」
  const last = renderStructureTable(computeStructure({ targetWords: 1_000_000, currentChapter: 280 })).join('\n');
  assert.match(last, /已是最后一部/);
  assert.ok(!last.includes('下一部自第'), '终部不该出现下一部');
});

test('渲染 · 告警行进表并带分级图标（🔴 是要处理的，ℹ️ 只是说明）', () => {
  const hot = renderStructureTable(computeStructure({ targetWords: 10_000_000 })).join('\n');
  assert.match(hot, /🔴 按 19 部拆分每部 151 章/);
  const info = renderStructureTable(computeStructure({ targetWords: 300_000 })).join('\n');
  assert.match(info, /ℹ️/);
  assert.ok(!info.includes('🔴'), '30 万字只有说明级提示，不该被标成待处理');
});

test('只算不存 · project.json 里不许出现 structure 字段（防第二份真相）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-structure-'));
  initProject(root, { title: '结构测试书', genre: '玄幻', targetWords: 1_000_000, targetChapters: 286 });
  const project = loadProject(root);
  assert.equal(project.structure, undefined, '结构参数必须是 targetWords 的纯函数，落盘就会过期');
  assert.equal(project.targetWords, 1_000_000);
  // 改目标字数后 status 立刻跟着变（2.1「中途改目标重算」的实现方式）
  assert.equal(projectStatus(root).stats.structureParts, 2);
  initProject(root, { targetWords: 3_000_000, targetChapters: 857 });
  assert.equal(projectStatus(root).stats.structureParts, 6);
});

test('状态层 · 默认三行摘要，structure=full 才出整张表，off 不带（省 token 的入口不许塞二十行）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-structure-status-'));
  initProject(root, { title: '状态书', genre: '都市', targetWords: 300_000, targetChapters: 86 });

  const lite = projectStatus(root);
  const liteText = lite.lines.join('\n');
  assert.match(liteText, /结构换算（提示词第二节，按目标字数现算）/);
  assert.match(liteText, /N=1 部/);
  assert.match(liteText, /1 部·约 86 章\/部｜2 卷·约 43 章\/卷/);
  assert.match(liteText, /大层级 5｜反派洋葱 3 层｜悬念账户 3 层（短\/卷\/部）/);
  assert.match(liteText, /弧光 1 段｜归档 0 次/);
  assert.ok(!liteText.includes('| 结构单元 |'), '默认不该铺整张表');
  assert.equal(lite.structureMode, 'summary');
  // 摘要压掉的是排版，不是判据：口径打架的 🔴 必须在
  const warnRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-structure-warn-'));
  initProject(warnRoot, { title: '打架书', genre: '都市', targetWords: 1_000_000, targetChapters: 400 });
  assert.match(projectStatus(warnRoot).lines.join('\n'), /🔴.*口径不一致/);

  const full = projectStatus(root, { structure: 'full' });
  const fullText = full.lines.join('\n');
  assert.match(fullText, /\| 结构单元 \| 换算结果 \| 依据 \|/);
  assert.match(fullText, /\| 悬念账户 \| 3 层/);
  assert.match(fullText, /体量结构换算（提示词第二节）/);

  for (const st of [lite, full]) {
    assert.equal(st.stats.structureParts, 1);
    assert.equal(st.stats.structureChapters, 86);
    assert.equal(st.stats.structureTiers, 5);
    assert.equal(st.stats.structureOnionLayers, 3);
    assert.equal(st.stats.structureSuspenseLayers, 3);
    assert.equal(st.stats.structureWarnings, 0);
  }

  const off = projectStatus(root, { structure: 'off' });
  assert.ok(!off.lines.join('\n').includes('结构换算'), 'off 要整块消失');
  assert.ok(off.lines.join('\n').includes('写作记忆'), '但其余状态行不许跟着丢');
  assert.equal(off.structure.parts.count, 1, 'off 只是不渲染，stats 仍在');

  assert.equal(projectStatus(root, { structure: 'huh' }).structureMode, 'summary', '非法取值退回默认，不许抛');

  // 表插在状态行之后、待办之前，位置错了会把待办挤出可读区
  assert.ok(liteText.indexOf('结构换算') > liteText.indexOf('写作记忆'), '结构块应在状态行后');
  assert.ok(liteText.indexOf('结构换算') < liteText.indexOf('待办：'), '结构块应在待办前');
});

test('状态层 · 未初始化目录不硬凑结构块', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-structure-empty-'));
  const status = projectStatus(dir);
  assert.ok(!status.lines.join('\n').includes('结构换算'), '没有项目就不假装知道体量');
});

test('工具层 · init 就把换算表交给作者（开书第一屏就该知道分几部）', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-structure-books-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: booksRoot }), footer: 'full' };
  const created = await applyTool('webnovel_init', {
    bookId: 'structbook', title: '长篇书', genre: '玄幻', logline: '一句话。', targetWords: 3_000_000, targetChapters: 857,
  }, config);
  assert.match(created, /已建好新书：structbook/);
  assert.match(created, /体量结构换算/);
  assert.match(created, /N=6 部/);
  assert.match(created, /大层级数 \| 10/);
  assert.match(created, /短\/卷\/部\/跨部\/全书/);
  assert.match(created, /归档 5 次/);

  const st = await applyTool('webnovel_status', { bookId: 'structbook' }, config);
  assert.match(st, /结构换算（提示词第二节，按目标字数现算）/);
  assert.match(st, /6 部·约 143 章\/部/);
  assert.match(st, /下一章：第 1 章/);
  assert.ok(!st.includes('| 结构单元 |'), 'status 默认只给摘要');
  assert.match(st, /structure=full/, '要指路怎么拿全表');

  const fullSt = await applyTool('webnovel_status', { bookId: 'structbook', structure: 'full' }, config);
  assert.match(fullSt, /\| 部 \| 6 部（约 143 章\/部/);
  const offSt = await applyTool('webnovel_status', { bookId: 'structbook', structure: 'off' }, config);
  assert.ok(!offSt.includes('结构换算'), 'off 时整块消失');
  assert.match(offSt, /已写 0 章/, '其余状态不受影响');
});

test('工具层 · 建书不传字数也出表，且默认 100 万字/400 章的口径打架要被点名', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-structure-default-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: booksRoot }), footer: 'full' };
  const created = await applyTool('webnovel_init', { bookId: 'defaultbook', title: '默认书', genre: '悬疑' }, config);
  assert.match(created, /N=2 部/);
  // 默认 100 万字 / 400 章是工具自己的缺省值——这条口径不自洽必须被指出来，别藏着
  const warnCount = computeStructure({ targetWords: 1_000_000, targetChapters: 400 })
    .notes.filter((n) => n.level === 'warn').length;
  assert.equal(warnCount >= 1, true, '默认章数与默认字数打架时，表里要有 🔴');
  assert.match(created, /🔴/);
});

test('配置 · WEBNOVEL_STRUCTURE 旋钮：默认 summary，full/off 都认，乱填退回默认', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-structure-env-'));
  assert.equal(loadConfig({ WEBNOVEL_ROOT: booksRoot }).structure, 'summary');
  assert.equal(loadConfig({ WEBNOVEL_STRUCTURE: 'full' }).structure, 'full');
  assert.equal(loadConfig({ WEBNOVEL_STRUCTURE: ' OFF ' }).structure, 'off');
  assert.equal(loadConfig({ WEBNOVEL_STRUCTURE: 'nonsense' }).structure, 'summary');

  // 环境变量要真能驱动工具输出（不是只被解析出来放着好看）
  const envConfig = { ...loadConfig({ WEBNOVEL_ROOT: booksRoot, WEBNOVEL_STRUCTURE: 'full' }), footer: 'full' };
  await applyTool('webnovel_init', { bookId: 'envbook', title: '旋钮书', genre: '玄幻', targetWords: 1_000_000, targetChapters: 286 }, envConfig);
  assert.match(await applyTool('webnovel_status', { bookId: 'envbook' }, envConfig), /\| 结构单元 \|/);
  const offConfig = { ...loadConfig({ WEBNOVEL_ROOT: booksRoot, WEBNOVEL_STRUCTURE: 'off' }), footer: 'full' };
  assert.ok(!(await applyTool('webnovel_status', { bookId: 'envbook' }, offConfig)).includes('结构换算'));
  // 显式传参优先于环境变量
  assert.match(await applyTool('webnovel_status', { bookId: 'envbook', structure: 'full' }, offConfig), /\| 结构单元 \|/);
});
