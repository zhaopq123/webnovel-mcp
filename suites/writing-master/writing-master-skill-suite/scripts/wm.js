#!/usr/bin/env node
'use strict';
/*
 * WritingMaster 写作大师 · 脚本引擎（单文件实现，零第三方依赖）
 * 契约: 与 skills 下各 SKILL.md 层约定（输出为人类/LLM 可读文本，退出码 0 成功 / 1 校验失败 / 2 用法错误）
 * 入口: wm-init.sh / wm-context.sh / wm-commit.sh / wm-review.sh /
 *       wm-status.sh / wm-archive.sh / wm-restore.sh / wm-doctor.sh（薄包装）
 * 通用性: 只依赖 bash + node，任何 agent 环境可用；每条命令输出末尾含
 *         "下一步建议"，供 agent 自动接力调用（技能互调的工程基础）。
 */

const fs = require('fs');
const path = require('path');

/* ───────────────────────── 常量 ───────────────────────── */

/* v2.0 赛道口径：四大赛道 + novel 赛道下的言情模式（genre）。
 * 原 v1.x 独立赛道 romance 已整体并入 novel（言情模式），一条规则未删；
 * 旧参数 --track romance 保留为废弃别名，自动映射 novel+genre=romance。 */
const TRACKS = ['novel', 'screenplay', 'jubensha', 'toolbook'];
const GENRES = ['general', 'romance'];
const MODES = ['auto', 'collab'];
const TASKS = ['plan', 'write', 'review', 'report'];

/* 状态归一：v1.x 旧项目 state.track='romance' 自动按 novel·言情模式处理（不回写文件） */
function normalizeState(st) {
  if (st.track === 'romance') { st.track = 'novel'; if (st.genre === undefined) st.genre = 'romance'; }
  if (st.genre === undefined) st.genre = 'general';
  return st;
}
/* 展示口径：novel+言情模式 显示为 novel·言情模式，其余赛道原样 */
function trackLabel(st) {
  return st && st.track === 'novel' && st.genre === 'romance' ? 'novel·言情模式' : String(st && st.track);
}

/* 三线节奏模型（wm-pacing 体检 + summary.strand 标记）：
 * quest=主线剧情 / fire=感情线 / constellation=世界观扩展。
 * 理想配比与断档阈值按赛道换算（TRACK_PACING），行业基线 6:2:2。 */
const STRANDS = ['quest', 'fire', 'constellation'];
const STRAND_META = {
  quest: { label: '主线剧情', ideal: 0.6, maxGap: 5, icon: '🔵' },
  fire: { label: '感情线', ideal: 0.2, maxGap: 10, icon: '🔴' },
  constellation: { label: '世界观', ideal: 0.2, maxGap: 15, icon: '🟢' }
};
/* 赛道换算表（pacing 体检按作品赛道取此配比） */
const TRACK_PACING = {
  novel: { quest: 0.6, fire: 0.2, constellation: 0.2, note: '网文行业基线 6:2:2' },
  romance: { quest: 0.4, fire: 0.4, constellation: 0.2, note: '言情模式感情线提至 40% 起' },
  screenplay: { quest: 0.5, fire: 0.3, constellation: 0.2, note: '剧本每集须触碰全部三线' },
  jubensha: { quest: 0.5, fire: 0.3, constellation: 0.2, note: '剧本杀换算：案线/情感线/机制线 5:3:2' },
  toolbook: { quest: 0.6, fire: 0.2, constellation: 0.2, note: '工具书换算：论点/案例/方法线 6:2:2' }
};

/* 写作记忆类型（wm-memory 沉淀，context 自动注入） */
const MEMORY_KINDS = ['style', 'technique', 'setting', 'feedback', 'character'];
const MEMORY_KIND_LABEL = {
  style: '文风', technique: '写法', setting: '设定约定', feedback: '读者/编辑反馈', character: '人物把握'
};

const USAGE = {
  init: '用法: bash wm-init.sh --track <novel|screenplay|jubensha|toolbook> --title <名> --target-words <N> [--genre <general|romance>] [--mode auto|collab] [--dir <目录>] [--no-outline-gate]（言情模式: --track novel --genre romance；旧参数 --track romance 已废弃，仍可用并自动映射）',
  context: '用法: bash wm-context.sh [--dir <目录>] [--task <plan|write|review|report>] [--chapter N] [--budget N]',
  commit: '用法: bash wm-commit.sh --dir <目录> --file <更新.json>',
  review: '用法: bash wm-review.sh --dir <目录> --file <稿件.md> [--chapter N]',
  status: '用法: bash wm-status.sh [--dir <目录>]',
  archive: '用法: bash wm-archive.sh --dir <目录> --part N',
  restore: '用法: bash wm-restore.sh [--dir <目录>]',
  doctor: '用法: bash wm-doctor.sh [--dir <目录>]',
  outline: '用法: bash wm-outline.sh --dir <目录> (--save <master|part|volume|chapter> --file <大纲.md> [--num N] | --show <master|part|volume|chapter> [--num N] | --list | --enable | --disable)',
  query: '用法: bash wm-query.sh --dir <目录> --what <characters|foreshadow|suspense|info-gap|plotlines|timeline|names|fulltext> [--name <名>] [--id <编号>] [--keyword <词>] [--top N]',
  pacing: '用法: bash wm-pacing.sh --dir <目录> [--window N]',
  memory: '用法: bash wm-memory.sh --dir <目录> (--add <记忆.json> | --list [--kind <类>] [--tag <标签>] | --search <关键词>)',
  verify: '用法: bash wm-verify.sh [--root <包根>] [--update-lock] [--no-smoke]'
};

const MAIN_USAGE = `WritingMaster 脚本引擎 · 子命令:
  wm-init.sh    初始化作品项目（创建 .wm/ 账本；四大赛道 + novel·言情模式 --genre romance）
  wm-context.sh 动笔前上下文装配（章纲门禁 + 写作记忆自动注入）
  wm-commit.sh  事实增量提交（名词锁校验 + 三线 strand 标记）
  wm-review.sh  稿件机械审查门禁
  wm-status.sh  进度面板
  wm-archive.sh 部归档（活跃区压缩）
  wm-restore.sh 断点恢复包
  wm-doctor.sh  账本体检
  wm-outline.sh 大纲管理（总纲/部纲/卷纲/章纲 存取 + 无章纲不动笔门禁）
  wm-query.sh   台账查询（角色/伏笔/悬念/信息差/情节线/时间线/专名 + 全文检索）
  wm-pacing.sh  三线节奏体检（占比/断档/修复建议，按赛道换算）
  wm-memory.sh  写作经验沉淀（五类 learn/list/search，context 自动注入）
  wm-verify.sh  包完整性门禁（切片 sha 锁/模板引用/命令齐备/全链路冒烟）
  mcp-server.mjs MCP 服务器（stdio JSON-RPC，全部 CLI 命令暴露为 MCP 工具）
各命令加 -h/--help 查看详细用法。退出码: 0 成功 / 1 校验失败 / 2 用法错误`;

/* AI味/书面腔黑名单（默认；可通过 .wm/review-blacklist.txt 追加，每行一词，# 为注释） */
const DEFAULT_BLACKLIST = [
  '诉说着', '诠释着', '演绎着', '见证着', '昭示着', '彰显着', '预示着',
  '空气中弥漫', '弥漫着一丝', '眼底闪过一丝', '眼中闪过一丝', '嘴角勾起一抹', '勾起一抹',
  '一丝不易察觉', '仿佛在诉说', '不禁让人', '令人不禁', '无声地诉说',
  '岁月的长河', '历史的长河', '时间的长河', '命运的齿轮', '命运的洪流',
  '静静地', '缓缓地', '悠悠地', '默默地', '淡淡的',
  '毅然决然', '义无反顾', '坚定不移', '不动声色', '一针见血',
  '语重心长', '循循善诱', '娓娓道来', '意味深长', '耐人寻味', '引人深思', '发人深省',
  '显而易见', '不言而喻', '众所周知', '毋庸置疑', '与此同时', '话音刚落', '说时迟那时快',
  '恍如隔世', '白驹过隙', '沧海桑田', '时过境迁', '物是人非',
  '思绪万千', '百感交集', '五味杂陈', '心潮澎湃', '热泪盈眶', '泪如雨下',
  '如沐春风', '游刃有余', '举重若轻', '淋漓尽致', '恰到好处', '相得益彰',
  '熠熠生辉', '熠熠', '氤氲', '旖旎', '缱绻', '静谧', '斑驳陆离', '光怪陆离'
];

/* 常见繁体字（简体正文中不应出现） */
const TRADITIONAL = new Set(Array.from(
  '們這裡裏後說話時東車馬鳥龍漢語書學國會來對發開關門問實寶愛樂萬無煙夢雲兒氣風飛鳳嶺絕繼續經級紅綠藍蘭灣壓壞滿滅燈靈點黨齊絲與專業為辦勵動務勢勝區醫單嚴師帶幾廣廠異導層幹並麼莊廚縣參雙變數誤請談論誰諸課調講謝謠謙謹識證譯議護譽讀讓讚趙趨蹤軌軍軒軟輕較載輛輝輪辭邊還進遠違適選遷過運遺遙遞遜邏鄉鄰醜釋鐘錶錯鍵鎖鏡長閉閑閒隊階隨難電霧靜頂項順須頓頗領頭頻題額顏願類飯飲養餘館驚體髮鬆鬧鮮麗麥黃龜個眾機極構標樣權歡歷歸殺殘淚準漁熱燒營燭爺牆狀獨獄獲獸獻環現瓊畫當盜盞盧禮禪筆筍節範築篤簡糾納紐純紗紙紡見買賣費貼貴貧貨資賺賽贊趕轟轉輸廳聽應豐豬貓兩內備婦媽寧審屍廢彈徹從復憶恆懸懇懼慘慚憤憫懷懶髒鬚魯鵝'
));

const CJK_RE = /[\u4e00-\u9fff]/;

/* ───────────────────────── 基础工具 ───────────────────────── */

function usageErr(msg, cmd) {
  console.error('用法错误: ' + msg);
  if (cmd && USAGE[cmd]) console.error(USAGE[cmd]);
  process.exit(2);
}
function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}
function p(line) { console.log(line === undefined ? '' : line); }
function fmtNum(n) { return Number(n).toLocaleString('en-US'); }
function nowISO() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

function parseArgs(cmd, argv, spec, required) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { p(USAGE[cmd]); process.exit(0); }
    if (!a.startsWith('--')) usageErr('无法识别的参数: ' + a, cmd);
    const key = a.slice(2);
    if (!(key in spec)) usageErr('无法识别的选项 --' + key, cmd);
    if (spec[key] === 'flag' || spec[key] === 0) { out[key] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) usageErr('--' + key + ' 需要一个值', cmd);
    out[key] = v;
  }
  for (const r of required || []) if (out[r] === undefined) usageErr('缺少必填参数 --' + r, cmd);
  return out;
}

/* ───────────────────────── 状态目录 I/O ───────────────────────── */

function resolveDir(a) { return a.dir || process.cwd(); }
function wmPath(dir) { return path.join(dir, '.wm'); }
function ledgerFile(dir, name) { return path.join(dir, '.wm', 'ledger', name); }

function requireProject(dir) {
  if (!fs.existsSync(dir)) fail(`目录不存在: ${dir}`);
  if (!fs.existsSync(path.join(wmPath(dir), 'state.json'))) {
    fail(`不是 WritingMaster 项目（缺少 ${wmPath(dir)}/state.json），请先运行 wm-init.sh`);
  }
}

function readJSONFile(f, what) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { fail(`${what} 读取失败或不是合法 JSON: ${f}\n  ${e.message}`); }
}
function writeJSONFile(f, o) {
  fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8');
}
function loadState(dir) { return normalizeState(readJSONFile(path.join(wmPath(dir), 'state.json'), 'state.json')); }
function saveState(dir, st) {
  st.updated_at = nowISO();
  writeJSONFile(path.join(wmPath(dir), 'state.json'), st);
}
function loadLedger(dir, name, defKey) {
  const o = readJSONFile(ledgerFile(dir, name), `台账 ${name}`);
  if (typeof o !== 'object' || o === null || Array.isArray(o)) fail(`台账 ${name} 结构错误（应为对象）: ${ledgerFile(dir, name)}`);
  if (!Array.isArray(o[defKey])) fail(`台账 ${name} 缺少 "${defKey}" 数组: ${ledgerFile(dir, name)}`);
  return o;
}

function readNamesTable(dir) {
  const f = ledgerFile(dir, 'names.tsv');
  const rows = [];
  if (!fs.existsSync(f)) return rows;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    if (!c[0]) continue;
    rows.push({ name: c[0], type: c[1] || 'other', first_chapter: parseInt(c[2] || '0', 10) || 0, note: c.slice(3).join('\t') });
  }
  return rows;
}
function writeNamesTable(dir, rows) {
  const f = ledgerFile(dir, 'names.tsv');
  const lines = ['# WritingMaster 专名表（列: name\ttype\tfirst_chapter\tnote）'];
  for (const r of rows) {
    const note = (r.note || '').replace(/[\t\n\r]/g, ' ');
    lines.push([r.name, r.type || 'other', String(r.first_chapter || 0), note].join('\t'));
  }
  fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8');
}
function appendNamesRow(dir, row) {
  const f = ledgerFile(dir, 'names.tsv');
  const note = (row.note || '').replace(/[\t\n\r]/g, ' ');
  fs.appendFileSync(f, [row.name, row.type || 'other', String(row.first_chapter || 0), note].join('\t') + '\n', 'utf8');
}

function commitsLogPath(dir) { return path.join(wmPath(dir), 'commits.log'); }
function nextCommitSeq(dir) {
  const f = commitsLogPath(dir);
  if (!fs.existsSync(f)) return 1;
  let max = 0;
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /commit #(\d+)/.exec(l);
    if (m) max = Math.max(max, +m[1]);
  }
  return max + 1;
}
function appendLog(dir, line) { fs.appendFileSync(commitsLogPath(dir), `[${nowISO()}] ${line}\n`, 'utf8'); }

function chapterSummaryPath(dir, ch) {
  return path.join(wmPath(dir), 'summaries', 'ch-' + String(ch).padStart(3, '0') + '.md');
}
/* 归档感知：章摘要优先查活跃区，未命中再查 archive 各部 summaries（部归档后前章钩子仍可承接） */
function findChapterSummaryPath(dir, ch) {
  const active = chapterSummaryPath(dir, ch);
  if (fs.existsSync(active)) return active;
  const archRoot = path.join(wmPath(dir), 'archive');
  if (fs.existsSync(archRoot)) {
    for (const d of fs.readdirSync(archRoot).sort()) {
      const f = path.join(archRoot, d, 'summaries', 'ch-' + String(ch).padStart(3, '0') + '.md');
      if (fs.existsSync(f)) return f;
    }
  }
  return active;
}
function listChapterSummaries(dir) {
  const d = path.join(wmPath(dir), 'summaries');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .map(f => /^ch-(\d+)\.md$/.exec(f))
    .filter(Boolean)
    .map(m => +m[1])
    .sort((a, b) => a - b);
}
function listPartSummaries(dir) {
  const d = path.join(wmPath(dir), 'summaries');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .map(f => /^part-(\d+)\.md$/.exec(f))
    .filter(Boolean)
    .map(m => +m[1])
    .sort((a, b) => a - b);
}
function readSummaryFile(f) {
  if (!fs.existsSync(f)) return null;
  const txt = fs.readFileSync(f, 'utf8');
  const one = /one_line[：:]\s*(.*)/.exec(txt);
  const hook = /hook_type[：:]\s*(.*)/.exec(txt);
  const chg = /changes[：:]\s*(.*)/.exec(txt);
  return { one_line: one ? one[1].trim() : '', hook_type: hook ? hook[1].trim() : '', changes: chg ? chg[1].trim() : '', raw: txt };
}
function archivedChapterSet(dir) {
  const set = new Set();
  const archRoot = path.join(wmPath(dir), 'archive');
  if (fs.existsSync(archRoot)) {
    for (const d of fs.readdirSync(archRoot)) {
      const sd = path.join(archRoot, d, 'summaries');
      if (fs.existsSync(sd) && fs.statSync(sd).isDirectory()) {
        for (const f of fs.readdirSync(sd)) { const m = /^ch-(\d+)\.md$/.exec(f); if (m) set.add(+m[1]); }
      }
    }
  }
  return set;
}

