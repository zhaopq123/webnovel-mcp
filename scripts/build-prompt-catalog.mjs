#!/usr/bin/env node
/**
 * 提示词切片目录构建器（唯一事实来源：prompt/CREATIVE-PROMPT.md → prompt/catalog.json）
 *
 * 为什么需要它：这份 19 节提示词约 3 万汉字（≈2 万 token），不能整篇塞进每章任务书，
 * 也不能抄进专家包/技能文件（会变成第四份副本并漂移）。所以原文只存一份，
 * 运行时按阶段切片供给 —— 本脚本就是「原文 → 切片」的生成器。
 *
 * 用法：
 *   node scripts/build-prompt-catalog.mjs          # 生成/更新 catalog 与 source-lock
 *   node scripts/build-prompt-catalog.mjs --check   # 只校验不写盘（CI/闸门用），不一致即红
 *   node scripts/build-prompt-catalog.mjs --selftest # 证明判据能变红（注入损坏副本）
 *
 * 完整性判据（任一不过直接 exit 1，绝不静默降级）：
 *   C1 顶层节数 == 19，编号 1..19 连续无缺无重（总起切片 id='0' 不计入）
 *   C2 小节编号在其节内逐 1 递增，起始号允许 0 或 1（原文确有 10.0）
 *   C3 行覆盖无缝无重叠：每个字符行恰好归属一个切片
 *   C4 重复段落扫描：正文中长度 ≥18 的整行出现 >1 次即报错（抄重/漏删的唯一自动捕手）
 *   C5 原文哈希与 source-lock.json 一致（改原文必须显式重锁）
 *   C6 幂等：同输入重跑输出逐字节相同
 *   C7 拼接还原：切片按行序拼回 == 原文逐字符一致（切片无损）
 *   C8 逐片文本 == 该切片行区间的原文（防「文本与行号分家」：C7 只走行区间，抓不到差一位吃掉标题行）
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_REL = 'prompt/CREATIVE-PROMPT.md';
const CATALOG_REL = 'prompt/catalog.json';
const LOCK_REL = 'prompt/source-lock.json';

/**
 * 仓库根 = prompt/ 的上一级。与 lib/features/craft.js 共用同一个 WEBNOVEL_PROMPT_ROOT 旋钮：
 * 一是部署改位，二是让「篡改即红」的测试能在临时副本上跑 ——
 * 测试不许动工作树里的真原文（node --test 并发跑文件，改真文件会让兄弟用例读到脏 catalog，
 * 实测过一次偶发红；脚本崩在半路还会把仓库留在脏状态）。
 */
function repoRoot() {
  return process.env.WEBNOVEL_PROMPT_ROOT
    ? resolve(process.env.WEBNOVEL_PROMPT_ROOT)
    : resolve(HERE, '..');
}
const ROOT = repoRoot();

/** 中文数字（支持一..十九与二十+）→ int。解析失败返回 0。 */
export function cn2num(s) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  let m = /^十([一二三四五六七八九])$/.exec(s);
  if (m) return 10 + digits[m[1]];
  m = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(s);
  if (m) return digits[m[1]] * 10 + (m[2] ? digits[m[2]] : 0);
  if (digits[s]) return digits[s];
  return 0;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 解析原文 → 切片数组（纯函数，供构建器与运行时 craft 共用同一口径）。 */
