/**
 * 端到端测试：模拟一位作者用这个插件写完一章的完整闭环。
 *
 * 覆盖 PRD 的核心用户路径：
 *   建项目 → 定总纲/卷纲/章纲 → 取任务书 → 写正文 → 自审 → 提交 → 查询 → 节奏
 *
 * 全程使用真实文件系统（独立临时目录），不触碰任何真实项目。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { findProjectRoot, assertInside } from '../lib/core/paths.js';
import { readState, readIndex, readForeshadowing, readMemory, findChapter } from '../lib/core/state.js';
import { buildWritingBrief } from '../lib/features/context.js';
import { writeChapterOutline, writeVolumeOutline, writeMasterOutline, writeChapterText } from '../lib/features/outline.js';
import { commitChapter, listCommits, readCommit } from '../lib/features/commit.js';
import { analyzePacing, renderPacingMarkdown } from '../lib/features/pacing.js';
import { reviewChapter } from '../lib/features/review.js';
import { learnMemory, recallMemory } from '../lib/features/memory.js';
import { projectStatus, compactStatusLine } from '../lib/features/status.js';
import { runQuery } from '../lib/features/query.js';
import { applyTool } from '../mcp/tools.mjs';
import { countWords } from '../lib/util.js';

/* ------------------------------------------------------------------ *
 * 测试夹具
 * ------------------------------------------------------------------ */

function newProject(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-e2e-'));
  initProject(root, {
    title: '听物',
    genre: '都市异能',
    genreTags: ['都市', '异能'],
    logline: '一个能听见物品记忆的少年，在旧城改造中揭开母亲失踪的真相。',
    targetWords: 1_000_000,
    targetChapters: 400,
    ...overrides,
  });
  return root;
}

/** 一段足够长的正文，用于字数与审查测试。 */
const SAMPLE_TEXT = `# 第一章 旧宅

林越推开那扇锈迹斑斑的铁门时，指尖传来一阵细密的震颤。

不是风。是这扇门在说话。

"三十七年了。"他低声重复着门传来的那句话，喉咙发紧。母亲最后一次推开它，是三十七年前的冬天。

屋里的空气凝成了固体。灰尘在午后的光柱里翻滚，像无数细小的虫。

他蹲下身，手掌贴上地面。冰凉的水泥底下，有什么东西在低鸣——是那个铁盒子。母亲把它埋在这里的时候，他还只有四岁。

"别怕。"他对自己说。

可他怕。他怕打开它，也怕打不开它。

铁盒锈得厉害，边缘几乎和泥土长在了一起。林越用指甲抠了十几分钟，指腹磨破了，血渗出来，滴在铁皮上。

就在血接触到铁盒的瞬间，一道声音炸开在他脑子里——

"越越，如果你听到这个，说明妈妈已经不在了。"

他猛地缩回手，撞翻了身后的木凳。

那句话还在继续，是母亲的声音，很轻，很平静，像在哄一个睡不着的小孩。可内容却让他浑身发冷。

"盒子里有半张地图。另外半张，在你父亲手里。找到他之前，谁都不要相信。"

林越盯着那个铁盒，很久没有说话。

窗外的天色暗下来了。巷子里传来收废品的吆喝声，一声长，一声短，像某种暗号。

他终于伸出手，把盒子抱进了怀里。

"妈。"他说，"我去找他。"`;

/* ------------------------------------------------------------------ *
 * 1. 建项目
 * ------------------------------------------------------------------ */

test('E2E · 建项目：骨架完整且可重复执行', () => {
  const root = newProject();

  for (const dir of ['设定集', '大纲', '正文', '.webnovel', '大纲/卷纲', '大纲/章纲', '.webnovel/commits', '.webnovel/summaries']) {
    assert.ok(fs.existsSync(path.join(root, dir)), `应创建目录 ${dir}`);
  }
  for (const file of ['设定集/世界观.md', '设定集/力量体系.md', '设定集/主角卡.md', '设定集/金手指.md', '大纲/总纲.md', '大纲/卷纲/第1卷.md']) {
    assert.ok(fs.existsSync(path.join(root, file)), `应创建文件 ${file}`);
  }
  assert.ok(fs.readFileSync(path.join(root, '大纲/总纲.md'), 'utf8').includes('听物'), '总纲应含书名');

  // 幂等 + 不覆盖用户内容
  fs.writeFileSync(path.join(root, '设定集/世界观.md'), '# 我手写的世界观\n重要设定');
  const again = initProject(root, { title: '听物' });
  assert.equal(again.existed, true);
  assert.equal(
    fs.readFileSync(path.join(root, '设定集/世界观.md'), 'utf8'),
    '# 我手写的世界观\n重要设定',
    '重复 init 绝不能覆盖用户已写内容',
  );
});

test('E2E · 重复 init：机器态与已写记忆原样保留，显式传值才更新元信息', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, summary: 's1', strand: 'quest', wordCount: 100,
    deltas: { protagonist: { name: '林越' }, foreshadowing: { planted: [{ name: '玉佩' }] } },
  });
  await learnMemory(root, { kind: 'style', title: '短句', content: '打斗用短句。' });
  const before = JSON.parse(fs.readFileSync(path.join(root, '.webnovel/project.json'), 'utf8'));

  const again = initProject(root, {});
  assert.equal(again.existed, true);
  assert.equal(readState(root).value.progress.currentChapter, 1, '进度不许被重置');
  assert.equal(readState(root).value.protagonist.name, '林越', '状态卡不许被清空');
  assert.equal(readIndex(root).value.chapters.length, 1, '索引不许被清空');
  assert.equal(readForeshadowing(root).value.items.length, 1, '伏笔台账不许被清空');
  assert.equal(readMemory(root).value.entries.length, 1, '写作记忆不许被清空');
  const after = JSON.parse(fs.readFileSync(path.join(root, '.webnovel/project.json'), 'utf8'));
  assert.equal(after.title, before.title, '没传 title 不许改名');
  assert.equal(after.createdAt, before.createdAt, 'createdAt 不许被重置');

  const renamed = initProject(root, { title: '新名字' });
  assert.equal(renamed.meta.title, '新名字', '显式传的新值应生效');
  assert.equal(readIndex(root).value.chapters.length, 1, '改名也不许碰机器态');
});

