/**
 * 派生文档门禁：技能（skills/）与专家包（expert/）是同一个东西的两种形态，
 * 它们最容易在「加工具 / 改口径」时掉队——这份测试专门盯这种漂移。
 *
 * 三条不变量（都是真实踩过的）：
 *   ① 写死「N 个工具」时，N 必须与注册表对得上（1.7.0 加了 restore 后，专家包还写着「12 个」）；
 *   ② coach 两种形态都必须提到 `webnovel_restore`——换会话靠它，漏了就等于没这个入口；
 *   ③ 提到 `wm_*` 就必须同时提到 `.wm/`，否则读者会拿 wm 的工具去操作 `.webnovel/` 的书。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from '../mcp/tool-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

const docs = [
  ...walk(path.join(ROOT, 'skills')),
  ...walk(path.join(ROOT, 'expert')),
];

const WEB_NOVEL_COUNT = TOOL_NAMES.filter((n) => n.startsWith('webnovel_')).length;
const TOTAL_COUNT = TOOL_NAMES.length;

test('派生文档 · 扫描面非空（防「扫了个空目录」的假绿）', () => {
  assert.ok(docs.length >= 5, `只扫到 ${docs.length} 个文件`);
  assert.ok(docs.some((p) => p.includes(`${path.sep}skills${path.sep}`)), 'skills/ 不在扫描面里');
  assert.ok(docs.some((p) => p.includes(`${path.sep}expert${path.sep}`)), 'expert/ 不在扫描面里');
});

test('派生文档 · 写死「N 个工具」必须与注册表一致', () => {
  const bad = [];
  for (const file of docs) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(\d+)\s*个(?:本体)?工具/g)) {
      const n = Number(m[1]);
      // 允许两种口径：只数本体（13）或连套件一起数（26）；其它数字一律视为过期
      if (n !== WEB_NOVEL_COUNT && n !== TOTAL_COUNT) {
        bad.push(`${path.relative(ROOT, file)} → 「${m[0]}」（应为本体 ${WEB_NOVEL_COUNT} 或合计 ${TOTAL_COUNT}）`);
      }
    }
  }
  assert.deepEqual(bad, [], `派生文档里的工具数过期了：\n${bad.join('\n')}`);
});

test('派生文档 · coach 的两种形态都写了「接手用 webnovel_restore」', () => {
  const coaches = docs.filter((p) => /coach/i.test(p));
  assert.ok(coaches.length >= 2, `coach 文档应至少 2 份（技能 + 专家包），实际 ${coaches.length}`);
  for (const file of coaches) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /webnovel_restore/,
      `${path.relative(ROOT, file)} 没提 webnovel_restore——换会话/接手时就没有入口了`);
  }
});

test('派生文档 · 提到 wm_* 的文档必须同时说明账本在 .wm/', () => {
  for (const file of docs) {
    const text = readFileSync(file, 'utf8');
    if (!/wm_[a-z_]+/.test(text)) continue;
    assert.match(text, /\.wm\//,
      `${path.relative(ROOT, file)} 提了 wm_* 却没写账本在 .wm/，读者会拿它去操作 .webnovel/ 的书`);
  }
});
