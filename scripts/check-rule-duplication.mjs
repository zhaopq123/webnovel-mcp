#!/usr/bin/env node
/**
 * 规则正文重复扫描：证明「提示词原文只存一份」这条设计没有被破坏。
 *
 * 背景：整合前规则文本已经分散在三处（专家包 agents/*.md、mcp/skills-src.mjs 的提示词、
 * lib/features/context.js 的 HARD_RULES）。再抄一份原文进去 = 第四份副本 = 必然漂移。
 * 本脚本把原文的整行拿去找跨文件命中，命中即红。
 *
 * 用法：
 *   node scripts/check-rule-duplication.mjs            # 报告，命中则 exit 1
 *   node scripts/check-rule-duplication.mjs --json     # 机器可读
 *   node scripts/check-rule-duplication.mjs --selftest # 注入一份副本，证明能变红
 *
 * 判定口径（写在这里，别让读代码的人猜）：
 * - 参与比对的行：原文里 trim 后长度 ≥ MIN_LEN（默认 20）的非标题、非表格分隔行；
 *   短行（如「- 时间线：」）到处都可能出现，拿来判重只有噪音。
 * - 豁免目录/文件：prompt/（原文与派生物本身）、books/、logs/、.git、node_modules、
 *   test-artifacts；以及白名单里的「指路行」——只允许引用切片号，不允许引用正文。
 * - 本脚本自身豁免：它内嵌了 selftest 用的样例文本。
 */
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REL = 'prompt/CREATIVE-PROMPT.md';
const MIN_LEN = 20;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'books', 'logs', 'test-artifacts', 'prompt', 'scripts']);
const SKIP_FILES = new Set(['README.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', '.gitattributes']);
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.txt', '.yaml', '.yml']);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !rel.startsWith('prompt/')) yield* walk(full);
    } else if (entry.isFile() && TEXT_EXT.has(path.extname(entry.name)) && !SKIP_FILES.has(entry.name)) {
      yield rel;
    }
  }
}

/** 从原文取出参与判重的行集合。 */
export function promptLines(markdown, { minLen = MIN_LEN } = {}) {
  const set = new Map();
  markdown.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.length < minLen) return;
    if (/^#{1,4}\s/.test(t)) return;
    if (/^\|[-\s|:]+\|$/.test(t)) return;
    if (t.startsWith('```')) return;
    set.set(t, i + 1);
  });
  return set;
}

export function scanDup({ root = ROOT } = {}) {
  const source = readFileSync(path.join(root, SOURCE_REL), 'utf8');
  const lines = promptLines(source);
  const hits = [];
  const files = [...walk(root)];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    const stolen = [];
    for (const [line, srcLine] of lines) {
      if (text.includes(line)) stolen.push({ line, srcLine });
    }
    if (stolen.length) hits.push({ rel, count: stolen.length, sample: stolen.slice(0, 3) });
  }
  return { scanned: files.length, pool: lines.size, hits };
}

function selftest() {
  const source = readFileSync(path.join(ROOT, SOURCE_REL), 'utf8');
  const lines = promptLines(source);
  const probe = [...lines.keys()][10];
  const clean = scanDup();
  // 判据必须能红：把一条原文整行塞进临时副本文件，必须被扫出来。
  const trap = path.join(ROOT, 'lib', '.dup-trap.tmp.md');
  writeFileSync(trap, `# 副本\n\n${probe}\n`, 'utf8');
  let dirty;
  try {
    dirty = scanDup();
  } finally {
    rmSync(trap, { force: true });
  }
  const caught = dirty.hits.find((h) => h.rel === 'lib/.dup-trap.tmp.md');
  console.log(`${clean.hits.length === 0 ? 'PASS' : 'FAIL'}  现役仓库零跨文件重复（实际命中 ${clean.hits.length}）`);
  console.log(`${caught ? 'PASS' : 'FAIL'}  注入一份副本能被扫出（${caught ? `${caught.count} 行` : '没扫到 = 判据是死的'}）`);
  const ok = clean.hits.length === 0 && !!caught;
  console.log(ok ? '✓ selftest 通过' : '✗ selftest 失败');
  process.exit(ok ? 0 : 1);
}

const args = process.argv.slice(2);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) {
  // 被 import（测试用）时不执行 CLI
} else if (args.includes('--selftest')) {
  selftest();
} else if (args.includes('--list')) {
  console.log([...walk(ROOT)].join('\n'));
} else {
  const r = scanDup();
  if (args.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`原文可比行 ${r.pool} 条 / 扫描文件 ${r.scanned} 个（已排除 prompt/、README、CHANGELOG、脚本自身）`);
    if (!r.hits.length) console.log('✓ 跨文件重复条文数=0');
    for (const h of r.hits) {
      console.log(`✗ ${h.rel}：${h.count} 行原文照抄`);
      for (const s of h.sample) console.log(`    · 原文第 ${s.srcLine} 行：${s.line.slice(0, 60)}`);
    }
  }
  process.exit(r.hits.length ? 1 : 0);
}