export function parsePrompt(markdown) {
  const lines = markdown.split('\n');
  const units = [];
  const title = (lines.find((l) => /^# /.test(l)) || '').replace(/^#\s*/, '').trim();

  // 先定位所有标题行
  const heads = [];
  lines.forEach((line, i) => {
    const m = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (!m) return;
    heads.push({ level: m[1].length, title: m[2], line: i });
  });

  // 逐标题切出区间 [line, nextHeadLine)
  const ranges = heads.map((h, idx) => ({
    ...h,
    end: idx + 1 < heads.length ? heads[idx + 1].line - 1 : lines.length - 1,
  }));

  // 首个「第X节」之前的正文（标题行 + 角色与优先级声明）也是切片，否则这段最高优先级的
  // 元规则会在切片化时被静默丢掉。
  if (ranges.length && ranges[0].line > 0) {
    ranges.unshift({ level: 2, title: '总起（角色与优先级声明）', line: 0, end: ranges[0].line - 1, synthetic: true });
  }

  let section = 0;          // 当前节号（1..19）
  let subSeq = 0;           // 当前节内小节序号
  let lastSectionFromNum = 0;
  let curUnit = null;       // 当前 level3 切片（level4 归到它下面）

  for (const h of ranges) {
    if (h.level === 2) {
      if (h.synthetic) {
        units.push(mkUnit({ level: 2, id: '0', section: 0, parent: null,
          title: h.title, startLine: h.line, endLine: h.end }));
        continue;
      }
      const mSec = /^第([一二三四五六七八九十]+)节/.exec(h.title);
      if (!mSec) throw new Error(`非「第X节」格式的二级标题：${h.title}`);
      section = cn2num(mSec[1]);
      if (!section) throw new Error(`节号解析失败：${h.title}`);
      subSeq = 0;
      curUnit = null;
      // 小节基准号：优先用标题自带的 N.M（如 3.6），否则自动补 M
      const mOwn = new RegExp(`^${section}\\.(\\d+)`).exec(h.title);
      lastSectionFromNum = mOwn ? Number(mOwn[1]) : 0;
      units.push(mkUnit({ level: 2, id: String(section), section, parent: null,
        title: h.title, startLine: h.line, endLine: h.end }));
      continue;
    }
    if (!section) throw new Error(`出现于任何节之前的 ${h.level} 级标题：${h.title}`);

    const mOwn = new RegExp(`^${section}\\.(\\d+)(?:\\.(\\d+))?`).exec(h.title);
    let id;
    if (h.level === 3) {
      subSeq = mOwn ? Number(mOwn[1]) : subSeq + 1;
      curUnit = `${section}.${subSeq}`;
      id = curUnit;
    } else {
      // level 4：带号（15.3.1）沿用；不带号（6.14 下三段）在该小节内补序
      const pfx = curUnit || String(section);
      if (mOwn && mOwn[2] !== undefined) id = `${section}.${mOwn[1]}.${mOwn[2]}`;
      else {
        const siblings = units.filter((u) => u.parent === pfx).length;
        id = `${pfx}.${siblings + 1}`;
      }
    }
    units.push(mkUnit({ level: h.level, id, section, parent: id.split('.').slice(0, -1).join('.') || String(section),
      title: h.title, startLine: h.line, endLine: h.end }));
  }

  const bodyStart = lines.findIndex((l) => /^# /.test(l));
  // 注意：startLine/endLine 是 1 起的行号，slice 是 0 起的下标 —— 这里差一位就会
  // 把标题行吃掉（C7 走行区间发现不了，必须靠 craft 侧的逐片文本哈希才发现）。
  for (const u of units) {
    u.text = lines.slice(u.startLine - 1, u.endLine).join('\n').replace(/\s+$/, '');
    u.chars = [...u.text].length;
    u.lines = u.text.split('\n').length;
  }
  return { title, lines, units, bodyStart };
}

function mkUnit({ level, id, section, parent, title, startLine, endLine }) {
  return { id, level, section, parent, title, startLine: startLine + 1, endLine: endLine + 1,
    chars: 0, lines: 0, text: '' };
}

/** C1/C2/C3/C4 校验；返回问题数组（空 == 通过）。 */
export function verifyUnits(parsed, { allowDup = [] } = {}) {
  const problems = [];
  const { units, lines } = parsed;

  // C1 顶层节 1..19 连续（id='0' 的总起切片不计入节数）
  const secs = units.filter((u) => u.level === 2 && u.section > 0).map((u) => Number(u.id));
  if (secs.length !== 19) problems.push(`C1 顶层节数=${secs.length}，应为 19`);
  for (let i = 0; i < secs.length; i++) if (secs[i] !== i + 1) problems.push(`C1 节号不连续：位置${i} 是第${secs[i]}节`);

  // C2 小节号在节内逐 1 递增，起始号允许 0 或 1（原文第十节确有 10.0）
  for (const sec of secs) {
    const subs = units.filter((u) => u.level === 3 && u.section === sec)
      .map((u) => Number(u.id.split('.')[1]));
    if (!subs.length) continue;
    if (subs[0] !== 0 && subs[0] !== 1) problems.push(`C2 第${sec}节小节起始号异常：${subs[0]}`);
    for (let i = 1; i < subs.length; i++) {
      if (subs[i] !== subs[i - 1] + 1) problems.push(`C2 第${sec}节小节号不连续：期望 ${subs[i - 1] + 1} 实得 ${subs[i]}`);
    }
  }

  // id 唯一
  const seen = new Map();
  units.forEach((u) => seen.set(u.id, (seen.get(u.id) || 0) + 1));
  for (const [id, n] of seen) if (n > 1) problems.push(`重复切片 id：${id} ×${n}`);

  // C3 行覆盖：切片拼起来必须无缝覆盖全文每一行（含首节之前的总起）
  const covered = new Set();
  for (const u of units) {
    for (let ln = u.startLine; ln <= u.endLine; ln++) {
      if (covered.has(ln)) problems.push(`C3 行重叠：第${ln}行属于多个切片`);
      covered.add(ln);
    }
  }
  for (let ln = 1; ln <= lines.length; ln++) {
    if (!covered.has(ln)) problems.push(`C3 行遗漏：第${ln}行不属于任何切片 —— "${(lines[ln - 1] || '').slice(0, 40)}"`);
  }

  // C4 重复段落扫描（长度 ≥18 的整行；空行/表格分隔/纯符号不计）
  const dupSeen = new Map();
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.replace(/[\s|>*\-–—]/g, '').length < 18) return;
    if (/^\|[-\s|:]+\|$/.test(t)) return;
    if (allowDup.some((p) => t.startsWith(p))) return;
    if (!dupSeen.has(t)) dupSeen.set(t, []);
    dupSeen.get(t).push(i + 1);
  });
  for (const [t, ls] of dupSeen) {
    if (ls.length > 1) problems.push(`C4 疑似抄重：「${t.slice(0, 26)}…」出现在第 ${ls.join(' / ')} 行`);
  }

  // C8 逐片文本 == 自己行区间的原文（C3/C7 只走行区间，抓不到「文本与行号分家」）
  for (const u of units) {
    const own = normTail(lines.slice(u.startLine - 1, u.endLine).join('\n'));
    if (normTail(u.text) !== own) {
      problems.push(`C8 切片 ${u.id} 的文本与其行区间 [${u.startLine},${u.endLine}] 内容不一致`);
    }
  }

  // 叶子切片非空（父级标题行下面直接跟子标题时，自身正文只有标题行，属正常）
  const parents = new Set(units.map((u) => u.parent).filter(Boolean));
  for (const u of units) {
    if (!parents.has(u.id) && u.chars < 10) {
      problems.push(`叶子切片 ${u.id}「${u.title.slice(0, 18)}」正文过短（${u.chars} 字）`);
    }
  }
  return problems;
}

