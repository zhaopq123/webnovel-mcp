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
/**
 * 仓库根：lib/features → 上两级。原文/切片/锁都相对模块自身定位，不依赖 cwd。
 * WEBNOVEL_PROMPT_ROOT 与 scripts/build-prompt-catalog.mjs 共用同一个旋钮：
 * 部署改位、以及让「篡改即红」的测试在临时副本上跑，不动工作树。
 * 每次调用现读环境变量，不在模块加载时固化 —— 指错不会静默返回空规则，
 * loadCatalog 会明确报「切片库未构建」，测试也能当场模拟漏拷。
 */
export function craftRoot() {
  return process.env.WEBNOVEL_PROMPT_ROOT
    ? path.resolve(process.env.WEBNOVEL_PROMPT_ROOT)
    : path.resolve(HERE, '..', '..');
}

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
/**
 * 【设定记录】20 表 → 本工具包数据模型的落点（设计 D4 的口径表）。
 *
 * 已有=有现成落点且已进提交链；部分=有落点但字段不全，缺的部分落 notes/memory；
 * 本次新增=本版新增的账本；工具不做=机械校验覆盖不到，属于写作方执行项（诚实标注，不假装有）。
 *
 * ⚠ target 写的是**今天真读得出来的字段名**，不是设计意图。这张表会被 agent 当成
 * 「该往哪个键里塞东西」的说明书（`action=map` 原样输出），写一个不存在的键＝让工具撒谎。
 * 每落地一条数据模型（计划第 9-14 条）都要回来改这一行。
 */
export const SETTING_TABLE_MAP = [
  { table: '已锁定专名', target: '.webnovel/terms.json（deltas.terms[]）', status: 'new', note: '名词｜类别｜首次出现章号｜别名；提交时扫未登记专名并告警，此表是错字核对基准' },
  { table: '全书结构换算表', target: 'structure.js 按 project.targetWords 现算（webnovel_status / webnovel_init 输出）', status: 'new', note: '部/卷/大层级/洋葱/悬念层数/预计章数；刻意不落盘——改了目标字数表就跟着变，存一份就多一份假账' },
  { table: '文风基准', target: 'memory.json(kind=style) + 设定集/文风基准', status: 'partial', note: '三段样本要旨 + 文风指纹 3-5 项 + 上次校准章；每 30 章的漂移自动对比工具不做（见第十九节外的「工具不做」清单）' },
  { table: '已确立设定', target: 'state.world + outline action=write_master', status: 'state', note: '层级体系/金手指规则/铁律/世界观规则/俗套声明' },
  { table: '动机演进档案', target: 'memory.json(kind=setting) 固定标题条目', status: 'agent', note: '开局/中点/终局三段 + 当前段位 + 转向事件；工具只存条目，段位推进是否合理由作者与 agent 判' },
  { table: '人物三维档案', target: 'state.characters[].{desire,fear,secret,contradiction}', status: 'new', note: '6.1 三层 + 6.2 内在矛盾；主要人物缺项由 status 报缺口、任务书点名' },
  { table: '口语档位档案', target: 'state.characters[].voice', status: 'new', note: 'fingerprint/sentenceLen/tone/vocabulary/address/avoidTopics/fillers/profanity/tics/meltdown——对话与档位双重核对基准' },
  { table: '主角人味档案', target: 'state.protagonist.humanFlaws', status: 'new', note: 'habits（三个小毛病）/selfishMotive（一个私心）/errorPlan（犯错预案）；完人路线声明写进 master 段' },
  { table: '人物状态', target: 'state.characters[]（location/realm/relationLevel/knows/notKnows/mistaken）', status: 'new', note: '渐变桥进度与小弧光进度记 arcProgress，其余落 notes/memory' },
  { table: '反派计划线', target: 'state.characters[].plan（role=反派时缺 plan 报缺口）', status: 'new', note: '目标/当前步骤/进度写在同一条文本里；对主角认知等级与洋葱层由作者维护' },
  { table: '误导线索表', target: 'foreshadowing.json（type=red_herring）', status: 'new', note: 'falseAssumption（要骗读者相信的错假设）/realExplanation（真实解释）；没写真实解释是 🔴——骗读者不可挽回' },
  { table: '信息表', target: 'state.characters[].{knows,notKnows,mistaken}', status: 'new', note: '跨章累积去重；3.6⑧ 归属核对拿它逐条台词比对，说错人当场红。多视角信息隔离的全量交叉校验工具不做' },
  { table: '悬念账户', target: 'foreshadowing.json（type=suspense + layer）', status: 'new', note: '余额线 3（多部书 4）与悬置 40/50 章由 ledger.js 算，status/任务书/query 三处同一个数' },
  { table: '支票清单', target: 'foreshadowing.json（type=cheque + plannedPayoff）', status: 'new', note: '到期前提醒、宽限内逾期、超宽限违约三档；dueChapter 归一进 plannedPayoff，不存两份' },
  { table: '伏笔台账', target: 'foreshadowing.json（type=foreshadow，同时是缺省类别）', status: 'state', note: '本版补 type/layer/hintChapters；暗埋的伏笔不吃「40 章没暗示」判据（那等于逼作者剧透）' },
  { table: '感情线状态', target: 'state.characters[].relationLevel（1-5）+ outline master 段六拍文本', status: 'partial', note: '仅启用感情线的书需要；当前拍/下一拍落点/主线咬合点没有独立结构，写在 master 段' },
  { table: '时间线', target: 'state.timeline', status: 'state', note: '故事内日期/时辰，提交时累积' },
  { table: '已写章节摘要', target: '.webnovel/index.json chapters[].{summary,hook,strand,ending}', status: 'state', note: '本版钩子按 {type,strength} 存；账户变动与冲突层级写在 summary 文本里' },
  { table: '世界状态', target: 'state.world', status: 'state', note: '势力格局/公开信息/地理版图，只增不减' },
  { table: '部N摘要（历史区）', target: '（未落地）计划第 14 条：.webnovel/parts/ + state.progress.parts', status: 'agent', note: '本版内由作者把部总结写进设定集并登记；落地后这一行改成真实路径' },
];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const normTail = (s) => String(s).replace(/\s+$/, '');