/* ------------------------------------------------------------------ *
 * 2. 护栏：没有章纲不许裸写
 * ------------------------------------------------------------------ */

test('E2E · 护栏：缺章纲时任务书给出 blocker', () => {
  const root = newProject();
  const brief = buildWritingBrief(root, 1);
  assert.equal(brief.blockers.length, 1);
  assert.match(brief.blockers[0], /还没有章纲/);
  assert.match(brief.markdown, /⛔ 动笔前必须先解决/);
});

/* ------------------------------------------------------------------ *
 * 3. 完整闭环
 * ------------------------------------------------------------------ */

test('E2E · 完整闭环：定纲 → 任务书 → 写 → 审 → 提交 → 查询', async () => {
  const root = newProject();

  // --- 定总纲与卷纲 ---
  writeMasterOutline(root, '# 总纲\n\n少年听物寻母。');
  const vol = writeVolumeOutline(root, 1, '# 第一卷 旧城\n\n起承转合…', { title: '旧城', chapterRange: '1-100' });
  assert.equal(vol.volume, 1);

  // --- 定章纲 ---
  writeChapterOutline(root, 1, [
    '# 第一章 旧宅',
    '',
    '- 场景：老城区旧宅，黄昏',
    '- 关键事件：林越推开铁门，听见门的记忆；挖出母亲埋下的铁盒',
    '- 揭示：母亲失踪、半张地图、父亲的存在',
    '- 章末钩子：决定去找父亲',
  ].join('\n'));

  // --- 取任务书（此时不该再有 blocker）---
  const brief = buildWritingBrief(root, 1);
  assert.equal(brief.blockers.length, 0, `不应有 blocker，实际：${brief.blockers.join(';')}`);
  assert.ok(brief.brief.chapterOutline, '任务书应含章纲');
  assert.match(brief.markdown, /大纲即法律/);
  assert.match(brief.markdown, /硬约束/);

  // --- 保存正文 ---
  const saved = writeChapterText(root, 1, '旧宅', SAMPLE_TEXT);
  assert.ok(saved.path.startsWith('正文/'));
  assert.ok(countWords(SAMPLE_TEXT) > 300, `样例正文应足够长，实际 ${countWords(SAMPLE_TEXT)}`);

  // --- 审查 ---
  const review = reviewChapter(root, 1);
  assert.equal(review.chapter, 1);
  assert.ok(review.words > 300);
  assert.ok(Array.isArray(review.issues));
  assert.match(review.markdown, /审查报告/);

  // --- 提交 ---
  const committed = await commitChapter(root, {
    chapter: 1,
    title: '旧宅',
    summary: '林越在旧宅听见门的记忆，挖出母亲埋下的铁盒，得知半张地图与父亲的存在，决定出发寻找。',
    strand: 'quest',
    hook: { type: '悬念钩', strength: 'strong' },
    ending: { time: '傍晚', location: '旧宅' },
    deltas: {
      protagonist: { name: '林越', location: '老城区旧宅', power: { realm: '凡人' }, condition: '指腹擦伤' },
      world: { locations: ['老城区', '旧宅'], factions: ['未知势力'] },
      timeline: { time: '傍晚', location: '旧宅', event: '发现母亲留下的铁盒与半张地图' },
      foreshadowing: {
        planted: [
          { name: '母亲留下的铁盒', plannedPayoff: 30, importance: 'high', note: '含半张地图' },
          { name: '另外半张地图在父亲手里', plannedPayoff: 80, importance: 'high' },
        ],
      },
    },
  });

  assert.equal(committed.chapter, 1);
  assert.equal(committed.words, countWords(SAMPLE_TEXT));
  assert.equal(committed.planted.length, 2);
  assert.deepEqual(listCommits(root), [1]);

  // --- 落盘校验：状态/索引/伏笔/摘要/提交记录 ---
  const { value: state } = readState(root);
  assert.equal(state.progress.currentChapter, 1);
  assert.equal(state.protagonist.name, '林越');
  assert.equal(state.protagonist.location, '老城区旧宅');
  assert.equal(state.protagonist.condition, '指腹擦伤');
  assert.equal(state.strand.lastQuest, 1);
  assert.ok(state.world.locations.includes('旧宅'));
  assert.equal(state.timeline.length, 1);

  const { value: index } = readIndex(root);
  const entry = findChapter(index, 1);
  assert.equal(entry.title, '旧宅');
  assert.equal(entry.strand, 'quest');
  assert.equal(entry.hook.type, '悬念钩');
  assert.ok(entry.summary.includes('铁盒'));

  const { value: ledger } = readForeshadowing(root);
  assert.equal(ledger.items.length, 2);
  assert.ok(ledger.items.every((i) => i.status === 'open'));

  assert.ok(fs.existsSync(path.join(root, '.webnovel/summaries/ch0001.md')), '应写摘要');
  assert.ok(fs.existsSync(path.join(root, '.webnovel/commits/ch0001.json')), '应写提交记录');
  const commitFile = readCommit(root, 1);
  assert.equal(commitFile.chapter, 1);
  assert.ok(commitFile.deltas.protagonist, '提交记录应保留原始增量（可审计）');

  // --- 提交幂等 ---
  await commitChapter(root, { chapter: 1, title: '旧宅', summary: '改过的摘要', strand: 'quest' });
  const { value: index2 } = readIndex(root);
  assert.equal(index2.chapters.length, 1, '重复提交不应产生重复条目');
  assert.equal(findChapter(index2, 1).summary, '改过的摘要', '应覆盖为最新');
});

/* ------------------------------------------------------------------ *
 * 4. 防遗忘：状态延续到下一章
 * ------------------------------------------------------------------ */

