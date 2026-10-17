#!/usr/bin/env node
/**
 * 分发物生成/校验：`prompt/paste-any-agent.md` = 使用说明 + 提示词原文。
 *
 * 为什么由脚本生成而不是手写：这份文件和 `prompt/CREATIVE-PROMPT.md` 逐字相同，
 * 手写就等于养第二份原文——原文改一次、这里忘一次，分发出去的规则立刻过期。
 * 生成 + `--check` 是这个形态唯一不会漂移的做法（同 build-prompt-catalog 的口径）。
 *
 * 用法：
 *   node scripts/build-dist.mjs            # 生成/覆盖 prompt/paste-any-agent.md
 *   node scripts/build-dist.mjs --check    # 只校验，不一致 exit 1
 *   node scripts/build-dist.mjs --selftest # 证明校验能红（临时目录里篡改一次）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_REL = 'prompt/CREATIVE-PROMPT.md';
export const TARGET_REL = 'prompt/paste-any-agent.md';

export const HEADER = `# 纯文本整段（给装不了 MCP / 插件的 agent）

> 用法：把本文件**从下一行分隔线开始到最后**整段粘贴进 agent 的系统提示词 / 自定义指令。
> 它不依赖任何工具、插件或 MCP；代价是**没有记忆库**——设定、伏笔、时间线、进度要靠
> 你和 agent 用文件自己维护，每章结束把事实增量写回去。
>
> 如果你能连 MCP，别用本文件：装 \`skills/\` 里的技能或按 \`prompt/agents-md-snippet.md\`
> 配置连接器，工具会自动组装任务书、维护台账并做一致性审查。
>
> 下面是《小说创作全流程协作提示词（通用交付版·闭环终版）》原文，逐字保留，共 19 节。
`;

/** 生成目标文件全文（纯函数，测试直接比对磁盘内容）。 */
export function buildPasteDoc(root = ROOT) {
  const source = fs.readFileSync(path.join(root, SOURCE_REL), 'utf8');
  return `${HEADER}\n---\n\n${source.replace(/\s+$/, '')}\n`;
}

/** 校验磁盘上的分发文件与原文生成结果逐字符一致。 */
export function checkPasteDoc(root = ROOT) {
  const target = path.join(root, TARGET_REL);
  if (!fs.existsSync(target)) {
    return { ok: false, reason: `${TARGET_REL} 不存在——先运行 node scripts/build-dist.mjs` };
  }
  const actual = fs.readFileSync(target, 'utf8');
  const expected = buildPasteDoc(root);
  if (actual !== expected) {
    return {
      ok: false,
      reason: `${TARGET_REL} 与原文生成结果不一致（手改过，或原文更新后没重建）——运行 node scripts/build-dist.mjs 重建`,
    };
  }
  return { ok: true };
}

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-dist-'));
  try {
    fs.mkdirSync(path.join(dir, 'prompt'), { recursive: true });
    const source = '# 测试原文\n\n第一节：只用于自检。\n';
    fs.writeFileSync(path.join(dir, SOURCE_REL), source);
    const absent = checkPasteDoc(dir);
    if (absent.ok) throw new Error('目标文件不存在时校验却报绿');

    fs.writeFileSync(path.join(dir, TARGET_REL), buildPasteDoc(dir));
    const good = checkPasteDoc(dir);
    if (!good.ok) throw new Error(`刚生成的文件校验失败：${good.reason}`);

    fs.appendFileSync(path.join(dir, TARGET_REL), '\n手改一行\n');
    const bad = checkPasteDoc(dir);
    if (bad.ok) throw new Error('目标文件被篡改后校验仍报绿');

    fs.writeFileSync(path.join(dir, SOURCE_REL), `${source}原文新增一行\n`);
    fs.writeFileSync(path.join(dir, TARGET_REL), buildPasteDoc(dir));
    fs.appendFileSync(path.join(dir, SOURCE_REL), '原文又改了一行\n');
    const stale = checkPasteDoc(dir);
    if (stale.ok) throw new Error('原文改了但分发文件没重建，校验仍报绿');

    console.log('PASS selftest 5/5：缺失/一致/篡改/原文变更后过期 都能被识别');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.includes('--selftest')) {
    selftest();
    return;
  }
  if (argv.includes('--check')) {
    const result = checkPasteDoc();
    if (!result.ok) {
      console.error(`✗ ${result.reason}`);
      process.exit(1);
    }
    console.log(`✓ ${TARGET_REL} 与 ${SOURCE_REL} 逐字符一致`);
    return;
  }
  const doc = buildPasteDoc();
  fs.writeFileSync(path.join(ROOT, TARGET_REL), doc);
  console.log(`✓ 已生成 ${TARGET_REL}（${doc.length} 字节）`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
