/**
 * craft：把《小说创作全流程协作提示词》按创作阶段切片供给。
 *
 * 为什么要这个模块：那份提示词 19 节 / 92 切片 / 2.2 万字，既不能整篇塞进每章任务书
 * （会挤掉本书事实），也不能抄进专家包与技能文件（会变成第四份副本并开始漂移）。
 * 所以仓库里只存一份原文（prompt/CREATIVE-PROMPT.md，逐字保留），
 * 由 scripts/build-prompt-catalog.mjs 生成 prompt/catalog.json，
 * 运行时只读 catalog、按阶段取切片 —— 规则与原文永远同源。
 *
 * 四条硬约束：
 *  1. 只读：本模块绝不写盘、绝不改原文（改原文必须显式跑构建器重锁，见 C5）。
 *  2. 无损：切片文本 == 原文对应行区间，一个字不改（C7 在构建期已断言）。
 *  3. 陈旧即红：catalog 与 source-lock 对不上时直接抛错，不降级返回旧规则。
 *  4. 阶段包只列切片号，正文仍在原文里 —— 调整阶段包不需要动原文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePrompt, verifyUnits, reconstruct } from '../../scripts/build-prompt-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：lib/features → 上两级。原文/切片/锁都相对模块自身定位，不依赖 cwd。 */
const ROOT = path.resolve(HERE, '..', '..');

/** 阶段包：键是阶段别名，ids 是切片号前缀（连同其所有子切片一起展开）。 */
export const STAGE_PACKS = {
  negotiate: {
    label: '开工协商（阶段1 开场四问之前）',
    ids: ['0', '1.1', '1.2', '1.3', '2.1', '10.0', '18'],
  },
  stage1: {
    label: '阶段1 核心设定',
    ids: ['1.2', '2.2', '2.3', '2.4', '8', '10', '6.1', '6.14'],
  },
  stage2: {
    label: '阶段2 世界观与层级体系',
    ids: ['1.2', '3.3', '11', '2.3'],
  },
  stage3: {
    label: '阶段3 人物建档',
    ids: ['1.2', '3.4', '3.5', '6', '12'],
  },
  stage4: {
    label: '阶段4 全书路线图 + 当前部大纲',
    ids: ['2.2', '2.3', '2.4', '2.6', '4.1', '4.4', '5.2', '7.1', '13'],
  },
  stage5: {
    label: '阶段5 章纲（每批 10 章）',
    ids: ['3.1', '4', '9.1', '14'],
  },
  stage6: {
    label: '阶段6 正文写作（两遍交付制）',
    ids: ['1.2', '1.3', '3.1', '3.4', '6.4', '6.5', '6.13', '6.14', '15'],
  },
  stage7: {
    label: '阶段7 完本修订',
    ids: ['5.3', '5.4', '16'],
  },
  report: {
    label: '连载状态报告（每 10 章）',
    ids: ['2.5', '9.1', '17'],
  },
  record: {
    label: '【设定记录】格式',
    ids: ['19'],
  },
  protocol: {
    label: '流程总控与交互协议',
    ids: ['9', '18'],
  },
};

/** 别名：允许调用方用中文/数字说阶段，不必记英文键。 */
const STAGE_ALIASES = {
  协商: 'negotiate', 开场: 'negotiate', 开工: 'negotiate',
  设定: 'stage1', 世界观: 'stage2', 人物: 'stage3', 建档: 'stage3',
  大纲: 'stage4', 部纲: 'stage4', 路线图: 'stage4',
  章纲: 'stage5', 细纲: 'stage5', 正文: 'stage6', 写作: 'stage6',
  修订: 'stage7', 完本: 'stage7', 报告: 'report', 连载报告: 'report',
  记录: 'record', 设定记录: 'record', 协议: 'protocol', 流程: 'protocol', 总控: 'protocol',
};

const STATUS_LABEL = { state: '已有', partial: '部分', new: '本次新增', agent: '工具不做' };

/**
 * 【设定记录】20 表 → 本工具包数据模型的落点（设计 D4 的口径表）。
 *
 * 已有=有现成落点且已进提交链；部分=有落点但字段不全，缺的部分落 notes/memory；
 * 本次新增=本版新增的账本；工具不做=机械校验覆盖不到，属于写作方执行项（诚实标注，不假装有）。
 */