test('E2E · 防遗忘：第 2 章任务书带上第 1 章的状态与伏笔', async () => {
  const root = newProject();
  writeChapterOutline(root, 1, '# 第一章\n- 事件：发现铁盒');
  writeChapterText(root, 1, '旧宅', SAMPLE_TEXT);
  await commitChapter(root, {
    chapter: 1,
    title: '旧宅',
    summary: '发现铁盒，得知半张地图。',
    strand: 'quest',
    deltas: {
      protagonist: { name: '林越', location: '旧宅', condition: '右臂骨裂，短期内无法用力' },
      foreshadowing: { planted: [{ name: '母亲留下的铁盒', plannedPayoff: 30, importance: 'high' }] },
    },
  });

  writeChapterOutline(root, 2, '# 第二章 出发\n- 事件：林越离开旧宅');
  const brief = buildWritingBrief(root, 2);

  assert.equal(brief.blockers.length, 0);
  // 主角状态必须延续
  assert.equal(brief.brief.protagonist.condition, '右臂骨裂，短期内无法用力');
  assert.match(brief.markdown, /右臂骨裂/);
  assert.match(brief.markdown, /写作时务必延续此状态/);
  // 前情必须带上
  assert.equal(brief.brief.previous.length, 1);
  assert.match(brief.markdown, /发现铁盒/);
  // 伏笔必须在场
  assert.equal(brief.brief.openForeshadowing.length, 1);
  assert.match(brief.markdown, /母亲留下的铁盒/);
});

/* ------------------------------------------------------------------ *
 * 5. 审查抓出真实的状态冲突（PRD 场景 A）
 * ------------------------------------------------------------------ */

test('E2E · 审查：抓出「断手还握剑」的状态冲突', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1,
    title: '受伤',
    summary: '主角右臂被废。',
    strand: 'quest',
    deltas: { protagonist: { name: '林越', condition: '右臂经脉尽废，无法持物' } },
    force: true,
  });
  writeChapterOutline(root, 2, '# 第二章\n- 事件：战斗');

  const badText = '林越双手握剑，剑势如虹，一招劈开了对方的防御。他的右手稳稳地压住剑柄，纹丝不动。';
  const review = reviewChapter(root, 2, { text: badText });

  const conflict = review.issues.find((i) => i.dimension === 'consistency' && i.severity === 'error');
  assert.ok(conflict, `应抓出状态冲突，实际问题：${JSON.stringify(review.issues)}`);
  assert.match(conflict.message, /状态冲突/);
  assert.ok(conflict.evidence, '应给出原文证据');
  assert.equal(review.passed, false, '有 error 时不应通过');
});

test('E2E · 任务书：卷标不重复（第 1 卷 第一卷 / 第 1 卷 第一卷 旧城）', () => {
  const root = newProject();
  writeChapterOutline(root, 1, '# 第一章\n- 场景：旧宅');
  const brief = buildWritingBrief(root, 1);
  assert.match(brief.markdown, /当前卷：第 1 卷（1-100）/, '空卷名时不该重复');

  // 作者把卷名写成「第一卷 旧城」时也要去掉重复前缀
  const { value: state } = readState(root);
  state.progress.volumes = [{ volume: 1, title: '第一卷 旧城', chapterRange: '1-100', status: 'writing' }];
  fs.writeFileSync(path.join(root, '.webnovel', 'state.json'), JSON.stringify(state, null, 2));
  const brief2 = buildWritingBrief(root, 1);
  assert.match(brief2.markdown, /当前卷：第 1 卷旧城（1-100）/, `实际：${brief2.markdown.split('\n').find((l) => l.includes('当前卷'))}`);
  assert.ok(!/第 1 卷 第/.test(brief2.markdown), '不允许出现「第 1 卷 第…」');
});

test('E2E · 提交容错：字段被塞进 deltas 时自动提回顶层并回提醒', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-hoist-'));
  const config = { booksRoot, token: '', port: 0, bind: '127.0.0.1', maxBody: 1 << 20 };
  await applyTool('webnovel_init', { bookId: 'h', title: '容错' }, config);
  // 故意把 summary/strand/hook/ending 塞进 deltas（模型常犯），并塞一个不认的字段
  const text = await applyTool('webnovel_commit', {
    bookId: 'h',
    chapter: 1,
    deltas: {
      summary: '本章摘要被放错位置。',
      strand: 'quest',
      hook: { type: '悬念钩', strength: 'strong' },
      ending: { time: '夜', location: '旧宅' },
      protagonist: { name: '林越', location: '旧宅' },
      bogusField: '不该被接收',
    },
    force: true,
  }, config);

  assert.match(text, /参数位置提醒/, '应回提醒');
  assert.match(text, /`summary` 属于顶层参数/, '应指出 summary 放错位置');
  assert.match(text, /`strand` 属于顶层参数/, '应指出 strand 放错位置');
  assert.match(text, /bogusField/, '应点名不认的字段');

  const idx = JSON.parse(fs.readFileSync(path.join(booksRoot, 'h', '.webnovel', 'index.json'), 'utf8'));
  const entry = idx.chapters.find((c) => c.chapter === 1);
  assert.equal(entry.strand, 'quest', 'strand 必须真的落到索引里（旧实现会静默丢）');
  assert.match(entry.summary, /放错位置/, 'summary 必须真的落库');
  assert.equal(entry.hook.type, '悬念钩');
  const state = JSON.parse(fs.readFileSync(path.join(booksRoot, 'h', '.webnovel', 'state.json'), 'utf8'));
  assert.equal(state.strand.lastQuest, 1, '节奏统计要认到这条线别');
});

