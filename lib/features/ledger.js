/**
 * 叙事债务账本（提示词 4.1 悬念账户 / 4.4 支票 / 第五节 红鲱鱼 / 第十七节 连载状态报告的落点）。
 *
 * 为什么要并成一个账本：这四样在原文里是四张表，但它们是同一种东西——
 * 「作者欠读者的、还没还的」。分开记就没人对总账，而读者的弃书点恰恰是总账爆了的那天。
 * 现有 `foreshadowing.json` 已经是「条目 + 状态 + 章号」的形状，所以不再新建第四份 JSON，
 * 而是给它加维度：`type`（伏笔/悬念/支票/红鲱鱼）、`layer`（悬念账户层，层名沿用换算表 2.3）、
 * `hintChapters[]`（暗示过哪几章）、`readerAware`、`realExplanation`/`falseAssumption`（红鲱鱼专用）。
 * 「应兑现/应回收章」不新增字段：入参可写 `dueChapter`，落库归一进已有的 `plannedPayoff`
 * （理由见 `dueOf` 上方注释）。
 *
 * 三条硬口径，动这个文件前先读：
 * 1. **字段按「省略默认值」存**：`type==='foreshadow'`、`layer===null`、空数组、空串一律不写进
 *    JSON。这样 v1.2.x 老书读出来的条目形状，与 doctor 从提交链重放出来的条目形状完全一致
 *    （`replay-foreshadowing` 是整表比对的，多一个键就永久告警）；读侧取值统一走下面的
 *    `typeOf/layerOf/hintsOf/dueOf/readerAwareOf`，别在调用处 `item.type || 'foreshadow'` 各写一遍。
 * 2. **判据由代码算，不靠作者自觉**：余额、悬置章数、逾期章数都从这里出，
 *    status / 任务书 / query 三处共用同一份判定，别在渲染层重新发明阈值。
 * 3. **阈值只在 LEDGER_THRESHOLDS 定义一次**（50 章硬线来自 2.3，支票 5 章宽限来自 4.4，
 *    余额 ≥3 / 多部书 ≥4 来自 4.1）。
 */
import { toInt } from '../util.js';
import { SUSPENSE_LAYERS, computeStructure, suspenseLayersFor } from './structure.js';

/** 四类债务（`type` 的合法值；key 存英文、label 给人看，跟专名账本一个套路）。 */
export const LEDGER_TYPES = {
  foreshadow: { label: '伏笔', en: 'foreshadow', zh: ['伏笔', '暗线'] },
  suspense: { label: '悬念', en: 'suspense', zh: ['悬念', '悬念账户', '在线问题'] },
  cheque: { label: '支票', en: 'cheque', zh: ['支票', '许诺', '预告'] },
  red_herring: { label: '红鲱鱼', en: 'red_herring', zh: ['红鲱鱼', '误导线索', '误导'] },
};

export const LEDGER_DEFAULT_TYPE = 'foreshadow';

/** 判据阈值（来源都标在注释里，改数值必须同时改来源说明）。 */
export const LEDGER_THRESHOLDS = {
  idleWarn: 40,            // 悬念账户：离 50 章硬线还剩 10 章就预警（别等撞线才说）
  idleHard: 50,            // 2.3「任何层的问题悬置超 50 章无暗示＝警报」
  chequeGrace: 5,          // 4.4「拖延不超过 5 章」
  chequeSoon: 3,           // 到期前 3 章提醒安排（不是原文数字，是给作者的提前量）
  minBalance: 3,           // 4.1「任何时刻余额 ≥3」
  minBalanceMultiPart: 4,  // 4.1「多部书 ≥4」
};

/**
 * 尝试认出作者写的类别（认不出来返回 null，由调用方决定是提示还是兜底）。
 * 认三种写法：英文 key（`suspense`）、中文正式名（`悬念`）、以及常见同义词
 * （`支票`/`许诺`/`预告`、`误导线索`…）。
 */
