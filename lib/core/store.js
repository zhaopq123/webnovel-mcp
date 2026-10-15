/**
 * 存储层：原子读写 + 并发互斥 + schema 版本迁移。
 *
 * 三条保证：
 * 1. 原子写：先写 .tmp 再 rename，崩溃不会留下半个 JSON。
 * 2. 不丢数据：JSON 解析失败不崩溃，坏文件另存 .corrupt 并告警。
 * 3. 并发安全：同进程按项目根排队；跨进程用锁文件（尽力而为）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, FILES } from './paths.js';

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 同进程互斥：按 key 串行执行临界区
 * ------------------------------------------------------------------ */
const tails = new Map();

export async function withLock(key, fn) {
  const prev = tails.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate, () => gate);
  tails.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
  }
}

/* ------------------------------------------------------------------ *
 * 跨进程锁文件（尽力而为：失败不阻塞主流程）
 * ------------------------------------------------------------------ */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireFileLock(root) {
  const lockPath = path.join(root, FILES.lock);
  const deadline = Date.now() + LOCK_WAIT_MS;
  ensureDir(path.dirname(lockPath));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lockPath); } catch { /* 已被清理 */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') return () => {};
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* 锁刚被释放，重试 */ }
      if (Date.now() > deadline) return () => {};
      sleepSync(LOCK_POLL_MS);
    }
  }
}

/**
 * 临界区：同进程串行 + 跨进程锁文件。
 * fn 内部应使用同步 IO，保证锁的有效性。
 */
export async function withProjectLock(root, fn) {
  return withLock(`project:${root}`, async () => {
    const release = acquireFileLock(root);
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 原子读写
 * ------------------------------------------------------------------ */
function tmpNameFor(filePath) {
  return `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
}

/** 原子写文本：tmp → rename。返回写入的字节数。 */
export function writeTextAtomic(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tmp = tmpNameFor(filePath);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw err;
  }
  return Buffer.byteLength(text, 'utf8');
}

/** 原子写 JSON（2 空格缩进 + 末尾换行，便于 git diff 与人工阅读）。 */
export function writeJsonAtomic(filePath, value) {
  return writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** 读文本；不存在返回 null。 */
export function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 读 JSON。返回 { value, warnings }。
 * - 文件不存在 → fallback（无告警）
 * - 解析失败 → 备份为 .corrupt，返回 fallback + 告警
 */
export function readJson(filePath, fallback = null) {
  const raw = readText(filePath);
  if (raw === null) return { value: fallback, warnings: [] };
  if (raw.trim().length === 0) return { value: fallback, warnings: [`${path.basename(filePath)} 为空，已按默认值处理`] };
  try {
    return { value: JSON.parse(raw), warnings: [] };
  } catch (err) {
    const warnings = [`${path.basename(filePath)} 内容损坏（${err.message}），已备份为 .corrupt 并按默认值继续`];
    try {
      fs.renameSync(filePath, `${filePath}.corrupt`);
    } catch { /* 备份失败不影响继续 */ }
    return { value: fallback, warnings };
  }
}

/* ------------------------------------------------------------------ *
 * schema 版本与迁移
 * ------------------------------------------------------------------ */
const migrations = new Map();

/** 注册迁移：from 版本 → 升到 from+1 的变换。 */
export function registerMigration(from, fn) {
  migrations.set(from, fn);
}

/**
 * 把数据升到目标版本。
 * 未知的更高版本 → 抛错（保护用户数据，绝不降级覆盖）。
 */
export function migrate(data, targetVersion = SCHEMA_VERSION, label = 'data') {
  if (!data || typeof data !== 'object') return data;
  let current = Number.isInteger(data.schemaVersion) ? data.schemaVersion : 0;
  if (current > targetVersion) {
    throw new Error(
      `${label} 的 schemaVersion=${current} 高于本插件支持的 ${targetVersion}；`
      + '请升级 dsh-webnovel-writer 后再打开此项目（已拒绝写入以避免损坏数据）',
    );
  }
  let value = data;
  while (current < targetVersion) {
    const step = migrations.get(current);
    if (step) value = step(value);
    current += 1;
    value.schemaVersion = current;
  }
  return value;
}

/** 读 + 迁移 + 校验，一步到位。 */
export function readJsonMigrated(filePath, fallback, label) {
  const { value, warnings } = readJson(filePath, fallback);
  if (value === null) return { value: fallback, warnings };
  return { value: migrate(value, SCHEMA_VERSION, label ?? path.basename(filePath)), warnings };
}

/** 文件是否存在。 */
export function exists(filePath) {
  try {
    fs.existsSync(filePath);
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** 删除文件（不存在不报错）。 */
export function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 文件大小（字节）；不存在返回 0。 */
export function sizeOf(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
