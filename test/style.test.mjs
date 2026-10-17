/**
 * 文风漂移（15.6）测试（v1.4.0 未闭环清零 · 第 4 条）。
 *
 * 要证明的事：
 * 1. 同风格写到第 30 章不报警、不写报告；
 * 2. 第 30 章故意拉长句、砍对话 → commit 报警 + 写 style-ch0030.json，
 *    review 的 style 维度、status 的待办也都能看见；
 * 3. 基线可从正文重建（老书/人工重置）；
 * 4. 老书没有基线时，首次提交自动建；
 * 5. 阈值只在 STYLE_THRESHOLDS 定义一次（别的模块不许再抄一份数字）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { chapterFileName } from '../lib/core/paths.js';
import { commitChapter } from '../lib/features/commit.js';
import { reviewChapter } from '../lib/features/review.js';
import { projectStatus } from '../lib/features/status.js';
import { learnMemory, setStyleBaseline } from '../lib/features/memory.js';
import {
  STYLE_THRESHOLDS, STYLE_METRIC_KEYS, analyzeStyle, readStyleBaseline,
  rebuildStyleBaseline, styleBaselinePath,
} from '../lib/features/style.js';

function newProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-style-'));
  initProject(root, {
    title: '文风测试书',
    genre: '都市',
    logline: '文风一变，读者先感觉到。',
    targetWords: 100_000,
    targetChapters: 50,
  });
  return root;
}

function writeText(root, chapter, text) {
  const dir = path.join(root, '正文');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, chapterFileName(chapter, '测试')), text, 'utf8');
}

async function commit(root, chapter, text) {
  writeText(root, chapter, text);
  return commitChapter(root, {
    chapter,
    title: `第${chapter}章`,
    summary: `第 ${chapter} 章摘要`,
    strand: 'quest',
    force: true,
  });
}

/** 正常风格：短句 + 每段一句对话（对话占比约 20%）。 */
function normalText() {
  const paragraphs = [];
  for (let p = 0; p < 6; p += 1) {
    const sentences = [];
    for (let s = 0; s < 5; s += 1) {
      sentences.push(`雨点敲在窗棂上，他数到第${p * 5 + s}下，指节跟着轻轻一敲。`);
    }
    sentences.push(`“别数了，天亮之前得走，巷口那辆黑车已经停了半个时辰。”她压低声音说。`);
    paragraphs.push(sentences.join(''));
  }
  return paragraphs.join('\n\n');
}

/** 漂移风格：长句一逗到底 + 零对话 + 段落拉长。 */
function driftedText() {
  const paragraphs = [];
  for (let p = 0; p < 6; p += 1) {
    const sentences = [];
    for (let s = 0; s < 5; s += 1) {
      sentences.push(
        `他沿着潮湿的石阶缓慢地往下走去并在心里反复推演着刚才那场对峙里每一个人的每一个表情`
        + `以及每一句话背后可能隐藏着的第二层意思与第三种解释${p}${s}。`,
      );
    }
    paragraphs.push(sentences.join(''));
  }
  return paragraphs.join('\n\n');
}

function baselineFile(root) {
  return path.join(root, '.webnovel', 'style-baseline.json');
}

function reportFile(root, chapter) {
  return path.join(root, '.webnovel', 'reviews', `style-ch${String(chapter).padStart(4, '0')}.json`);
}

async function seedBaseline(root) {
  for (let ch = 1; ch <= 5; ch += 1) {
    await commit(root, ch, normalText());
  }
}

test('analyzeStyle：指标可算且与文本长度自洽', () => {
  const metrics = analyzeStyle(normalText());
  assert.ok(metrics.chars > 500);
  assert.ok(metrics.sentences >= 20);
  assert.ok(metrics.paragraphs >= 5);
  assert.ok(metrics.avgSentence > 0);
  assert.ok(metrics.sentenceSd > 0);
  assert.ok(metrics.dialogueRatio > 0.1);
  assert.ok(metrics.punctuationDensity > 0);

  const empty = analyzeStyle('');
  assert.equal(empty.chars, 0);
  assert.equal(empty.avgSentence, 0);
});

test('老书没有基线：首次提交自动建，前 5 章逐章并入样本', async () => {
  const root = newProject();
  assert.equal(readStyleBaseline(root), null);

  const first = await commit(root, 1, normalText());
  assert.equal(first.style.baselineCreated, true);
  assert.equal(first.style.baselineSource, 'auto');
  assert.ok(fs.existsSync(baselineFile(root)));
  assert.deepEqual(readStyleBaseline(root).sampleChapters, [1]);

  const second = await commit(root, 2, normalText());
  assert.equal(second.style.baselineSampled, true);
  assert.deepEqual(readStyleBaseline(root).sampleChapters, [1, 2]);
  assert.equal(readStyleBaseline(root).checkedAtChapter, 0);
});

test('同风格写到第 30 章：不报警、不写漂移报告', async () => {
  const root = newProject();
  await seedBaseline(root);

  const result = await commit(root, 30, normalText());
  assert.equal(result.style.checked, true);
  assert.equal(result.style.drifted, false);
  assert.equal(result.style.items.length, 0);
  assert.equal(fs.existsSync(reportFile(root, 30)), false);
  assert.ok(!result.warnings.some((w) => /文风漂移/.test(w)));
  // 检查过就拨闹钟，下一章不会重复检查
  assert.equal(readStyleBaseline(root).checkedAtChapter, 30);
});