function matchLedgerType(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (LEDGER_TYPES[raw]) return raw;
  for (const [key, def] of Object.entries(LEDGER_TYPES)) {
    if (def.zh.some((z) => raw === z.toLowerCase() || raw.includes(z.toLowerCase()))) return key;
  }
  if (raw.includes('cheque') || raw.includes('check') || raw.includes('promise')) return 'cheque';
  if (raw.includes('suspense') || raw.includes('question')) return 'suspense';
  if (raw.includes('hering') || raw.includes('mislead')) return 'red_herring';
  return null;
}

/** 认类型：认不出来就退回默认值（老账本本来就只有伏笔）。 */
export function normalizeLedgerType(value) {
  return matchLedgerType(value) ?? LEDGER_DEFAULT_TYPE;
}

/**
 * 「这个词到底认出来了没」。与 normalizeLedgerType 分开是有必要的：
 * 兜底成伏笔 和 作者真写了伏笔，结果相同、但该不该提醒不同——
 * 把「支票」静默存成伏笔，等于把这条债从总账里抹掉，必须当场说。
 */
export function isKnownLedgerType(value) {
  return matchLedgerType(value) !== null;
}

/**
 * 类型的中文label。**既接受类型值（`cheque`／`支票`），也接受条目对象**（取它的 `.type`）：
 * 调用处两种写法都有，只认值会把对象 stringify 成 `[object Object]`、
 * 然后静默兜底成「伏笔」——支票在回执里被念成伏笔，实测踩过，所以这里显式兼容。
 */
export function ledgerTypeLabel(value) {
  const raw = value && typeof value === 'object' ? value.type : value;
  return LEDGER_TYPES[normalizeLedgerType(raw ?? LEDGER_DEFAULT_TYPE)].label;
}

/** 认悬念账户层：接受「短/短期/短期问题」「部/本部级」这类写法，认不出来返回 null。 */
export function normalizeLedgerLayer(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (SUSPENSE_LAYERS.includes(raw)) return raw;
  for (const layer of SUSPENSE_LAYERS) {
    if (raw === `本${layer}级` || raw === `${layer}级` || raw.startsWith(layer)) return layer;
  }
  if (raw.startsWith('短期')) return '短';
  if (raw.startsWith('跨部')) return '跨部';
  if (raw.startsWith('全书')) return '全书';
  return null;
}

/* ------------------------------------------------------------------ *
 * 读侧取值（默认值在这里，不在 JSON 里）
 * ------------------------------------------------------------------ */

export const typeOf = (item) => normalizeLedgerType(item?.type);
export const layerOf = (item) => normalizeLedgerLayer(item?.layer);
export const hintsOf = (item) => (Array.isArray(item?.hintChapters)
  ? [...new Set(item.hintChapters.map((c) => toInt(c)).filter((c) => c > 0))].sort((a, b) => a - b)
  : []);
/**
 * 到期章。**账上只存一个**：写入侧（commit）把 `dueChapter` 归一到 `plannedPayoff`，
 * 因为后者是 v1.2 就有的字段，`openForeshadowing` / 任务书红榜 / query 的到期判定全都读它——
 * 再存一份 dueChapter 等于同一件事两个真相，改一个忘一个就会让「任务书说到期」和
 * 「总账说逾期」互相打架。这里仍兼容读 dueChapter，是给手写 JSON 与历史数据的退路。
 */
export const dueOf = (item) => {
  const direct = item?.dueChapter === null || item?.dueChapter === undefined ? null : toInt(item.dueChapter);
  if (direct !== null && direct > 0) return direct;
  const planned = item?.plannedPayoff === null || item?.plannedPayoff === undefined ? null : toInt(item.plannedPayoff);
  return planned !== null && planned > 0 ? planned : null;
};
/** 4.1：埋了但读者没意识到的问题不算余额。没标注时按「已意识到」处理（新悬念会单独提醒补标注）。 */
export const readerAwareOf = (item) => item?.readerAware !== false && item?.readerAware !== 'false';
export const isOpen = (item) => String(item?.status ?? 'open') === 'open';

/** 把「已意识到」写成布尔存进条目（true 是默认值，按口径 1 省略不存）。 */
function compactReaderAware(value) {
  if (value === undefined || value === null) return null;
  const v = value === true || value === 'true' || value === '是' || value === 1;
  return v ? null : false;
}