test('E2E · 提交容错：角色首次出场章号自动填', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-first-'));
  const config = { booksRoot, token: '', port: 0, bind: '127.0.0.1', maxBody: 1 << 20 };
  await applyTool('webnovel_init', { bookId: 'f', title: '首次出场' }, config);
  await applyTool('webnovel_commit', {
    bookId: 'f', chapter: 3, summary: '苏晚登场。', strand: 'fire', force: true,
    deltas: { characters: [{ name: '苏晚', patch: { role: '女主', relation: '同门' } }] },
  }, config);
  const state = JSON.parse(fs.readFileSync(path.join(booksRoot, 'f', '.webnovel', 'state.json'), 'utf8'));
  assert.equal(state.characters['苏晚'].firstChapter, 3, 'firstChapter 应自动填本章号');
  assert.equal(state.characters['苏晚'].lastChapter, 3, 'lastChapter 应自动填本章号');
  const card = await applyTool('webnovel_query', { bookId: 'f', kind: 'character', name: '苏晚' }, config);
  assert.match(card, /首次出场：第 3 章/, '角色卡应显示首次出场');
  assert.match(card, /同门/, '关系应显示');

  // 第 5 章再次出场：firstChapter 保持 3，lastChapter 变 5
  await applyTool('webnovel_commit', {
    bookId: 'f', chapter: 5, summary: '苏晚再现。', strand: 'fire', force: true,
    deltas: { characters: [{ name: '苏晚', patch: { location: '青云宗' } }] },
  }, config);
  const state2 = JSON.parse(fs.readFileSync(path.join(booksRoot, 'f', '.webnovel', 'state.json'), 'utf8'));
  assert.equal(state2.characters['苏晚'].firstChapter, 3, 'firstChapter 不该被覆盖');
  assert.equal(state2.characters['苏晚'].lastChapter, 5, 'lastChapter 应更新为最近出场');
});

test('E2E · 书名带《》不会被套成《《甲》》', async () => {
  const root = newProject();
  fs.rmSync(path.join(root, '.webnovel'), { recursive: true, force: true });
  initProject(root, { title: '《听物》', genre: '都市异能' });
  const status = projectStatus(root);
  assert.equal(status.lines[0].split('，')[0], '《听物》已写 0 章 / 0 字');
  assert.ok(!status.lines[0].startsWith('《《'), '不应出现双重书名号');
  assert.ok(compactStatusLine(root).startsWith('《听物》'), 'compactStatusLine 同样不能双重包裹');
});

test('E2E · 工具层：webnovel_books 一行一本书，不带重复书名', async () => {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-bookslist-'));
  const config = { booksRoot, token: '', port: 0, bind: '127.0.0.1', maxBody: 1 << 20 };
  await applyTool('webnovel_init', { bookId: 'jia', title: '《甲》' }, config);
  await applyTool('webnovel_init', { bookId: 'yi', title: '乙' }, config);
  await applyTool('webnovel_commit', { chapter: 1, title: '一', summary: 's', strand: 'quest', force: true,
    bookId: 'jia', deltas: { foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 1 }] } } }, config);
  await applyTool('webnovel_commit', { chapter: 2, title: '二', summary: 's', strand: 'quest', force: true,
    bookId: 'jia', deltas: { foreshadowing: { paid: ['玉佩'] } } }, config);

  const text = await applyTool('webnovel_books', {}, config);
  const rows = text.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(rows.length, 2, '应有两本书，每行一本');
  const jia = rows.find((r) => r.includes('jia'));
  assert.ok(jia, '应有 jia 这一行');
  assert.match(jia, /《甲》\s*已写 2 章/, '应显示书名与已提交章数');
  assert.ok(!/《《/.test(text), '不该出现双重书名号');
  assert.ok(!jia.includes('《甲》《甲》'), '书名只该出现一次');
  assert.match(rows.find((r) => r.includes('yi')), /《乙》\s*已写 0 章/, '没提交过的书写 0 章');
});

test('E2E · 审查：骨裂/骨折/无法用力 这类常见伤情也能抓到冲突', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1,
    title: '受伤',
    summary: '主角右臂骨裂。',
    strand: 'quest',
    deltas: { protagonist: { name: '林越', condition: '右臂骨裂，短期内无法用力' } },
    force: true,
  });
  writeChapterOutline(root, 2, '# 第二章\n- 事件：交手');
  const bad = '林越双手握剑，剑势如虹。他的右手稳稳压住剑柄。';
  const review = reviewChapter(root, 2, { text: bad });
  const conflict = review.issues.find((i) => i.dimension === 'consistency' && i.severity === 'error');
  assert.ok(conflict, `「右臂骨裂」应能识别为伤情，实际问题：${JSON.stringify(review.issues)}`);
  assert.match(conflict.message, /状态冲突/);

  // 没有伤情时不许误报
  const root2 = newProject();
  const review2 = reviewChapter(root2, 1, { text: bad });
  assert.equal(
    review2.issues.find((i) => i.dimension === 'consistency' && i.severity === 'error'), undefined,
    '没有状态记录时不应报状态冲突',
  );
});

test('E2E · 审查：状态一致时不误报', () => {
  const root = newProject();
  const okText = '林越左手扶着墙，慢慢站起来。他的右臂垂在身侧，一点力气也使不上。';
  const review = reviewChapter(root, 1, { text: okText });
  const conflict = review.issues.find((i) => i.dimension === 'consistency' && i.severity === 'error');
  assert.equal(conflict, undefined, '状态一致时不应报 error');
});

