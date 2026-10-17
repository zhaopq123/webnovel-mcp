/**
 * 分发四形态门禁（计划第 6 条）+ README 可执行性（计划第 7 条）。
 *
 * 四形态不是「多放几个文件」：每一份都是要交给别人的接口文档，写错一个路径、一个切片号，
 * 对面的 agent 就会照着调、调不到、然后开始编。这里把能机械核对的都钉住：
 *   ① 三份 SKILL.md 的 front-matter（name == 目录名、description 带触发词）；
 *   ② 文档里引用的 craft 切片号/阶段必须真实存在；
 *   ③ paste-any-agent.md 必须与原文生成结果逐字符一致（防手改出第二份原文）；
 *   ④ AGENTS.md 片段只用占位符，工具表覆盖全部工具；
 *   ⑤ README 的相对链接真实存在、分发矩阵四条路径都在、19 节能力地图不缺节。
 * 判据自身用坏输入自证（front-matter 解析、阶段拆分、假切片号都要被判出来）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPasteDoc, checkPasteDoc, TARGET_REL, SOURCE_REL } from '../scripts/build-dist.mjs';
import { resolveStage } from '../lib/features/craft.js';
import { TOOL_NAMES } from '../mcp/tool-names.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CATALOG = JSON.parse(read('prompt/catalog.json'));
const UNIT_IDS = new Set(CATALOG.units.map((u) => u.id));

/** 解析 SKILL.md 的 front-matter；解析不出来返回 null（让调用方报出文件名）。 */
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return null;
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return data;
}

function collectCraftRefs(text) {
  const ids = [...text.matchAll(/id=(\d+(?:\.\d+)*)/g)].map((m) => m[1]);
  const stages = [...text.matchAll(/stage=([a-z0-9|]+)/g)].flatMap((m) => m[1].split('|').filter(Boolean));
  return { ids, stages };
}

function relativeLinks(markdown) {
  return [...markdown.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)]
    .map((m) => m[1].split('#')[0].trim())
    .filter((href) => href && !href.startsWith('<'));
}

test('分发 · 三份 SKILL.md 的 front-matter 合规（name == 目录、description 带触发词）', () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory());
  const names = dirs.map((e) => e.name).sort();
  assert.deepEqual(names, ['webnovel-coach', 'webnovel-craft', 'webnovel-reviewer'], '四形态里的三个 SKILL 必须齐全');

  for (const name of names) {
    const rel = `skills/${name}/SKILL.md`;
    const text = read(rel);
    const fm = parseFrontMatter(text);
    assert.ok(fm, `${rel} 缺 front-matter`);
    assert.equal(fm.name, name, `${rel} 的 name 必须与目录名一致`);
    assert.ok(fm.description && fm.description.length > 30, `${rel} 的 description 太短`);
    assert.match(fm.description, /触发词|Triggers/i, `${rel} 的 description 必须写触发词`);
    assert.ok(text.includes('webnovel_'), `${rel} 没提到任何工具——它得告诉 agent 怎么调`);
    const refs = collectCraftRefs(text);
    for (const id of refs.ids) assert.ok(UNIT_IDS.has(id), `${rel} 引用了不存在的切片 id=${id}`);
    for (const stage of refs.stages) assert.doesNotThrow(() => resolveStage(stage), `${rel} 引用了未知阶段 stage=${stage}`);
  }

  // 判据自证：坏输入必须被解析器/校验逻辑识别出来
  assert.equal(parseFrontMatter('# 没有 front-matter'), null);
  assert.deepEqual(parseFrontMatter('---\nname: x\ndescription: y\n---\n正文').name, 'x');
  assert.deepEqual(collectCraftRefs('action=get id=15.5 stage=stage6|report'), { ids: ['15.5'], stages: ['stage6', 'report'] });
});

test('分发 · 专家包与片段里引用的 craft 切片/阶段真实存在（写错切片号 = 对面调不到）', () => {
  const files = [
    'expert/README.md',
    'expert/webnovel-coach/agents/webnovel-coach.md',
    'expert/webnovel-reviewer/agents/webnovel-reviewer.md',
    'prompt/agents-md-snippet.md',
  ];
  let checked = 0;
  for (const rel of files) {
    const { ids, stages } = collectCraftRefs(read(rel));
    checked += ids.length + stages.length;
    for (const id of ids) assert.ok(UNIT_IDS.has(id), `${rel} 引用了不存在的切片 id=${id}`);
    for (const stage of stages) assert.doesNotThrow(() => resolveStage(stage), `${rel} 引用了未知阶段 stage=${stage}`);
  }
  assert.ok(checked >= 8, `只校验到 ${checked} 个引用，扫描逻辑可能失效了`);
  // 自证：假切片号确实不在目录里（防止 UNIT_IDS 意外包含一切）
  assert.equal(UNIT_IDS.has('99.99'), false);
});