/**
 * 生成「只存非默认值」的条目补丁。upsert 走 deepMerge，所以这里省略的键＝不写入，
 * 老条目的形状不会因为升级而漂移（doctor 的整表对账才稳）。
 */
export function compactLedgerPatch(item = {}) {
  const out = {};
  const type = String(item.type ?? '').trim();
  if (type && normalizeLedgerType(type) !== LEDGER_DEFAULT_TYPE) out.type = normalizeLedgerType(type);
  else if (type) out.type = LEDGER_DEFAULT_TYPE;   // 作者显式写了「伏笔」就照存，别自作主张抹掉
  const layer = normalizeLedgerLayer(item.layer);
  if (layer) out.layer = layer;
  // dueChapter 不单独存：写入侧已归一进 plannedPayoff（见 dueOf 上方注释）。
  // 存两份就是两个真相——改一处漏一处，任务书与总账会互相打架。
  const hints = hintsOf(item);
  if (hints.length > 0) out.hintChapters = hints;
  const aware = compactReaderAware(item.readerAware);
  if (aware !== null) out.readerAware = aware;
  if (String(item.realExplanation ?? '').trim()) out.realExplanation = String(item.realExplanation).trim();
  if (String(item.falseAssumption ?? '').trim()) out.falseAssumption = String(item.falseAssumption).trim();
  return out;
}

/** 记一次暗示（同章重复登记不会把数组撑大——累积的是事实，不是次数）。 */
export function withHint(item, chapter) {
  const hints = hintsOf(item);
  const num = toInt(chapter);
  if (num <= 0) return item;
  if (hints.includes(num)) return item;
  return { ...item, hintChapters: [...hints, num].sort((a, b) => a - b) };
}

/** 合并两份暗示章列表（提交链重放是累积式重放，必须幂等）。 */
export function mergeHints(a, b) {
  const all = [...hintsOf({ hintChapters: a ?? [] }), ...hintsOf({ hintChapters: b ?? [] })];
  return [...new Set(all)].sort((x, y) => x - y);
}

/* ------------------------------------------------------------------ *
 * 总账
 * ------------------------------------------------------------------ */

/**
 * 算一次叙事债务。纯函数，不读盘。
 * @param {object} ledger foreshadowing.json 的 {items}
 * @param {{chapter?:number, partsCount?:number, thresholds?:object}} options
 *   chapter=当前章（已提交的最后一章）；partsCount=部数（来自体量换算表，决定余额门槛 3/4）；
 *   thresholds=覆盖个别阈值（只给测试用：判据必须随常量移动，写死数字的用例证明不了这点）。
 */