export const SETTING_TABLE_MAP = [
  { table: '已锁定专名', target: '.webnovel/terms.json', status: 'new', note: '名词｜首次出现章号；提交时扫未登记专名并告警，此表是错字核对基准' },
  { table: '全书结构换算表', target: 'project.json + 设定集/全书结构换算表', status: 'partial', note: '体量→部/卷/层级/洋葱/悬念的公式在原文第二节，换算结果写进设定集并登记' },
  { table: '文风基准', target: '设定集/文风基准', status: 'partial', note: '三段样本要旨 + 文风指纹 3-5 项 + 上次校准章；漂移自动对比工具不做' },
  { table: '已确立设定', target: '设定集/*.md + memory.json(kind=rule)', status: 'state', note: '层级体系/金手指规则/铁律/世界观规则/俗套声明' },
  { table: '动机演进档案', target: 'state.protagonist.motivation', status: 'new', note: '开局/中点/终局三段 + 当前段位 + 转向事件 + 预定落点章' },
  { table: '人物三维档案', target: 'state.characters[]', status: 'partial', note: '补外在标签/欲望/恐惧/秘密创伤/内在矛盾/语言指纹' },
  { table: '口语档位档案', target: 'state.characters[].speech', status: 'new', note: '语气词组合/粗口档位/说话毛病/失控降级模式——对话与档位双重核对基准' },
  { table: '主角人味档案', target: 'state.protagonist.humanFlaws', status: 'new', note: '三个小毛病/一个私心/每卷犯错预案/完人路线声明' },
  { table: '人物状态', target: 'state.characters[]（位置/层级/伤势/已知信息/关系级别）', status: 'partial', note: '渐变桥进度与小弧光进度记在 memory/notes' },
  { table: '反派计划线', target: 'state.characters[].villainPlan', status: 'new', note: '目标/当前步骤/进度/对主角认知等级/所处洋葱层' },
  { table: '误导线索表', target: 'foreshadowing.json(type=misdirect)', status: 'new', note: '内容/指向的错误假设/真实解释/揭晓章——叙事债四类之一' },
  { table: '信息表', target: 'state.characters[].knows', status: 'new', note: '每角色知道/不知道/误以为；多视角信息隔离的机械校验工具不做' },
  { table: '悬念账户', target: 'foreshadowing.json(type=suspense)', status: 'new', note: '余额≥3（多部书≥4）由 doctor/pacing 计数核对' },
  { table: '支票清单', target: 'foreshadowing.json(type=promise)', status: 'new', note: '许诺内容/明写章/应兑现章；到期未兑=红灯' },
  { table: '伏笔台账', target: 'foreshadowing.json(type=foreshadow)', status: 'state', note: '现有台账，本版补 type 与暗示章' },
  { table: '感情线状态', target: 'state.romance', status: 'new', note: '仅启用感情线的书需要；当前拍/下一拍落点/主线咬合点' },
  { table: '时间线', target: 'state.timeline', status: 'state', note: '故事内日期/时辰，提交时累积' },
  { table: '已写章节摘要', target: '.webnovel/summaries/*.md + index.json', status: 'state', note: '本版把钩子类型/账户变动/冲突层级补进摘要结构' },
  { table: '世界状态', target: 'state.world', status: 'state', note: '势力格局/公开信息/地理版图，只增不减' },
  { table: '部N摘要（历史区）', target: '.webnovel/parts/partNN.md + state.parts', status: 'new', note: '部总结包归档处，历史区每部≤15 行' },
];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const normTail = (s) => String(s).replace(/\s+$/, '');

function catalogTextOf(catalog) {
  return JSON.stringify(catalog, null, 2) + '\n';
}

/** 读 catalog + 锁，并做陈旧度校验：对不上就抛错，绝不返回旧规则。 */
export function loadCatalog({ root = ROOT, verify = true } = {}) {
  const catPath = path.join(root, 'prompt', 'catalog.json');
  const lockPath = path.join(root, 'prompt', 'source-lock.json');
  if (!fs.existsSync(catPath) || !fs.existsSync(lockPath)) {
    throw new Error('提示词切片库未构建：缺 prompt/catalog.json 或 prompt/source-lock.json。'
      + '请先跑 node scripts/build-prompt-catalog.mjs');
  }
  const catalog = JSON.parse(fs.readFileSync(catPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (verify && sha256(catalogTextOf(catalog)) !== lock.catalogSha256) {
    throw new Error('catalog.json 与锁文件记录的哈希不符（被手改或原文已变）。'
      + '请重跑 node scripts/build-prompt-catalog.mjs 重新生成并锁定。');
  }
  return { catalog, lock };
}

/** 取切片：前缀展开（'6' → 6 与全部 6.x/6.x.y），按原文顺序、去重。 */
export function expandIds(catalog, ids) {
  const out = new Map();
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id) continue;
    if (id === 'all') {
      for (const u of catalog.units) out.set(u.id, u);
      continue;
    }
    const hit = catalog.units.filter((u) => u.id === id || u.id.startsWith(`${id}.`));
    if (!hit.length) throw new Error(`切片号不存在：${id}（用 action=sections 查可用切片号）`);
    for (const u of hit) out.set(u.id, u);
  }
  const order = new Map(catalog.units.map((u, i) => [u.id, i]));
  return [...out.values()].sort((a, b) => order.get(a.id) - order.get(b.id));
}