/* ───────────────────────── wm-init ───────────────────────── */

function cmdInit(a) {
  const dir = a.dir || process.cwd();
  let track = a.track, title = (a.title || '').trim(), mode = a.mode || 'auto', genre = a.genre;
  if (!track) usageErr('缺少必填参数 --track', 'init');
  if (!title) usageErr('缺少必填参数 --title', 'init');
  if (a['target-words'] === undefined) usageErr('缺少必填参数 --target-words', 'init');
  /* v2.0 迁移：旧赛道参数 romance → novel·言情模式（废弃别名，不再单列赛道） */
  let legacyRomance = false;
  if (track === 'romance') { track = 'novel'; if (genre === undefined) genre = 'romance'; legacyRomance = true; }
  if (!TRACKS.includes(track)) fail(`无效赛道 --track "${track}"（可选: ${TRACKS.join(' | ')}；言情模式请用 --track novel --genre romance）`);
  if (genre === undefined) genre = 'general';
  if (!GENRES.includes(genre)) fail(`无效子模式 --genre "${genre}"（可选: ${GENRES.join(' | ')}）`);
  if (genre !== 'general' && track !== 'novel') fail(`--genre "${genre}" 仅支持 novel 赛道（言情模式用法: --track novel --genre romance）`);
  if (!MODES.includes(mode)) fail(`无效模式 --mode "${mode}"（可选: ${MODES.join(' | ')}）`);
  if (!/^\d+$/.test(a['target-words']) || +a['target-words'] <= 0) fail(`--target-words 必须为正整数（收到: "${a['target-words']}"）`);

  const wm = wmPath(dir);
  if (fs.existsSync(path.join(wm, 'state.json'))) fail(`该项目已初始化（${wm}/state.json 已存在），如需重来请先删除 .wm/ 目录`);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) fail(`路径存在但不是目录: ${dir}`);
  fs.mkdirSync(path.join(wm, 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(wm, 'summaries'), { recursive: true });
  fs.mkdirSync(path.join(wm, 'archive'), { recursive: true });

  const state = {
    track, mode, title, genre,
    target_words: +a['target-words'],
    part: 1, volume: 1, chapter: 0, total_words: 0,
    updated_at: nowISO(), stage: 'init',
    /* v1.2 章纲门禁：默认启用（无章纲不动笔，防长篇盲写跑偏）；--no-outline-gate 关闭 */
    outline_gate: a['no-outline-gate'] ? false : true
  };
  writeJSONFile(path.join(wm, 'state.json'), state);
  writeJSONFile(path.join(wm, 'parts.json'), { parts: [{ part: 1, start_ch: 1, end_ch: null, archived: false, start_total_words: 0 }] });
  writeNamesTable(dir, []);
  for (const [f, skeleton] of [
    ['characters.json', { items: [] }],
    ['foreshadow.json', { items: [] }],
    ['timeline.json', { events: [] }],
    ['suspense.json', { items: [] }],
    ['info-gap.json', { items: [] }],
    ['plotlines.json', { items: [] }]
  ]) writeJSONFile(ledgerFile(dir, f), skeleton);
  fs.writeFileSync(commitsLogPath(dir), '', 'utf8');

  p('✓ 项目初始化完成');
  p(`  目录: ${path.resolve(dir)}  (赛道=${trackLabel(state)}  引擎=${genre === 'romance' ? '言情v8.1' : '通用19节'}  模式=${mode})`);
  if (legacyRomance) p('  ⚠ 旧参数 --track romance 已废弃（v2.0 并入 novel 赛道言情模式），本次已按 --track novel --genre romance 处理，后续请使用新口径');
  p(`  标题: 《${title}》  目标体量: ${fmtNum(state.target_words)} 字`);
  p('  账本: state.json · parts.json · commits.log · ledger/{names.tsv, characters.json, foreshadow.json, timeline.json, suspense.json, info-gap.json, plotlines.json}');
  p('  目录: summaries/（章/部摘要） · archive/（归档部）');
  p(`  章纲门禁: ${state.outline_gate ? '已启用（context --task write 前须先 wm-outline.sh --save chapter 存章纲）' : '未启用（--no-outline-gate）'}`);
  p('  下一步: 运行 wm-context.sh --task plan 装配规划上下文');
}

/* ───────────────────────── wm-context ───────────────────────── */

const TASK_HINTS = {
  plan: '建议: 先盘点下方伏笔/情节线与目标体量，规划本部分章节奏，再 wm-context.sh --task write 进入写作。',
  write: '建议: 承接上一章 hook_type 继续；本章首次出现的名词必须在 wm-commit 的 names[] 里声明 new:true。',
  review: '建议: 完稿后运行 wm-review.sh --file <稿件.md> --chapter N，红色问题修复后再提交。',
  report: '建议: 进度数据如上；章摘要材料在 .wm/summaries/，部摘要为 part-N.md。'
};
const TASK_STAGE_RE = {
  plan: /plan|outline|negotiate|protocol|setup|设定/i,
  write: /write|draft|stage|chapter|正文/i,
  review: /review|check|gate|审查/i,
  report: /report|record|summar|总结/i
};

function ledgerOverviewLines(dir, baseCh, opts) {
  opts = opts || {};
  const cap = opts.cap != null ? opts.cap : 6;
  const lines = [];
  const names = readNamesTable(dir);
  lines.push(`专名表: ${names.length} 个` + (names.length ? `（${names.slice(0, 10).map(r => r.name).join('、')}${names.length > 10 ? ' 等' : ''}）` : '（尚未提交名词）'));

  const chars = loadLedger(dir, 'characters.json', 'items').items;
  const active = chars.filter(c => (c.status || 'active') === 'active');
  lines.push(`人物: 活跃 ${active.length} / 共 ${chars.length}` + (active.length ? ` — ${active.slice(0, 8).map(c => c.name).join('、')}` : ''));

  const fore = loadLedger(dir, 'foreshadow.json', 'items').items;
  const open = fore.filter(f => (f.status || 'open') === 'open');
  const parts = open.slice(0, cap).map(f => {
    const seen = f.last_seen_ch || f.planted_ch || 0;
    const warn = baseCh - seen > 12 ? ' ⚠超期未露' : '';
    return `${f.id} ${f.name}(埋于ch${f.planted_ch || '?'}, 末露ch${seen}${warn})`;
  });
  lines.push(`伏笔: 未回收 ${open.length} / 共 ${fore.length}` + (parts.length ? ` — ${parts.join(' | ')}` : ''));
  const overdue = open.filter(f => baseCh - (f.last_seen_ch || f.planted_ch || 0) > 12);
  for (const f of overdue.slice(0, 3)) {
    lines.push(`  ⚠ 伏笔超期预警: ${f.id} ${f.name} — 距上次露出已 ${baseCh - (f.last_seen_ch || f.planted_ch)} 章（阈值 12 章），本章必须露出或回收`);
  }

  const tl = loadLedger(dir, 'timeline.json', 'events').events;
  const recent = tl.slice(-5).map(e => `ch${e.chapter} ${String(e.event).slice(0, 30)}`);
  lines.push(`时间线: ${tl.length} 条` + (recent.length ? `（近: ${recent.join('；')}）` : ''));

  const sus = loadLedger(dir, 'suspense.json', 'items').items;
  const susOpen = sus.filter(s => (s.status || 'open') === 'open');
  lines.push(`悬念: 未解 ${susOpen.length} / 共 ${sus.length}` + (susOpen.length ? ` — ${susOpen.slice(0, 3).map(s => `${s.id} ${s.name}`).join(' | ')}` : ''));

  const gaps = loadLedger(dir, 'info-gap.json', 'items').items;
  const gapOpen = gaps.filter(g => (g.status || 'open') === 'open');
  lines.push(`信息差: 未闭合 ${gapOpen.length} / 共 ${gaps.length}` + (gapOpen.length ? ` — ${gapOpen.slice(0, 3).map(g => `${g.id} ${String(g.gap).slice(0, 24)}`).join(' | ')}` : ''));

  const pl = loadLedger(dir, 'plotlines.json', 'items').items;
  const plActive = pl.filter(x => (x.status || 'active') === 'active');
  lines.push(`情节线: 活跃 ${plActive.length} / 共 ${pl.length}` + (plActive.length ? ` — ${plActive.slice(0, 5).map(x => `${x.id} ${x.name}`).join(' | ')}` : ''));
  return lines;
}

function knowledgeSliceLines(scriptsDir, state, task, cap) {
  const toolRoot = path.dirname(scriptsDir);
  const idx = path.join(toolRoot, 'knowledge', 'index.json');
  if (!fs.existsSync(idx)) return ['◦ 知识切片索引未找到（knowledge/index.json），跳过切片推荐'];
  let items;
  try {
    items = JSON.parse(fs.readFileSync(idx, 'utf8'));
    if (!Array.isArray(items)) throw new Error('index.json 应为数组');
  } catch (e) { return [`◦ 知识切片索引不可用（${e.message}），跳过切片推荐`]; }
  /* v2.0 切片匹配：track + genre 双过滤。genre=romance 为言情模式专用切片；
   * 无 genre 字段的条目为赛道通用切片，对所有该 track 作品生效。 */
  const genre = state.genre || 'general';
  let matched = items.filter(it => (!it.track || it.track === state.track) && (!it.genre || it.genre === genre));
  const re = TASK_STAGE_RE[task] || null;
  const byStage = re ? matched.filter(it => it.stage && re.test(String(it.stage))) : [];
  if (byStage.length) matched = byStage;
  /* 言情模式：专用切片（genre=romance）优先展示，赛道通用切片殿后 */
  if (state.track === 'novel' && genre === 'romance') {
    matched = [...matched].sort((a, b) => ((b.genre === 'romance') ? 1 : 0) - ((a.genre === 'romance') ? 1 : 0));
  }
  if (!matched.length) return [`◦ 未找到适配「${trackLabel(state)}」的切片`];
  return matched.slice(0, cap).map(it =>
    `- ${it.id || '(无id)'} | ${it.file ? path.join('knowledge', String(it.file)) : '(路径未知)'} | ${it.words || '?'} 字` +
    (it.trigger ? ` | 触发: ${String(it.trigger).slice(0, 20)}` : ''));
}

function cmdContext(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  const state = loadState(dir);
  let task = a.task || 'write';
  if (!TASKS.includes(task)) fail(`无效 --task "${task}"（可选: ${TASKS.join(' | ')}）`);
  let baseCh = state.chapter + 1;
  if (a.chapter !== undefined) {
    if (!/^\d+$/.test(a.chapter) || +a.chapter < 1) fail(`--chapter 必须为正整数（收到: "${a.chapter}"）`);
    baseCh = +a.chapter;
  }
  let budget = 3000;
  if (a.budget !== undefined) {
    if (!/^\d+$/.test(a.budget) || +a.budget < 200) fail(`--budget 必须为 ≥200 的整数（收到: "${a.budget}"）`);
    budget = +a.budget;
  }

  /* v1.2 章纲门禁：outline_gate 启用时，task=write 必须先有本章章纲（无章纲不动笔） */
  const chOutlinePath = path.join(wmPath(dir), 'outlines', 'ch-' + String(baseCh).padStart(3, '0') + '.md');
  const chOutline = fs.existsSync(chOutlinePath) ? fs.readFileSync(chOutlinePath, 'utf8').trim() : null;
  if (state.outline_gate && task === 'write' && !chOutline) {
    p('⛔ BLOCKER: 本章章纲缺失（outline_gate 已启用）');
    p(`  焦点章节: 第 ${baseCh} 章 | 期望文件: .wm/outlines/ch-${String(baseCh).padStart(3, '0')}.md`);
    p('  修复: 先按赛道模板产出章纲，然后 bash wm-outline.sh --dir <目录> --save chapter --num ' + baseCh + ' --file <章纲.md>');
    p('  跳过: bash wm-outline.sh --dir <目录> --disable 关闭门禁（不建议长篇连载使用）');
    p('下一步建议: 补存章纲后重跑本命令（无章纲不动笔）');
    fail('章纲门禁拦截：无章纲不动笔');
  }

  const headLines = [
    `═══ WritingMaster 上下文装配 ═══`,
    `作品: 《${state.title}》 (${trackLabel(state)}/${state.mode}) | 阶段: ${state.stage}`,
    `任务: ${task} | 焦点章节: 第 ${baseCh} 章`
  ];
  const pct = state.target_words ? (state.total_words / state.target_words * 100) : 0;
  const progressLines = [
    '── 进度 ──',
    `第 ${state.part} 部 · 第 ${state.volume} 卷 · 已写 ${state.chapter} 章 | 字数 ${fmtNum(state.total_words)} / ${fmtNum(state.target_words)} (${pct.toFixed(2)}%)`
  ];

  /* v1.2 本章章纲（写作的直接依据，有则展示） */
  const outlineLines = ['── 本章章纲 ──'];
  if (chOutline) {
    const ol = chOutline.split(/\r?\n/);
    for (const l of (ol.length > 18 ? ol.slice(0, 18) : ol)) outlineLines.push('  ' + l);
    if (ol.length > 18) outlineLines.push(`  …（章纲共 ${ol.length} 行，全文: ${chOutlinePath}）`);
  } else {
    outlineLines.push(`  ◦ 未存章纲${state.outline_gate ? '' : '（outline_gate 未启用）'}`);
  }

  /* v1.2 写作记忆注入：最近 5 条与本书赛道相关的经验（跨章复用有效写法）
   * v2.0 语义：条目 track 为空/all → 通用注入；显式 genre（或旧 romance 标记）→ 仅同模式书注入。 */
  const memLines = ['── 写作记忆（最近沉淀，按需取用） ──'];
  let memN = 0;
  const memFile = path.join(wmPath(dir), 'memory.json');
  if (fs.existsSync(memFile)) {
    try {
      const mem = readJSONFile(memFile, 'memory.json');
      const entries = Array.isArray(mem.entries) ? mem.entries : [];
      const matched = entries.filter(e => {
        const rawTrack = String(e.track || '');
        const t = rawTrack === 'romance' ? 'novel' : rawTrack;
        if (t && t !== 'all' && t !== state.track) return false;
        const g = e.genre || (rawTrack === 'romance' ? 'romance' : '');
        if (g && g !== 'all' && g !== (state.genre || 'general')) return false;
        return true;
      }).slice(-5).reverse();
      for (const e of matched) {
        const lbl = e.track ? (e.track === 'romance' ? 'novel·言情' : e.track) : '';
        memLines.push(`  ◦ [${MEMORY_KIND_LABEL[e.kind] || e.kind || '经验'}] ${String(e.title).slice(0, 30)} — ${String(e.content).slice(0, 60)}${String(e.content).length > 60 ? '…' : ''}${lbl ? ` (${lbl})` : ''}`);
        memN++;
      }
    } catch (_) { /* 记忆损坏不阻塞装配 */ }
  }
  if (!memN) memLines.push('  ◦ 暂无写作记忆（用 bash wm-memory.sh --add 沉淀有效写法）');

  for (let level = 0; level <= 3; level++) {
    const secs = [['head', headLines], ['progress', progressLines]];
    if (level <= 1) secs.push(['outline', outlineLines]);
    if (level === 0) secs.push(['memory', memLines]);
    secs.push(['ledger', ['── 台账概览 ──', ...ledgerOverviewLines(dir, baseCh, { cap: level >= 2 ? 3 : 6 })]]);

    const chs = listChapterSummaries(dir);
    const focus = chs.filter(c => c < baseCh).slice(-3);
    let sumLines;
    if (!focus.length) {
      const parts2 = listPartSummaries(dir);
      sumLines = ['── 最近 3 章摘要 ──'];
      if (parts2.length) sumLines.push(`◦ 活跃区无章摘要（早期部已归档，部摘要: ${parts2.map(n => 'part-' + n + '.md').join('、')}）`);
      else sumLines.push('◦ 暂无章摘要（尚未开始写作或焦点章之前无记录）');
    } else {
      sumLines = ['── 最近 3 章摘要（ch' + focus[0] + '–ch' + focus[focus.length - 1] + '）──'];
      for (const c of focus) {
        const s = readSummaryFile(chapterSummaryPath(dir, c));
        if (!s) continue;
        sumLines.push(`[ch-${String(c).padStart(3, '0')}] ${s.one_line}`);
        if (s.hook_type) sumLines.push(`  hook: ${s.hook_type}`);
        if (level < 2 && s.changes) sumLines.push(`  changes: ${s.changes.slice(0, 60)}${s.changes.length > 60 ? '…' : ''}`);
      }
    }
    secs.push(['summaries', sumLines]);

    secs.push(['knowledge', [
      `── 推荐知识切片（task=${task}）──`,
      ...knowledgeSliceLines(__dirname, state, task, level >= 1 ? 5 : 10)
    ]]);
    secs.push(['hint', ['── 本次建议 ──', TASK_HINTS[task]]]);

    const text = secs.map(([, lines]) => lines.join('\n')).join('\n\n');
    if ([...text].length <= budget || level === 3) {
      p(text);
      if ([...text].length > budget) p(`…（输出超预算 ${budget} 字，已截断）`);
      else if (level > 0) p(`（输出预算 ${budget} 字，低优先级内容已压缩）`);
      p(`下一步: ${task === 'review' ? '修订稿件后重审，通过后 wm-commit.sh 提交事实增量。' : task === 'report' ? 'wm-status.sh 查看进度面板，或 wm-archive.sh 归档当前部。' : '写稿 → wm-review.sh 审查（--file 稿件 --chapter N）→ wm-commit.sh 提交事实增量。'}`);
      /* 状态尾锚点：供 Agent/MCP 解析的机读状态行 */
      p(`[state] ch=${baseCh} part=${state.part} vol=${state.volume} stage=${state.stage} words=${state.total_words}/${state.target_words}`);
      return;
    }
  }
}