export function narrativeDebt(ledger, options = {}) {
  const chapter = Math.max(0, toInt(options.chapter));
  const partsCount = Math.max(1, toInt(options.partsCount, 1));
  const T = { ...LEDGER_THRESHOLDS, ...(options.thresholds ?? {}) };
  const required = partsCount >= 2 ? T.minBalanceMultiPart : T.minBalance;
  // 本书启用的悬念账户层（2.3 按部数加分段层）——层名与层数都来自体量换算表，
  // 账本里出现「全书」层的悬念而本书只有 1 部，说明作者按另一套结构在记。
  const enabledLayers = suspenseLayersFor(partsCount);

  const items = Array.isArray(ledger?.items) ? ledger.items : [];
  const openItems = items.filter(isOpen);
  const byType = { foreshadow: [], suspense: [], cheque: [], red_herring: [] };
  for (const it of openItems) byType[typeOf(it)].push(it);

  // 只有作者真的在用悬念账户（登记过 type=suspense）时才执法。
  // 老书一条悬念都没有，直接判「余额 0 < 3」会把整套机制变成每日噪音——那是最典型的
  // 「判据太吵，于是没人再看」的死法；所以这里退回一句指路，不报警。
  const adopted = items.some((i) => typeOf(i) === 'suspense');

  const balanceByLayer = {};
  for (const layer of SUSPENSE_LAYERS) balanceByLayer[layer] = 0;
  balanceByLayer['未分层'] = 0;
  let balance = 0;
  const unlayered = [];
  const offLayer = [];
  for (const it of byType.suspense) {
    if (!readerAwareOf(it)) continue;   // 4.1：读者没意识到的不算余额
    balance += 1;
    const layer = layerOf(it);
    if (layer) {
      balanceByLayer[layer] += 1;
      if (!enabledLayers.includes(layer)) offLayer.push({ name: it.name, layer });
    } else {
      balanceByLayer['未分层'] += 1;
      unlayered.push(it.name);
    }
  }

  const alerts = [];
  const push = (level, code, message, extra = {}) => {
    alerts.push({ level, code, message, ...extra });
  };

  // ── ① 余额（4.1）────────────────────────────────────────────────
  if (adopted) {
    if (balance === 0) {
      push('error', 'account-empty',
        `悬念账户清空（在线问题 0 个）。4.1 禁止账户清空——只允许全书终章出现一次；`
        + `回收旧问题的同时必须同步或提前抛出新问题。`,
        { balance, required });
    } else if (balance < required) {
      push('error', 'balance-low',
        `悬念账户余额 ${balance} 个，低于 ${required} 个的线（4.1：任何时刻余额≥${T.minBalance}${partsCount >= 2 ? `，本书 ${partsCount} 部→≥${T.minBalanceMultiPart}` : ''}）。下一批必须补。`,
        { balance, required });
    }
    if (unlayered.length > 0) {
      push('warn', 'suspense-unlayered',
        `这些悬念没标 layer，账户没法按层核对：${unlayered.slice(0, 6).join('、')}${unlayered.length > 6 ? '…' : ''}。`
        + `本书启用的层：「${enabledLayers.join('/')}」（2.3，由目标字数换算）。`, { names: unlayered });
    }
    if (offLayer.length > 0) {
      push('warn', 'suspense-layer-off',
        `这些悬念标了本书没启用的层：${offLayer.map((x) => `${x.name}（${x.layer}）`).join('、')}。`
        + `本书按 ${partsCount} 部算只有「${enabledLayers.join('/')}」这几层（2.3）——`
        + '层用错会导致部末收不清账户，改成本书有的层。', { names: offLayer.map((x) => x.name) });
    }

    // ── ①.5 层级阶梯（2.3）：新开一层不得跳过中间层 ──────────────────
    // 判定看「历史上真的开过哪些层」而不是只看 open：已回收的短/卷层同样证明
    // 这本书是一级一级加上来的。1 部书的跨部/全书层由上面的 suspense-layer-off 管，
    // 这里只管「启用的层内部有没有断档」。
    const usedLayers = new Set();
    for (const it of items) {
      if (typeOf(it) !== 'suspense') continue;
      const layer = layerOf(it);
      if (layer) usedLayers.add(layer);
    }
    const gaps = [];
    for (let i = 0; i < enabledLayers.length; i += 1) {
      const layer = enabledLayers[i];
      if (!usedLayers.has(layer)) continue;
      const missing = enabledLayers.slice(0, i).filter((l) => !usedLayers.has(l));
      if (missing.length > 0) gaps.push(`「${layer}」层（缺 ${missing.join('/')}）`);
    }
    if (gaps.length > 0) {
      push('warn', 'suspense-layer-skip',
        `悬念层级跳级：${gaps.join('、')}。2.3 要求按「${enabledLayers.join('→')}」逐级加层——`
        + '先把缺的那一层开起来（哪怕只留一个在线问题），否则部末收账户时会缺一整级可收的债。',
        { layers: [...usedLayers] });
    }
  } else if (chapter > 0) {
    push('info', 'account-not-adopted',
      '台账里还没有悬念账户条目（type=suspense）。4.1 要求任何时刻余额≥'
      + `${T.minBalance}${partsCount >= 2 ? `（多部书≥${T.minBalanceMultiPart}）` : ''}——`
      + '把「读者此刻在追的问题」用 deltas.foreshadowing.planted 的 type=suspense + layer 登记进来，本判据才会开始执法。',
      { balance, required });
  }

  // ── ② 悬置无暗示（2.3 硬线 50 章）：只对悬念账户执法 ───────────────
  // 为什么不对伏笔执法：4.4 明写「暗埋的伏笔回收时兑现惊喜，不提前剧透」——
  // 对暗线喊「你都 40 章没暗示了」等于逼作者剧透，判据本身就成了干扰。
  const idle = [];
  for (const it of byType.suspense) {
    const hints = hintsOf(it);
    const from = hints.length > 0 ? hints[hints.length - 1] : toInt(it.plantedChapter, chapter);
    const silent = Math.max(0, chapter - from);
    if (silent >= T.idleHard) {
      idle.push({ name: it.name, layer: layerOf(it), silentChapters: silent, lastHint: hints.at(-1) ?? null, level: 'error' });
      push('error', 'suspense-idle',
        `悬念「${it.name}」${hints.length ? `自第 ${hints[hints.length - 1]} 章暗示过之后` : `自第 ${toInt(it.plantedChapter)} 章抛出以来`}`
        + `已悬置 ${silent} 章无暗示，超过 2.3 的 ${T.idleHard} 章硬线——读者已经忘了这个问题，直接回收会显得突兀，`
        + `先补一次暗示再收。`, { name: it.name, silentChapters: silent });
    } else if (silent >= T.idleWarn) {
      idle.push({ name: it.name, layer: layerOf(it), silentChapters: silent, lastHint: hints.at(-1) ?? null, level: 'warn' });
      push('warn', 'suspense-aging',
        `悬念「${it.name}」已 ${silent} 章无暗示（离 ${T.idleHard} 章硬线还剩 ${T.idleHard - silent} 章），近期安排一次露脸。`,
        { name: it.name, silentChapters: silent });
    }
  }

  // ── ③ 支票（4.4）─────────────────────────────────────────────────
  const cheques = { open: [], dueSoon: [], grace: [], breaching: [], undated: [] };
  for (const it of byType.cheque) {
    const due = dueOf(it);
    const entry = {
      name: it.name, dueChapter: due, late: due === null ? null : chapter - due,
      interest: String(it.note ?? ''),
    };
    cheques.open.push(entry);
    if (due === null) {
      cheques.undated.push(entry);
      push('warn', 'cheque-undated',
        `支票「${it.name}」没写应兑现章（dueChapter）。4.4 的「拖延不超过 ${T.chequeGrace} 章」没法判——`
        + `明写了许诺就得定下哪天还。`, { name: it.name });
      continue;
    }
    if (entry.late > T.chequeGrace) {
      push('error', 'cheque-breached',
        `支票「${it.name}」明写于第 ${toInt(it.plantedChapter)} 章、应第 ${due} 章兑现，`
        + `现在第 ${chapter} 章已拖 ${entry.late} 章，超出 4.4 的 ${T.chequeGrace} 章上限。`
        + `要么本章兑现，要么用利息补偿（冲突升级/新变数）并改 dueChapter。`,
        { name: it.name, late: entry.late });
      cheques.breaching.push(entry);
    } else if (entry.late > 0) {
      push('warn', 'cheque-late',
        `支票「${it.name}」已逾期 ${entry.late} 章（4.4 允许最多拖 ${T.chequeGrace} 章，剩 ${T.chequeGrace - entry.late} 章），`
        + '拖延期要用利息补偿：冲突升级或新变数。', { name: it.name, late: entry.late });
      cheques.grace.push(entry);
    } else if (due - chapter <= T.chequeSoon) {
      push('warn', 'cheque-due-soon',
        `支票「${it.name}」第 ${due} 章到期（还剩 ${due - chapter} 章），本章或下章要兑现。`,
        { name: it.name });
      cheques.dueSoon.push(entry);
    }
  }

  // ── ④ 红鲱鱼（第五节：误导线索的诚实性）───────────────────────────
  const redHerrings = { open: [], missingExplanation: [], missingAssumption: [] };
  for (const it of byType.red_herring) {
    const entry = {
      name: it.name, realExplanation: String(it.realExplanation ?? ''), falseAssumption: String(it.falseAssumption ?? ''),
      dueChapter: dueOf(it),
    };
    redHerrings.open.push(entry);
    if (!entry.realExplanation) {
      redHerrings.missingExplanation.push(entry);
      push('error', 'herring-unexplained',
        `误导线索「${it.name}」还没写真实解释。第五节要求：揭晓后那条线索本身必须有真实解释`
        + `（「最可疑的人之所以鬼祟，是因为他在隐瞒另一件较小的、但符合他人性的事」）——`
        + '现在不写，揭晓那章只能硬编，读者回头一看就是骗。', { name: it.name });
    }
    if (!entry.falseAssumption) {
      redHerrings.missingAssumption.push(entry);
      push('warn', 'herring-no-assumption',
        `误导线索「${it.name}」没写它指向的错误假设（falseAssumption）。`
        + '不记这个，没法核对「读者当时确实被骗到了、且骗得公平」。', { name: it.name });
    }
  }

  // ── ⑤ 到期未回收（伏笔 + 悬念共用同一条：过了 due 还 open）──────────
  const overdue = [];
  for (const it of [...byType.foreshadow, ...byType.suspense]) {
    const due = dueOf(it);
    if (due === null || chapter < due) continue;
    overdue.push({ name: it.name, type: typeOf(it), dueChapter: due, late: chapter - due, hints: hintsOf(it).length });
  }
  // 只发一条汇总级 🟡：逐条的「已到期未回收」在任务书/状态里各有一张红榜，
  // 这里再逐条发一遍等于同一件事在两个地方各自报警（判据重复＝噪音）。
  if (overdue.length > 0) {
    push('warn', 'overdue-open',
      `过了应回收章还没回收的共 ${overdue.length} 条：${overdue.slice(0, 5).map((o) => `${o.name}（第 ${o.dueChapter} 章该收）`).join('、')}`
      + `${overdue.length > 5 ? `…另有 ${overdue.length - 5} 条` : ''}。逐条见 webnovel_query kind=foreshadowing。`,
      { count: overdue.length });
  }

  const errors = alerts.filter((a) => a.level === 'error');
  const warns = alerts.filter((a) => a.level === 'warn');

  return {
    chapter,
    partsCount,
    adopted,
    required,
    enabledLayers,
    balance,
    balanceByLayer,
    byType: {
      foreshadow: byType.foreshadow.length,
      suspense: byType.suspense.length,
      cheque: byType.cheque.length,
      red_herring: byType.red_herring.length,
    },
    hinted: byType.suspense.filter((i) => hintsOf(i).length > 0).length,
    idle,
    cheques,
    redHerrings,
    overdue,
    alerts,
    errors,
    warns,
    thresholds: { ...T },
  };
}