test('E2E · 任务书：章节编号必须连续（省略区块不留空号）', () => {
  const root = newProject();
  writeChapterOutline(root, 1, '# 第一章\n- 场景：旧宅');
  const brief = buildWritingBrief(root, 1);
  const heads = brief.markdown.split('\n').filter((l) => l.startsWith('## '));
  const nums = heads.map((h) => h.replace(/^##\s*/, '').split('、')[0]);
  const expected = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  assert.deepEqual(
    nums, expected.slice(0, heads.length),
    `编号应连续，实际：${nums.join(' / ')}（标题：${heads.join(' | ')}）`,
  );
});

test('E2E · 任务书：区块齐全时编号也连续', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, title: 'A', summary: '前情摘要', strand: 'quest',
    deltas: {
      protagonist: { name: '林越', location: '旧宅' },
      characters: [{ name: '苏晚', patch: { role: '女主', lastChapter: 1 } }],
      timeline: { time: '傍晚', location: '旧宅', event: '发现铁盒' },
      foreshadowing: { planted: [{ name: '铁盒', plannedPayoff: 30 }] },
    },
    force: true,
  });
  await learnMemory(root, { kind: 'style', title: '短句', content: '用短句。' });
  writeChapterOutline(root, 2, '# 第二章\n- 场景：旧宅');
  const brief = buildWritingBrief(root, 2);
  const heads = brief.markdown.split('\n').filter((l) => l.startsWith('## '));
  const nums = heads.map((h) => h.replace(/^##\s*/, '').split('、')[0]);
  const expected = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  assert.deepEqual(nums, expected.slice(0, heads.length), `编号应连续，实际：${nums.join(' / ')}`);
  assert.ok(heads.length >= 8, `区块齐全时应有足够多区块，实际 ${heads.length}`);
});

test('E2E · 审查：结构性小标题不被当成应出现在正文的要素', () => {
  const root = newProject();
  // 章纲只用了「场景：/ 关键事件：/ 揭示：/ 章末钩子：」这类结构性标签
  writeChapterOutline(root, 1, [
    '# 第一章 旧宅', '',
    '- 场景：老城区旧宅，黄昏',
    '- 关键事件：林越推开铁门，听见门的记忆；挖出母亲埋下的铁盒',
    '- 揭示：母亲失踪、半张地图、父亲的存在',
    '- 章末钩子：决定去找父亲',
  ].join('\n'));

  // 正文确实写了大纲里的实质要素（铁门、铁盒、母亲），只是不含「场景」「揭示」这些标签
  const review = reviewChapter(root, 1, { text: SAMPLE_TEXT });
  const outlineIssues = review.issues.filter((i) => i.dimension === 'outline' && i.severity === 'warning');
  assert.equal(
    outlineIssues.length, 0,
    '结构性标签（场景/揭示/章末钩子）不该被当成正文里必须出现的要素，实际误报：'
    + JSON.stringify(outlineIssues),
  );
});

test('E2E · 审查：真的漏掉章纲要素时会告警', () => {
  const root = newProject();
  writeChapterOutline(root, 1, '# 第一章\n- 场景：「青云宗」禁地「剑冢」');
  // 正文完全没提这两个地名
  const text = '林越走在集市上，买了二斤猪肉，回家做了顿饭。夜色渐深，他吹灭油灯睡下。';
  const review = reviewChapter(root, 1, { text });
  assert.ok(
    review.issues.some((i) => i.dimension === 'outline' && /青云宗|剑冢/.test(i.message)),
    `真的漏掉要素应告警，实际 issues：${JSON.stringify(review.issues)}`,
  );
});

test('E2E · 审查：章末缺钩子会告警', () => {
  const root = newProject();
  const flat = '林越走进了房间。他坐下。他喝了口水。然后他睡了一觉。天亮了，他起床，洗脸，吃饭，出门上班，一天就这样过去了，很平静，没有什么特别的事情发生，一切都很好，所有人都很满意，故事就这样平稳地继续着，没有任何波澜。';
  const review = reviewChapter(root, 1, { text: flat });
  assert.ok(review.issues.some((i) => i.dimension === 'reader-pull'), '应提示章末缺钩子');
});

test('E2E · 审查：指认/揭示类收尾也算钩子，不该误报「缺钩子」', () => {
  const root = newProject();
  // 真实写作里最常见的一种悬念收尾：末尾抛出一个「原来是他」式的指认。
  // 这类句子没有问号感叹号，旧词表判不出来，会误报。
  const text = '林越盯着那张剪报。人群最后面站着个年轻人，个子很高，穿着一件旧夹克。他半小时前刚见过。';
  const review = reviewChapter(root, 1, { text });
  assert.ok(
    !review.issues.some((i) => i.dimension === 'reader-pull' && /章末缺少钩子/.test(i.message)),
    `「他半小时前刚见过」是标准悬念收尾，不该报缺钩子。实际 issues：${JSON.stringify(review.issues)}`,
  );
});

test('E2E · 审查：不再拿「钩子类型名」去误判「开头没承接」', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1,
    title: '第一章',
    summary: '深夜有人上门。',
    strand: 'quest',
    force: true,
    hook: { type: '危机钩', strength: 'strong' },
    ending: { time: '当晚', location: '出租屋' },
  });
  // 旧实现会把「危机钩」的「危机」二字拿去正文开头找，必然找不到 → 每章都误报。
  const review = reviewChapter(root, 2, { text: '门外的声音很稳，不像喝醉的人。林越没立刻开。' });
  assert.ok(
    !review.issues.some((i) => /本章开头似乎没有承接/.test(i.message)),
    `不该拿钩子类型名匹配正文。实际：${JSON.stringify(review.issues.map((i) => i.message))}`,
  );
});

test('E2E · 审查：正文疑似埋伏笔、台账为空时提醒登记', () => {
  const root = newProject();
  const text = '他在墙缝里埋下那个铁盒，谁也没告诉。这东西日后会有用。';
  const review = reviewChapter(root, 1, { text });
  assert.ok(
    review.issues.some((i) => /疑似埋下伏笔/.test(i.message)),
    `正文埋了伏笔但台账为空，应提醒登记。实际：${JSON.stringify(review.issues.map((i) => i.message))}`,
  );
});

test('E2E · 任务书：计划本章回收的伏笔说「本章应回收」，不是「已超期」', async () => {
  const root = newProject();
  writeChapterOutline(root, 1, '# 第一章\n- 事件：埋下玉佩');
  await commitChapter(root, {
    chapter: 1,
    title: '第一章',
    summary: '埋下玉佩。',
    strand: 'quest',
    force: true,
    deltas: { foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 4, importance: 'high' }] } },
  });

  // 写第 4 章时，计划第 4 章回收的伏笔正是「本章该收」——章还没写，不能叫超期
  const brief4 = buildWritingBrief(root, 4);
  assert.match(brief4.markdown, /本章应回收/, `实际：${brief4.markdown.split('\n').find((l) => l.includes('玉佩'))}`);
  assert.ok(!/已超期/.test(brief4.markdown), '写第 4 章时不该说「已超期」');

  // 拖到第 5 章才叫超期
  const brief5 = buildWritingBrief(root, 5);
  assert.match(brief5.markdown, /已超期 1 章/, '写第 5 章时计划第 4 章回收 = 超期 1 章');
});

/* ------------------------------------------------------------------ *
 * 6. 节奏
 * ------------------------------------------------------------------ */