/* ───────────────────────── wm-commit ───────────────────────── */

class CommitError extends Error {}
function cerr(msg) { throw new CommitError(msg); }
function vStr(o, k, where, opt) {
  const v = o[k];
  if (v === undefined || v === null) { if (opt) return undefined; cerr(`${where}.${k} 必须为非空字符串`); }
  if (typeof v !== 'string' || !v.trim()) cerr(`${where}.${k} 必须为非空字符串（收到: ${JSON.stringify(v)}）`);
  return v;
}
function vInt(o, k, where, opt) {
  const v = o[k];
  if (v === undefined || v === null) { if (opt) return undefined; cerr(`${where}.${k} 必须为非负整数`); }
  if (!Number.isInteger(v) || v < 0) cerr(`${where}.${k} 必须为非负整数（收到: ${JSON.stringify(v)}）`);
  return v;
}
function vEnum(o, k, where, values, opt) {
  const v = o[k];
  if (v === undefined || v === null) { if (opt) return undefined; cerr(`${where}.${k} 必填，可选: ${values.join(' | ')}`); }
  if (!values.includes(v)) cerr(`${where}.${k} 无效值 "${v}"（可选: ${values.join(' | ')}）`);
  return v;
}
function asArr(upd, k) {
  const v = upd[k];
  if (v === undefined) return [];
  if (!Array.isArray(v)) cerr(`字段 "${k}" 必须为数组（收到: ${JSON.stringify(v).slice(0, 40)}）`);
  return v;
}
function nextId(items, prefix) {
  let max = 0;
  for (const it of items) {
    const m = /^([A-Z]+)-(\d+)$/.exec(it.id || '');
    if (m && m[1] === prefix) max = Math.max(max, +m[2]);
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}
function upsertById(items, obj, prefix, where) {
  if (obj.id !== undefined) {
    if (typeof obj.id !== 'string' || !/^[A-Z]+-\d+$/.test(obj.id)) cerr(`${where}.id 格式应为如 "${prefix}-001"（收到: ${JSON.stringify(obj.id)}）`);
    const idx = items.findIndex(x => x.id === obj.id);
    if (idx < 0) cerr(`${where}.id 不存在: ${obj.id}（新增条目请省略 id，由系统自动分配）`);
    items[idx] = Object.assign({}, items[idx], obj);
    return { op: 'update', item: items[idx] };
  }
  const id = nextId(items, prefix);
  const rec = Object.assign({ id }, obj);
  items.push(rec);
  return { op: 'add', item: rec };
}

function cmdCommit(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  if (!fs.existsSync(a.file)) fail(`更新文件不存在: ${a.file}`);
  let upd;
  try { upd = JSON.parse(fs.readFileSync(a.file, 'utf8')); }
  catch (e) { fail(`更新文件不是合法 JSON: ${a.file}\n  ${e.message}`); }
  if (typeof upd !== 'object' || upd === null || Array.isArray(upd)) fail('更新文件必须为 JSON 对象');

  try {
    const ALLOWED = ['names', 'characters', 'foreshadow', 'timeline', 'suspense', 'info_gap', 'plotlines', 'summary', 'words_count'];
    for (const k of Object.keys(upd)) if (!ALLOWED.includes(k)) cerr(`无法识别的字段 "${k}"（允许: ${ALLOWED.join(', ')}）`);

    const state = loadState(dir);
    const notes = [];
    const chRef = (upd.summary && upd.summary.chapter) || state.chapter + 1;

    /* 1. 名词锁 */
    const namesTbl = readNamesTable(dir);
    const additions = [];
    for (let i = 0; i < asArr(upd, 'names').length; i++) {
      const item = asArr(upd, 'names')[i];
      if (typeof item !== 'object' || item === null || Array.isArray(item)) cerr(`names[${i}] 必须为对象`);
      const name = vStr(item, 'name', `names[${i}]`);
      if (/[\t\r\n]/.test(name)) cerr(`names[${i}].name 不能包含制表符或换行: "${name}"`);
      if ('new' in item && typeof item.new !== 'boolean') cerr(`names[${i}].new 必须为布尔值 true/false（收到: ${JSON.stringify(item.new)}）`);
      if ('type' in item && typeof item.type !== 'string') cerr(`names[${i}].type 必须为字符串`);
      if ('note' in item && typeof item.note !== 'string') cerr(`names[${i}].note 必须为字符串`);
      const exists = namesTbl.some(r => r.name === name);
      if (!exists) {
        if (item.new === true) additions.push({ name, type: item.type || 'other', first_chapter: chRef, note: item.note || '' });
        else cerr(`名词锁校验失败: "${name}" 不在专名表中。若是新名词，请在 names[] 中声明 "new":true 一并提交；若已存在，请核对拼写`);
      } else if (item.new === true) {
        notes.push(`"${name}" 已在专名表中，未重复添加`);
      }
    }
    const knownNames = new Set([...namesTbl.map(r => r.name), ...additions.map(r => r.name)]);

    /* 2. 人物 */
    const charsLedger = loadLedger(dir, 'characters.json', 'items');
    const charUpserts = [];
    const charsArr = asArr(upd, 'characters');
    for (let i = 0; i < charsArr.length; i++) {
      const c = charsArr[i];
      if (typeof c !== 'object' || c === null || Array.isArray(c)) cerr(`characters[${i}] 必须为对象`);
      const name = vStr(c, 'name', `characters[${i}]`);
      if (!knownNames.has(name)) cerr(`名词锁校验失败: 人物 "${name}" 未在专名表声明。请在本提交的 names[] 中加 {"name":"${name}","new":true}`);
      if ('aliases' in c) {
        if (!Array.isArray(c.aliases)) cerr(`characters[${i}].aliases 必须为字符串数组`);
        for (const al of c.aliases) {
          if (typeof al !== 'string' || !al.trim()) cerr(`characters[${i}].aliases 含非法项: ${JSON.stringify(al)}`);
          if (!knownNames.has(al)) cerr(`名词锁校验失败: 人物 "${name}" 的别名 "${al}" 未在专名表声明`);
        }
      }
      if ('status' in c) vEnum(c, 'status', `characters[${i}]`, ['active', 'offline', 'dead']);
      vInt(c, 'first_ch', `characters[${i}]`, true);
      vInt(c, 'last_ch', `characters[${i}]`, true);
      const cur = charsLedger.items.findIndex(x => x.name === name);
      const base = cur >= 0 ? charsLedger.items[cur] : { name, first_ch: chRef };
      const merged = Object.assign({}, base, c);
      if (!('status' in merged)) merged.status = 'active';
      merged.last_ch = Math.max(merged.last_ch || 0, chRef);
      if (cur >= 0) charsLedger.items[cur] = merged; else charsLedger.items.push(merged);
      charUpserts.push(name);
    }

    /* 3. 伏笔 */
    const foreLedger = loadLedger(dir, 'foreshadow.json', 'items');
    const foreOps = { add: 0, update: 0 };
    const foreArr = asArr(upd, 'foreshadow');
    for (let i = 0; i < foreArr.length; i++) {
      const f = foreArr[i];
      if (typeof f !== 'object' || f === null || Array.isArray(f)) cerr(`foreshadow[${i}] 必须为对象`);
      if (f.id === undefined) vStr(f, 'name', `foreshadow[${i}]`);  /* 新增必填；按 id 更新时可选（合并保留原值） */
      if ('status' in f) vEnum(f, 'status', `foreshadow[${i}]`, ['open', 'resolved', 'abandoned']);
      for (const k of ['planted_ch', 'last_seen_ch', 'due_ch', 'resolved_ch']) vInt(f, k, `foreshadow[${i}]`, true);
      if (f.id === undefined) {
        if (f.planted_ch === undefined) f.planted_ch = chRef;
        if (f.last_seen_ch === undefined) f.last_seen_ch = chRef;
        if (!('status' in f)) f.status = 'open';
      }
      const r = upsertById(foreLedger.items, f, 'F', `foreshadow[${i}]`);
      foreOps[r.op === 'add' ? 'add' : 'update']++;
    }

    /* 4. 时间线（追加） */
    const tlLedger = loadLedger(dir, 'timeline.json', 'events');
    const tlAdd = [];
    const tlArr = asArr(upd, 'timeline');
    for (let i = 0; i < tlArr.length; i++) {
      const t = tlArr[i];
      if (typeof t !== 'object' || t === null || Array.isArray(t)) cerr(`timeline[${i}] 必须为对象`);
      const ev = vStr(t, 'event', `timeline[${i}]`);
      const tch = vInt(t, 'chapter', `timeline[${i}]`);
      const rec = { id: nextId(tlLedger.events, 'T'), chapter: tch, event: ev };
      if (t.in_story_time !== undefined) rec.in_story_time = vStr(t, 'in_story_time', `timeline[${i}]`, true) || '';
      tlLedger.events.push(rec);
      tlAdd.push(rec);
    }

    /* 5. 悬念 */
    const susLedger = loadLedger(dir, 'suspense.json', 'items');
    const susOps = { add: 0, update: 0 };
    const susArr = asArr(upd, 'suspense');
    for (let i = 0; i < susArr.length; i++) {
      const s = susArr[i];
      if (typeof s !== 'object' || s === null || Array.isArray(s)) cerr(`suspense[${i}] 必须为对象`);
      if (s.id === undefined) vStr(s, 'name', `suspense[${i}]`);  /* 新增必填；按 id 更新时可选 */
      if ('status' in s) vEnum(s, 'status', `suspense[${i}]`, ['open', 'resolved']);
      for (const k of ['created_ch', 'resolved_ch']) vInt(s, k, `suspense[${i}]`, true);
      if (s.id === undefined && !('created_ch' in s)) s.created_ch = chRef;
      const r = upsertById(susLedger.items, s, 'S', `suspense[${i}]`);
      susOps[r.op === 'add' ? 'add' : 'update']++;
    }

    /* 6. 信息差 */
    const gapLedger = loadLedger(dir, 'info-gap.json', 'items');
    const gapOps = { add: 0, update: 0 };
    const gapArr = asArr(upd, 'info_gap');
    for (let i = 0; i < gapArr.length; i++) {
      const g = gapArr[i];
      if (typeof g !== 'object' || g === null || Array.isArray(g)) cerr(`info_gap[${i}] 必须为对象`);
      if (g.id === undefined) vStr(g, 'gap', `info_gap[${i}]`);  /* 新增必填；按 id 更新时可选 */
      if ('status' in g) vEnum(g, 'status', `info_gap[${i}]`, ['open', 'closed']);
      for (const k of ['created_ch', 'closed_ch']) vInt(g, k, `info_gap[${i}]`, true);
      if (g.id === undefined && !('created_ch' in g)) g.created_ch = chRef;
      const r = upsertById(gapLedger.items, g, 'G', `info_gap[${i}]`);
      gapOps[r.op === 'add' ? 'add' : 'update']++;
    }

    /* 7. 情节线 */
    const plLedger = loadLedger(dir, 'plotlines.json', 'items');
    const plOps = { add: 0, update: 0 };
    const plArr = asArr(upd, 'plotlines');
    for (let i = 0; i < plArr.length; i++) {
      const x = plArr[i];
      if (typeof x !== 'object' || x === null || Array.isArray(x)) cerr(`plotlines[${i}] 必须为对象`);
      if (x.id === undefined) vStr(x, 'name', `plotlines[${i}]`);  /* 新增必填；按 id 更新时可选 */
      if ('status' in x) vEnum(x, 'status', `plotlines[${i}]`, ['active', 'paused', 'ended']);
      for (const k of ['start_ch', 'end_ch']) vInt(x, k, `plotlines[${i}]`, true);
      if (x.id === undefined && !('start_ch' in x)) x.start_ch = chRef;
      const r = upsertById(plLedger.items, x, 'P', `plotlines[${i}]`);
      plOps[r.op === 'add' ? 'add' : 'update']++;
    }

    /* 8. 章摘要 */
    let summaryInfo = null;
    if (upd.summary !== undefined) {
      const s = upd.summary;
      if (typeof s !== 'object' || s === null || Array.isArray(s)) cerr('summary 必须为对象');
      const chapter = vInt(s, 'chapter', 'summary');
      if (chapter < 1) cerr(`summary.chapter 必须 ≥1（收到: ${chapter}）`);
      const one_line = vStr(s, 'one_line', 'summary');
      if ('hook_type' in s && typeof s.hook_type !== 'string') cerr('summary.hook_type 必须为字符串');
      if ('changes' in s && typeof s.changes !== 'string') cerr('summary.changes 必须为字符串');
      /* v1.2 三线标记（pacing 体检数据源）：quest=主线剧情 fire=感情线 constellation=世界观；留空=多线混合章。
       * 中文别名（主线/感情/世界观/剧情/设定/爱情…）自动归一化为标准值。 */
      if ('strand' in s && s.strand !== undefined && s.strand !== '') {
        const norm = normQueryStrand(s.strand);
        if (!STRANDS.includes(norm)) cerr(`summary.strand 无效值 "${s.strand}"（可选: ${STRANDS.join(' | ')} 或中文别名 主线/感情/世界观；允许留空表示多线混合章）`);
        s.strand = norm;
      }
      summaryInfo = {
        chapter, one_line,
        hook_type: s.hook_type || '', changes: s.changes || '',
        strand: (s.strand === undefined || s.strand === '') ? '' : s.strand
      };
    }

    /* 9. 字数 */
    let words = 0;
    if (upd.words_count !== undefined) {
      if (!Number.isInteger(upd.words_count) || upd.words_count < 0) cerr(`words_count 必须为非负整数（收到: ${JSON.stringify(upd.words_count)}）`);
      words = upd.words_count;
    }

    /* ── 校验全部通过，落盘（原子：以上任一步失败均未写盘） ── */
    for (const row of additions) appendNamesRow(dir, row);
    writeJSONFile(ledgerFile(dir, 'characters.json'), charsLedger);
    writeJSONFile(ledgerFile(dir, 'foreshadow.json'), foreLedger);
    writeJSONFile(ledgerFile(dir, 'timeline.json'), tlLedger);
    writeJSONFile(ledgerFile(dir, 'suspense.json'), susLedger);
    writeJSONFile(ledgerFile(dir, 'info-gap.json'), gapLedger);
    writeJSONFile(ledgerFile(dir, 'plotlines.json'), plLedger);
    if (summaryInfo) {
      const f = chapterSummaryPath(dir, summaryInfo.chapter);
      fs.writeFileSync(f, [
        `# 第 ${summaryInfo.chapter} 章`,
        ``,
        `- one_line: ${summaryInfo.one_line}`,
        `- hook_type: ${summaryInfo.hook_type}`,
        `- changes: ${summaryInfo.changes}`,
        `- strand: ${summaryInfo.strand || ''}`
      ].join('\n') + '\n', 'utf8');
    }
    const prevTotal = state.total_words;
    state.total_words += words;
    if (summaryInfo) state.chapter = Math.max(state.chapter, summaryInfo.chapter);
    state.stage = 'writing';
    saveState(dir, state);

    const seq = nextCommitSeq(dir);
    const parts = [`commit #${seq} ch=${summaryInfo ? summaryInfo.chapter : chRef}`];
    if (additions.length) parts.push(`names+${additions.length}(${additions.map(r => r.name + '*').join(',')})`);
    if (charUpserts.length) parts.push(`characters+${charUpserts.length}(${charUpserts.join(',')})`);
    if (foreOps.add + foreOps.update) parts.push(`foreshadow+${foreOps.add},upd${foreOps.update}`);
    if (tlAdd.length) parts.push(`timeline+${tlAdd.length}`);
    if (susOps.add + susOps.update) parts.push(`suspense+${susOps.add},upd${susOps.update}`);
    if (gapOps.add + gapOps.update) parts.push(`info_gap+${gapOps.add},upd${gapOps.update}`);
    if (plOps.add + plOps.update) parts.push(`plotlines+${plOps.add},upd${plOps.update}`);
    parts.push(`words+${words} total=${state.total_words}`);
    if (summaryInfo) parts.push(`one_line=${summaryInfo.one_line.slice(0, 40)}`);
    appendLog(dir, parts.join(' '));

    p(`✓ 提交完成（commit #${seq}）`);
    if (additions.length) p(`  新名词: ${additions.map(r => `${r.name}(${r.type}, ch${r.first_chapter})*`).join('、')}`);
    for (const n of notes) p(`  注: ${n}`);
    p(`  人物 ${charUpserts.length} · 伏笔 +${foreOps.add}/改${foreOps.update} · 时间线 +${tlAdd.length} · 悬念 +${susOps.add}/改${susOps.update} · 信息差 +${gapOps.add}/改${gapOps.update} · 情节线 +${plOps.add}/改${plOps.update}`);
    if (summaryInfo) p(`  章摘要: .wm/summaries/ch-${String(summaryInfo.chapter).padStart(3, '0')}.md（${summaryInfo.one_line}）`);
    if (words) p(`  字数: +${fmtNum(words)} → 累计 ${fmtNum(state.total_words)}（原 ${fmtNum(prevTotal)}）`);
    p('  下一步: wm-review.sh 审查稿件（如未审），或 wm-context.sh --task write 装配下一章上下文');
  } catch (e) {
    if (e instanceof CommitError) fail('提交被拒绝（未写入任何数据）: ' + e.message);
    throw e;
  }
}

/* ───────────────────────── wm-review ───────────────────────── */

function loadBlacklist(dir) {
  const list = [...DEFAULT_BLACKLIST];
  const f = path.join(wmPath(dir), 'review-blacklist.txt');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (!list.includes(t)) list.push(t);
    }
  }
  return list;
}