/**
 * 「到期」这个动作，四类债务各有说法（伏笔回收、支票兑现、误导线索揭晓）。
 * 措辞跟着类型走：拿「回收伏笔」去说一张逾期支票，读者会以为在讲另一件事。
 */
const PAYOFF_VERB = { foreshadow: '回收', suspense: '收线', cheque: '兑现', red_herring: '揭晓' };

/** 该类型的「到期」动词（渲染层要用它，别在各处把「回收」写死——支票要「兑现」）。 */
export const payoffVerb = (item) => PAYOFF_VERB[typeOf(item)];

/**
 * 清单行首的类别前缀。**伏笔不标**：它是默认类型，逐条清单里九成正是伏笔，
 * 每条都挂个「伏笔｜」反而把真正要留意的悬念/支票/红鲱鱼淹掉了。
 * 渲染层共用这一个（任务书与 query 各写一份，早晚会一份标、一份不标）。
 */
export const debtTag = (item) => (typeOf(item) === 'foreshadow' ? '' : `${ledgerTypeLabel(item)}｜`);

/** 一行条目（commit 回执与 query 明细共用，别在两处各写一套措辞）。 */
export function debtItemLine(item, { chapter = null } = {}) {
  const type = typeOf(item);
  const verb = PAYOFF_VERB[type];
  const due = dueOf(item);
  const now = toInt(chapter);
  let line = `${ledgerTypeLabel(item)}「${item.name}」`;
  if (due === null) line += `（${verb}章未定）`;
  else if (now > 0 && now >= due) line += `（第 ${due} 章该${verb}${now > due ? `，已拖 ${now - due} 章` : '，就是本章'}）`;
  else line += `（第 ${due} 章${verb}）`;
  const hints = hintsOf(item);
  if (hints.length > 0) line += `｜暗示 ${hints.length} 次（最近第 ${hints[hints.length - 1]} 章）`;
  return line;
}