test('E2E · 节奏：从未出现过的线显示「未出现」，不写「N 章前」', async () => {
  const root = newProject();
  for (let c = 1; c <= 3; c += 1) {
    await commitChapter(root, {
      chapter: c, title: `第${c}章`, summary: `第 ${c} 章摘要`, strand: 'quest', force: true,
    });
  }
  const report = analyzePacing(root);
  assert.equal(report.lastSeen.fire, null, '感情线从未出现');
  assert.equal(report.lastSeen.quest, 3, '主线最后出现在第 3 章');

  const md = renderPacingMarkdown(report);
  // 只看表格行：告警里也会提到「感情线」，用 includes 会先抓到告警那句。
  const fireRow = md.split('\n').find((l) => l.startsWith('|') && l.includes('感情线'));
  assert.match(fireRow, /未出现/, `从未出现应写「未出现」。实际：${fireRow}`);
});

test('E2E · 节奏：从未出现的线告警措辞是「从未出现」', async () => {
  const root = newProject();
  for (let c = 1; c <= 12; c += 1) {
    await commitChapter(root, {
      chapter: c, title: `第${c}章`, summary: `第 ${c} 章摘要`, strand: 'quest', force: true,
    });
  }
  const report = analyzePacing(root);
  const fireAlert = report.alerts.find((a) => a.strand === 'fire');
  assert.ok(fireAlert, '感情线从未出现且已写 12 章，应告警');
  assert.match(fireAlert.message, /从未出现/, `实际：${fireAlert.message}`);
});

test('E2E · 节奏：感情线断档超过红线时告警', async () => {
  const root = newProject();
  // 感情线红线是 10 章；写 12 章纯主线必然触发
  for (let c = 1; c <= 12; c += 1) {
    await commitChapter(root, {
      chapter: c,
      title: `第${c}章`,
      summary: `第 ${c} 章摘要`,
      strand: 'quest',
      force: true,
    });
  }
  const report = analyzePacing(root);
  assert.equal(report.counts.quest, 12);
  assert.equal(report.gaps.quest, 0, '主线刚写过，断档为 0');
  assert.ok(report.gaps.fire >= 12, '感情线应显示断档');
  assert.ok(report.alerts.some((a) => a.strand === 'fire'), `应告警感情线断档，实际：${JSON.stringify(report.alerts)}`);
  assert.equal(report.ratios.quest, 1);
  assert.equal(report.healthy, false, '有 error 级告警时 healthy 应为 false');
});

test('E2E · 节奏：8 章纯主线不触发红线（红线是 10 章）', async () => {
  const root = newProject();
  for (let c = 1; c <= 8; c += 1) {
    await commitChapter(root, { chapter: c, title: `第${c}章`, summary: 's', strand: 'quest', force: true });
  }
  const report = analyzePacing(root);
  assert.equal(
    report.alerts.filter((a) => a.strand === 'fire' && a.level !== 'info').length, 0,
    '未超过 10 章红线时不应告警感情线断档',
  );
});

test('E2E · 节奏：三线轮转时无告警', async () => {
  const root = newProject();
  const pattern = ['quest', 'fire', 'constellation', 'quest', 'fire', 'constellation', 'quest', 'fire'];
  for (let i = 0; i < pattern.length; i += 1) {
    await commitChapter(root, {
      chapter: i + 1, title: `第${i + 1}章`, summary: 's', strand: pattern[i], force: true,
    });
  }
  const report = analyzePacing(root);
  assert.equal(report.alerts.filter((a) => a.level === 'error').length, 0, '轮转不应有 error 级告警');
  assert.ok(report.ratios.fire > 0.2, '感情线占比应达标');
});

/* ------------------------------------------------------------------ *
 * 7. 伏笔生命周期
 * ------------------------------------------------------------------ */

test('E2E · 伏笔：埋下 → 到期告警 → 回收', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1,
    title: '埋',
    summary: '埋下玉佩伏笔。',
    strand: 'quest',
    deltas: { foreshadowing: { planted: [{ name: '母亲留下的玉佩', plannedPayoff: 3, importance: 'high' }] } },
    force: true,
  });

  // 到第 5 章仍未回收 → 超期
  await commitChapter(root, { chapter: 5, title: '第五章', summary: 's', strand: 'quest', force: true });
  const overdue = runQuery(root, 'foreshadowing');
  assert.equal(overdue.overdue, 1);
  assert.match(overdue.lines.join('\n'), /已到期未回收/);

  // 回收
  const result = await commitChapter(root, {
    chapter: 6,
    title: '回收',
    summary: '玉佩揭示真相。',
    strand: 'quest',
    deltas: { foreshadowing: { paid: ['母亲留下的玉佩'] } },
    force: true,
  });
  assert.deepEqual(result.paid, ['母亲留下的玉佩']);
  assert.equal(runQuery(root, 'foreshadowing').overdue, 0, '回收后不应再告警');
});

test('E2E · 伏笔：回收不存在的伏笔会告警而非崩溃', async () => {
  const root = newProject();
  const result = await commitChapter(root, {
    chapter: 1, title: 'X', summary: 's', strand: 'quest',
    deltas: { foreshadowing: { paid: ['并不存在的伏笔'] } },
    force: true,
  });
  assert.ok(result.warnings.some((w) => w.includes('不在台账中')));
});

/* ------------------------------------------------------------------ *
 * 8. 长期记忆
 * ------------------------------------------------------------------ */

test('E2E · 记忆：沉淀后进入下一章的任务书', async () => {
  const root = newProject();
  await learnMemory(root, { kind: 'style', title: '打斗用短句', content: '动作场面用 8-15 字短句。', tags: ['打斗'], chapter: 1 });
  writeChapterOutline(root, 2, '# 第二章');

  const brief = buildWritingBrief(root, 2);
  assert.equal(brief.brief.memory.length, 1);
  assert.match(brief.markdown, /已沉淀的写作经验/);
  assert.match(brief.markdown, /打斗用短句/);

  const recalled = recallMemory(root, { query: '短句' });
  assert.equal(recalled.hits.length, 1);
});

test('E2E · 记忆：非法类型与缺字段被拒绝', async () => {
  const root = newProject();
  await assert.rejects(learnMemory(root, { kind: 'bogus', title: 't', content: 'c' }), /未知的记忆类型/);
  await assert.rejects(learnMemory(root, { kind: 'style', title: '', content: 'c' }), /需要 title/);
  await assert.rejects(learnMemory(root, { kind: 'style', title: 't', content: '' }), /需要 content/);
});

