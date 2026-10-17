/**
 * 仓库卫生门禁：版本只有一个真相源，发布物里不许带作者环境。
 *
 * 两个都是真出过的事：CHANGELOG 写到 1.0.1 而 package.json 还停在 1.0.0（服务自报
 * 版本号因此是假的）；脱敏漏掉内网 IP 会直接把家庭局域网写进公开仓库。
 * 门禁的价值在于**它能失败**——所以每条规则都配了反例自测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'books', 'logs', 'test-artifacts']);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

function textFiles() {
  const out = [];
  for (const file of walk(ROOT)) {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // 二进制
    out.push({ rel: path.relative(ROOT, file).replace(/\\/g, '/'), text: buf.toString('utf8') });
  }
  return out;
}

/** 规则一律用拼装构造：写成字面量会让本文件自己命中自己的扫描。 */
function re(head, tail) {
  return new RegExp(head.join('') + '(?![0-9a-f])', tail);
}

const RULES = [
  {
    name: '内网 IP（RFC1918）',
    // 必须是完整四段，否则文档里的「v10.2」这种版本号也会被当成泄漏。
    pattern: new RegExp(
      ['(?<![\\d.])(?:', '192', '\\.', '16\\d|', '172', '\\.', '(?:1[6-9]|2\\d|3[01])|',
        '10', '\\.', '\\d{1,3}', ')[', '\\.', ']\\d{1,3}[', '\\.', ']\\d{1,3}(?![\\d.])'].join(''),
    ),
  },
  {
    name: '64 位十六进制令牌',
    pattern: re(['(?<![0-9a-f])', '[0-9a-f]', '{64}'], ''),
    // 例外只按「上下文是不是校验和」判定，不按文件放行：`"sourceSha256": "<64hex>"` 这种
    // 是内容指纹（提示词原文/切片库的锁），公开是设计意图；真正的令牌不会长在 sha256 键上。
    // 判定仍逐命中生效——同一个文件里塞一条裸令牌照样红。
    allowContext: new RegExp(['(?:sha', '[-_ ]?256|checksum|哈希|校验和)', '[^\\n]{0,8}$'].join(''), 'i'),
  },
  { name: '私钥', pattern: new RegExp(['BEGIN ', '[A-Z ]*', 'PRIVATE', ' KEY'].join('')) },
  {
    name: '个人邮箱',
    pattern: new RegExp(
      ['[\\w.+-]+', '@', '(?:gmail|qq|163|126|outlook|foxmail|sina|icloud)', '\\.', '(?:com|cn|net|org)'].join(''),
      'i',
    ),
  },
  { name: '本机用户目录', pattern: new RegExp(['[A-Za-z]:', '[\\\\/]{2}', '[Uu]sers', '[\\\\/]'].join('')) },
  { name: 'macOS 用户目录', pattern: /\/Users\// },
];

// 哈希锁文件豁免：catalog/source-lock 的 sha256 是防篡改锁的功能字段，不是泄漏令牌。
// 其余规则（IP/邮箱/用户目录/登录名）对这两个文件照扫不误。

const LOCAL_USER = process.env.USERNAME || process.env.USER || '';
if (LOCAL_USER.length >= 2) {
  RULES.push({ name: `本机登录名「${LOCAL_USER}」`, pattern: new RegExp(`(?<![\\w-])${LOCAL_USER}(?![\\w-])`) });
}

test('仓库卫生：发布物不含作者环境', () => {
  const files = textFiles();
  assert.ok(files.length > 10, `只扫到 ${files.length} 个文本文件，扫描逻辑八成坏了`);
  const hits = [];
  for (const { rel, text } of files) {
    for (const rule of RULES) {
      for (const hit of scan(text, rule)) hits.push(`${rel} [${rule.name}] ${hit}`);
    }
  }
  assert.deepEqual(hits, [], `发现不该出现在公开仓库的内容：\n${hits.join('\n')}`);
});

/** 逐命中扫描：带 allowContext 的规则只在「命中处前面确实是校验和上下文」时豁免该次命中。 */
function scan(text, rule) {
  const out = [];
  const rx = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
  let m;
  while ((m = rx.exec(text)) !== null) {
    if (m[0].length === 0) { rx.lastIndex += 1; continue; }
    if (rule.allowContext && rule.allowContext.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    out.push(m[0]);
  }
  return out;
}

test('脱敏规则确实能失败（防止门禁恒真）', () => {
  const ip = RULES.find((r) => r.name.includes('内网'));
  const tok = RULES.find((r) => r.name.includes('十六进制'));
  const mail = RULES.find((r) => r.name.includes('邮箱'));
  assert.match('http://192' + '.169.3.35:8600/mcp', new RegExp(ip.pattern.source));
  assert.ok(!ip.pattern.test('2026' + '-10-15 08:15'), '正常时间戳被误判成内网 IP');
  assert.ok(!ip.pattern.test('node 24.18' + '.0.1'), '版本号被误判成内网 IP');
  assert.match('a'.repeat(8) + 'f'.repeat(56), new RegExp(tok.pattern.source));
  assert.ok(!tok.pattern.test('deadbeef'), '短十六进制串被误判成令牌');
  assert.match('someone@gm' + 'ail.com', new RegExp(mail.pattern.source, 'i'));

  // 校验和豁免必须精确：sha256 键下的指纹放行，裸令牌与「token 键下的 64 hex」一律要红。
  const digest = 'b'.repeat(64);
  assert.deepEqual(scan(`{"sourceSha256": "${digest}"}`, tok), [], 'sha256 键下的校验和被误判成令牌');
  assert.deepEqual(scan(`sha256=${digest}`, tok), [], 'sha256= 形式的校验和被误判');
  assert.deepEqual(scan(`{"token": "${digest}"}`, tok), [digest], '令牌被豁免规则放过（豁免过宽）');
  assert.deepEqual(scan(`${digest}`, tok), [digest], '裸 64 位十六进制被放过');
  assert.deepEqual(
    scan(`{"sourceSha256": "${digest}"}\n{"api_key": "${'c'.repeat(64)}"}`, tok),
    ['c'.repeat(64)],
    '同一文件里混排的校验和与令牌没有分别处置',
  );
});

test('版本号只有一个真相源（含所有专家包）', async () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { SERVER_INFO } = await import(pathToFileURL(path.join(ROOT, 'mcp', 'protocol.mjs')).href);
  const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

  const top = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(top, 'CHANGELOG 顶部没有 `## [x.y.z]` 版本段');
  assert.equal(SERVER_INFO.version, pkg.version, 'MCP serverInfo 与 package.json 版本不一致');
  assert.equal(top[1], pkg.version, 'CHANGELOG 最新版本与 package.json 版本不一致（服务自报版本号会是假的）');

  // 专家包不止一个（webnovel-coach / webnovel-reviewer…），逐个对齐，漏一个就是假版本。
  const expertDir = path.join(ROOT, 'expert');
  const expertEntries = readdirSync(expertDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(expertEntries.length > 0, 'expert/ 下没有专家包目录，扫描逻辑坏了');
  const drifted = [];
  for (const entry of expertEntries) {
    const manifest = JSON.parse(
      readFileSync(path.join(expertDir, entry.name, '.codebuddy-plugin', 'plugin.json'), 'utf8'),
    );
    if (manifest.version !== pkg.version) {
      drifted.push(`${entry.name} 停在 ${manifest.version}`);
    }
  }
  assert.deepEqual(drifted, [], `专家包版本与 package.json 不一致：${drifted.join('；')}`);
});

test('npm test 用自动发现，不用会被当文件的路径写法', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.doesNotMatch(pkg.scripts.test, /--test\s+\S/, 'Node 24 把带路径参数的 --test 当成单个文件，会只报 ERR_TEST_FAILURE');
  assert.match(pkg.scripts.test, /--test/);
});