function extractProse(raw) {
  let txt = raw;
  if (txt.startsWith('\uFEFF')) txt = txt.slice(1);
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(txt);
  if (fm) txt = txt.slice(fm[0].length);
  const out = [];
  let inCode = false;
  for (let l of txt.split(/\r?\n/)) {
    if (/^\s*```/.test(l)) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (/^\s*---\s*$/.test(l)) continue;
    if (/^\s*#{1,6}\s/.test(l)) continue;
    l = l.replace(/^\s*[-*+]\s+/, '').replace(/^\s*>\s?/, '');
    out.push(l);
  }
  return out.join('\n');
}

function splitSentences(prose) {
  const sents = [];
  for (const para of prose.split(/\n+/)) {
    for (const s of para.split(/(?<=[。！？!?；;])/)) {
      const t = s.trim();
      if (!t || !CJK_RE.test(t)) continue;
      sents.push(t);
    }
  }
  return sents;
}

function edAtMost1(a, b) {
  const A = Array.from(a), B = Array.from(b);
  if (Math.abs(A.length - B.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (A.length === B.length) { i++; j++; }
    else if (A.length > B.length) i++;
    else j++;
  }
  diff += (A.length - i) + (B.length - j);
  return diff === 1;
}

function nearMissScan(text, names) {
  const found = [];
  const seen = new Set();
  const nameSet = new Set(names.map(n => n.name));
  /* 只在连续 CJK 字符流上取窗口：引号/换行/标点等噪声字符不得参与疑似笔误比对 */
  const chars = Array.from(text.slice(0, 30000).replace(/[^\u4e00-\u9fff]/g, ''));
  /* 标记被已知名词正确出现覆盖的字符位：与正确出现重叠的窗口不参与疑似笔误比对
     （否则"林昭推开"中的"昭推"、"若隐若现+昭儿"拼接出的"现昭"都会被误判为笔误） */
  const covered = new Array(chars.length).fill(false);
  for (const nm of nameSet) {
    const arr = Array.from(nm);
    if (arr.length < 1) continue;
    for (let i = 0; i + arr.length <= chars.length; i++) {
      let ok = true;
      for (let k = 0; k < arr.length; k++) if (chars[i + k] !== arr[k]) { ok = false; break; }
      if (ok) for (let k = 0; k < arr.length; k++) covered[i + k] = true;
    }
  }
  for (const n of names) {
    const nc = Array.from(n.name);
    const L = nc.length;
    if (L < 2 || L > 6) continue;
    for (let wlen = Math.max(1, L - 1); wlen <= L + 1; wlen++) {
      for (let i = 0; i + wlen <= chars.length; i++) {
        /* 单编辑距离下至少一端字符保持不变，先做廉价预筛 */
        if (chars[i] !== nc[0] && chars[i + wlen - 1] !== nc[L - 1]) continue;
        /* 窗口与某个已知名词的正确出现重叠：该处名词拼写正确，非笔误 */
        let overlap = false;
        for (let k = i; k < i + wlen; k++) if (covered[k]) { overlap = true; break; }
        if (overlap) continue;
        const w = chars.slice(i, i + wlen).join('');
        if (!CJK_RE.test(w) || nameSet.has(w) || seen.has(w)) continue;
        /* 窗口本身包含名词（如"林昭"后接动词"林昭推"）：是名词的延伸词组，非笔误 */
        if (w.includes(n.name)) continue;
        let substringOfKnown = false;
        for (const nm of nameSet) { if (nm.length > w.length && nm.includes(w)) { substringOfKnown = true; break; } }
        if (substringOfKnown) continue;
        if (edAtMost1(w, n.name)) {
          seen.add(w);
          found.push({ word: w, near: n.name });
          if (found.length >= 5) return found;
        }
      }
    }
  }
  return found;
}

function cmdReview(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  const state = loadState(dir);
  if (!fs.existsSync(a.file)) fail(`稿件文件不存在: ${a.file}`);
  let chapter = state.chapter + 1;
  if (a.chapter !== undefined) {
    if (!/^\d+$/.test(a.chapter) || +a.chapter < 1) fail(`--chapter 必须为正整数（收到: "${a.chapter}"）`);
    chapter = +a.chapter;
  }
  const raw = fs.readFileSync(a.file, 'utf8');
  const prose = extractProse(raw);
  const proseChars = Array.from(prose.replace(/\s/g, '')).length;
  const issues = [];
  const push = (sev, tag, msg) => issues.push({ sev, tag, msg });

  /* 1. AI味/书面腔黑名单 */
  const blacklist = loadBlacklist(dir);
  let blHits = 0;
  for (const term of blacklist) {
    let idx = prose.indexOf(term), count = 0, firstCtx = '';
    while (idx >= 0) {
      count++;
      if (!firstCtx) firstCtx = prose.slice(Math.max(0, idx - 10), idx + term.length + 10).replace(/\n/g, '␤');
      idx = prose.indexOf(term, idx + term.length);
    }
    if (count) { blHits += count; push('red', '黑名单', `AI味/书面腔词 "${term}" ×${count} — …${firstCtx}…`); }
    if (blHits >= 10) break;
  }

  /* 2. 超长句（>40字） */
  const sents = splitSentences(prose);
  const longs = sents.filter(s => Array.from(s.replace(/\s/g, '')).length > 40);
  const longSev = longs.length >= 4 ? 'red' : 'yellow';
  if (longs.length) {
    const sample = longs.slice(0, 5).map(s => `「${s.slice(0, 24)}…」(${Array.from(s).length}字)`).join(' ');
    push(longSev, '句长', `${longs.length} 个超过 40 字的长句${longs.length >= 4 ? '（≥4 个，判红）' : '（提醒）'}: ${sample}`);
  }

  /* 3. 英文字母 */
  const en = prose.match(/[A-Za-z]+/g) || [];
  if (en.length) {
    const uniq = [...new Set(en)].slice(0, 10);
    push('red', '英文字母', `检测到 ${en.length} 处英文（示例: ${uniq.join(', ')}），正文应为纯中文`);
  }

  /* 4. 繁体字 */
  const tradUniq = [];
  for (const c of prose) if (TRADITIONAL.has(c) && !tradUniq.includes(c)) tradUniq.push(c);
  if (tradUniq.length) push('red', '繁体字', `检测到繁体字 ${tradUniq.length} 种: ${tradUniq.slice(0, 20).join(' ')}，请转为简体`);

  /* 5. 标点规范 */
  const dots = prose.match(/\.{2,}/g) || [];
  if (dots.length) push('red', '标点', `省略号不规范: 出现 "${dots[0]}"（应为中文省略号 ……）`);
  const dts = prose.match(/。{2,}/g) || [];
  if (dts.length) push('red', '标点', `省略号不规范: 句号连用 "${dts[0]}"（应为 ……）`);
  const ell = (prose.match(/…/g) || []).length;
  if (ell % 2 === 1) push('red', '标点', `省略号 …… 未成对使用（共 ${ell} 个 …，省略号应为两个 …… 连用）`);
  const hyph = prose.match(/-{2,}/g) || [];
  if (hyphs(hyph)) push('red', '标点', `破折号不规范: 出现 "${hyph[0]}"（应为 ——）`);
  const em = (prose.match(/—/g) || []).length;
  if (em % 2 === 1) push('red', '标点', `破折号 — 数量为奇数（${em}），破折号应成对为 ——`);
  for (const [l, r, nm] of [['\u201c', '\u201d', '双引号 “”'], ['\u2018', '\u2019', '单引号 ‘’'], ['「', '」', '直角引号 「」'], ['『', '』', '二级引号 『』']]) {
    const cl = prose.split(l).length - 1, cr = prose.split(r).length - 1;
    if (cl !== cr) push('red', '标点', `${nm} 不配对: 左 ${cl} 个 / 右 ${cr} 个`);
  }

  /* 6. 专名对照（锁表） */
  const names = readNamesTable(dir);
  for (const n of nearMissScan(prose, names)) push('red', '专名对照', `疑似专名笔误: 稿中 "${n.word}" 接近表内名词 "${n.near}"，请核对`);
  const quoted = [];
  let qm;
  /* 名词性引号内容：≤12 字且不含标点（对白/整句含标点，不视为专有名词，防误报噪音） */
  const qre = /[「“]([^「”」]{1,12})[」”]/g;
  while ((qm = qre.exec(prose)) !== null) {
    if (!/[，。！？；：、…—,.!?;:]/.test(qm[1]) && !quoted.includes(qm[1])) quoted.push(qm[1]);
    if (quoted.length >= 5) break;
  }
  const bookQ = [];
  const bre = /《([^《》]{1,12})》/g;
  while ((qm = bre.exec(prose)) !== null) {
    if (!bookQ.includes(qm[1])) bookQ.push(qm[1]);
    if (bookQ.length >= 5) break;
  }
  const nameSet = new Set(names.map(n => n.name));
  for (const q of [...quoted, ...bookQ]) {
    if (!nameSet.has(q) && CJK_RE.test(q)) push('yellow', '专名对照', `引号名词 "${q}" 不在专名表中；若是新名词，提交时请在 names[] 声明 new:true`);
  }

  /* 7. 伏笔超期预警（距上次露出 > 12 章） */
  const fore = loadLedger(dir, 'foreshadow.json', 'items').items;
  for (const f of fore) {
    if ((f.status || 'open') !== 'open') continue;
    const seen = f.last_seen_ch || f.planted_ch || 0;
    if (chapter - seen > 12) {
      push('red', '伏笔超期', `${f.id} ${f.name} — 埋于 ch${f.planted_ch || '?'}，末次露出 ch${seen}，已 ${chapter - seen} 章未露（阈值 12 章），本章须露出或回收`);
    }
  }

  /* 8. 前章钩子承接提醒 */
  let hookLine = null;
  if (chapter > 1) {
    const s = readSummaryFile(findChapterSummaryPath(dir, chapter - 1));
    if (s) hookLine = `前章(ch${chapter - 1}) hook_type=${s.hook_type || '(未填)'} | one_line: ${s.one_line || '(未填)'} — 请确保本章承接`;
    else hookLine = `前章(ch${chapter - 1}) 摘要缺失，无法提供钩子承接提醒`;
  }

  /* ── 输出 ── */
  p('═══ WritingMaster 机械审查门禁 ═══');
  p(`稿件: ${a.file} | 审查章节: 第 ${chapter} 章（第 ${state.part} 部）| 正文字数: ${fmtNum(proseChars)}`);
  p('');
  p('── 审查发现 ──');
  if (!issues.length) p('◦ 无红/黄级问题');
  issues.sort((x, y) => (x.sev === 'red' ? 0 : 1) - (y.sev === 'red' ? 0 : 1));
  for (const it of issues) p(`[${it.sev === 'red' ? '红' : '黄'}|${it.tag}] ${it.msg}`);
  if (hookLine) p(`[提醒|钩子承接] ${hookLine}`);
  const reds = issues.filter(i => i.sev === 'red').length;
  const yellows = issues.filter(i => i.sev === 'yellow').length;
  p('');
  if (reds) {
    p(`结论: 【打回】（红 ${reds} 项，黄 ${yellows} 项）`);
    p('请修复红色问题后重审；黄色为提醒，酌情处理。');
    p('下一步: 修订稿件后重新运行 wm-review.sh，通过后 wm-commit.sh 提交事实。');
    process.exit(1);
  }
  p(`结论: 【通过】（红 0 项，黄 ${yellows} 项）`);
  p('下一步: wm-commit.sh 提交本章事实增量（names/summary/words_count 等）。');
}
function hyphs(h) { return Array.isArray(h) && h.length > 0; }

/* ───────────────────────── wm-status ───────────────────────── */

function cmdStatus(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  const state = loadState(dir);
  const pct = state.target_words ? state.total_words / state.target_words * 100 : 0;
  const filled = Math.min(20, Math.round(pct / 5));

  p('═══ WritingMaster 进度面板 ═══');
  p(`作品: 《${state.title}》 | 赛道: ${trackLabel(state)} | 模式: ${state.mode} | 阶段: ${state.stage}`);
  p(`进度: 第 ${state.part} 部 · 第 ${state.volume} 卷 · 已写 ${state.chapter} 章`);
  p(`字数: ${fmtNum(state.total_words)} / ${fmtNum(state.target_words)} (${pct.toFixed(2)}%)`);
  p(`[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}]`);
  p('');
  p('── 台账健康 ──');

  const lines = [];
  lines.push(['state.json', '绿', `有效（章节 ${state.chapter}，阶段 ${state.stage}）`]);

  const names = readNamesTable(dir);
  const dup = names.length !== new Set(names.map(n => n.name)).size;
  lines.push(['names.tsv 专名表', dup ? '红' : names.length ? '绿' : '黄', dup ? '存在重名条目' : names.length ? `${names.length} 个名词` : '空（尚未提交名词）']);

  const chars = loadLedger(dir, 'characters.json', 'items').items;
  const active = chars.filter(c => (c.status || 'active') === 'active').length;
  lines.push(['characters.json', chars.length ? '绿' : '黄', `活跃 ${active} / 共 ${chars.length}`]);

  const fore = loadLedger(dir, 'foreshadow.json', 'items').items;
  const open = fore.filter(f => (f.status || 'open') === 'open');
  const overdue = open.filter(f => (state.chapter + 1) - (f.last_seen_ch || f.planted_ch || 0) > 12);
  const soon = open.filter(f => { const g = (state.chapter + 1) - (f.last_seen_ch || f.planted_ch || 0); return g > 6 && g <= 12; });
  lines.push(['foreshadow.json', overdue.length ? '红' : soon.length ? '黄' : '绿',
    `未回收 ${open.length} / 共 ${fore.length}` + (overdue.length ? ` ⚠超期 ${overdue.length} 个（${overdue.slice(0, 3).map(f => f.id).join(',')}）` : soon.length ? `（${soon.length} 个接近阈值）` : '')]);

  const tl = loadLedger(dir, 'timeline.json', 'events').events;
  lines.push(['timeline.json', tl.length ? '绿' : '黄', `${tl.length} 条时间线`]);

  const sus = loadLedger(dir, 'suspense.json', 'items').items;
  lines.push(['suspense.json', sus.length ? '绿' : '黄', `未解 ${sus.filter(s => (s.status || 'open') === 'open').length} / 共 ${sus.length}`]);

  const gaps = loadLedger(dir, 'info-gap.json', 'items').items;
  lines.push(['info-gap.json', gaps.length ? '绿' : '黄', `未闭合 ${gaps.filter(g => (g.status || 'open') === 'open').length} / 共 ${gaps.length}`]);

  const pl = loadLedger(dir, 'plotlines.json', 'items').items;
  lines.push(['plotlines.json', pl.length ? '绿' : '黄', `活跃 ${pl.filter(x => (x.status || 'active') === 'active').length} / 共 ${pl.length}`]);

  const chs = listChapterSummaries(dir);
  const all = [...new Set([...chs, ...archivedChapterSet(dir)])].sort((x, y) => x - y);
  const missing = [];
  for (let c = 1; c <= state.chapter; c++) if (!all.includes(c)) missing.push(c);
  const sumLight = missing.length ? '红' : '绿';
  lines.push(['summaries/ 摘要', sumLight, state.chapter === 0 ? '尚无章节' : `章摘要 ${all.length} 份` + (missing.length ? ` ⚠缺失: ch-${missing.slice(0, 8).join(',ch-')}${missing.length > 8 ? '…' : ''}` : '')]);

  let logLines = 0;
  if (fs.existsSync(commitsLogPath(dir))) logLines = fs.readFileSync(commitsLogPath(dir), 'utf8').split(/\r?\n/).filter(Boolean).length;
  lines.push(['commits.log', logLines ? '绿' : state.chapter ? '黄' : '绿', `${logLines} 条流水`]);

  for (const [k, l, msg] of lines) p(`  ${k.padEnd(18)} [${l}灯] ${msg}`);
  p('');
  const remWords = Math.max(0, state.target_words - state.total_words);
  p(`── 距离目标体量还有 ${fmtNum(remWords)} 字（约 ${state.target_words ? Math.ceil(remWords / 2400) : 0} 章 @2400字/章）──`);
  p('下一步建议: 运行 wm-context.sh --task write 装配写作上下文');
}

/* ───────────────────────── wm-archive ───────────────────────── */

function loadParts(dir) {
  const f = path.join(wmPath(dir), 'parts.json');
  if (!fs.existsSync(f)) fail(`缺少 ${f}（项目结构不完整，请运行 wm-doctor.sh 体检）`);
  const o = readJSONFile(f, 'parts.json');
  if (!o || !Array.isArray(o.parts) || !o.parts.length) fail('parts.json 结构错误（缺少 parts 数组）');
  return o;
}

function cmdArchive(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  if (!/^\d+$/.test(a.part) || +a.part < 1) fail(`--part 必须为正整数（收到: "${a.part}"）`);
  const N = +a.part;
  const state = loadState(dir);
  const partsObj = loadParts(dir);
  const part = partsObj.parts.find(x => x.part === N);
  if (!part) fail(`第 ${N} 部不存在（当前共 ${partsObj.parts.length} 部）`);
  if (part.archived) fail(`第 ${N} 部已归档过，请勿重复归档`);
  if (N !== state.part) fail(`当前在第 ${state.part} 部，只能归档当前部（第 ${N} 部不是当前部）`);
  const endCh = state.chapter;
  const startCh = part.start_ch;
  if (state.chapter < startCh) fail(`第 ${N} 部尚无章节（起于 ch${startCh}，当前进度 ch${state.chapter}），无可归档内容`);

  const archDir = path.join(wmPath(dir), 'archive', `part-${N}`);
  fs.mkdirSync(path.join(archDir, 'summaries'), { recursive: true });

  /* 伏笔清点 */
  const fore = loadLedger(dir, 'foreshadow.json', 'items');
  const carried = fore.items.filter(f => (f.status || 'open') === 'open');
  const resolvedFore = fore.items.filter(f => f.status === 'resolved' && (f.resolved_ch || 0) <= endCh);

  /* 摘要迁移 */
  let movedSummaries = 0;
  for (const c of listChapterSummaries(dir)) {
    if (c >= startCh && c <= endCh) {
      fs.renameSync(chapterSummaryPath(dir, c), path.join(archDir, 'summaries', 'ch-' + String(c).padStart(3, '0') + '.md'));
      movedSummaries++;
    }
  }

  /* 台账压缩：按章范围移入归档 */
  const tl = loadLedger(dir, 'timeline.json', 'events');
  const tlMove = tl.events.filter(e => e.chapter <= endCh);
  tl.events = tl.events.filter(e => e.chapter > endCh);
  writeJSONFile(ledgerFile(dir, 'timeline.json'), tl);
  writeJSONFile(path.join(archDir, 'timeline.json'), { events: tlMove });

  writeJSONFile(path.join(archDir, 'foreshadow.json'), { items: resolvedFore });
  fore.items = fore.items.filter(f => !(f.status === 'resolved' && (f.resolved_ch || 0) <= endCh));
  writeJSONFile(ledgerFile(dir, 'foreshadow.json'), fore);

  const sus = loadLedger(dir, 'suspense.json', 'items');
  const susMove = sus.items.filter(s => s.status === 'resolved' && (s.resolved_ch || 0) <= endCh);
  sus.items = sus.items.filter(s => !(s.status === 'resolved' && (s.resolved_ch || 0) <= endCh));
  writeJSONFile(ledgerFile(dir, 'suspense.json'), sus);
  writeJSONFile(path.join(archDir, 'suspense.json'), { items: susMove });

  const gap = loadLedger(dir, 'info-gap.json', 'items');
  const gapMove = gap.items.filter(g => g.status === 'closed' && (g.closed_ch || 0) <= endCh);
  gap.items = gap.items.filter(g => !(g.status === 'closed' && (g.closed_ch || 0) <= endCh));
  writeJSONFile(ledgerFile(dir, 'info-gap.json'), gap);
  writeJSONFile(path.join(archDir, 'info-gap.json'), { items: gapMove });

  const chars = loadLedger(dir, 'characters.json', 'items');
  const charMove = chars.items.filter(c => (c.status || 'active') !== 'active');
  chars.items = chars.items.filter(c => (c.status || 'active') === 'active');
  writeJSONFile(ledgerFile(dir, 'characters.json'), chars);
  writeJSONFile(path.join(archDir, 'characters.json'), { items: charMove });

  const pl = loadLedger(dir, 'plotlines.json', 'items');
  const plMove = pl.items.filter(x => x.status === 'ended' && (x.end_ch || 0) <= endCh);
  pl.items = pl.items.filter(x => !(x.status === 'ended' && (x.end_ch || 0) <= endCh));
  writeJSONFile(ledgerFile(dir, 'plotlines.json'), pl);
  writeJSONFile(path.join(archDir, 'plotlines.json'), { items: plMove });

  /* 部摘要模板 */
  const partWords = state.total_words - (part.start_total_words || 0);
  const tpl = [
    `# 第 ${N} 部总结（ch${startCh}–ch${endCh}）`,
    '',
    '<!-- 本模板由 wm-archive 自动生成，"待填"字段需人工补全；整份部摘要请保持在 15 行以内 -->',
    '',
    `- 本部字数: ${fmtNum(partWords)}（累计 ${fmtNum(state.total_words)}）`,
    `- 未回收伏笔（带入下部）: ${carried.length ? carried.map(f => `${f.id} ${f.name}(埋于ch${f.planted_ch || '?'}, 末露ch${f.last_seen_ch || f.planted_ch || '?'})`).join('；') : '无'}`,
    `- 活跃人物: ${chars.items.map(c => c.name).join('、') || '无'}`,
    `- 主题与主要事件: <!-- 待填 -->`,
    `- 人物核心变化: <!-- 待填 -->`,
    `- 情节线推进: <!-- 待填 -->`,
    `- 悬念/信息差交接: <!-- 待填 -->`,
    `- 下部注意事项: <!-- 待填 -->`
  ].join('\n');
  fs.writeFileSync(path.join(wmPath(dir), 'summaries', `part-${N}.md`), tpl + '\n', 'utf8');

  /* 更新部索引与状态 */
  part.archived = true;
  part.end_ch = endCh;
  partsObj.parts.push({ part: N + 1, start_ch: endCh + 1, end_ch: null, archived: false, start_total_words: state.total_words });
  writeJSONFile(path.join(wmPath(dir), 'parts.json'), partsObj);
  state.part = N + 1;
  state.stage = 'archived';
  saveState(dir, state);

  appendLog(dir, `archive part=${N} chapters=${startCh}-${endCh} moved(summaries=${movedSummaries},timeline=${tlMove.length},foreshadow=${resolvedFore.length},suspense=${susMove.length},info_gap=${gapMove.length},characters=${charMove.length},plotlines=${plMove.length}) open_foreshadow_carried=${carried.length} part_words=${partWords}`);

  p(`✓ 第 ${N} 部归档完成（ch${startCh}–ch${endCh}）`);
  p(`  摘要迁移: ${movedSummaries} 份章摘要 → .wm/archive/part-${N}/summaries/`);
  p(`  活跃区压缩: 时间线 -${tlMove.length} → 剩 ${tl.events.length} | 伏笔 -${resolvedFore.length} → 剩 ${fore.items.length} | 悬念 -${susMove.length} | 信息差 -${gapMove.length} | 离场人物 -${charMove.length} | 已完情节线 -${plMove.length}`);
  p(`  本部字数: ${fmtNum(partWords)}`);
  if (carried.length) {
    p(`  ⚠ 未回收伏笔清点（${carried.length} 个带入第 ${N + 1} 部）:`);
    for (const f of carried) p(`    - ${f.id} ${f.name}（埋于 ch${f.planted_ch || '?'}，末露 ch${f.last_seen_ch || f.planted_ch || '?'}）`);
    p('    请在下部安排露出或回收，超 12 章未露将在审查时被打回。');
  } else p('  伏笔清点: 本部伏笔全部回收，无携带');
  p(`  部摘要模板已生成: .wm/summaries/part-${N}.md（请人工补全"待填"字段，保持 ≤15 行）`);
  p(`  当前进入: 第 ${N + 1} 部（起于 ch${endCh + 1}）`);
  p('  下一步: wm-restore.sh 生成续作恢复包，或 wm-context.sh --task plan 规划下部');
}