/** action=sections：切片目录 + 阶段包大小（不含正文，供调用方定位）。 */
export function craftSections(catalog) {
  const lines = [
    `《${catalog.title}》：${catalog.stats.sections} 节 / ${catalog.units.length} 切片 / ${catalog.stats.chars} 字`,
    `原文：${catalog.source}（sha256 ${catalog.sourceSha256.slice(0, 12)}…，逐字保留，切片无损）`,
    '',
    '切片目录：',
  ];
  for (const u of catalog.units) {
    const indent = u.level === 2 ? '' : u.level === 3 ? '  ' : '    ';
    lines.push(`${indent}${u.id}  ${u.title}  [${u.chars}字]`);
  }
  lines.push('', '阶段包（action=brief&stage=<阶段>）：');
  for (const [key, pack] of Object.entries(STAGE_PACKS)) {
    const units = expandIds(catalog, pack.ids);
    lines.push(`- ${key}｜${pack.label}：${units.length} 切片 / ${sumChars(units)} 字`);
  }
  return lines.join('\n');
}

const sumChars = (units) => units.reduce((a, u) => a + u.chars, 0);

/** action=get：按切片号取原文（逗号分隔多个；'15' 取整节；'all' 取全篇）。 */
export function craftGet(catalog, idsText, { maxChars = 0 } = {}) {
  const ids = String(idsText || '').split(/[,，\s]+/).filter(Boolean);
  if (!ids.length) throw new Error('action=get 需要 ids，例如 ids="15.8,19"，或整节 ids="15"，或全篇 ids="all"。');
  const units = expandIds(catalog, ids);
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Infinity;
  const kept = [];
  const skipped = [];
  let used = 0;
  for (const u of units) {
    if (used + u.chars > budget) { skipped.push(u); continue; }
    kept.push(u);
    used += u.chars;
  }
  const text = kept.map((u) => u.text).join('\n\n');
  const tail = skipped.length ? `\n\n（因超出 maxChars 省略 ${skipped.length} 个切片：${skipped.map((s) => s.id).join('、')}）` : '';
  return {
    units: kept,
    skipped,
    chars: used,
    text: text + tail,
    sourceSha256: catalog.sourceSha256,
  };
}

/** action=brief：按创作阶段组包（阶段规则的唯一切片化入口）。 */
export function craftBrief(catalog, stage, { maxChars = 0, extra = [] } = {}) {
  const key = resolveStage(stage);
  const pack = STAGE_PACKS[key];
  const ids = [...pack.ids, ...extra.map((s) => String(s).trim())].filter(Boolean);
  const units = expandIds(catalog, ids);
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Infinity;
  const kept = [];
  const skipped = [];
  let used = 0;
  for (const u of units) {
    if (used + u.chars > budget) { skipped.push(u); continue; }
    kept.push(u);
    used += u.chars;
  }
  const header = [
    `【创作规则包 · ${pack.label}】`,
    `唯一事实来源：${catalog.source}（sha ${catalog.sourceSha256.slice(0, 12)}…）`,
    `本包 ${kept.length} 个切片 / ${used} 字${skipped.length ? `（超预算省略 ${skipped.length} 个：${skipped.map((s) => s.id).join('、')}）` : ''}`,
  ];
  return {
    stage: key,
    label: pack.label,
    units: kept,
    skipped,
    chars: used,
    text: [...header, '', ...kept.map((u) => u.text)].join('\n\n'),
  };
}

/** 任务书注入用的「阶段硬规摘要」：只取本阶段最容易被漏的几条，严格限长。 */
export function stageRulesForBrief(catalog, stage, { maxChars = 1200 } = {}) {
  const key = resolveStage(stage);
  const brief = craftBrief(catalog, key, { maxChars });
  return { stage: key, label: brief.label, chars: brief.chars, text: brief.text, skipped: brief.skipped };
}

export function resolveStage(stage) {
  const raw = String(stage ?? 'stage6').trim();
  if (!raw) return 'stage6';
  if (STAGE_PACKS[raw]) return raw;
  const norm = raw.replace(/\s+/g, '');
  if (STAGE_ALIASES[norm]) return STAGE_ALIASES[norm];
  const m = /^阶段([一二三四五六七1234567])$/.exec(norm);
  if (m) {
    const cn = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7' };
    return `stage${cn[m[1]] ?? m[1]}`;
  }
  throw new Error(`未知阶段：${raw}。可用：${Object.keys(STAGE_PACKS).join(' / ')}（也支持「阶段3」「正文」「章纲」这类中文说法）`);
}