/**
 * 待办动词表：把「一条告警」翻译成「作者下一步做什么」。
 * 为什么在这里定义：状态页、任务书、审查都要说同一件事，措辞散在三处就会各说各话
 * （而且三处的轻重判断会漂移）。新增 code 必须同步这里，否则该告警进不了待办。
 */
const DEBT_ACTION = {
  'account-empty': ['抛新的在线悬念（悬念账户清零了）', null, '4.1：禁止账户清空，回收旧问题的同时必须同步或提前抛新问题'],
  'balance-low': ['补足悬念账户余额', null, '4.1：任何时刻在线问题数不能低于余额线'],
  'suspense-idle': ['给悬置过久的悬念补一次暗示', 'name', '2.3：问题悬置超 50 章无暗示＝警报，先暗示再回收'],
  'cheque-breached': ['兑现逾期支票，或用利息补偿并改应兑现章', 'name', '4.4：明写的许诺拖延不超过 5 章'],
  'herring-unexplained': ['补上误导线索的真实解释', 'name', '第五节：揭晓后线索本身必须有真实解释，否则读者回头就是被骗'],
};

/**
 * 告警 → 待办条目（`priority/action/why/tool` 的形状与 status.js 的 todos 一致）。
 * 🔴 优先；`limit` 用来防止一屏全红。未带动词的 code（如 layer 用错）留给详情行说，
 * 不硬凑成待办——待办列表里出现一句读不通的行动，比少一条更糟。
 */
