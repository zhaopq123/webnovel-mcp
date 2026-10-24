/**
 * 章级正文文件解析回归测试（1.8.2）。
 *
 * 旧行为：write_text 按标题新建文件，read/commit/doctor 却按 readdir 的第一个
 * 前缀命中取文件（NTFS 常按文件名排序）。改标题后再写，旧标题若排在前面，
 * 就会「写成功、读旧文、commit 字数按旧文」——看起来像服务端幻写/章级锁死。
 *
 * 这里锁死四条不变量：
 * 1. 同一章再次写入时覆盖已有文件，不再按新标题新增；
 * 2. 同章多个历史文件时，按 mtime 取最新，不按文件名顺序；
 * 3. commit 字数按最新正文统计；
 * 4. doctor 能报出同章多文件（warn），不再全绿掩盖写入健康问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../lib/core/project.js';
import { chapterFileName, findChapterFile, listChapterTextFiles } from '../lib/core/paths.js';
import { writeChapterText, readChapterText } from '../lib/features/outline.js';
import { commitChapter } from '../lib/features/commit.js';
import { doctorCheck } from '../lib/features/doctor.js';
import { countWords } from '../lib/util.js';

function newProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-chapter-text-'));
  initProject(root, {
    title: '正文写入回归测试书',
    genre: '悬疑',
    logline: '写进去的必须读得出来。',
    targetWords: 100_000,
    targetChapters: 50,
  });
  return root;
}

/** 手工造一个历史正文文件，并把 mtime 固定到指定秒。 */
function seedFile(root, name, text, secondsAgo) {
  const dir = path.join(root, '正文');
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, text, 'utf8');
  const t = Date.now() / 1000 - secondsAgo;
  fs.utimesSync(abs, t, t);
  return { abs, name };
}

test('改标题再写同一章：覆盖原文件，读回是新文', () => {
  const root = newProject();
  const oldText = '# 第十二章 安城旧事\n\n旧文旧文旧文\n';
  const newText = '# 第十二章 最长的夜\n\n新文新文新文\n';

  const first = writeChapterText(root, 12, '安城旧事', oldText);
  assert.equal(first.name, chapterFileName(12, '安城旧事'));
  assert.equal(first.verified, true);

  // 「安」在码点上排在「最」前面：旧实现的 readdir 首个命中会一直读到旧文。
  const second = writeChapterText(root, 12, '最长的夜', newText);
  assert.equal(second.name, first.name, '同章写入必须复用已有文件，不能按新标题另建');
  assert.equal(second.duplicates.length, 0);

  const files = listChapterTextFiles(root, 12);
  assert.equal(files.length, 1, '同章只应有一个正文文件');
  assert.equal(readChapterText(root, 12).text.trim(), newText.trim());
});

test('历史重复文件：按 mtime 取最新，不按文件名排序', () => {
  const root = newProject();
  const oldText = '# 第十二章 安城旧事\n\n旧文应被忽略\n';
  const newText = '# 第十二章 最长的夜\n\n新文必须胜出\n';
  seedFile(root, chapterFileName(12, '安城旧事'), oldText, 120);
  const newest = seedFile(root, chapterFileName(12, '最长的夜'), newText, 10);

  const files = listChapterTextFiles(root, 12);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, newest.name);
  assert.equal(findChapterFile(root, 12), newest.abs);

  const read = readChapterText(root, 12);
  assert.equal(read.name, newest.name);
  assert.equal(read.text.trim(), newText.trim());
  assert.deepEqual(read.duplicates, [chapterFileName(12, '安城旧事')]);
});

test('历史重复文件上再写：覆盖最新那份，旧文件保留并告警', () => {
  const root = newProject();
  const oldName = chapterFileName(12, '安城旧事');
  const midName = chapterFileName(12, '最长的夜');
  seedFile(root, oldName, '# 第十二章 安城旧事\n\n旧文\n', 120);
  seedFile(root, midName, '# 第十二章 最长的夜\n\n第二稿\n', 10);

  const third = '# 第十二章 第三稿\n\n第三稿正文\n';
  const r = writeChapterText(root, 12, '第三稿', third);
  assert.equal(r.name, midName, '应覆盖 mtime 最新的那一份，不再新增');
  assert.deepEqual(r.duplicates, [oldName]);
  assert.equal(readChapterText(root, 12).text.trim(), third.trim());
  assert.equal(listChapterTextFiles(root, 12).length, 2, '旧文件保留，由作者决定是否归档');
});

test('commit 字数按最新正文统计（不再按旧文）', async () => {
  const root = newProject();
  const oldText = `# 第一章 旧稿\n\n${'旧'.repeat(80)}\n`;
  const newText = `# 第一章 新稿\n\n${'新'.repeat(20)}\n`;
  seedFile(root, chapterFileName(1, '旧稿'), oldText, 120);
  const newest = seedFile(root, chapterFileName(1, '新稿'), newText, 10);

  const rec = await commitChapter(root, {
    chapter: 1,
    title: '第一章 新稿',
    summary: '主角推门进屋。',
    strand: 'quest',
    force: true,
    deltas: {},
  });
  assert.equal(rec.words, countWords(newText));
  assert.equal(findChapterFile(root, 1), newest.abs);
});

test('doctor 对同章多文件报 warn（不再全绿掩盖）', () => {
  const root = newProject();
  seedFile(root, chapterFileName(2, '旧标题'), '# 第二章 旧标题\n\n旧文\n', 120);
  seedFile(root, chapterFileName(2, '新标题'), '# 第二章 新标题\n\n新文\n', 10);

  const result = doctorCheck(root);
  const hit = result.issues.find((i) => i.code === 'text-duplicate');
  assert.ok(hit, '应报出 text-duplicate');
  assert.equal(hit.severity, 'warn');
  assert.match(hit.message, /第 2 章/);
});