/** action=map：【设定记录】20 表 → 数据模型落点。 */
export function craftMap() {
  const rows = SETTING_TABLE_MAP.map((r) => `| ${r.table} | ${r.target} | ${STATUS_LABEL[r.status]} | ${r.note} |`);
  return [
    '【设定记录】20 表 → 工具包数据模型落点',
    '',
    '| 设定记录表 | 落在哪 | 现状 | 说明 |',
    '|---|---|---|---|',
    ...rows,
    '',
    `合计 ${SETTING_TABLE_MAP.length} 表：已有 ${countBy('state')}、部分 ${countBy('partial')}、本次新增 ${countBy('new')}、工具不做 ${countBy('agent')}。`,
    '',
    '口径：工具只管能机械核对的账（专名、伏笔/悬念/支票/误导四类叙事债、人物状态、时间线、章节摘要）；',
    '文风漂移自动对比、多视角信息隔离的机械校验、查重不在工具范围内，属于写作方执行项（见 README「能力边界」）。',
  ].join('\n');
}

const countBy = (status) => SETTING_TABLE_MAP.filter((r) => r.status === status).length;

/** action=check：运行时三方对账（原文 ↔ 锁 ↔ 切片库），证明线上用的规则就是仓库里那份。 */
export function craftCheck({ root = ROOT } = {}) {
  const paths = {
    source: path.join(root, 'prompt', 'CREATIVE-PROMPT.md'),
    catalog: path.join(root, 'prompt', 'catalog.json'),
    lock: path.join(root, 'prompt', 'source-lock.json'),
  };
  const problems = [];
  for (const [name, p] of Object.entries(paths)) {
    if (!fs.existsSync(p)) problems.push(`缺失文件（${name}）：prompt/${path.basename(p)} —— 跑 node scripts/build-prompt-catalog.mjs 生成`);
  }
  if (problems.length) return { ok: false, problems, stats: null };

  const raw = fs.readFileSync(paths.source, 'utf8');
  const srcSha = sha256(raw);
  const lock = JSON.parse(fs.readFileSync(paths.lock, 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(paths.catalog, 'utf8'));

  if (srcSha !== lock.sourceSha256) {
    problems.push(`C5 原文哈希漂移：现算 ${srcSha.slice(0, 12)}… ≠ 锁定 ${lock.sourceSha256.slice(0, 12)}…（原文被改或行尾变了）`);
  }
  if (sha256(catalogTextOf(catalog)) !== lock.catalogSha256) {
    problems.push('catalog.json 内容哈希与锁不符（被手改）');
  }
  if (catalog.sourceSha256 !== lock.sourceSha256) problems.push('catalog 与 lock 记录的原文哈希不一致');
  if (catalog.source !== 'prompt/CREATIVE-PROMPT.md') problems.push(`catalog.source 指错了：${catalog.source}`);

  const parsed = parsePrompt(raw);
  const vp = verifyUnits(parsed);
  problems.push(...vp);
  if (!vp.length && normTail(reconstruct(parsed)) !== normTail(raw)) {
    problems.push('C7 切片拼接还原与原文不一致');
  }
  // 已落盘的 catalog 与「从原文重建」必须同一份（防止原文改了但忘了重跑构建器）
  if (!vp.length) {
    const fp = (u) => `${u.id}|${u.startLine}|${u.endLine}|${u.chars}|${sha256(u.text).slice(0, 16)}`;
    const rebuilt = parsed.units.map(fp).join('\n');
    const onDisk = catalog.units.map(fp).join('\n');
    if (rebuilt !== onDisk) problems.push('catalog 的切片边界/字数/正文与当前原文重建结果不一致（切片陈旧或被手改）');
  }

  return {
    ok: problems.length === 0,
    problems,
    stats: {
      sections: catalog.stats.sections,
      units: catalog.units.length,
      chars: catalog.stats.chars,
      sourceSha256: srcSha,
      checkedFrom: root,
    },
  };
}

/** 渲染 action=check 的返回文本。 */
export function renderCheck(result) {
  if (!result.ok) {
    return ['✗ 提示词切片库自检不通过：', ...result.problems.map((p) => `  - ${p}`)].join('\n');
  }
  const s = result.stats;
  return [`✓ 原文 / 切片库 / 锁 三方一致：${s.sections} 节 ${s.units} 切片 ${s.chars} 字`,
    `  原文 sha256=${s.sourceSha256}`,
    '  规则以 prompt/CREATIVE-PROMPT.md 为唯一事实来源；改原文后必须重跑 scripts/build-prompt-catalog.mjs。'].join('\n');
}

export const CRAFT_ROOT = ROOT;