/* ------------------------------------------------------------------ *
 * 9. 查询
 * ------------------------------------------------------------------ */

test('E2E · 查询：角色卡', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 3, title: '相遇', summary: '苏晚登场。', strand: 'fire',
    deltas: { characters: [{ name: '苏晚', patch: { role: '女主', realm: '筑基一层', location: '青云宗', firstChapter: 3, lastChapter: 3 } }] },
    force: true,
  });
  const single = runQuery(root, 'character', { name: '苏晚' });
  assert.equal(single.found, true);
  assert.match(single.lines.join('\n'), /女主/);
  assert.match(single.lines.join('\n'), /筑基一层/);

  const missing = runQuery(root, 'character', { name: '不存在的人' });
  assert.equal(missing.found, false);

  const all = runQuery(root, 'character', {});
  assert.equal(all.items.length, 1);
});

test('E2E · 查询：主角能被查到（主角存在 protagonist 而非 characters）', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, title: '登场', summary: '林越登场。', strand: 'quest',
    deltas: {
      protagonist: {
        name: '林越', location: '旧宅',
        power: { realm: '炼气一层', bottleneck: '经脉未通' },
        condition: '右臂骨裂',
        goldenFinger: { name: '听物', level: 2 },
      },
    },
    force: true,
  });

  // 直接问主角
  const hero = runQuery(root, 'character', { name: '林越' });
  assert.equal(hero.found, true, '主角必须能按名字查到');
  assert.equal(hero.character.role, '主角');
  assert.match(hero.lines.join('\n'), /炼气一层/);
  assert.match(hero.lines.join('\n'), /右臂骨裂/, '应带出身体状态');
  assert.match(hero.lines.join('\n'), /听物/, '应带出金手指');

  // 列全部时主角排最前
  await commitChapter(root, {
    chapter: 2, title: '相遇', summary: '苏晚登场。', strand: 'fire',
    deltas: { characters: [{ name: '苏晚', patch: { role: '女主', lastChapter: 2 } }] },
    force: true,
  });
  const all = runQuery(root, 'character', {});
  assert.equal(all.items.length, 2);
  assert.equal(all.items[0].name, '林越', '主角应排最前');

  // 查不到时给出主角名作为提示
  const missing = runQuery(root, 'character', { name: '查无此人' });
  assert.equal(missing.found, false);
  assert.match(missing.lines.join('\n'), /林越/, '应提示当前主角是谁');
});

test('E2E · 查询：全文检索命中正文', () => {
  const root = newProject();
  writeChapterText(root, 1, '旧宅', SAMPLE_TEXT);
  const hit = runQuery(root, 'search', { query: '半张地图' });
  assert.ok(hit.total > 0, '应检索到正文中的关键词');
  assert.match(hit.lines.join('\n'), /正文/);
});

test('E2E · 查询：未知 kind 报可读错误', () => {
  const root = newProject();
  assert.throws(() => runQuery(root, 'bogus', {}), /未知的查询类型/);
});

/* ------------------------------------------------------------------ *
 * 10. 状态与待办
 * ------------------------------------------------------------------ */

test('E2E · 状态：未提交正文会进待办', async () => {
  const root = newProject();
  writeChapterText(root, 1, '旧宅', SAMPLE_TEXT); // 写了但没提交
  const status = projectStatus(root);
  assert.deepEqual(status.stats.uncommitted, [1]);
  assert.ok(status.todos.some((t) => t.action.includes('提交第 1 章')), '应提示提交');
});

test('E2E · 状态：到期伏笔会进待办', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, title: 'A', summary: 's', strand: 'quest',
    deltas: { foreshadowing: { planted: [{ name: '玉佩', plannedPayoff: 2 }] } },
    force: true,
  });
  await commitChapter(root, { chapter: 5, title: 'B', summary: 's', strand: 'quest', force: true });
  const status = projectStatus(root);
  assert.ok(status.todos.some((t) => t.action.includes('回收到期伏笔')), '应提示回收伏笔');
});

test('E2E · 状态：compactStatusLine 供系统提示使用', async () => {
  const root = newProject();
  await commitChapter(root, {
    chapter: 1, title: '旧宅', summary: 's', strand: 'quest',
    deltas: { protagonist: { name: '林越', power: { realm: '炼气一层' } } },
    force: true,
  });
  const line = compactStatusLine(root);
  assert.ok(line.includes('听物'));
  assert.ok(line.includes('林越'));
  assert.ok(line.includes('炼气一层'));
});

test('E2E · 状态：空项目不注入提示（返回 null）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-empty-'));
  assert.equal(compactStatusLine(dir), null);
});

/* ------------------------------------------------------------------ *
 * 11. 数据安全
 * ------------------------------------------------------------------ */

test('E2E · 安全：章节标题里的路径穿越被净化（不逃逸出项目）', () => {
  const root = newProject();
  // 标题里的 ../ 与斜杠被 sanitizeFilename 去掉，落点仍在 正文/ 内。
  const saved = writeChapterText(root, 1, '../../evil', 'x');
  const abs = path.join(root, saved.path);
  assert.ok(abs.startsWith(path.join(root, '正文')), `必须落在 正文/ 内，实际 ${abs}`);
  assert.equal(fs.existsSync(path.join(root, '..', '..', 'evil.md')), false, '不应在项目外产生文件');
});

test('E2E · 安全：越界的写入路径被硬拒绝', async () => {
  const root = newProject();
  const { assertInside } = await import('../lib/core/paths.js');
  assert.throws(() => assertInside(root, path.join('..', '..', 'evil.md')), /路径越界/);
  assert.throws(() => assertInside(root, path.resolve(os.tmpdir(), 'outside.md')), /路径越界/);
});

test('E2E · 安全：损坏的状态文件不导致崩溃', () => {
  const root = newProject();
  fs.writeFileSync(path.join(root, '.webnovel/state.json'), '{ broken json');
  const { value, warnings } = readState(root);
  assert.equal(value.progress.currentChapter, 0, '应降级为默认值');
  assert.equal(warnings.length, 1);
  assert.ok(fs.existsSync(path.join(root, '.webnovel/state.json.corrupt')), '应备份坏文件');
});