/* ───────────────────────── wm-restore ───────────────────────── */

function integrityCheck(dir) {
  const problems = [];
  const wm = wmPath(dir);
  const need = ['state.json', 'parts.json', 'commits.log', 'ledger/names.tsv', 'ledger/characters.json', 'ledger/foreshadow.json', 'ledger/timeline.json', 'ledger/suspense.json', 'ledger/info-gap.json', 'ledger/plotlines.json'];
  for (const rel of need) {
    if (!fs.existsSync(path.join(wm, rel))) problems.push(`缺失文件: .wm/${rel}`);
  }
  if (problems.length) return problems;
  for (const rel of ['state.json', 'parts.json', 'ledger/characters.json', 'ledger/foreshadow.json', 'ledger/timeline.json', 'ledger/suspense.json', 'ledger/info-gap.json', 'ledger/plotlines.json']) {
    try { JSON.parse(fs.readFileSync(path.join(wm, rel), 'utf8')); }
    catch (e) { problems.push(`JSON 损坏: .wm/${rel}（${e.message}）`); }
  }
  try {
    const st = readJSONFile(path.join(wm, 'state.json'), 'state.json');
    for (const k of ['track', 'title', 'target_words', 'part', 'chapter', 'total_words']) {
      if (st[k] === undefined) problems.push(`state.json 缺少字段: ${k}`);
    }
    const po = readJSONFile(path.join(wm, 'parts.json'), 'parts.json');
    if (!Array.isArray(po.parts) || !po.parts.length) problems.push('parts.json 缺少 parts 数组');
    else {
      for (let i = 0; i < po.parts.length; i++) {
        const exp = i === 0 ? 1 : po.parts[i - 1].end_ch + 1;
        if (po.parts[i].start_ch !== exp) problems.push(`parts.json 第 ${i + 1} 个部条目 start_ch=${po.parts[i].start_ch}，应为 ${exp}（部区间不连续）`);
      }
    }
  } catch (e) { /* 已在上面报过 */ }
  return problems;
}

function cmdRestore(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  const problems = integrityCheck(dir);
  const state = loadState(dir);

  p('═══ WritingMaster 断点恢复包 ═══');
  p(`生成时间: ${nowISO()}`);
  p('');
  if (problems.length) {
    p('── 完整性问题（恢复中止）──');
    for (const x of problems) p(`  ✗ ${x}`);
    p('');
    p('结论: 账本不完整，无法无损续作。请先运行 wm-doctor.sh 逐项修复。');
    process.exit(1);
  }
  p('── 账本完整性: 通过 ──');
  p('');
  p('── 当前状态 ──');
  p(`  作品: 《${state.title}》（${trackLabel(state)}/${state.mode}）| 阶段: ${state.stage}`);
  p(`  第 ${state.part} 部 · 第 ${state.volume} 卷 · 已写 ${state.chapter} 章 | 字数 ${fmtNum(state.total_words)} / ${fmtNum(state.target_words)}（${(state.total_words / state.target_words * 100).toFixed(2)}%）`);
  const partsObj = loadParts(dir);
  const cur = partsObj.parts.find(x => x.part === state.part);
  if (cur) p(`  当前部范围: 自 ch${cur.start_ch} 起（未归档）`);
  p('');
  p('── 台账现状 ──');
  for (const l of ledgerOverviewLines(dir, state.chapter + 1, { cap: 5 })) p('  ' + l);
  p('');
  const chs = listChapterSummaries(dir);
  const last3 = chs.slice(-3);
  p('── 最近章摘要 ──');
  if (!last3.length) {
    const ps = listPartSummaries(dir);
    if (ps.length) p(`  ○ 活跃区无章摘要（部摘要: ${ps.map(n => 'part-' + n + '.md').join('、')}）`);
    else p('  ○ 暂无');
  }
  for (const c of last3) {
    const s = readSummaryFile(chapterSummaryPath(dir, c));
    p(`  [ch-${String(c).padStart(3, '0')}] ${s ? s.one_line : '(摘要文件存在但内容异常)'}${s && s.hook_type ? `（hook: ${s.hook_type}）` : ''}`);
  }
  p('');
  let logTail = [];
  if (fs.existsSync(commitsLogPath(dir))) logTail = fs.readFileSync(commitsLogPath(dir), 'utf8').split(/\r?\n/).filter(Boolean).slice(-5);
  p('── 最近提交 ──');
  if (!logTail.length) p('  ○ 暂无提交');
  for (const l of logTail) p('  ' + l);
  p('');
  p('── 续作指引 ──');
  p(`  下一步: 写第 ${state.chapter + 1} 章。建议顺序: wm-context.sh --task write → 写稿 → wm-review.sh --file <稿件> --chapter ${state.chapter + 1} → wm-commit.sh 提交事实。`);
  p('  恢复完毕，本包可作为新会话的启动上下文。');
}