function catalogTextOf(catalog) {
  return JSON.stringify(catalog, null, 2) + '\n';
}

/** 读 catalog + 锁，并做陈旧度校验：对不上就抛错，绝不返回旧规则。 */
export function loadCatalog({ root = craftRoot(), verify = true } = {}) {
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

/**
 * 任务书注入用的「本章必守」优先级表（P1 #13）。
 *
 * 为什么不整段塞、也不按原文顺序取：正文规则全量 5000+ 字，每章都带上会挤掉本书事实；
 * 按原文顺序取又会把 15.4/15.7/15.8 这几条最容易忘、后果最重的规则截掉。
 * 所以这里是一张**人工排的优先级表**：从最要命的开始，取到预算用完为止，
 * 被截掉哪些必须在返回里说出来（不许静默丢规则）。
 *
 * 排序依据（按「每字成本 × 工具能不能兜住」）：
 *  1. 铁律与交付流程（1.2/15.8）——不做就整章返工，且无任何工具能替它把关；
 *  2. 短而硬性（1.3 合规 50 字、6.5/15.3.6/4.2 均 ≤170 字）——性价比最高，先占位；
 *  3. 工具当场抓不到的写作规则（15.5 去 AI 味、15.7 洁净度：库里没有繁体/标点/错别字检测器，
 *     写了就没法回头）；
 *  4. 长而偏「审校阶段」的（15.9/15.4）——放后面，预算不够时靠未带清单指路
 *     `webnovel_craft action=get`，一步就能取到，不让模型「执行一条它拿不到的规则」。
 *
 * 加塞项（briefTriggers）排在表首，它占的字数就是从那几章的尾部扣的：报告节点章带
 * 第十七节（874 字）会把 15.5/15.7 挤出预算。这是取舍不是 bug——被挤掉的条目一律进
 * 未带清单并指路 craft，且该行为被测试锁死（有人改成语义不明的「装箱」会当场变红）。
 */
export const BRIEF_PRIORITY = [
  { id: '1.2', why: '防幻觉三铁律：名词锁定/不确定必问/前文依据' },
  { id: '15.8', why: '两遍交付制：写完不等于交付' },
  { id: '3.1', why: '五条追踪线：断裂即返工' },
  { id: '1.3', why: '合规红线' },
  { id: '15.3.6', why: '对话人味四项（15.8 第一扫要执行）' },
  { id: '6.5', why: '语言指纹：遮住名字认得出是谁' },
  { id: '4.2', why: '章末/章中钩子五种类型，写完要标类型' },
  { id: '15.5', why: '去 AI 味：词汇黑名单与句式纪律' },
  { id: '15.7', why: '文字洁净度（15.8 第二扫要执行；工具不检测，只能写时守）' },
  { id: '15.9', why: '交付自检清单（两遍制的收口）' },
  { id: '15.4', why: '可读性铁律（15.8 第二扫要执行；未带时用 craft 取原文）' },
  { id: '15.6', why: '文风锚点：每 30 章校准一次' },
];

/** 本章特殊情况下的加塞项（在优先级表之前插入，仍受预算约束）。 */
export function briefTriggers({ romanceEnabled = false, debtDue = 0, batchReport = false } = {}) {
  const extra = [];
  if (batchReport) extra.push({ id: '17', why: '本章是每 10 章的报告节点' });
  if (debtDue > 0) extra.push({ id: '4.1', why: `本章有 ${debtDue} 笔叙事债到期` });
  if (romanceEnabled) extra.push({ id: '7.2', why: '本书启用感情线' });
  return extra;
}

/**
 * 任务书里的「本章必守」：按优先级装配、严格限长、截断显式声明。
 * 默认预算只在本文件定义一次（context.js 与 mcp/tools.mjs 都引这个常量，避免三处漂移）。
 * 2400 字 ≈ 1600 token/章：装得下「工具兜不住的那部分规则」的前 9 片——
 * 三铁律、两遍制、追踪线、合规、对话人味、语言指纹、钩子类型、去 AI 味、**文字洁净度 15.7**；
 * 15.9/15.4/15.6 靠未带清单指路 `webnovel_craft action=get` 一步取到。嫌贵用 WEBNOVEL_BRIEF_RULES_CHARS 调小或 off。
 */
export const BRIEF_DEFAULT_CHARS = 2400;

/**
 * 装配口径：**按优先级取到装不下为止（截断），不是「挑能装的下」（装箱）**。
 *
 * 为什么必须 break 而不是 continue：优先级表说的是「哪条更要命」，
 * 装箱语义会为了塞进后面一条小规则而跳过前面一条大规则——结果每章任务书都缺 15.7
 * （文字洁净度），却带着 15.6（文风锚点，30 章才用一次）。更要命的是这类缺口工具事后查不出来：
 * 繁体/标点/错别字没人检测，写了就没法回头。宁可少带，不能倒序带。
 *
 * 未带条目一律进 dropped（指路 `webnovel_craft action=get`），不许静默丢规则。
 */
export function briefRules(catalog, { maxChars = BRIEF_DEFAULT_CHARS, triggers = [] } = {}) {
  const byId = new Map(catalog.units.map((u) => [u.id, u]));
  const plan = [...triggers, ...BRIEF_PRIORITY];
  const unique = [...new Set(plan.map((item) => item.id))];
  // 表完整性与预算无关：低优先级的 id 写错了，哪怕永远装不下也必须当场炸（否则这条规则会永远静默消失）
  const missing = unique.filter((id) => !byId.get(id));
  if (missing.length > 0) throw new Error(`BRIEF_PRIORITY 引用了不存在的切片 ${missing.join('、')}`);

  const kept = [];
  const dropped = [];
  const keptIds = new Set();
  const droppedIds = new Set();
  let used = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const item = plan[i];
    if (keptIds.has(item.id)) continue;   // 触发项与表里同一条：只带一次
    const u = byId.get(item.id);
    if (used + u.chars > maxChars) {
      // 第一处装不下＝截断点：连它带它之后的所有条目全部记为未带。
      // 注意是 slice(i) 不是 slice(i+1)——装不下的那一条自己也是最该被点名的，漏了它任务书就会
      // 出现「规则凭空消失但没写在未带清单里」，那正是本函数要消灭的静默丢规则。
      for (const rest of plan.slice(i)) {
        if (keptIds.has(rest.id) || droppedIds.has(rest.id)) continue;
        droppedIds.add(rest.id);
        dropped.push(rest);
      }
      break;
    }
    keptIds.add(item.id);
    kept.push({ ...item, unit: u });
    used += u.chars;
  }
  return {
    kept: kept.map((k) => ({ id: k.id, why: k.why, chars: k.unit.chars })),
    dropped: dropped.map((d) => ({ id: d.id, why: d.why })),
    chars: used,
    maxChars,
    truncated: dropped.length > 0,
    text: kept.map((k) => k.unit.text).join('\n\n'),
    sourceSha256: catalog.sourceSha256,
  };
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
export function craftCheck({ root = craftRoot() } = {}) {
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