test('E2E · 安全：提交需要有效章节号', async () => {
  const root = newProject();
  await assert.rejects(commitChapter(root, { chapter: 0 }), /有效的 chapter/);
  await assert.rejects(commitChapter(root, { chapter: 'abc' }), /有效的 chapter/);
});

test('E2E · 安全：未初始化目录提交时报可读错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-uninit-'));
  await assert.rejects(commitChapter(dir, { chapter: 1 }), /不是一个已初始化的书项目/);
});

/* ------------------------------------------------------------------ *
 * 12. 项目自动发现（workspace 里放一本书的情况）
 * ------------------------------------------------------------------ */

test('E2E · 定位：从工作区根能发现子目录里的书项目', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-ws-'));
  const novel = path.join(workspace, '我的小说-听物');
  initProject(novel, { title: '听物' });

  // 工作区根不是项目，但子目录是
  assert.equal(findProjectRoot(workspace), novel, '应自动发现子目录里的唯一项目');
});

test('E2E · 定位：工作区自身是项目时优先用自己', () => {
  const root = newProject();
  const sub = path.join(root, '正文');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(findProjectRoot(sub), root, '向上查找应先命中自己所在的项目');
});

test('E2E · 定位：项目自身也是工作区根', () => {
  const root = newProject();
  assert.equal(findProjectRoot(root), root);
});

test('E2E · 定位：多个子项目取最近修改的', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-multi-'));
  const a = path.join(workspace, '书A');
  const b = path.join(workspace, '书B');
  initProject(a, { title: 'A' });
  // 确保 B 的 .webnovel 更晚
  await new Promise((r) => setTimeout(r, 20));
  initProject(b, { title: 'B' });
  assert.equal(findProjectRoot(workspace), b, '歧义时应取最近修改的那个');
});

test('E2E · 定位：工具层按 bookId 直接定位书项目', async () => {
  const root = newProject();
  const config = { booksRoot: path.dirname(root), token: '', port: 0, bind: '127.0.0.1', maxBody: 1024 * 1024 };
  const text = await applyTool('webnovel_status', { bookId: path.basename(root) }, config);
  assert.match(text, /听物/, '指定 bookId 后应读到该书');
});

test('E2E · 定位：找不到项目时报可读错误', async () => {
  const config = {
    booksRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-notsure-')),
    token: '', port: 0, bind: '127.0.0.1', maxBody: 1024 * 1024,
  };
  await assert.rejects(
    () => applyTool('webnovel_status', { bookId: 'nope' }, config),
    (err) => {
      assert.match(err.message, /还不是书项目|没有找到|还没有任何书/);
      assert.match(err.message, /webnovel_init/, '应提示可用 init 补救');
      return true;
    },
  );
});

test('E2E · 节奏：开局三章全是主线时就该警告，不等 20 章', async () => {
  const root = newProject();
  for (let c = 1; c <= 3; c += 1) {
    await commitChapter(root, { chapter: c, title: `第${c}章`, summary: `第 ${c} 章摘要`, strand: 'quest', force: true });
  }
  const report = analyzePacing(root);
  const skew = report.alerts.find((a) => a.level === 'warning');
  assert.ok(skew, `三章同线、另两线从未出现，必须出告警（旧版这里报「无明显节奏问题」）。实际：${JSON.stringify(report.alerts)}`);
  assert.match(skew.message, /从未出现/);
  assert.doesNotMatch(renderPacingMarkdown(report), /无明显节奏问题/, '有告警时不许再印绿灯标题');
});

test('E2E · 审查：单章字数不足本书章均目标七成时要拦', () => {
  const root = newProject(); // 100 万字 / 400 章 → 章均 2500
  // 「林越握住门框。」= 6 汉字 + 1 标点 = 7 字；200 遍 = 1400 字，低于 2500×0.7=1750。
  const thin = '林越握住门框。'.repeat(200) + '可他真正想问的是，那个人究竟是谁。';
  const review = reviewChapter(root, 1, { text: thin });
  assert.ok(review.words < 1750, `构造用例本身要够短，实际 ${review.words} 字`);
  assert.ok(
    review.issues.some((i) => /不足本书章均目标/.test(i.message)),
    `1400 字对 2500 字章均必须报短章。实际：${JSON.stringify(review.issues.map((i) => i.message))}`,
  );

  // 320 遍 = 2240 字，已过七成线，不该再报。
  const ok = '林越握住门框。'.repeat(320) + '可他真正想问的是，那个人究竟是谁。';
  const fine = reviewChapter(root, 2, { text: ok });
  assert.ok(!fine.issues.some((i) => /不足本书章均目标/.test(i.message)), `达标章节不该被报短。实际 ${fine.words} 字`);
});

test('E2E · 审查：场景没切换时不再误报「开头没交代地点」', async () => {
  const root = newProject();
  const body = '门外的声音很稳，不像喝醉的人。林越把门拉开一条缝，走廊里坏了一盏灯。';
  await commitChapter(root, { chapter: 1, title: '第一章', summary: '深夜有人上门。', strand: 'quest', force: true, ending: { time: '当晚', location: '出租屋' } });
  await commitChapter(root, { chapter: 2, title: '第二章', summary: '门外来人。', strand: 'quest', force: true, ending: { time: '当晚', location: '出租屋' } });
  const same = reviewChapter(root, 2, { text: body });
  assert.ok(!same.issues.some((i) => i.dimension === 'continuity'), `同一场戏接着演，不该要求开头交代地点。实际：${JSON.stringify(same.issues.map((i) => i.message))}`);

  // 真换了地方才提醒。
  await commitChapter(root, { chapter: 3, title: '第三章', summary: '去了厂房。', strand: 'quest', force: true, ending: { time: '次日', location: '废弃厂房' } });
  const moved = reviewChapter(root, 3, { text: body });
  assert.ok(moved.issues.some((i) => i.dimension === 'continuity' && /上一章结束于/.test(i.message)), '场景确实切换时应提醒交代');
});