/* ───────────────────────── wm-doctor ───────────────────────── */

function cmdDoctor(a) {
  const dir = resolveDir(a);
  const wm = wmPath(dir);
  if (!fs.existsSync(path.join(wm, 'state.json'))) fail(`不是 WritingMaster 项目（缺少 ${wm}/state.json）`);
  const results = [];
  const R = (level, id, msg) => results.push({ level, id, msg });
  const MAXD = 8;

  /* D01 state.json 合法性（v2.0：旧赛道 romance 自动按 novel·言情模式处理并提示迁移） */
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(wm, 'state.json'), 'utf8'));
    const legacyRomance = state.track === 'romance';
    normalizeState(state);
    if (state.genre !== undefined && !GENRES.includes(state.genre)) R('FAIL', 'D01', `state.genre 无效: ${state.genre}（可选: ${GENRES.join(' | ')}）`);
    else if (legacyRomance) R('WARN', 'D01', `旧版赛道 "romance" 已并入 novel（v2.0），本次按 novel·言情模式处理；建议把 state.json 的 track 改为 "novel" 并加 "genre": "romance" 完成迁移`);
    else {
      const need = ['track', 'mode', 'title', 'target_words', 'part', 'volume', 'chapter', 'total_words', 'updated_at', 'stage'];
      const miss = need.filter(k => state[k] === undefined);
      if (miss.length) R('FAIL', 'D01', `state.json 缺字段: ${miss.join(', ')}`);
      else if (!TRACKS.includes(state.track)) R('FAIL', 'D01', `state.track 无效: ${state.track}`);
      else if (!Number.isInteger(state.target_words) || state.target_words <= 0) R('FAIL', 'D01', 'state.target_words 应为正整数');
      else if (!Number.isInteger(state.chapter) || state.chapter < 0) R('FAIL', 'D01', 'state.chapter 应为非负整数');
      else if (!Number.isInteger(state.part) || state.part < 1) R('FAIL', 'D01', 'state.part 应为 ≥1 整数');
      else R('OK', 'D01', 'state.json 合法且字段齐全');
    }
  } catch (e) { R('FAIL', 'D01', `state.json 不是合法 JSON: ${e.message}`); }

  /* D02 文件完整性 */
  const needFiles = ['parts.json', 'commits.log', 'ledger/names.tsv', 'ledger/characters.json', 'ledger/foreshadow.json', 'ledger/timeline.json', 'ledger/suspense.json', 'ledger/info-gap.json', 'ledger/plotlines.json'];
  const missing = needFiles.filter(f => !fs.existsSync(path.join(wm, f)));
  if (missing.length) R('FAIL', 'D02', `缺失文件: ${missing.map(f => '.wm/' + f).join(', ')}`);
  else R('OK', 'D02', `账本文件齐全（${needFiles.length + 1} 项）`);

  if (!state) {
    p('═══ WritingMaster 账本体检 ═══');
    for (const r of results) p(`  [${r.level === 'OK' ? '通过' : r.level === 'WARN' ? '警告' : '故障'}] ${r.id} ${r.msg}`);
    p(`结论: state.json 无法解析，其余检查中止，请先修复。`);
    process.exit(1);
  }

  /* D03 各台账 JSON 合法性 */
  const jsonFiles = ['parts.json', 'ledger/characters.json', 'ledger/foreshadow.json', 'ledger/timeline.json', 'ledger/suspense.json', 'ledger/info-gap.json', 'ledger/plotlines.json'];
  const valid = {};
  let badJson = 0;
  for (const f of jsonFiles) {
    try { JSON.parse(fs.readFileSync(path.join(wm, f), 'utf8')); valid[f] = true; }
    catch (e) { valid[f] = false; badJson++; R('FAIL', 'D03', `.wm/${f} 不是合法 JSON: ${e.message}`); }
  }
  if (!badJson) R('OK', 'D03', '全部台账 JSON 合法');

  /* D04 专名表 + 交叉引用 */
  const names = readNamesTable(dir);
  const dupNames = names.filter((n, i) => names.findIndex(m => m.name === n.name) !== i);
  if (dupNames.length) R('FAIL', 'D04', `names.tsv 存在重复名词: ${[...new Set(dupNames.map(n => n.name))].slice(0, MAXD).join(', ')}`);
  else if (!names.length) R('WARN', 'D04', 'names.tsv 为空（尚未提交任何名词）');
  else R('OK', 'D04', `names.tsv ${names.length} 个名词，无重复`);
  if (valid['ledger/characters.json']) {
    let chars = [];
    try { chars = JSON.parse(fs.readFileSync(path.join(wm, 'ledger/characters.json'), 'utf8')).items || []; } catch (e) { chars = []; }
    const nameSet = new Set(names.map(n => n.name));
    const xrefs = [];
    for (const c of chars) {
      if (c && !nameSet.has(c.name)) xrefs.push(`人物 "${c.name}" 不在专名表`);
      for (const al of (c && c.aliases) || []) if (!nameSet.has(al)) xrefs.push(`人物 "${c.name}" 的别名 "${al}" 不在专名表`);
    }
    if (xrefs.length) R('FAIL', 'D04', `名词交叉引用失败: ${xrefs.slice(0, MAXD).join('；')}${xrefs.length > MAXD ? ' 等' : ''}`);
    else if (names.length) R('OK', 'D04', '人物名词交叉引用一致');
  }
  const future = names.filter(n => n.first_chapter > state.chapter);
  if (future.length) R('WARN', 'D04', `专名表 ${future.length} 个名词首次出现章大于当前进度（${future.slice(0, 5).map(n => `${n.name}@ch${n.first_chapter}`).join(', ')}）`);

  /* D05 悬空伏笔 */
  if (valid['ledger/foreshadow.json']) {
    let fore = [];
    try { fore = JSON.parse(fs.readFileSync(path.join(wm, 'ledger/foreshadow.json'), 'utf8')).items || []; } catch (e) { fore = []; }
    const danglings = [];
    for (const f of fore) {
      if ((f.status || 'open') === 'open' && (f.planted_ch || 0) > state.chapter) danglings.push(`${f.id} 埋点 ch${f.planted_ch} 超出当前进度 ch${state.chapter}`);
      if (f.status === 'resolved' && !f.resolved_ch) danglings.push(`${f.id} 已回收但缺 resolved_ch`);
      if (f.status === 'resolved' && f.resolved_ch && f.resolved_ch < (f.planted_ch || 0)) danglings.push(`${f.id} resolved_ch(${f.resolved_ch}) 早于埋点(${f.planted_ch})`);
      if ((f.status || 'open') === 'open' && !f.last_seen_ch && f.planted_ch) danglings.push(`${f.id} 缺 last_seen_ch`);
    }
    if (danglings.length) R('FAIL', 'D05', `悬空伏笔: ${danglings.slice(0, MAXD).join('；')}${danglings.length > MAXD ? ' 等' : ''}`);
    else if (fore.length) R('OK', 'D05', `伏笔 ${fore.length} 条，无悬空`);
    else R('OK', 'D05', '伏笔台账为空');
  }

  /* D06 章号连续性 + 摘要缺失 */
  const have = new Set([...listChapterSummaries(dir), ...archivedChapterSet(dir)]);
  const gaps = [];
  for (let c = 1; c <= state.chapter; c++) if (!have.has(c)) gaps.push(c);
  if (state.chapter === 0) R('OK', 'D06', '尚无章节，无连续性要求');
  else if (gaps.length) R('FAIL', 'D06', `章摘要缺失（章号断档）: ch-${gaps.slice(0, MAXD).join(', ch-')}${gaps.length > MAXD ? ' 等' : ''}（共 ${gaps.length} 章缺失，当前进度 ch${state.chapter}）`);
  else R('OK', 'D06', `章号连续，摘要齐全（1–${state.chapter} 共 ${have.size} 份）`);

  /* D07 parts.json 与归档一致性 */
  let partsOk = false;
  let partsObj = null;
  try { partsObj = JSON.parse(fs.readFileSync(path.join(wm, 'parts.json'), 'utf8')); } catch (e) { partsObj = null; }
  if (!partsObj || !Array.isArray(partsObj.parts) || !partsObj.parts.length) R('FAIL', 'D07', 'parts.json 缺少 parts 数组');
  else {
    partsOk = true;
    const bad = [];
    for (let i = 0; i < partsObj.parts.length; i++) {
      const pt = partsObj.parts[i];
      const exp = i === 0 ? 1 : partsObj.parts[i - 1].end_ch + 1;
      if (pt.start_ch !== exp) bad.push(`第${pt.part}部 start_ch=${pt.start_ch}(应为${exp})`);
      if (pt.archived && !fs.existsSync(path.join(wm, 'archive', `part-${pt.part}`))) bad.push(`第${pt.part}部已归档但 archive/part-${pt.part}/ 不存在`);
    }
    if (partsObj.parts[partsObj.parts.length - 1].part !== state.part) bad.push(`state.part=${state.part} 与 parts.json 末部不一致`);
    if (bad.length) R('FAIL', 'D07', `部结构异常: ${bad.join('；')}`);
    else R('OK', 'D07', `部结构连续（共 ${partsObj.parts.length} 部，当前第 ${state.part} 部）`);
  }

  /* D08 commits.log */
  const logf = path.join(wm, 'commits.log');
  if (!fs.existsSync(logf)) R('FAIL', 'D08', 'commits.log 缺失');
  else {
    const lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/).filter(Boolean);
    if (state.chapter > 0 && !lines.length) R('FAIL', 'D08', `已写 ${state.chapter} 章但 commits.log 为空`);
    else if (lines.length && !lines.every(l => /^\[\d{4}-\d{2}-\d{2}T/.test(l))) R('FAIL', 'D08', 'commits.log 存在无法识别的行');
    else R('OK', 'D08', `commits.log ${lines.length} 条流水` + (lines.length ? `，最近: ${lines[lines.length - 1].slice(0, 80)}` : ''));
  }

  p('═══ WritingMaster 账本体检 ═══');
  p(`作品: 《${state.title}》 | ${wm}`);
  p('');
  p('── 检查项 ──');
  for (const r of results) {
    const mark = r.level === 'OK' ? '[通过]' : r.level === 'WARN' ? '[警告]' : '[故障]';
    p(`  ${mark} ${r.id} ${r.msg}`);
  }
  const fails = results.filter(r => r.level === 'FAIL').length;
  const warns = results.filter(r => r.level === 'WARN').length;
  p('');
  if (fails) {
    p(`结论: 发现 ${fails} 项故障${warns ? `、${warns} 项警告` : ''}，请按 D 编号逐项修复。`);
    process.exit(1);
  }
  p(`结论: 全部通过${warns ? `（${warns} 项警告可关注）` : '，账本健康'}。`);
  p('下一步建议: wm-restore.sh 生成续作恢复包，或 wm-status.sh 查看进度。');
}

/* ───────────────────────── wm-outline（v1.2） ───────────────────────── */

const OUTLINE_KINDS = ['master', 'part', 'volume', 'chapter'];
function outlinePath(dir, kind, num) {
  const root = path.join(wmPath(dir), 'outlines');
  if (kind === 'master') return path.join(root, 'master.md');
  if (kind === 'part') return path.join(root, `part-${num}.md`);
  if (kind === 'volume') return path.join(root, `volume-${num}.md`);
  return path.join(root, `ch-${String(num).padStart(3, '0')}.md`);
}

function cmdOutline(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  const state = loadState(dir);

  /* 门禁开关 */
  if (a.enable !== undefined) {
    state.outline_gate = true; saveState(dir, state);
    p('✓ 章纲门禁已启用（context --task write 前必须先存本章章纲）');
    p('  提示: 存章纲 → bash wm-outline.sh --save chapter --num N --file 章纲.md');
    return;
  }
  if (a.disable !== undefined) {
    state.outline_gate = false; saveState(dir, state);
    p('⚠ 章纲门禁已关闭（不推荐长篇连载使用，盲写易跑偏）');
    return;
  }

  const kind = a.save || a.show;
  if (!kind) {
    if (a.list !== undefined) {
      const root = path.join(wmPath(dir), 'outlines');
      p('═══ WritingMaster 大纲清单 ═══');
      if (!fs.existsSync(root)) { p('（暂无任何大纲文件）'); p('下一步建议: 用 --save master 先落总纲'); return; }
      const files = fs.readdirSync(root).filter(f => f.endsWith('.md')).sort();
      if (!files.length) { p('（暂无任何大纲文件）'); p('下一步建议: 用 --save master 先落总纲'); return; }
      for (const f of files) {
        const txt = fs.readFileSync(path.join(root, f), 'utf8');
        const first = txt.split(/\r?\n/).find(l => l.trim() && !/^#/.test(l.trim())) || '(空)';
        p(`  ${f.padEnd(16)} ${String([...txt].length).padStart(6)} 字 | ${first.trim().slice(0, 40)}`);
      }
      p(`  共 ${files.length} 份大纲`);
      p('下一步建议: --show <kind> 查看具体大纲，或继续创作流程');
      return;
    }
    usageErr('缺少操作参数（--save / --show / --list / --enable / --disable）', 'outline');
  }
  if (!OUTLINE_KINDS.includes(kind)) fail(`无效大纲类型 "${kind}"（可选: ${OUTLINE_KINDS.join(' | ')}）`);

  let num = 0;
  if (kind !== 'master') {
    if (a.num === undefined || !/^\d+$/.test(a.num) || +a.num < 1) fail(`--num 必须为正整数（${kind} 类型必填）`);
    num = +a.num;
  }

  if (a.save !== undefined) {
    if (!a.file) usageErr('--save 需要 --file <大纲.md>', 'outline');
    if (!fs.existsSync(a.file)) fail(`大纲文件不存在: ${a.file}`);
    const txt = fs.readFileSync(a.file, 'utf8');
    if (!txt.trim()) fail('大纲文件为空');
    const dest = outlinePath(dir, kind, num);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, txt, 'utf8');
    const rel = path.join('.wm', 'outlines', path.basename(dest)).split(path.sep).join('/');
    p(`✓ 大纲已保存: ${rel}（${[...txt].length} 字）`);
    if (kind === 'chapter') {
      p(`  章纲门禁: ${state.outline_gate ? `ch${num} 已解锁（可 wm-context.sh --task write --chapter ${num}）` : '未启用（--enable 可开启）'}`);
      if (state.chapter > 0 && num <= state.chapter) p('  ⚠ 该章已提交过，补录的章纲仅作回溯参考');
    }
    p('下一步建议: ' + (kind === 'master' ? '继续产出部纲/卷纲，或 wm-context.sh --task plan 进入规划' : 'wm-context.sh --task write 装配写作上下文'));
    return;
  }

  /* --show */
  const dest = outlinePath(dir, kind, num);
  if (!fs.existsSync(dest)) {
    if (kind === 'chapter') {
      p(`✗ 章纲缺失: ${path.join('.wm', 'outlines', path.basename(dest)).split(path.sep).join('/')}`);
      p(`  补法: 按赛道模板产出章纲 → bash wm-outline.sh --save chapter --num ${num} --file <章纲.md>`);
      fail(`第 ${num} 章章纲缺失`);
    }
    fail(`大纲文件不存在: ${dest}`);
  }
  p(fs.readFileSync(dest, 'utf8'));
  p('──');
  p('下一步建议: 按此大纲写作（wm-context.sh --task write）');
}

/* ───────────────────────── wm-query（v1.2） ───────────────────────── */

