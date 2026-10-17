/**
 * 单元测试：存储层与路径守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertInside, findProjectRoot, isProjectRoot, chapterFileName,
  summaryFileName, commitFileName, volumeFileName, inside,
} from '../lib/core/paths.js';
import {
  writeJsonAtomic, readJson, readJsonMigrated, migrate, registerMigration,
  withProjectLock, writeTextAtomic, readText, exists, removeFile, copyTree,
} from '../lib/core/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-test-'));
}

/* ---------------- 路径守卫 ---------------- */

test('assertInside 允许项目内路径', () => {
  const root = tmpdir();
  const p = assertInside(root, path.join('正文', '第0001章.md'));
  assert.ok(p.startsWith(root));
});

test('assertInside 拒绝 ../ 逃逸', () => {
  const root = tmpdir();
  assert.throws(() => assertInside(root, path.join('..', '..', 'evil.txt')), /路径越界/);
});

test('assertInside 拒绝绝对路径逃逸', () => {
  const root = tmpdir();
  const outside = path.join(os.tmpdir(), 'definitely-outside.txt');
  assert.throws(() => assertInside(root, outside), /路径越界/);
});

test('inside 拼接并守卫', () => {
  const root = tmpdir();
  const p = inside(root, '正文', 'a.md');
  assert.equal(p, path.join(root, '正文', 'a.md'));
});

test('findProjectRoot 向上查找 .webnovel', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.webnovel'), { recursive: true });
  const deep = path.join(root, '正文', 'sub');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findProjectRoot(deep), root);
  assert.equal(isProjectRoot(root), true);
});

test('findProjectRoot 找不到返回 null', () => {
  const dir = tmpdir();
  assert.equal(findProjectRoot(dir), null);
});

test('findProjectRoot 显式 root 未初始化时返回 null', () => {
  const dir = tmpdir();
  assert.equal(findProjectRoot(dir, dir), null);
});

test('文件名构造', () => {
  assert.equal(chapterFileName(12, '拜入宗门'), '第0012章-拜入宗门.md');
  assert.equal(chapterFileName(12, ''), '第0012章.md');
  assert.equal(summaryFileName(12), 'ch0012.md');
  assert.equal(commitFileName(7), 'ch0007.json');
  assert.equal(volumeFileName(2), '第2卷.md');
});

/* ---------------- 原子写与读 ---------------- */

test('writeJsonAtomic / readJson 往返', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'a.json');
  writeJsonAtomic(file, { x: 1 });
  const { value, warnings } = readJson(file);
  assert.deepEqual(value, { x: 1 });
  assert.equal(warnings.length, 0);
  // 末尾换行（便于 git diff）
  assert.ok(readText(file).endsWith('\n'));
});

test('readJson 文件不存在返回 fallback 且无告警', () => {
  const dir = tmpdir();
  const { value, warnings } = readJson(path.join(dir, 'nope.json'), { d: 1 });
  assert.deepEqual(value, { d: 1 });
  assert.equal(warnings.length, 0);
});

test('readJson 损坏文件不崩溃、备份为 .corrupt 并告警', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ this is not json');
  const { value, warnings } = readJson(file, { ok: true });
  assert.deepEqual(value, { ok: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /损坏/);
  assert.ok(fs.existsSync(`${file}.corrupt`), '应生成 .corrupt 备份');
});

test('writeTextAtomic 无残留 .tmp 文件', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'a.txt');
  writeTextAtomic(file, 'hello');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.equal(leftovers.length, 0);
});

test('exists / removeFile', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'x.txt');
  writeTextAtomic(file, 'x');
  assert.equal(exists(file), true);
  assert.equal(removeFile(file), true);
  assert.equal(exists(file), false);
  assert.equal(removeFile(file), false); // 幂等
});

/* ---------------- schema 迁移 ---------------- */

test('migrate 补齐 schemaVersion', () => {
  const out = migrate({ a: 1 }, 1, 'test');
  assert.equal(out.schemaVersion, 1);
});

test('migrate 拒绝更高版本（保护用户数据）', () => {
  assert.throws(() => migrate({ schemaVersion: 99 }, 1, 'test'), /高于本插件支持/);
});