test('分发 · paste-any-agent.md 由原文生成，逐字符一致（手改即红）', () => {
  assert.ok(fs.existsSync(path.join(ROOT, TARGET_REL)), `${TARGET_REL} 不存在`);
  const result = checkPasteDoc(ROOT);
  assert.deepEqual(result, { ok: true }, result.reason);

  const pasted = read(TARGET_REL);
  const source = read(SOURCE_REL);
  assert.ok(pasted.includes(source.trimEnd()), '粘贴版必须完整包含原文');
  assert.match(pasted, /# 纯文本整段/, '粘贴版缺使用说明头');
  assert.match(pasted, /没有记忆库/, '粘贴版必须说明无 MCP 的代价');
  assert.equal(pasted, buildPasteDoc(ROOT), '生成函数与磁盘内容不一致');
});

test('分发 · AGENTS.md 片段只用占位符，工具表覆盖全部 12 个工具', () => {
  const rel = 'prompt/agents-md-snippet.md';
  const text = read(rel);
  for (const placeholder of ['<HOST>', '<PORT>', '<TOKEN>', '<ABS_PATH>']) {
    assert.ok(text.includes(placeholder), `${rel} 缺占位符 ${placeholder}`);
  }
  assert.match(text, /streamableHttp/, '片段必须给 HTTP 连接方式');
  assert.match(text, /--stdio/, '片段必须给 stdio 连接方式');
  assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{12,}/, '片段里出现了真实 token');
  assert.doesNotMatch(text, /https?:\/\/(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01]))\./, '片段里出现了内网 IP');
  const missing = TOOL_NAMES.filter((n) => !text.includes(n));
  assert.deepEqual(missing, [], `片段工具表缺：${missing.join(', ')}`);
});

test('分发 · README 的相对链接全部存在', () => {
  const readme = read('README.md');
  const links = relativeLinks(readme);
  assert.ok(links.length >= 4, `只找到 ${links.length} 个相对链接，解析逻辑可能失效了`);
  const bad = links.filter((href) => !fs.existsSync(path.join(ROOT, href)));
  assert.deepEqual(bad, [], `README 里有失效相对路径：${bad.join(', ')}`);
  // 自证：不存在的路径会被判出来
  assert.ok(!fs.existsSync(path.join(ROOT, 'docs/__not_here__.md')));
});

test('分发 · README 的分发矩阵四条路径都在、19 节能力地图不缺节', () => {
  const readme = read('README.md');
  assert.match(readme, /## 分发矩阵/, 'README 缺「分发矩阵」段');
  for (const rel of [
    'expert/webnovel-coach',
    'skills/webnovel-coach/SKILL.md',
    'prompt/paste-any-agent.md',
    'prompt/agents-md-snippet.md',
  ]) {
    assert.ok(readme.includes(rel), `分发矩阵缺路径：${rel}`);
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `分发矩阵指向的文件不存在：${rel}`);
  }

  assert.match(readme, /## 19 节能力地图/, 'README 缺「19 节能力地图」段');
  const rows = [...readme.matchAll(/^\|\s*第\s*(\d+)\s*节/gm)].map((m) => Number(m[1]));
  assert.deepEqual(rows, Array.from({ length: 19 }, (_, i) => i + 1), '能力地图必须恰好列 1-19 节，不重不漏');

  assert.match(readme, /## 按阶段取规则/, 'README 缺「按阶段取规则」段');
  assert.match(readme, /webnovel_craft action=brief stage=stage6/, 'README 应给出正文阶段的取法');
});

test('分发 · 四形态的文件都真实存在（矩阵不是画饼）', () => {
  for (const rel of [
    'expert/webnovel-coach/.codebuddy-plugin/plugin.json',
    'expert/webnovel-reviewer/.codebuddy-plugin/plugin.json',
    'skills/webnovel-craft/SKILL.md',
    'skills/webnovel-coach/SKILL.md',
    'skills/webnovel-reviewer/SKILL.md',
    'prompt/paste-any-agent.md',
    'prompt/agents-md-snippet.md',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺分发文件：${rel}`);
  }
});