function normQueryStrand(s) {
  const raw = String(s || '').trim().toLowerCase();
  const alias = { 主线: 'quest', 剧情: 'quest', 主线剧情: 'quest', quest: 'quest', q: 'quest',
    感情: 'fire', 感情线: 'fire', 爱情: 'fire', fire: 'fire', f: 'fire',
    世界观: 'constellation', 设定: 'constellation', constellation: 'constellation', c: 'constellation' };
  return alias[raw] || raw;
}
function readAllSummaries(dir) {
  /* 汇总活跃区 + 归档区全部章摘要 */
  const out = [];
  const push = (f, ch) => {
    const s = readSummaryFile(f);
    out.push({ ch, one_line: s ? s.one_line : '', hook_type: s ? s.hook_type : '', changes: s ? s.changes : '', raw: s ? s.raw : '' });
  };
  for (const ch of listChapterSummaries(dir)) push(chapterSummaryPath(dir, ch), ch);
  const archRoot = path.join(wmPath(dir), 'archive');
  if (fs.existsSync(archRoot)) {
    for (const d of fs.readdirSync(archRoot).sort()) {
      const sd = path.join(archRoot, d, 'summaries');
      if (!fs.existsSync(sd)) continue;
      for (const f of fs.readdirSync(sd).filter(f => /^ch-\d+\.md$/.test(f)).sort()) push(path.join(sd, f), +(/ch-(\d+)/.exec(f)[1]));
    }
  }
  return out.sort((x, y) => x.ch - y.ch);
}

function cmdQuery(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  const state = loadState(dir);
  const what = a.what;
  if (!what) usageErr('缺少 --what <characters|foreshadow|suspense|info-gap|plotlines|timeline|names|fulltext>', 'query');
  const top = a.top !== undefined && /^\d+$/.test(a.top) ? +a.top : 5;

  p(`═══ WritingMaster 台账查询 ═══`);
  p(`作品: 《${state.title}》 | 查询: ${what}${a.name ? ` name=${a.name}` : ''}${a.id ? ` id=${a.id}` : ''}${a.keyword ? ` keyword=${a.keyword}` : ''}`);
  p('');

  if (what === 'characters') {
    const chars = loadLedger(dir, 'characters.json', 'items').items;
    if (a.name) {
      const c = chars.find(x => x.name === a.name || (x.aliases || []).includes(a.name));
      if (!c) fail(`未找到人物 "${a.name}"（台账号 ${chars.length}）`);
      p(`◦ ${c.name}（${c.id || '无编号'}） [${c.status || 'active'}]`);
      if (c.aliases && c.aliases.length) p(`  别名: ${c.aliases.join('、')}`);
      if (c.role) p(`  定位: ${c.role}`);
      if (c.goal) p(`  目标: ${c.goal}`);
      if (c.relations) p(`  关系: ${c.relations}`);
      p(`  首次出场: ch${c.first_ch || '?'} | 最近: ch${c.last_ch || '?'}`);
      for (const cd of (c.conditions || [])) p(`  伤病: ${cd.what} [${cd.status || 'open'}]（自 ch${cd.since_ch || '?'}）`);
      for (const it of (c.items || [])) p(`  持有: ${it.name} [${it.status || 'held'}]（自 ch${it.since_ch || '?'}）`);
      /* 该人物出场章（从摘要全文反查） */
      const at = readAllSummaries(dir).filter(s => s.raw && s.raw.includes(c.name)).map(s => s.ch);
      if (at.length) p(`  出场章: ${at.join(',')}`);
    } else {
      if (!chars.length) p('（人物台账为空）');
      for (const c of chars.slice(0, 20)) {
        const conds = (c.conditions || []).filter(x => (x.status || 'open') === 'open').map(x => x.what).join('、');
        p(`◦ ${c.name} [${c.status || 'active'}]${conds ? ` ⚠未愈: ${conds}` : ''}${(c.items || []).filter(x => (x.status || 'held') === 'held').length ? ` 持有${(c.items || []).filter(x => (x.status || 'held') === 'held').length}件` : ''}`);
      }
      if (chars.length > 20) p(`…（共 ${chars.length} 人，仅列前 20）`);
    }
  } else if (what === 'foreshadow') {
    const fore = loadLedger(dir, 'foreshadow.json', 'items').items;
    const list = a.id ? fore.filter(f => f.id === a.id) : fore.filter(f => (f.status || 'open') === 'open');
    if (a.id && !list.length) fail(`未找到伏笔 ${a.id}`);
    if (!list.length) p('（无未回收伏笔）');
    for (const f of list.slice(0, 15)) {
      const idle = state.chapter - (f.last_seen_ch || f.planted_ch || 0);
      p(`◦ ${f.id} ${f.name} [${f.status || 'open'}] 埋于 ch${f.planted_ch || '?'} 末露 ch${f.last_seen_ch || '?'}（${idle} 章前${idle > 12 ? ' ⚠超期' : ''}）${f.hint ? ` hint: ${String(f.hint).slice(0, 20)}` : ''}`);
    }
    if (list.length > 15) p(`…（共 ${list.length} 条）`);
  } else if (what === 'suspense') {
    const sus = loadLedger(dir, 'suspense.json', 'items').items;
    const list = a.id ? sus.filter(s => s.id === a.id) : sus.filter(s => (s.status || 'open') === 'open');
    if (a.id && !list.length) fail(`未找到悬念 ${a.id}`);
    if (!list.length) p('（无未解悬念）');
    for (const s of list.slice(0, 15)) {
      p(`◦ ${s.id} ${s.name} [${s.status || 'open'}]${s.layer ? ` L${s.layer}` : ''} 起于 ch${s.created_ch || '?'}${s.resolved_ch ? ` 解于 ch${s.resolved_ch}` : ''}`);
    }
  } else if (what === 'info-gap') {
    const gaps = loadLedger(dir, 'info-gap.json', 'items').items;
    const list = a.id ? gaps.filter(g => g.id === a.id) : gaps.filter(g => (g.status || 'open') === 'open');
    if (a.id && !list.length) fail(`未找到信息差 ${a.id}`);
    if (!list.length) p('（无未闭合信息差）');
    for (const g of list.slice(0, 15)) p(`◦ ${g.id} ${g.gap || ''} [${g.status || 'open'}]${g.holders ? ` | 知情: ${g.holders}` : ''}${g.until ? ` | 直至: ${g.until}` : ''}`);
  } else if (what === 'plotlines') {
    const pl = loadLedger(dir, 'plotlines.json', 'items').items;
    const list = a.id ? pl.filter(x => x.id === a.id) : pl.filter(x => (x.status || 'active') === 'active');
    if (a.id && !list.length) fail(`未找到情节线 ${a.id}`);
    if (!list.length) p('（无活跃情节线）');
    for (const x of list.slice(0, 15)) p(`◦ ${x.id} ${x.name} [${x.status || 'active'}] ch${x.start_ch || '?'}–${x.end_ch || '今'}`);
  } else if (what === 'timeline') {
    const tl = loadLedger(dir, 'timeline.json', 'events').events;
    /* 归档区也有时间线 */
    const archRoot = path.join(wmPath(dir), 'archive');
    let all = [...tl];
    if (fs.existsSync(archRoot)) {
      for (const d of fs.readdirSync(archRoot)) {
        const f = path.join(archRoot, d, 'timeline.json');
        if (fs.existsSync(f)) { try { all = [...JSON.parse(fs.readFileSync(f, 'utf8')).events, ...all]; } catch (_) {} }
      }
    }
    all.sort((x, y) => (x.chapter || 0) - (y.chapter || 0));
    if (a.name) all = all.filter(e => JSON.stringify(e).includes(a.name));
    if (!all.length) p('（时间线为空）');
    for (const e of all.slice(-20)) p(`◦ ch${e.chapter || '?'} ${e.event || ''}${e.where ? ` @${e.where}` : ''}`);
    if (all.length > 20) p(`…（共 ${all.length} 条，显示最近 20）`);
  } else if (what === 'names') {
    const names = readNamesTable(dir);
    if (a.keyword) {
      const hit = names.filter(n => n.name.includes(a.keyword) || (n.type || '').includes(a.keyword));
      if (!hit.length) p(`（无匹配 "${a.keyword}" 的名词）`);
      for (const n of hit) p(`◦ ${n.name} [${n.type || '?'}] 首现 ch${n.first_chapter || '?'}`);
    } else {
      if (!names.length) p('（专名表为空）');
      for (const n of names.slice(0, 30)) p(`◦ ${n.name} [${n.type || '?'}] 首现 ch${n.first_chapter || '?'}`);
      if (names.length > 30) p(`…（共 ${names.length} 个）`);
    }
  } else if (what === 'fulltext') {
    if (!a.keyword) fail('fulltext 检索需要 --keyword <词>');
    /* BM25-lite 中文二元检索：章摘要 + 大纲 + 正文快照 */
    const docs = [];
    for (const s of readAllSummaries(dir)) docs.push({ id: `摘要 ch${s.ch}`, text: `${s.one_line} ${s.changes} ${s.raw}` });
    const outRoot = path.join(wmPath(dir), 'outlines');
    if (fs.existsSync(outRoot)) {
      for (const f of fs.readdirSync(outRoot).filter(f => f.endsWith('.md'))) docs.push({ id: `大纲 ${f}`, text: fs.readFileSync(path.join(outRoot, f), 'utf8') });
    }
    const textsRoot = path.join(wmPath(dir), 'texts');
    if (fs.existsSync(textsRoot)) {
      for (const f of fs.readdirSync(textsRoot).filter(f => /^ch-\d+\.md$/.test(f))) docs.push({ id: `正文 ${f.replace('.md', '')}`, text: fs.readFileSync(path.join(textsRoot, f), 'utf8') });
    }
    if (!docs.length) { p('（无可检索文档：无摘要/大纲/正文快照）'); return; }
    const kw = a.keyword;
    const hits = docs.map(d => {
      const count = d.text.split(kw).length - 1;
      if (!count) return null;
      const idx = d.text.indexOf(kw);
      return { id: d.id, count, ctx: d.text.slice(Math.max(0, idx - 15), idx + kw.length + 25).replace(/\n/g, '␤') };
    }).filter(Boolean).sort((x, y) => y.count - x.count).slice(0, top);
    if (!hits.length) p(`（在 ${docs.length} 份文档中未找到 "${kw}"）`);
    else for (const h of hits) p(`◦ ${h.id} ×${h.count} — …${h.ctx}…`);
  } else {
    fail(`无效 --what "${what}"（可选: characters | foreshadow | suspense | info-gap | plotlines | timeline | names | fulltext）`);
  }
  p('──');
  p('下一步建议: 需要更细的检索用 --id/--name/--keyword 定点查询');
}

/* ───────────────────────── wm-pacing（v1.2） ───────────────────────── */

function cmdPacing(a) {
  const dir = resolveDir(a);
  requireProject(dir);
  const state = loadState(dir);
  let window = 20;
  if (a.window !== undefined) {
    if (!/^\d+$/.test(a.window) || +a.window < 3) fail(`--window 必须为 ≥3 的整数（收到: "${a.window}"）`);
    window = +a.window;
  }
  const sums = readAllSummaries(dir);
  if (!sums.length) fail('尚无章摘要，无法做节奏体检（先提交 summary）');
  const recent = sums.slice(-window);
  const strands = recent.map(s => {
    const m = /strand[：:]\s*(\S*)/.exec(s.raw || '');
    return { ch: s.ch, strand: normQueryStrand(m ? m[1] : '') };
  });

  const counts = { quest: 0, fire: 0, constellation: 0, unknown: 0 };
  for (const s of strands) counts[STRANDS.includes(s.strand) ? s.strand : 'unknown']++;
  const total = strands.length;

  /* 赛道换算：言情模式（novel+genre=romance）取专用配比，其余按赛道取（TRACK_PACING），断档阈值不变 */
  const tp = TRACK_PACING[(state.track === 'novel' && state.genre === 'romance') ? 'romance' : state.track] || TRACK_PACING.novel;

  p('═══ WritingMaster 三线节奏体检 ═══');
  p(`作品: 《${state.title}》 | 窗口: 最近 ${total} 章（ch${recent[0].ch}–ch${recent[recent.length - 1].ch}）`);
  p(`赛道换算: ${trackLabel(state)} → ${tp.note}`);
  p('');
  p('── 三线占比 ──');
  for (const k of STRANDS) {
    const ratio = total ? counts[k] / total : 0;
    const ideal = tp[k];
    const dev = ideal ? (ratio - ideal) / ideal : 0;
    const mark = Math.abs(dev) > 0.5 ? '⚠' : '✓';
    const bar = '■'.repeat(Math.round(ratio * 20));
    p(`  ${STRAND_META[k].icon} ${STRAND_META[k].label} ${String(Math.round(ratio * 100)).padStart(3)}% ${bar.padEnd(14)} 理想 ${Math.round(ideal * 100)}% ${mark}`);
  }
  if (counts.unknown) p(`  ⬜ 未标记 ${String(Math.round(counts.unknown / total * 100)).padStart(3)}% ——commit 时补 summary.strand（quest|fire|constellation）`);
  p('');
  p('── 断档检测 ──');
  let gapWarn = 0;
  const gapHit = [];
  for (const k of STRANDS) {
    const maxGap = STRAND_META[k].maxGap;
    let last = null, worst = 0;
    for (const s of strands) {
      if (s.strand === k) { last = s.ch; }
      else if (last !== null) worst = Math.max(worst, s.ch - last);
    }
    const tailGap = last === null ? total : (recent[recent.length - 1].ch - last);
    const g = Math.max(worst, tailGap);
    if (g >= maxGap) { p(`  ⚠ ${STRAND_META[k].label} 断档 ${g} 章（阈值 ${maxGap}）——读者将流失，下 1-2 章必须安排该线内容`); gapWarn++; gapHit.push(k); }
    else p(`  ✓ ${STRAND_META[k].label} 最长断档 ${g} 章（阈值内）`);
  }
  if (!counts.unknown && !gapWarn) {
    const qDev = Math.abs(counts.quest / total - tp.quest), fDev = Math.abs(counts.fire / total - tp.fire);
    if (qDev <= 0.25 && fDev <= 0.15) p(`  ✓ 三线占比健康（赛道配比 ${Math.round(tp.quest * 100)}:${Math.round(tp.fire * 100)}:${Math.round(tp.constellation * 100)}）`);
  }
  p('');
  p('── 修复建议 ──');
  if (counts.unknown >= Math.ceil(total / 2)) p('  ◦ 过半章节未标记 strand——先在后续 commit 补 summary.strand，否则占比与断档均失真');
  if (gapHit.includes('quest')) p('  ◦ 主线断档（最严重）：下一章让主线目标出现在人物对话/选择里（哪怕 200 字）；用支线冲突反向服务主线');
  if (gapHit.includes('fire')) p('  ◦ 感情线断档：插入 1 个微交互场景（并肩/递物/一句关心，300 字即可）；禁用回忆杀凑数（静态，不产生新进展）');
  if (gapHit.includes('constellation')) p('  ◦ 世界观断档：让新规则/新地图成为当前冲突的解法（世界观必须"有用"才立得住）；禁止设定说明书式灌输');
  const fireRatio = total ? counts.fire / total : 0;
  if (!gapHit.length && fireRatio < tp.fire * 0.5) p('  ◦ 感情线占比不足理想一半：下一章把主线事件与人物关系绑定（同场景双线推进）');
  const qRatio = total ? counts.quest / total : 0;
  if (qRatio > 0.75) p('  ◦ 主线过载（>75%）：读者疲劳——切 1-2 章感情/世界观章，给主线蓄力');
  if (!gapHit.length && !counts.unknown && qRatio >= tp.quest * 0.75 && fireRatio >= tp.fire * 0.5) p('  ◦ 节奏结构无需修复：保持当前 strand 分配继续推进');
  p('');
  p('下一步建议: ' + (gapWarn ? '按断档预警安排下章 strand，优先补断档最久的线' : counts.unknown ? '先补齐 strand 标记再复检（wm-pacing.sh）' : '节奏健康，继续 wm-context.sh --task write'));
}

/* ───────────────────────── wm-memory（v1.2） ───────────────────────── */