export function debtTodos(debt, { limit = 3 } = {}) {
  const out = [];
  for (const a of [...debt.errors, ...debt.warns]) {
    const spec = DEBT_ACTION[a.code];
    if (!spec) continue;
    const [verb, keyField, why] = spec;
    out.push({
      priority: a.level === 'error' ? 'high' : 'normal',
      action: keyField && a[keyField] ? `${verb}：${a[keyField]}` : verb,
      why,
      tool: 'webnovel_commit',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 余额口径：只数「读者已意识到」的在线悬念（4.1），测试与渲染都引它，别各算一遍。 */
export function balanceOf(ledger, options = {}) {
  return narrativeDebt(ledger, options).balance;
}

/**
 * status / 任务书 / query / commit 四处都要算总账，而「余额线是 3 还是 4」取决于部数，
 * 部数又取决于目标字数——这条推导链必须只有一份。
 * 传 project.json 的内容即可，本函数只多算一次结构换算（现算不存，见 structure.js）。
 */
export function debtFromProject(project, ledger, chapter) {
  const structure = computeStructure({
    targetWords: project?.targetWords,
    targetChapters: project?.targetChapters,
    currentChapter: chapter,
  });
  return narrativeDebt(ledger, { chapter, partsCount: structure.parts.count });
}

/**
 * 一行总账（给极简场合用，如 webnovel_books 列表）。没有债务可说时返回 null。
 */
export function debtHeadline(debt) {
  if (!debt) return null;
  if (!debt.adopted && debt.byType.cheque === 0 && debt.byType.red_herring === 0 && debt.overdue.length === 0) return null;
  const c = debt.byType;
  return `悬念余额 ${debt.balance}/${debt.required}｜伏笔 ${c.foreshadow}·悬念 ${c.suspense}·支票 ${c.cheque}·红鲱鱼 ${c.red_herring}`
    + `${debt.overdue.length ? `｜到期未收 ${debt.overdue.length}` : ''}`
    + `${debt.errors.length ? `｜🔴 ${debt.errors.length}` : ''}`;
}

/**
 * 紧凑版（任务书 / status 用）：一行总账 + 要紧的几条。
 * 告警按 error 优先排，最多 `limit` 条——剩下的指路 query，别把任务书压成报表。
 */
export function renderDebtSummary(debt, { limit = 5, header = true } = {}) {
  const lines = [];
  const counts = debt.byType;
  if (header) {
    lines.push(`叙事债务：悬念余额 ${debt.balance}/${debt.required}${debt.adopted ? '' : '（未启用账户，见下）'}`
      + `｜在线 伏笔 ${counts.foreshadow} · 悬念 ${counts.suspense} · 支票 ${counts.cheque} · 红鲱鱼 ${counts.red_herring}`
      + `${debt.overdue.length ? `｜到期未回收 ${debt.overdue.length}` : ''}`);
  }
  for (const a of [...debt.errors, ...debt.warns].slice(0, limit)) {
    lines.push(`${a.level === 'error' ? '🔴' : '🟡'} ${a.message}`);
  }
  const rest = debt.errors.length + debt.warns.length - Math.min(limit, debt.errors.length + debt.warns.length);
  if (rest > 0) lines.push(`　…另有 ${rest} 条：\`webnovel_query kind=foreshadowing\`（含层分布与逐条账目）`);
  for (const a of debt.alerts.filter((x) => x.level === 'info')) lines.push(`ℹ️ ${a.message}`);
  return lines;
}

/** 全量账目（query 用）。 */
export function renderDebtReport(debt) {
  const lines = [];
  lines.push(`叙事债务总账（第 ${debt.chapter} 章｜全书按 ${debt.partsCount} 部算，余额线 ${debt.required}）`);
  lines.push('');
  lines.push(`- 悬念账户余额：**${debt.balance}** 个（要求≥${debt.required}）｜已标注暗示过的 ${debt.hinted} 个`);
  const layers = Object.entries(debt.balanceByLayer).filter(([, n]) => n > 0);
  lines.push(`  - 各层：${layers.length > 0 ? layers.map(([l, n]) => `${l} ${n}`).join('｜') : '（无）'}`);
  lines.push(`- 在线条目：伏笔 ${debt.byType.foreshadow}｜悬念 ${debt.byType.suspense}｜支票 ${debt.byType.cheque}｜红鲱鱼 ${debt.byType.red_herring}`);
  if (debt.overdue.length > 0) {
    lines.push(`- 到期未回收 ${debt.overdue.length} 条：`);
    for (const o of debt.overdue.slice(0, 20)) {
      lines.push(`  - ${ledgerTypeLabel(o.type)}「${o.name}」应第 ${o.dueChapter} 章收，已拖 ${o.late} 章（暗示 ${o.hints} 次）`);
    }
  }
  if (debt.idle.length > 0) {
    lines.push(`- 悬置无暗示（2.3 硬线 ${debt.thresholds.idleHard} 章）：`);
    for (const i of debt.idle) {
      lines.push(`  - ${i.level === 'error' ? '🔴' : '🟡'} ${i.name}（${i.layer ?? '未分层'}）已 ${i.silentChapters} 章${i.lastHint ? `（上次暗示第 ${i.lastHint} 章）` : '（一次都没暗示过）'}`);
    }
  }
  if (debt.cheques.open.length > 0) {
    lines.push(`- 支票清单（4.4：明写的许诺拖延不超过 ${debt.thresholds.chequeGrace} 章，拖延期付利息）：`);
    for (const c of debt.cheques.open) {
      const state = c.dueChapter === null ? '应兑现章未定'
        : c.late > debt.thresholds.chequeGrace ? `🔴 已拖 ${c.late} 章（违约）`
          : c.late > 0 ? `🟡 逾期 ${c.late} 章（宽限内）`
            : `第 ${c.dueChapter} 章兑现`;
      lines.push(`  - ${c.name}｜${state}${c.interest ? `｜备注：${c.interest}` : ''}`);
    }
  }
  if (debt.redHerrings.open.length > 0) {
    lines.push('- 误导线索台账（第五节：揭晓后必须有真实解释）：');
    for (const r of debt.redHerrings.open) {
      lines.push(`  - ${r.name}｜指向：${r.falseAssumption || '（未填 falseAssumption）'}｜真实解释：${r.realExplanation || '🔴 未填'}`);
    }
  }
  if (debt.alerts.length > 0) {
    lines.push('');
    lines.push('判据：');
    for (const a of debt.alerts) lines.push(`- ${a.level === 'error' ? '🔴' : a.level === 'warn' ? '🟡' : 'ℹ️'} ${a.message}`);
  } else {
    lines.push('');
    lines.push('✅ 没有逾期、没有悬置超限、支票都在期限内。');
  }
  return lines;
}