/** C7 拼接还原：按行序把切片原文拼回去，必须与源文件逐字符相同（切片无损的最终证据）。 */
export function reconstruct(parsed) {
  return parsed.units.map((u) => parsed.lines.slice(u.startLine - 1, u.endLine).join('\n')).join('\n');
}
const normTail = (s) => s.replace(/\s+$/, '');

/** 生成要落盘的 catalog 对象（不含时间戳，保证 C6 幂等）。 */
export function buildCatalog(parsed, sourceSha) {
  const units = parsed.units.map((u) => ({
    id: u.id, level: u.level, section: u.section, parent: u.parent, title: u.title,
    startLine: u.startLine, endLine: u.endLine, chars: u.chars, lines: u.lines, text: u.text,
  }));
  return {
    schemaVersion: 1,
    source: SOURCE_REL,
    sourceSha256: sourceSha,
    title: parsed.title,
    stats: {
      sections: units.filter((u) => u.level === 2 && u.section > 0).length,
      units: units.length,
      chars: units.reduce((a, u) => a + u.chars, 0),
      lines: parsed.lines.length,
    },
    units,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();

  const srcPath = join(ROOT, SOURCE_REL);
  if (!existsSync(srcPath)) { console.error(`缺原文文件：${srcPath}`); process.exit(1); }

  // 原文一律以 LF 存（.gitattributes 已 * text=lf）；CRLF 先归一，避免 Windows 检出干扰哈希
  let raw = readFileSync(srcPath);
  let markdown = raw.toString('utf8');
  if (markdown.includes('\r\n')) {
    if (args.includes('--check')) { console.error('C0 原文含 CRLF，请先跑非 --check 模式归一'); process.exit(1); }
    markdown = markdown.replace(/\r\n/g, '\n');
    writeFileSync(srcPath, markdown, 'utf8');
    raw = Buffer.from(markdown, 'utf8');
    console.log('[fix] 原文行尾已归一为 LF');
  }
  const sourceSha = sha256(raw);

  const parsed = parsePrompt(markdown);
  const problems = verifyUnits(parsed);
  if (problems.length) {
    console.error(`✗ 提示词完整性不通过（${problems.length} 项）：`);
    problems.slice(0, 30).forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }

  // C7 拼接还原：按行序把切片原文拼回去，必须与源文件逐字符相同（切片无损的最终证据）
  const rebuilt = reconstruct(parsed);
  if (normTail(rebuilt) !== normTail(markdown)) {
    console.error('✗ C7 拼接还原与原文不一致（切片有损）');
    process.exit(1);
  }
  console.log('✓ C7 拼接还原：切片按序拼回 == 原文逐字符一致');

  const catalog = buildCatalog(parsed, sourceSha);
  const catalogText = JSON.stringify(catalog, null, 2) + '\n';
  const lock = {
    source: SOURCE_REL,
    sourceSha256: sourceSha,
    bytes: raw.length,
    lines: parsed.lines.length,
    units: catalog.units.length,
    sections: catalog.stats.sections,
    catalogSha256: sha256(Buffer.from(catalogText, 'utf8')),
  };
  const lockText = JSON.stringify(lock, null, 2) + '\n';

  const catPath = join(ROOT, CATALOG_REL);
  const lockPath = join(ROOT, LOCK_REL);
  if (args.includes('--check')) {
    const curCat = existsSync(catPath) ? readFileSync(catPath, 'utf8') : '(缺失)';
    const curLock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '(缺失)';
    const diffs = [];
    if (curCat !== catalogText) diffs.push('catalog.json 与原文重建结果不一致（陈旧或原文被改）');
    if (curLock !== lockText) diffs.push('source-lock.json 与当前原文哈希不一致');
    if (diffs.length) { console.error('✗ --check 失败：\n  - ' + diffs.join('\n  - ')); process.exit(1); }
    console.log(`✓ 原文/切片/锁三者一致：${catalog.stats.sections} 节 ${catalog.units.length} 切片 ${catalog.stats.chars} 字`);
    process.exit(0);
  }

  writeFileSync(catPath, catalogText, 'utf8');
  writeFileSync(lockPath, lockText, 'utf8');
  console.log(`✓ 已生成 ${CATALOG_REL}：${lock.sections} 节 / ${lock.units} 切片 / ${catalog.stats.chars} 字`);
  console.log(`✓ 已锁定 ${LOCK_REL}：sha256=${sourceSha.slice(0, 16)}…`);

  // C6 幂等自证：重建一次必须逐字节相同
  const again = JSON.stringify(buildCatalog(parsePrompt(readFileSync(srcPath, 'utf8')), sourceSha), null, 2) + '\n';
  console.log(again === catalogText ? '✓ C6 幂等：重跑输出逐字节相同' : '✗ C6 幂等失败');
  if (again !== catalogText) process.exit(1);
}

/** --selftest：证明这些判据真的能变红（在内存里把原文改坏，期望 verifyUnits 报错）。 */
function selftest() {
  const cases = [];
  const src = readFileSync(join(ROOT, SOURCE_REL), 'utf8');
  // T1 删掉一整节 → C1 必红
  const t1 = src.replace(/## 第十三节[\s\S]*?(?=\n## 第十四节)/, '');
  cases.push(['删一节 → C1 报节数', verifyUnits(parsePrompt(t1)).some((p) => p.startsWith('C1'))]);
  // T2 抄重一段（复现真实踩过的坑）→ C4 必红
  const dupBlock = src.match(/### 6\.5 [\s\S]*?(?=\n### 6\.6)/)?.[0];
  if (!dupBlock) { console.error('✗ selftest 前置条件不成立：找不到 6.5 小节'); process.exit(1); }
  const t2 = src.replace('### 6.6 配角自主性', dupBlock + '\n\n### 6.6 配角自主性');
  cases.push(['抄重一节 → C4 报疑似抄重', verifyUnits(parsePrompt(t2)).some((p) => p.startsWith('C4'))]);
  // T3 小节号跳号 → C2 必红
  const t3 = src.replace(/### 4\.3 \S+/, '### 4.9 开篇还债规则');
  cases.push(['小节跳号 → C2 报不连续', verifyUnits(parsePrompt(t3)).some((p) => p.startsWith('C2'))]);
  // T4 切片集合缺一个（行出现空洞）→ C3 必红。
  // 说明：C3 在正常解析下由区间构造天然成立，它的真实作用是「解析器一旦被改坏，必须有东西报警」，
  // 所以这里用手工构造的 parsed 直接证明判据是活的，而不是伪造一个正常输入能触发的场景。
  const gapParsed = parsePrompt(src);
  const gapUnits = gapParsed.units.slice();
  gapUnits.splice(5, 1);
  cases.push(['切片缺失 → C3 报行遗漏', verifyUnits({ ...gapParsed, units: gapUnits }).some((p) => p.startsWith('C3 行遗漏'))]);
  // T5 原文完好 → 必须全绿（防「判据恒红」这种更阴险的假安全感）
  cases.push(['原文完好 → 零问题', verifyUnits(parsePrompt(src)).length === 0]);
  // T6 切片区间被截短 → C7 拼接还原必红（用假 units 直接喂还原器）
  const gp = parsePrompt(src);
  const tampered = { lines: gp.lines, units: gp.units.map((u, i) => (i === 5 ? { ...u, endLine: u.endLine - 1 } : u)) };
  cases.push(['切片截短一行 → C7 还原不等', normTail(reconstruct(tampered)) !== normTail(src)]);
  cases.push(['未篡改 → C7 还原相等', normTail(reconstruct(gp)) === normTail(src)]);
  // T7 切片文本与自己行区间分家（真实踩过的差一位：标题行被吃掉）→ C8 必红
  const cp = parsePrompt(src);
  const shifted = { ...cp, units: cp.units.map((u, i) => (i === 8 ? { ...u, text: u.text.split('\n').slice(1).join('\n') } : u)) };
  cases.push(['切片文本少一行 → C8 报不一致', verifyUnits(shifted).some((p) => p.startsWith('C8'))]);
  let bad = 0;
  for (const [name, ok] of cases) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); }
  console.log(bad === 0 ? `✓ selftest：判据可红可绿，${cases.length}/${cases.length}` : `✗ selftest：${bad} 项失效`);
  process.exit(bad === 0 ? 0 : 1);
}

/** 仅在直接执行时跑主流程：被 import 时（运行时 craft / 测试）只导出纯函数，不副作用、不 exit。 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('✗ 构建失败：' + e.message); process.exit(1); });
}