test('第 30 章拉长句 + 砍对话：commit / review / status 三处都能看见', async () => {
  const root = newProject();
  await seedBaseline(root);

  // review 先看（只读，不拨闹钟）
  const reviewed = reviewChapter(root, 30, { text: driftedText() });
  const styleIssue = reviewed.issues.find((i) => i.dimension === 'style');
  assert.ok(styleIssue, `review 应报文风漂移：${JSON.stringify(reviewed.issues)}`);
  assert.match(styleIssue.message, /平均句长/);
  assert.match(styleIssue.message, /对话占比/);

  const result = await commit(root, 30, driftedText());
  assert.equal(result.style.checked, true);
  assert.equal(result.style.drifted, true);
  assert.ok(result.style.items.some((i) => i.metric === 'avgSentence'));
  assert.ok(result.style.items.some((i) => i.metric === 'dialogueRatio'));
  assert.ok(result.warnings.some((w) => /文风漂移/.test(w)));
  assert.ok(fs.existsSync(reportFile(root, 30)));

  const report = JSON.parse(fs.readFileSync(reportFile(root, 30), 'utf8'));
  assert.equal(report.kind, 'style-drift');
  assert.equal(report.chapter, 30);
  assert.equal(report.drifted, true);
  assert.equal(report.baseline.source, 'auto');

  const status = projectStatus(root);
  assert.ok(status.lines.some((l) => /文风漂移：第 30 章/.test(l)));
  assert.ok(status.todos.some((t) => /回拉文风/.test(t.action)));
  assert.equal(status.stats.styleDriftChapter, 30);
});

test('基线可从正文重建（老书升级 / 人工重置）', async () => {
  const root = newProject();
  // 不 commit，只落正文——模拟老书正文早就在、机器态里没有基线
  for (let ch = 1; ch <= 3; ch += 1) writeText(root, ch, normalText());

  const rebuilt = rebuildStyleBaseline(root, { sample: 3 });
  assert.deepEqual(rebuilt.sampledChapters, [1, 2, 3]);
  const baseline = readStyleBaseline(root);
  assert.equal(baseline.source, 'rebuild');
  assert.deepEqual(baseline.sampleChapters, [1, 2, 3]);
  assert.equal(baseline.calibratedAtChapter, 3);
  assert.ok(Math.abs(baseline.metrics.avgSentence - analyzeStyle(normalText()).avgSentence) < 0.01);
});

test('人工基准覆盖优先：memory 设定后 commit 不再自动采样', async () => {
  const root = newProject();
  const manual = await setStyleBaseline(root, {
    content: JSON.stringify({ avgSentence: 40, dialogueRatio: 0.4 }),
    chapter: 10,
    title: '作者指定的文风',
  });
  assert.equal(manual.kind, 'manual');
  assert.equal(manual.baseline.source, 'manual');
  assert.equal(manual.baseline.metrics.avgSentence, 40);
  assert.equal(manual.baseline.metrics.dialogueRatio, 0.4);
  assert.equal(manual.baseline.checkedAtChapter, 10);

  const committed = await commit(root, 11, normalText());
  assert.equal(committed.style.baselineSampled, false);
  const after = readStyleBaseline(root);
  assert.equal(after.source, 'manual');
  assert.equal(after.metrics.avgSentence, 40);
  assert.deepEqual(after.sampleChapters, []);

  // kind=style + style-baseline 标签：把记忆正文当基准，同样可覆盖
  for (let ch = 1; ch <= 3; ch += 1) writeText(root, ch, normalText());
  const learned = await learnMemory(root, {
    kind: 'style',
    title: '文风基准',
    content: 'auto',
    tags: ['style-baseline'],
  });
  assert.equal(learned.baseline.kind, 'rebuild');
  assert.equal(readStyleBaseline(root).source, 'rebuild');
  // 默认最多取 5 章：这里正文目录有 1/2/3/11 四章，全部进样本
  assert.deepEqual(readStyleBaseline(root).sampleChapters, [1, 2, 3, 11]);
});

test('阈值只在 STYLE_THRESHOLDS 定义一次（其他模块不许抄数字）', () => {
  const rootDir = path.resolve(import.meta.dirname, '..');
  const files = [
    'lib/features/commit.js',
    'lib/features/review.js',
    'lib/features/status.js',
    'lib/features/memory.js',
    'mcp/tools.mjs',
  ];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    assert.doesNotMatch(source, /limit\s*:\s*0\.\d+/, `${rel} 不应再定义一套阈值`);
  }
  // 指标键从阈值对象派生，改阈值对象就自动生效
  assert.deepEqual(STYLE_METRIC_KEYS, Object.keys(STYLE_THRESHOLDS.metrics));
  assert.equal(STYLE_METRIC_KEYS.length, 5);
  assert.equal(styleBaselinePath(rootDir).endsWith('style-baseline.json'), true);
});
