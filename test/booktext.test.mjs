/**
 * 批量正文能力回归：范围解析 / 导出 / 批量替换 / 版本历史 / 重复文件清理。
 * 全部在临时书项目里跑，不碰真实书库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTool, loadConfig } from '../mcp/tools.mjs';
import { parseChapterSpec, formatChapterSpec } from '../lib/core/chapter-range.js';
import { chapterFileName } from '../lib/core/paths.js';
import { writeChapterText, readChapterText, rollbackChapterText, readChapterHistory } from '../lib/features/outline.js';
import { exportBook, replaceAllInBook, pruneDuplicateTexts } from '../lib/features/booktext.js';
import { listVersions } from '../lib/features/history.js';
import { doctorCheck } from '../lib/features/doctor.js';

function newEnv() {
  const booksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-booktext-'));
  const config = loadConfig({ WEBNOVEL_ROOT: booksRoot, WEBNOVEL_TOKEN: '' });
  return { booksRoot, config, book: 'tools' };
}

function seedFile(root, name, text, secondsAgo) {
  const dir = path.join(root, '正文');
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, text, 'utf8');
  const t = Date.now() / 1000 - secondsAgo;
  fs.utimesSync(abs, t, t);
}

async function seedBook(env) {
  await applyTool('webnovel_init', {
    bookId: env.book, title: '批量测试', genre: '悬疑', targetWords: 100000, targetChapters: 20,
  }, env.config);
  const root = path.join(env.booksRoot, env.book);
  writeChapterText(root, 1, '旧标题一', '# 第一章 旧标题一\n\n他推开门，屋里只有一盏灯。\n');
  writeChapterText(root, 2, '旧标题二', '# 第二章 旧标题二\n\n她站在窗边，手里握着一封信。\n');
  writeChapterText(root, 3, '旧标题三', '# 第三章 旧标题三\n\n雨停了，街面反着光。\n');
  return root;
}

test('章节范围：区间、逗号、中文逗号混用', () => {
  assert.deepEqual(parseChapterSpec('1-3,5'), [1, 2, 3, 5]);
  assert.deepEqual(parseChapterSpec('3，1-2'), [1, 2, 3]);
  assert.equal(formatChapterSpec([1, 2, 3, 7, 9, 10]), '1-3,7,9-10');
  assert.equal(parseChapterSpec(''), null);
  assert.throws(() => parseChapterSpec('abc'), /无法识别章节范围/);
});

test('导出：txt / md / json 三格式与范围', async () => {
  const env = newEnv();
  const root = await seedBook(env);

  const txt = exportBook(root, { format: 'txt', range: [1, 3] });
  assert.equal(txt.chapters.length, 2);
  assert.match(txt.text, /第1章 旧标题一/);
  assert.match(txt.text, /第3章 旧标题三/);
  assert.doesNotMatch(txt.text, /第2章/);

  const md = exportBook(root, { format: 'md', range: [2] });
  assert.match(md.text, /^## 第 2 章 旧标题二/m);

  const json = exportBook(root, { format: 'json' });
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.chapters.length, 3);
  assert.equal(parsed.chapters[0].chapter, 1);
  assert.ok(parsed.chapters[0].file.startsWith('正文/'));
  assert.ok(parsed.chapters[0].mtime);
  assert.equal(typeof parsed.chapters[0].text, 'string');
});

test('批量替换：默认 dry-run 不改盘，执行后逐章回读', async () => {
  const env = newEnv();
  const root = await seedBook(env);

  const dry = replaceAllInBook(root, { find: '旧标题', replace: '新标题', range: [1, 2] });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.totalHits, 2);
  assert.match(readChapterText(root, 1).text, /旧标题一/);

  const run = replaceAllInBook(root, { find: '旧标题', replace: '新标题', range: [1, 2], dryRun: false });
  assert.equal(run.dryRun, false);
  assert.equal(run.totalHits, 2);
  assert.match(readChapterText(root, 1).text, /新标题一/);
  assert.match(readChapterText(root, 2).text, /新标题二/);
  assert.equal(listVersions(root, 1).length, 1, '覆盖前应存一版历史');

  // 整章被 find 命中且 replace 为空：拒绝，避免一键清空正文
  const whole = readChapterText(root, 1).text;
  assert.throws(
    () => replaceAllInBook(root, { find: whole, replace: '', range: [1], dryRun: false }),
    /替换后正文会变空/,
  );
});

test('版本历史：覆盖存旧稿、最多 5 版、可读可回滚', () => {
  const env = newEnv();
  const root = path.join(env.booksRoot, 'history');
  fs.mkdirSync(path.join(root, '正文'), { recursive: true });

  for (let i = 1; i <= 7; i += 1) {
    writeChapterText(root, 1, '标题', `# 第一章 标题\n\n第 ${i} 稿正文\n`);
  }
  const versions = listVersions(root, 1);
  assert.equal(versions.length, 5, '只保留最近 5 版');
  assert.match(readChapterText(root, 1).text, /第 7 稿/);

  // version 1 是最旧一版（第 2 稿：7 次写入只留最近 5 版，第 1 稿已滚掉）
  const v1 = readChapterHistory(root, 1, 1);
  assert.match(v1.text, /第 2 稿/);
  const rolled = rollbackChapterText(root, 1, 1);
  assert.equal(rolled.rolledBackTo, 1);
  assert.match(readChapterText(root, 1).text, /第 2 稿/);
  assert.match(rolled.history.name, /^v\d+-/, '回滚前的当前稿应入历史');
});

test('重复正文文件：prune 默认不动，confirm 后进 trash 并同步索引', async () => {
  const env = newEnv();
  const root = await seedBook(env);
  seedFile(root, chapterFileName(2, '更旧稿'), '# 第二章 更旧稿\n\n旧稿\n', 120);
  // seedBook 已经写过一份最新的；再造一份更旧的同章文件
  const { commitChapter } = await import('../lib/features/commit.js');
  await commitChapter(root, { chapter: 2, title: '旧标题二', summary: '占位', strand: 'quest', force: true, deltas: {} });

  const before = fs.readdirSync(path.join(root, '正文')).filter((n) => n.startsWith('第0002章')).length;
  assert.equal(before, 2);

  const dry = pruneDuplicateTexts(root, { confirm: false });
  const row = dry.chapters.find((c) => c.chapter === 2);
  assert.ok(row);
  assert.equal(dry.movedCount, 0);
  assert.equal(fs.readdirSync(path.join(root, '正文')).filter((n) => n.startsWith('第0002章')).length, 2);

  const run = pruneDuplicateTexts(root, { confirm: true });
  assert.ok(run.movedCount >= 1);
  const left = fs.readdirSync(path.join(root, '正文')).filter((n) => n.startsWith('第0002章'));
  assert.equal(left.length, 1);
  assert.equal(left[0], row.keep.name);
  assert.ok(fs.existsSync(path.join(root, run.trashDir)));
  const result = doctorCheck(root);
  assert.equal(result.issues.filter((i) => i.code === 'text-duplicate').length, 0);
});

test('read chapters 批量与来源文件头（走工具层）', async () => {
  const env = newEnv();
  await seedBook(env);
  const out = await applyTool('webnovel_outline', {
    bookId: env.book, action: 'read', scope: 'text', chapters: '1-2',
  }, env.config);
  assert.match(out, /## 第 1 章/);
  assert.match(out, /取自：第0001章/);
  assert.match(out, /mtime /);
  assert.match(out, /## 第 2 章/);
});

test('参数报错列出必填项（不再只说需要 text）', async () => {
  const env = newEnv();
  await seedBook(env);
  await assert.rejects(
    () => applyTool('webnovel_outline', { bookId: env.book, action: 'write_master' }, env.config),
    /write_master 缺少必填参数：text。必填：text/,
  );
  await assert.rejects(
    () => applyTool('webnovel_outline', { bookId: env.book, action: 'write_text', text: 'x' }, env.config),
    /必填：chapter \/ text/,
  );
});

test('导出与替换走工具层：export / replace_all dry-run', async () => {
  const env = newEnv();
  await seedBook(env);
  const exp = await applyTool('webnovel_outline', {
    bookId: env.book, action: 'export', format: 'txt', range: '1-2',
  }, env.config);
  assert.match(exp, /已导出 2 章/);

  const rep = await applyTool('webnovel_outline', {
    bookId: env.book, action: 'replace_all', find: '灯', replace: '烛', range: '1',
  }, env.config);
  assert.match(rep, /预览（未落盘）/);
  assert.match(rep, /命中 1 处/);
  assert.match(rep, /dry_run=false/);
});