test('migrate 逐级升级', () => {
  registerMigration(1, (data) => ({ ...data, added: true }));
  const out = migrate({ schemaVersion: 1, a: 1 }, 2, 'test');
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.added, true);
});

test('readJsonMigrated 端到端', () => {
  const dir = tmpdir();
  const file = path.join(dir, 's.json');
  writeJsonAtomic(file, { schemaVersion: 1, v: 'x' });
  const { value } = readJsonMigrated(file, null, 's.json');
  assert.equal(value.v, 'x');
  assert.equal(value.schemaVersion, 1);
});

/* ---------------- 并发锁 ---------------- */

test('withProjectLock 串行执行（同 key 不并发）', async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.webnovel'), { recursive: true });
  const order = [];
  const task = (id, ms) => withProjectLock(dir, async () => {
    order.push(`start-${id}`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`end-${id}`);
  });
  await Promise.all([task('a', 30), task('b', 5)]);
  // 严格串行：a 完全结束后 b 才开始
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b']);
});

test('withProjectLock 异常也能释放锁', async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.webnovel'), { recursive: true });
  await assert.rejects(withProjectLock(dir, async () => { throw new Error('boom'); }), /boom/);
  // 锁已释放，后续任务能拿到
  const result = await withProjectLock(dir, async () => 'ok');
  assert.equal(result, 'ok');
});

test('withProjectLock 清理锁文件', async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.webnovel'), { recursive: true });
  await withProjectLock(dir, async () => {});
  assert.equal(fs.existsSync(path.join(dir, '.webnovel', '.lock')), false);
});

/* ---------------- copyTree（备份用目录拷贝） ---------------- */

test('copyTree 递归拷贝并把同名文件计成覆盖（备份重复名不会抛）', () => {
  const base = tmpdir();
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  fs.mkdirSync(path.join(src, '子', '孙'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'A');
  fs.writeFileSync(path.join(src, '子', 'b.md'), 'B');
  fs.writeFileSync(path.join(src, '子', '孙', 'c.md'), 'C');
  assert.equal(copyTree(src, dst), 3, '应报告拷贝了 3 个文件');
  assert.equal(fs.readFileSync(path.join(dst, '子', '孙', 'c.md'), 'utf8'), 'C');

  // 重跑 = 覆盖，不报错（备份目录带时间戳，但同名文件仍可能撞）
  fs.writeFileSync(path.join(src, 'a.md'), 'A2');
  assert.equal(copyTree(src, dst), 3);
  assert.equal(fs.readFileSync(path.join(dst, 'a.md'), 'utf8'), 'A2');
});

test('copyTree 源目录不存在时静默返回 0（check 是只读的，不该因为没东西可备而炸）', () => {
  const base = tmpdir();
  assert.equal(copyTree(path.join(base, '不存在'), path.join(base, 'dst')), 0);
  assert.equal(fs.existsSync(path.join(base, 'dst')), false, '不该建出半空目录');
});

test('copyTree 扛得住中文路径 —— 这条就是它存在的全部理由', () => {
  // 回归：fs.cpSync(recursive) 在 Windows + 非 ASCII 源路径上会把进程直接打挂
  // （Node 22.23.3 实测 __fastfail，try/catch 拦不住）。doctor 重建的备份用它，
  // 而书目录就放在中文工作区里 —— 恢复动作崩在恢复动作上，代价最大。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wnw-备份中文-'));
  const src = path.join(base, '摘要目录');
  fs.mkdirSync(path.join(src, '内层'), { recursive: true });
  fs.writeFileSync(path.join(src, 'ch0001.md'), '# 第一章\n');
  fs.writeFileSync(path.join(src, '内层', 'ch0002.md'), '# 第二章\n');
  const dst = path.join(base, '备份', 'summaries');
  assert.equal(copyTree(src, dst), 2);
  assert.equal(fs.readFileSync(path.join(dst, '内层', 'ch0002.md'), 'utf8'), '# 第二章\n');
  fs.rmSync(base, { recursive: true, force: true });
});