function memoryFile(dir) { return path.join(wmPath(dir), 'memory.json'); }
function loadMemory(dir) {
  const f = memoryFile(dir);
  if (!fs.existsSync(f)) return { entries: [] };
  const o = readJSONFile(f, 'memory.json');
  if (!o || !Array.isArray(o.entries)) fail('memory.json 结构错误（缺少 entries 数组），请修复或删除后重建');
  return o;
}

function cmdMemory(a) {
  const dir = resolveDir(a);
  requireProject(dir);

  if (a.add !== undefined) {
    if (!fs.existsSync(a.add)) fail(`记忆文件不存在: ${a.add}`);
    let e;
    try { e = JSON.parse(fs.readFileSync(a.add, 'utf8')); }
    catch (er) { fail(`记忆文件不是合法 JSON: ${a.add}\n  ${er.message}`); }
    if (typeof e !== 'object' || e === null || Array.isArray(e)) fail('记忆文件必须为 JSON 对象');
    const kind = e.kind || 'technique';
    if (!MEMORY_KINDS.includes(kind)) fail(`kind 无效值 "${kind}"（可选: ${MEMORY_KINDS.join(' | ')}）`);
    if (!e.title || typeof e.title !== 'string') fail('title 必须为非空字符串');
    if (!e.content || typeof e.content !== 'string') fail('content 必须为非空字符串');
    const mem = loadMemory(dir);
    const id = 'M-' + String(mem.entries.length + 1).padStart(3, '0');
    const rec = {
      id, kind,
      title: e.title.trim(),
      content: e.content.trim(),
      tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
      track: e.track || '',
      genre: e.genre || (e.track === 'romance' ? 'romance' : ''),
      chapter: Number.isInteger(e.chapter) ? e.chapter : null,
      created_at: nowISO()
    };
    mem.entries.push(rec);
    writeJSONFile(memoryFile(dir), mem);
    appendLog(dir, `memory#add ${id} kind=${kind} title=${rec.title.slice(0, 24)}`);
    p(`✓ 记忆已沉淀: ${id} [${MEMORY_KIND_LABEL[kind]}] ${rec.title}`);
    p(`  条目数: ${mem.entries.length} | context 装配时自动注入最近 5 条`);
    p('下一步建议: 继续创作（wm-context.sh），或 --list 查看全部记忆');
    return;
  }

  if (a.list !== undefined) {
    const mem = loadMemory(dir);
    let list = mem.entries;
    if (a.kind) list = list.filter(e => e.kind === a.kind);
    if (a.tag) list = list.filter(e => (e.tags || []).includes(a.tag));
    p('═══ WritingMaster 写作记忆 ═══');
    if (!list.length) { p('（暂无记忆' + (a.kind ? `（kind=${a.kind}）` : '') + '）'); p('下一步建议: --add 沉淀第一条有效写法'); return; }
    for (const e of [...list].reverse().slice(0, 30)) {
      p(`◦ ${e.id} [${MEMORY_KIND_LABEL[e.kind] || e.kind}] ${e.title}${e.track ? ` (${e.track === 'romance' ? 'novel·言情' : e.track})` : ''}`);
      p(`    ${String(e.content).slice(0, 70)}${String(e.content).length > 70 ? '…' : ''}`);
    }
    if (list.length > 30) p(`…（共 ${list.length} 条）`);
    p('下一步建议: 写作时 context 自动带出最近 5 条相关记忆');
    return;
  }

  if (a.search !== undefined) {
    const kw = String(a.search);
    const mem = loadMemory(dir);
    const hits = mem.entries.filter(e => (e.title + ' ' + e.content + ' ' + (e.tags || []).join(' ')).includes(kw));
    p(`═══ WritingMaster 记忆检索: "${kw}" ═══`);
    if (!hits.length) { p('（无匹配记忆）'); return; }
    for (const e of hits) {
      p(`◦ ${e.id} [${MEMORY_KIND_LABEL[e.kind] || e.kind}] ${e.title}`);
      p(`    ${String(e.content).slice(0, 70)}`);
    }
    p(`共 ${hits.length} 条`);
    return;
  }
  usageErr('缺少操作参数（--add <记忆.json> | --list | --search <关键词>）', 'memory');
}

/* ───────────────────────── wm-verify（v1.2） ───────────────────────── */

function cmdVerify(a) {
  const crypto = require('crypto');
  const root = a.root ? path.resolve(a.root) : path.resolve(__dirname, '..');
  const errs = [];
  const warn = [];
  const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);

  p('═══ WritingMaster 包完整性门禁 ═══');
  p(`包根: ${root}`);
  p('');

  /* V1 知识切片索引 ↔ 文件 ↔ sha 锁 */
  const idxFile = path.join(root, 'knowledge', 'index.json');
  const lockFile = path.join(root, 'knowledge', 'lock.json');
  if (!fs.existsSync(idxFile)) errs.push(`V1: 缺少 knowledge/index.json`);
  else {
    let idx = [];
    try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch (e) { errs.push(`V1: index.json 解析失败: ${e.message}`); }
    let seen = new Set();
    for (const it of idx) {
      if (!it.id || seen.has(it.id)) { errs.push(`V1: 切片 id 缺失或重复: ${it.id || '(空)'}`); continue; }
      seen.add(it.id);
      const f = path.join(root, 'knowledge', it.file || '');
      if (!it.file || !fs.existsSync(f)) { errs.push(`V1: 切片文件缺失: ${it.id} → ${it.file}`); continue; }
      /* 字数口径与索引生成一致：剔除 YAML front-matter 后的正文（含标题行） */
      const txt = fs.readFileSync(f, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      const words = [...txt.replace(/\s/g, '')].length;
      if (it.words !== undefined && Math.abs(it.words - words) > Math.max(3, words * 0.02)) {
        errs.push(`V1: 字数不符: ${it.id} 索引 ${it.words} vs 实际 ${words}`);
      }
    }
    p(`V1 知识切片: 索引 ${idx.length} 条，文件齐备性 ${errs.length ? '✗' : '✓'}`);
    /* --update-lock: 生成/刷新 sha 锁（改动知识切片后必须执行，CI 用无锁校验锁定状态） */
    if (a['update-lock'] !== undefined) {
      const slices = idx.filter(it => it.file && fs.existsSync(path.join(root, 'knowledge', it.file)))
        .map(it => ({ id: it.id, file: it.file, sha: shaOf(path.join(root, 'knowledge', it.file)) }));
      fs.writeFileSync(lockFile, JSON.stringify({ generated_at: nowISO(), slices }, null, 2) + '\n', 'utf8');
      p(`V1 sha 锁已生成: ${slices.length} 条 → knowledge/lock.json`);
    } else if (fs.existsSync(lockFile)) {
      let lock = null;
      try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (e) { errs.push(`V1: lock.json 解析失败`); }
      if (lock && Array.isArray(lock.slices)) {
        let mismatch = 0;
        for (const s of lock.slices) {
          const it = idx.find(x => x.id === s.id);
          if (!it) { mismatch++; errs.push(`V1: 锁内多余条目 ${s.id}`); continue; }
          const f = path.join(root, 'knowledge', it.file);
          if (!fs.existsSync(f)) continue; /* 文件缺失已由索引环报错，此处跳过防崩溃 */
          if (shaOf(f) !== s.sha) { mismatch++; errs.push(`V1: sha 不一致: ${s.id}（切片被改动，未更新锁）`); }
        }
        for (const it of idx) if (!lock.slices.find(s => s.id === it.id)) { errs.push(`V1: 锁内缺失 ${it.id}（新增切片未 --update-lock）`); }
        p(`V1 sha 锁: ${lock.slices.length} 条${mismatch ? `，${mismatch} 条不匹配 ✗` : '，全部一致 ✓'}`);
      }
    } else if (a['update-lock'] === undefined) {
      warn.push('V1: 未找到 knowledge/lock.json（首次请运行 --update-lock 生成）');
    }
  }

  /* V2 模板清单与引用完整性 */
  const tplRoot = path.join(root, 'templates');
  const tplFiles = fs.existsSync(tplRoot) ? fs.readdirSync(tplRoot).filter(f => f.endsWith('.md')) : [];
  const referenced = new Set();
  const skillRoot = path.join(root, 'skills');
  let skillN = 0;
  if (fs.existsSync(skillRoot)) {
    for (const sd of fs.readdirSync(skillRoot)) {
      const f = path.join(skillRoot, sd, 'SKILL.md');
      if (!fs.existsSync(f)) { errs.push(`V2: 缺少 skills/${sd}/SKILL.md`); continue; }
      skillN++;
      const txt = fs.readFileSync(f, 'utf8');
      for (const m of txt.matchAll(/templates\/([A-Za-z0-9\u4e00-\u9fff_-]+\.md)/g)) referenced.add(m[1]);
    }
  }
  for (const t of referenced) {
    if (!tplFiles.includes(t)) errs.push(`V2: SKILL 引用的模板缺失: templates/${t}`);
  }
  p(`V2 模板引用: ${tplFiles.length} 个模板，SKILL 引用 ${referenced.size} 个${errs.some(e => e.startsWith('V2')) ? ' ✗' : ' ✓'}`);

  /* V3 命令齐备性：基线 13 命令硬性必查 + 动态发现 scripts/wm-*.sh 包装（后续轮次新增命令自动纳入门禁） */
  const BASE_CMDS = ['init', 'context', 'commit', 'review', 'status', 'archive', 'restore', 'doctor',
    'outline', 'query', 'pacing', 'memory', 'verify'];
  const wrappers = fs.existsSync(path.join(root, 'scripts'))
    ? fs.readdirSync(path.join(root, 'scripts')).map(f => /^wm-([a-z]+)\.sh$/.exec(f)).filter(Boolean).map(m => m[1])
    : [];
  const expectCmds = [...new Set([...BASE_CMDS, ...wrappers])];
  for (const c of expectCmds) {
    const sh = path.join(root, 'scripts', `wm-${c}.sh`);
    if (!fs.existsSync(sh)) errs.push(`V3: 缺少脚本包装 scripts/wm-${c}.sh`);
  }
  const wmjs = fs.readFileSync(path.join(root, 'scripts', 'wm.js'), 'utf8');
  for (const c of expectCmds) {
    if (!new RegExp(`\\b${c}:\\s*cmd`).test(wmjs)) errs.push(`V3: wm.js 未注册命令 ${c}`);
  }
  const mcpSrv = path.join(root, 'scripts', 'mcp-server.mjs');
  if (!fs.existsSync(mcpSrv)) {
    errs.push('V3: 缺少 scripts/mcp-server.mjs（MCP 形态）');
  } else {
    /* CLI↔MCP 双形态一致性：每个 CLI 命令必须在 MCP 服务器有对应 wm_<cmd> 工具 */
    const mcpSrc = fs.readFileSync(mcpSrv, 'utf8');
    for (const c of expectCmds) {
      if (!mcpSrc.includes(`'wm_${c}'`)) errs.push(`V3: MCP 服务器缺少 wm_${c} 工具（CLI↔MCP 双形态不一致）`);
    }
  }
  p(`V3 命令齐备: ${expectCmds.length} 命令 + MCP 双形态一致${errs.some(e => e.startsWith('V3')) ? ' ✗' : ' ✓'}`);

  /* V4 全链路冒烟（沙箱） */
  if (a['no-smoke'] === undefined) {
    const { execFileSync } = require('child_process');
    const sbx = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wm-verify-'));
    try {
      const node = process.argv[0];
      const wmjsPath = path.join(root, 'scripts', 'wm.js');
      const run = (...args) => execFileSync(node, [wmjsPath, ...args], { cwd: sbx, stdio: 'pipe' });
      run('init', '--track', 'novel', '--title', '冒烟', '--target-words', '80000', '--dir', sbx);
      run('outline', '--dir', sbx, '--save', 'chapter', '--num', '1', '--file', (() => {
        const f = path.join(sbx, 'ch1-outline.md');
        fs.writeFileSync(f, '# 第1章\n- 场景：开场\n- 钩子：悬念', 'utf8');
        return f;
      })());
      run('context', '--dir', sbx, '--task', 'write', '--chapter', '1');
      const draft = path.join(sbx, 'draft.md');
      fs.writeFileSync(draft, '他推门进来。屋里的灯还亮着。\n\n「你来了。」她说。\n\n他点头，坐下，把杯子放在桌上。', 'utf8');
      run('review', '--dir', sbx, '--file', draft, '--chapter', '1');
      const upd = path.join(sbx, 'upd.json');
      fs.writeFileSync(upd, JSON.stringify({ names: [{ name: '林川', type: 'person', new: true }], summary: { chapter: 1, one_line: '开场', hook_type: '悬念', strand: 'quest' }, words_count: 40 }), 'utf8');
      run('commit', '--dir', sbx, '--file', upd);
      const mem = path.join(sbx, 'mem.json');
      fs.writeFileSync(mem, JSON.stringify({ kind: 'technique', title: '冒烟记忆', content: '开篇用悬念钩' }), 'utf8');
      run('memory', '--dir', sbx, '--add', mem);
      run('status', '--dir', sbx);
      run('pacing', '--dir', sbx, '--window', '3');
      run('query', '--dir', sbx, '--what', 'characters');
      run('doctor', '--dir', sbx);
      p('V4 全链路冒烟: init→outline→context→review→commit→memory→status→pacing→query→doctor ✓');
    } catch (e) {
      errs.push(`V4: 冒烟失败: ${String(e.stderr || e.message).slice(0, 200)}`);
      p('V4 全链路冒烟 ✗');
    } finally {
      fs.rmSync(sbx, { recursive: true, force: true });
    }
  } else {
    p('V4 全链路冒烟: 跳过（--no-smoke）');
  }

  p('');
  for (const w of warn) p(`[警告] ${w}`);
  if (errs.length) {
    for (const e of errs) p(`[失败] ${e}`);
    p('');
    p(`结论: 【不通过】${errs.length} 项失败`);
    process.exit(1);
  }
  p('结论: 【通过】包完整性核验全部通过');
  p('下一步建议: CI 中常驻 bash scripts/wm-verify.sh（改动 knowledge 后须 --update-lock）');
}


/* ───────────────────────── 调度 ───────────────────────── */

const CMDS = {
  init: cmdInit, context: cmdContext, commit: cmdCommit, review: cmdReview,
  status: cmdStatus, archive: cmdArchive, restore: cmdRestore, doctor: cmdDoctor,
  outline: cmdOutline, query: cmdQuery, pacing: cmdPacing, memory: cmdMemory, verify: cmdVerify
};

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === '-h' || cmd === '--help') {
  p(MAIN_USAGE);
  process.exit(cmd ? 0 : 2);
}
if (!CMDS[cmd]) {
  console.error(`未知命令: ${cmd}`);
  console.error(MAIN_USAGE);
  process.exit(2);
}
const SPECS = {
  init: { spec: { track: 1, title: 1, 'target-words': 1, genre: 1, mode: 1, dir: 1, 'no-outline-gate': 0 }, required: [] },
  context: { spec: { dir: 1, task: 1, chapter: 1, budget: 1 }, required: [] },
  commit: { spec: { dir: 1, file: 1 }, required: ['file'] },
  review: { spec: { dir: 1, file: 1, chapter: 1 }, required: ['file'] },
  status: { spec: { dir: 1 }, required: [] },
  archive: { spec: { dir: 1, part: 1 }, required: ['part'] },
  restore: { spec: { dir: 1 }, required: [] },
  doctor: { spec: { dir: 1 }, required: [] },
  outline: { spec: { dir: 1, save: 1, show: 1, file: 1, num: 1, list: 0, enable: 0, disable: 0 }, required: [] },
  query: { spec: { dir: 1, what: 1, name: 1, id: 1, keyword: 1, top: 1 }, required: ['what'] },
  pacing: { spec: { dir: 1, window: 1 }, required: [] },
  memory: { spec: { dir: 1, add: 1, list: 0, search: 1, kind: 1, tag: 1 }, required: [] },
  verify: { spec: { root: 1, 'update-lock': 0, 'no-smoke': 0 }, required: [] }
};
CMDS[cmd](parseArgs(cmd, argv.slice(1), SPECS[cmd].spec, SPECS[cmd].required));
