/**
 * 人物档案（提示词第六节 + 3.6⑧ 归属核对 + 6.14 主角人味）。
 *
 * 为什么要有这个文件：第六节二十来条全是「人物要立体」的要求，
 * 以前只能靠 agent 自觉——写三千字正文时没人记得「B 不该知道 A 的秘密」。
 * 这里把能机械核对的三件事抽成一份判据：
 *   ① 档案字段定义（6.1/6.2/6.5/6.12/6.13/6.14）——**字段名与必填项只在本文件定义一次**；
 *   ② 增量归一（进 state.characters 前统一形状，数组累积不覆盖）；
 *   ③ 归属核对（谁说了他不该知道的话）——判据落在 review 里，能红。
 *
 * 硬口径（与 ledger.js 同）：
 *   · 只存非默认值：没填的字段不落盘，老角色卡形状不随升级漂移（doctor 整表对账才稳）；
 *   · 判据由代码算：缺口列表、归属冲突都在函数里，渲染层不许自己数；
 *   · 保守执法：归属核对只在「说话人明确指名 + 命中登记过的短语」时报警，
 *     宁可漏报也不误伤——误伤一次，作者就再也不信这本账（铁律 1 的专名告警同理）。
 */
import { deepMerge, mergeArray, toInt, escapeRegExp } from '../util.js';

/* ------------------------------------------------------------------ *
 * 字段定义（唯一真相）
 * ------------------------------------------------------------------ */

/** 6.12 关系推进五级制（友好侧原文命名；敌对侧作者自定，只认数字级）。 */
export const RELATION_STAGES = ['陌生', '共事', '信任', '依赖', '托付'];

/** 6.1 三层 + 6.2 内在矛盾：主要人物必填的四项。 */
export const DOSSIER_CORE = [
  { key: 'desire', label: '最想要的', section: '6.1 内在层' },
  { key: 'fear', label: '最怕的', section: '6.1 内在层' },
  { key: 'secret', label: '秘密', section: '6.1 隐藏层' },
  { key: 'contradiction', label: '内在矛盾（既A又B）', section: '6.2' },
];

/** 6.5 语言指纹 + 6.13 口语档位：voice 的九项（遮住名字能认出是谁）。 */
export const VOICE_FIELDS = [
  { key: 'fingerprint', label: '语言指纹（遮名能认出是谁）', section: '6.5' },
  { key: 'sentenceLen', label: '句长习惯', section: '6.5' },
  { key: 'tone', label: '语气', section: '6.5' },
  { key: 'vocabulary', label: '词汇域', section: '6.5' },
  { key: 'address', label: '称呼习惯', section: '6.5' },
  { key: 'avoidTopics', label: '回避话题', section: '6.5' },
  { key: 'fillers', label: '语气词组合', section: '6.13', array: true },
  { key: 'profanity', label: '粗口档位', section: '6.13' },
  { key: 'tics', label: '说话毛病', section: '6.13', array: true },
  { key: 'meltdown', label: '情绪失控降级模式', section: '6.13' },
];

/** 6.14 主角人味三项（能力可以开挂，人格必须是普通人）。 */
export const HUMAN_FLAW_FIELDS = [
  { key: 'habits', label: '三个小毛病', section: '6.14', array: true },
  { key: 'selfishMotive', label: '一个私心', section: '6.14' },
  { key: 'errorPlan', label: '犯错预案', section: '6.14' },
];

/** 信息表三类（谁知道什么 / 谁不知道什么 / 谁误以为什么）。 */
export const INFO_FIELDS = ['knows', 'notKnows', 'mistaken'];

/**
 * 「主要人物」判定——只有这些卡要吃 6.1/6.2 完整性提醒。
 * 判据写得宽：配角卡不该被天天催着填三维档案（噪音会让人关掉整个功能）。
 * 只要作者填过任一项核心字段，也当作「正在建主要人物」处理。
 */
export function isMajorCard(card) {
  const role = String(card?.role ?? '');
  if (/主角|反派|重要配角|主要|男配|女配/.test(role)) return true;
  return DOSSIER_CORE.some((f) => String(card?.[f.key] ?? '').trim() !== '');
}

/* ------------------------------------------------------------------ *
 * 归一与合并
 * ------------------------------------------------------------------ */

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/** 信息条目可以是纯文本，也可以是 {text, note}；统一成纯文本存（少一层形状＝少一处漂移）。 */
function infoText(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') return trimmed(item.text) || trimmed(item.fact) || trimmed(item.note);
  return '';
}

/** 关系级：认 1-5、认罗马数字式「五级」、认友好侧五级名；认不出来返回 null（不猜）。 */
export function relationLevelOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = toInt(value, 0);
  if (num >= 1 && num <= 5) return num;
  const text = String(value).trim();
  const idx = RELATION_STAGES.findIndex((s) => text === s || text.startsWith(s));
  if (idx >= 0) return idx + 1;
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }[text.replace(/级|阶段/g, '')];
  return cn ?? null;
}

export const relationStageName = (level) => RELATION_STAGES[toInt(level, 0) - 1] ?? null;

/**
 * 归一一份角色卡增量。
 * 未知键原样保留（additive 演进，不许把作者写的东西吃掉），
 * 只把「形状可能跑偏」的几处掰正：voice 对象、三类信息表、关系级。
 * @returns {{patch:object, warnings:string[]}}
 */
export function normalizeDossierPatch(input = {}) {
  const warnings = [];
  const patch = { ...input };

  if (patch.voice !== undefined) {
    if (patch.voice === null || typeof patch.voice !== 'object' || Array.isArray(patch.voice)) {
      warnings.push('voice 必须是对象（如 {fingerprint:"短句、爱反问"}），本次已忽略。');
      delete patch.voice;
    } else {
      const voice = {};
      for (const [k, v] of Object.entries(patch.voice)) {
        if (Array.isArray(v)) {
          const list = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
          if (list.length > 0) voice[k] = list;
        } else if (typeof v === 'string') {
          if (v.trim()) voice[k] = v.trim();
        } else if (v !== null && v !== undefined) {
          voice[k] = v; // 数字/对象留着，不擅自丢作者的数据
        }
      }
      if (Object.keys(voice).length > 0) patch.voice = voice;
      else delete patch.voice;
    }
  }

  for (const key of INFO_FIELDS) {
    if (patch[key] === undefined) continue;
    if (!Array.isArray(patch[key])) {
      warnings.push(`${key} 必须是数组（如 ["玉佩是母亲遗物"]），本次已忽略。`);
      delete patch[key];
      continue;
    }
    const list = [...new Set(patch[key].map(infoText).filter(Boolean))];
    if (list.length > 0) patch[key] = list;
    else delete patch[key];
  }

  if (patch.relationLevel !== undefined) {
    const level = relationLevelOf(patch.relationLevel);
    if (level === null) {
      warnings.push(`relationLevel="${patch.relationLevel}" 不是 1-5（6.12：陌生→共事→信任→依赖→托付），本次未登记。`);
      delete patch.relationLevel;
    } else {
      patch.relationLevel = level;
    }
  }
  // relationStage 允许作者自定名（6.12 的敌对侧五级由作品自己定），只做能算出级号时补一份数字
  if (patch.relationStage !== undefined) {
    const stage = trimmed(patch.relationStage);
    if (!stage) delete patch.relationStage;
    else {
      patch.relationStage = stage;
      const level = relationLevelOf(stage);
      if (level !== null && patch.relationLevel === undefined) patch.relationLevel = level;
    }
  }

  for (const f of DOSSIER_CORE) {
    if (patch[f.key] !== undefined && typeof patch[f.key] !== 'string') {
      warnings.push(`${f.key}（${f.label}）必须是文本，本次已忽略。`);
      delete patch[f.key];
    }
  }

  // 3.6⑧ 剩余三类归属需要的基础字段（加性演进，老卡不填不报错）：
  // condition = 伤病/身体状态（自由文本），items = 当前持有物品名。
  if (patch.condition !== undefined) {
    if (typeof patch.condition !== 'string') {
      warnings.push('condition（伤病/身体状态）必须是文本，本次已忽略。');
      delete patch.condition;
    } else {
      patch.condition = patch.condition.trim();
    }
  }
  if (patch.items !== undefined) {
    if (!Array.isArray(patch.items)) {
      warnings.push('items（持有物品）必须是数组，如 ["青锋剑","半枚铜钱"]，本次已忽略。');
      delete patch.items;
    } else {
      const list = [...new Set(patch.items.map((x) => String(x ?? '').trim()).filter(Boolean))];
      if (list.length > 0) patch.items = list;
      else delete patch.items;
    }
  }

  // 只存非默认值：空串键一律删掉，别把角色卡撑成一堆空字段
  for (const [k, v] of Object.entries(patch)) {
    if (v === '' || v === null) delete patch[k];
  }
  return { patch, warnings };
}

/** 主角人味增量归一（6.14 三项，落在 state.protagonist.humanFlaws）。 */
export function normalizeHumanFlaws(input = {}) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const f of HUMAN_FLAW_FIELDS) {
    const v = input[f.key];
    if (v === undefined || v === null) continue;
    if (f.array) {
      const list = [...new Set((Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean))];
      if (list.length > 0) out[f.key] = list;
    } else if (String(v).trim()) out[f.key] = String(v).trim();
  }
  return out;
}

/** 信息表是累积的（每章新知道的事不该冲掉之前的），去重后按出现顺序排。 */
export function mergeInfoList(existing, incoming) {
  return mergeArray(Array.isArray(existing) ? existing : [], Array.isArray(incoming) ? incoming : []);
}

/** 读一张卡的档案（补齐缺省形状，老卡读出来不报错）。 */
export function dossierOf(card = {}) {
  const voice = card.voice && typeof card.voice === 'object' ? card.voice : {};
  return {
    ...card,
    knows: Array.isArray(card.knows) ? card.knows : [],
    notKnows: Array.isArray(card.notKnows) ? card.notKnows : [],
    mistaken: Array.isArray(card.mistaken) ? card.mistaken : [],
    condition: typeof card.condition === 'string' ? card.condition : '',
    items: Array.isArray(card.items) ? card.items : [],
    voice,
    relationLevel: relationLevelOf(card.relationLevel ?? card.relationStage),
  };
}

/* ------------------------------------------------------------------ *
 * 完整性（6.1/6.2/6.5/6.12/6.13/6.14）
 * ------------------------------------------------------------------ */

/** 一张卡的档案缺口（只报必填项，缺省不猜）。 */
export function dossierGaps(card) {
  const gaps = [];
  const d = dossierOf(card);
  if (isMajorCard(card)) {
    for (const f of DOSSIER_CORE) {
      if (!String(d[f.key] ?? '').trim()) gaps.push({ key: f.key, label: f.label, section: f.section });
    }
    if (!VOICE_FIELDS.some((f) => Array.isArray(d.voice[f.key]) ? d.voice[f.key].length > 0 : String(d.voice[f.key] ?? '').trim())) {
      gaps.push({ key: 'voice', label: '语言指纹/口语档位（十项全空）', section: '6.5 / 6.13' });
    }
    if (d.relationLevel === null && d.relation !== '本人') {
      // 「本人」是主角卡的写法：6.12 五级是「他与主角」的距离，主角跟自己没有这一级，
      // 逼作者去填等于制造一个永远填不掉的假缺口。
      gaps.push({ key: 'relationLevel', label: '关系推进级（1-5）', section: '6.12' });
    }
  }
  if (d.role && /反派/.test(d.role)) {
    if (!String(d.plan ?? '').trim()) gaps.push({ key: 'plan', label: '反派计划线（目标/步骤/进度）', section: '6.8' });
    if (!String(d.baseline ?? d.line ?? '').trim()) gaps.push({ key: 'bottomLine', label: '底线（他绝不做的事）', section: '6.7' });
  }
  return gaps;
}

/** 主角人味缺口（6.14：四维不得全满）。 */
export function humanFlawGaps(protagonist = {}) {
  const hf = protagonist.humanFlaws ?? {};
  return HUMAN_FLAW_FIELDS.filter((f) => {
    const v = hf[f.key];
    return f.array ? !(Array.isArray(v) && v.length > 0) : !String(v ?? '').trim();
  }).map((f) => ({ key: f.key, label: f.label, section: f.section }));
}

/** 整本档案概览（status 一行 + 待办用）。 */
export function dossierOverview(state) {
  const entries = Object.entries(state.characters ?? {});
  const major = entries.filter(([, c]) => isMajorCard(c));
  const gapCount = major.reduce((n, [, c]) => n + dossierGaps(c).length, 0);
  const infoCount = entries.reduce((n, [, c]) => n + dossierOf(c).knows.length + dossierOf(c).notKnows.length, 0);
  return {
    characters: entries.length,
    major: major.length,
    majorNames: major.map(([n]) => n),
    gaps: gapCount,
    infoItems: infoCount,
    protagonistGaps: humanFlawGaps(state.protagonist),
  };
}

/* ------------------------------------------------------------------ *
 * 3.6⑧ 归属核对（防张冠李戴）
 * ------------------------------------------------------------------ */

/** 引号内容 + 就近说话人。中文小说两种写法都认：「X 说道："…"」与「"…"X 冷笑」。 */
const QUOTE_RE = /[“「『]([^”」』\n]{2,200})[”」』]/g;
const SPEECH_VERBS = '说|道|问|答|喊|叫|骂|嘟囔|念叨|开口|低声|沉声|冷声|冷笑|哼|笑道|说道|问道|答道|喝道|喃喃';
const NAME_STOP = new Set(['他', '她', '它', '我', '你', '你们', '我们', '他们', '对方', '那人', '少年', '女子']);

/**
 * 从一段正文里抽出「谁说了什么」。
 * 说话人只认**角色卡上登记过的名字**（外加主角），泛称一律不猜——
 * 猜错一次的代价是作者再也不信这条告警。
 *
 * 归属判定按中文排版的两种写法：
 *   ① `X 说道：“……”` → 说话人在引号**前**（取同句行内、引号前最后一次出现的名字）；
 *   ② `“……”X 冷笑。` → 说话人在引号**后**（同句行内、12 字内出现名字且紧跟说话动词）。
 * 两边都能取到时**取更近的一边**。早先的版本跨行也认引号后的名字，
 * 于是「周伯道：“……”\n陈三说道：”……’」里前一句的台词会被安到下一句的人头上——
 * 这种张冠李戴恰好是本判据要抓的错，自己犯了比不犯更糟（测试里锁了这一条）。
 */
export function extractDialogue(text, knownNames = []) {
  const names = [...new Set(knownNames.filter((n) => n && !NAME_STOP.has(n)))]
    // 长名优先：一个名字是另一个的前缀时（「王林」与「王林生」），必须先看长的，
    // 否则「王林生道：“……”」会被判成王林说的——归属核对自己先犯了张冠李戴。
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (names.length === 0) return [];
  const body = String(text ?? '');
  const lineStarts = [];
  for (let i = 0; i <= body.length; i += 1) {
    if (i === 0 || body[i - 1] === '\n') lineStarts.push(i);
  }
  const lineStartOf = (pos) => {
    let lo = 0; let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lineStarts[lo];
  };
  const ATTRIB_RE = (name) => new RegExp(`${escapeRegExp(name)}[^\\n“「『”」』]{0,14}(?:${SPEECH_VERBS}|[：:])`);
  const nearestBefore = (segment) => {
    let best = null;
    for (const name of names) {
      const re = new RegExp(`${escapeRegExp(name)}(?=[^\\n“「『”」』]{0,14}(?:${SPEECH_VERBS}|[：:]))`, 'g');
      let m2; let last = -1;
      while ((m2 = re.exec(segment)) !== null) last = m2.index;
      if (last >= 0 && (!best || last > best.at)) best = { name, at: last };
    }
    return best;
  };
  const nearestAfter = (segment) => {
    let best = null;
    for (const name of names) {
      const m = ATTRIB_RE(name).exec(segment);
      if (m && (!best || m.index < best.at)) best = { name, at: m.index };
    }
    return best;
  };

  const out = [];
  for (const m of body.matchAll(QUOTE_RE)) {
    const said = m[1].trim();
    if (!said) continue;
    const start = m.index;
    const end = start + m[0].length;
    const before = body.slice(lineStartOf(start), start);
    const after = body.slice(end, body.indexOf('\n', end) === -1 ? body.length : body.indexOf('\n', end));
    const b = nearestBefore(before);
    const a = nearestAfter(after.slice(0, 24));
    let speaker = null;
    if (b && a) speaker = (start - (b.at + b.name.length)) <= a.at ? b.name : a.name;
    else speaker = b?.name ?? a?.name ?? null;
    out.push({ speaker, said, at: start });
  }
  return out;
}

/**
 * 把一条登记信息拆成可命中的关键词。
 * 原文整句常常太长（「他一直隐瞒自己是官府的眼线」），正文里只会露出其中一小截，
 * 所以先按标点、再按虚词/连接词切碎，只留 2-8 字且不是通用词的片段。
 * 这段判据只在这里有一份，告警与归属核对共用。
 *
 * 通用词必须滤掉，否则会误伤：「玉佩是母亲的遗物，你一直想知道」里的「知道」若当成关键词，
 * 任何带「知道」的台词都会被判成张冠李戴——误报一次，作者就把这条告警当噪音关掉。
 */
const STOP_HEAD = /^[的他她它我你的了是在有和与及为了把被让给从对往就都还又也吗呢吧啊嗯]/;
const KEY_SEG_SPLIT = /[，。；！？、：…—“”"'`（）()《》<>\s]+/;
const KEY_WORD_SPLIT = /(?:一直|始终|其实|曾经|后来|终于|没有|不是|已经|正在|就是|还有|自己|跟|和|与|及|的|了|是|在|把|被|让|向|对|而|就|都|也)/;
const KEY_GENERIC = new Set(['想', '说', '问', '看', '来', '去', '知道', '想要', '什么', '怎么', '为什么', '时候', '地方', '东西', '这个', '那个', '一个', '他', '她', '它', '我', '你', '们', '事', '人', '有', '不']);
export function infoKeys(entry) {
  const text = String(entry ?? '').trim();
  if (!text) return [];
  const keys = new Set();
  const push = (raw) => {
    const t = String(raw).trim();
    if (t.length < 2 || t.length > 8) return;
    if (KEY_GENERIC.has(t) || STOP_HEAD.test(t)) return;
    keys.add(t);
  };
  for (const seg of text.split(KEY_SEG_SPLIT)) {
    push(seg);
    for (const piece of seg.split(KEY_WORD_SPLIT)) push(piece);
  }
  if (text.length <= 12) push(text);   // 整条原文本身也当一次关键词（短的时候最准）
  return [...keys];
}

/** 说话人是否已登记知情：条目原文含命中片段，或条目的关键词与命中片段互相包含。 */
function coversAny(entries, hit) {
  return (entries ?? []).some((entry) => {
    const t = String(entry ?? '');
    if (t.includes(hit) || hit.includes(t)) return true;
    return infoKeys(t).some((k) => k === hit || hit.includes(k) || k.includes(hit));
  });
}

/**
 * 3.6⑧ 归属核对：逐条台词比对人物状态表。
 * 两条判据，严格程度不同（怕误伤）：
 *   🔴 说话人自己卡在 notKnows 里登记过的东西，从他嘴里说了出来；
 *   🟡 别人的秘密被非主人说出口，且说话人卡上 knows 没登记过这件事。
 * @returns {{issues:Array<{level:string,message:string,evidence:string,suggestion:string}>, checked:number}}
 */
export function ownershipCheck(state, text) {
  const body = String(text ?? '');
  if (!body.trim()) return { issues: [], checked: 0 };
  const protagonistName = state.protagonist?.name ?? '';
  const names = Object.keys(state.characters ?? {});
  if (protagonistName) names.unshift(protagonistName);
  const dialogue = extractDialogue(body, names);
  const issues = [];

  for (const { speaker, said } of dialogue) {
    if (!speaker) continue;
    const card = (state.characters ?? {})[speaker] ?? (protagonistName === speaker ? state.protagonist : null);
    if (!card) continue;
    const d = dossierOf(card);

    // 🔴 他自己登记为「不知道」的事，不该由他说出
    for (const entry of d.notKnows) {
      const hit = infoKeys(entry).find((k) => said.includes(k));
      if (hit) {
        issues.push({
          level: 'error', kind: 'notKnows', speaker, entry: String(entry), key: hit,
          message: `归属核对（3.6⑧）：角色卡登记「${speaker}」不知道「${entry}」，本章却由他说出「${hit}」`,
          evidence: said,
          suggestion: '要么改台词（换成他此刻确实知道的信息），要么在 commit 里补 `knows` 并写清他怎么知道的。',
        });
      }
    }

    // 🟡 别人的秘密从他嘴里出来，且他卡上没登记过知情（主角的秘密同样受保护）
    const owners = Object.entries(state.characters ?? {});
    if (protagonistName && state.protagonist?.secret) owners.push([protagonistName, state.protagonist]);
    for (const [owner, other] of owners) {
      if (owner === speaker) continue;
      const secret = String(other?.secret ?? '').trim();
      if (!secret) continue;
      const hit = infoKeys(secret).find((k) => said.includes(k));
      if (!hit) continue;
      if (coversAny(d.knows, hit)) continue; // 登记过知情＝合法，再报就是噪音
      issues.push({
        level: 'warning', kind: 'secret', speaker, owner, key: hit, entry: secret,
        message: `归属核对（3.6⑧）：「${hit}」是「${owner}」的秘密（${secret}），本章却从「${speaker}」嘴里说出`,
        evidence: said,
        suggestion: `确认「${speaker}」是否已知情：若已知情请 commit 里给他补 knows，否则改台词。`,
      });
    }
  }
  return { issues, checked: dialogue.filter((x) => x.speaker).length };
}

/* ------------------------------------------------------------------ *
 * 3.6⑧ 扩展：患病者 / 受伤者 / 物品持有者
 * ------------------------------------------------------------------ */

/** 伤病是否真的「在受伤」——「右臂完好」不该被判成冲突。 */
const INJURY_RE = /(伤|断|废|裂|折|未愈|不能|无法|不便|使不上|用不上|抬不起|麻痹|肿|流血|残|失明|瞎|昏迷|沉睡|不省人事)/;

/** 身体部位 → 会穿帮的动作（只收明确冲突的动作词，不收泛称）。 */
const CONDITION_ACTION_RULES = [
  {
    test: /(右臂|右手|右腕|右掌|右肩)/,
    verbs: ['挥剑', '持剑', '握剑', '拔剑', '提剑', '握刀', '持刀', '拔刀', '挥刀', '握拳', '挥拳', '出拳', '出掌', '抬臂', '抬手', '举起', '拎起', '抓住', '握紧', '劈下', '刺出', '斩出'],
  },
  {
    test: /(左臂|左手|左腕|左掌|左肩)/,
    verbs: ['挥剑', '持剑', '握剑', '拔剑', '提剑', '握刀', '持刀', '拔刀', '挥刀', '握拳', '挥拳', '出拳', '出掌', '抬臂', '抬手', '举起', '拎起', '抓住', '握紧', '劈下', '刺出', '斩出'],
  },
  {
    test: /(双腿|腿|脚踝|膝盖|脚)/,
    verbs: ['站起', '奔跑', '跃起', '大步', '飞奔', '疾驰', '追出', '逃走', '一脚', '狂奔'],
  },
  {
    test: /(双目|双眼|眼睛|失明|瞎)/,
    verbs: ['看见', '看到', '望着', '注视', '瞥见', '目光', '睁眼', '打量', '扫过'],
  },
  {
    test: /(重伤|垂死|濒死|气息奄奄)/,
    verbs: ['纵身', '飞跃', '疾奔', '生龙活虎', '大战', '狂奔'],
  },
];

/** 物品的「使用」动作——「看着剑」不算使用，避免把目光描写判成持有冲突。 */
const ITEM_USE_RE = /(使用|祭出|催动|挥动|握住|握紧|举起|刺出|劈下|扔出|抛出|拍出|捏碎|吞下|戴上|拿出|掏出|掷出|斩出|驱动|催发)/;

const EXT_SENTENCE_SPLIT = /[。！？!?；;\n]+/;

function sentencesOf(text) {
  return String(text ?? '').split(EXT_SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
}

function conditionConflictVerbs(condition) {
  const text = String(condition ?? '').trim();
  if (!text || !INJURY_RE.test(text)) return null;
  const verbs = [];
  for (const rule of CONDITION_ACTION_RULES) {
    if (!rule.test.test(text)) continue;
    for (const verb of rule.verbs) if (!verbs.includes(verb)) verbs.push(verb);
  }
  return verbs.length > 0 ? verbs : null;
}

/**
 * 句子是否**独立**提到了这个名字（不是更长的名字的一部分）。
 * 中文没有词边界：「陈三娘」里含「陈三」，直接 includes 会把陈三娘的动作算到陈三头上。
 * 判据：这个名字的每次出现都不被某个更长的已登记名字覆盖，才算提到。
 */
function mentionsName(sentence, name, allNames) {
  if (!name) return false;
  const longer = allNames.filter((n) => n !== name && n.length > name.length);
  let from = 0;
  for (;;) {
    const idx = sentence.indexOf(name, from);
    if (idx < 0) return false;
    const shadowed = longer.some((other) => {
      for (let start = sentence.indexOf(other); start !== -1; start = sentence.indexOf(other, start + 1)) {
        if (start <= idx && idx < start + other.length) return true;
      }
      return false;
    });
    if (!shadowed) return true;
    from = idx + 1;
  }
}

/**
 * 3.6⑧ 剩余三类归属核对（保守匹配）：
 *
 * 1. **伤病**：角色卡 condition 里的伤处 + 冲突动作必须与**角色名同句**才判——
 *    B 的病历不能按到 A 头上（旧版全局扫动作词的误报根源）。
 * 2. **物品**：物品名 + 使用动词 + 角色名同句，且句子里没有任何登记持有者才判；
 *    有登记持有者在场就放过（分不清谁在动手时不猜）。
 * 3. 没有 condition/items 的老卡不参与，泛称句（「他握紧了剑」）不判。
 *
 * @returns {{issues:Array, checked:number}}
 */
export function ownershipExtendedCheck(state, text) {
  const body = String(text ?? '');
  if (!body.trim()) return { issues: [], checked: 0 };

  const protagonistName = String(state?.protagonist?.name ?? '').trim();
  const entries = Object.entries(state?.characters ?? {});
  if (protagonistName && state?.protagonist) entries.push([protagonistName, state.protagonist]);
  const names = entries.map(([name]) => name).filter((name) => name.length >= 2);
  const sentences = sentencesOf(body);
  const issues = [];
  const seen = new Set();

  // ---- 1. 伤病错位 ----
  for (const [name, card] of entries) {
    // 主角的 condition 由 review 的既有规则查（含更多身体状态类别）；这里只查配角，
    // 避免同一条冲突报两遍。
    if (protagonistName && name === protagonistName) continue;
    if (name.length < 2) continue;
    const verbs = conditionConflictVerbs(card?.condition);
    if (!verbs) continue;
    for (const sentence of sentences) {
      if (!mentionsName(sentence, name, names)) continue;
      const hit = verbs.find((verb) => sentence.includes(verb));
      if (!hit) continue;
      const key = `${name}|condition|${sentence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        level: 'error',
        kind: 'condition',
        name,
        message: `归属核对（3.6⑧）：「${name}」登记伤病「${card.condition}」，同句却出现「${hit}」`,
        evidence: sentence.slice(0, 120),
        suggestion: `确认是否为带伤硬撑（需要正文交代代价），或改掉这个动作；若伤已恢复，`
          + `提交时用 characters patch 更新 condition。`,
      });
    }
  }

  // ---- 2. 物品持有 ----
  const holders = new Map();
  for (const [name, card] of entries) {
    if (!name || name.length < 2) continue;
    for (const item of Array.isArray(card?.items) ? card.items : []) {
      const key = String(item ?? '').trim();
      if (key.length < 2) continue;
      if (!holders.has(key)) holders.set(key, new Set());
      holders.get(key).add(name);
    }
  }
  if (holders.size > 0) {
    for (const sentence of sentences) {
      if (!ITEM_USE_RE.test(sentence)) continue;
      const present = names.filter((name) => mentionsName(sentence, name, names));
      if (present.length === 0) continue; // 没点名 = 不猜
      for (const [item, owners] of holders) {
        if (!sentence.includes(item)) continue;
        if (present.some((name) => owners.has(name))) continue; // 有登记持有者在场，不判
        const key = `${present[0]}|item|${item}|${sentence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
          level: 'warning',
          kind: 'item',
          name: present[0],
          item,
          message: `归属核对（3.6⑧）：「${item}」不在「${present[0]}」的持有清单里，本章却由他使用`,
          evidence: sentence.slice(0, 120),
          suggestion: `确认物品是否已转手/被捡到：是的话用 characters patch 更新 items；`
            + `否则改动作归属。`,
        });
      }
    }
  }

  return { issues, checked: sentences.length };
}

/* ------------------------------------------------------------------ *
 * 渲染（只排版，不另算判据）
 * ------------------------------------------------------------------ */

/**
 * 档案行（不含卡头与「境界/位置/出场」那几行基础信息）。
 * 拆出来是为了让 query 的角色卡能接着自己那套基础行往下排，
 * 而不是两张卡拼在一起出现重复行。
 */
export function dossierLines(card) {
  const d = dossierOf(card);
  const lines = [];
  if (d.relation && d.relationLevel) lines.push(`关系推进级：${d.relationLevel}/5（${RELATION_STAGES[d.relationLevel - 1]}）`);
  else if (d.relationLevel) lines.push(`关系推进级：${d.relationLevel}/5（${RELATION_STAGES[d.relationLevel - 1]}，6.12）`);
  else if (d.relationStage) lines.push(`关系阶段：${d.relationStage}（6.12 未标 1-5 级）`);
  for (const f of DOSSIER_CORE) {
    if (String(d[f.key] ?? '').trim()) lines.push(`${f.label}（${f.section}）：${d[f.key]}`);
  }
  for (const f of VOICE_FIELDS) {
    const v = d.voice[f.key];
    if (Array.isArray(v) ? v.length : String(v ?? '').trim()) lines.push(`${f.label}：${Array.isArray(v) ? v.join('、') : v}`);
  }
  if (d.knows.length) lines.push(`知道：${d.knows.join('；')}`);
  if (d.notKnows.length) lines.push(`不知道：${d.notKnows.join('；')}（3.6⑧ 归属核对据此执法）`);
  if (d.mistaken.length) lines.push(`误以为：${d.mistaken.join('；')}`);
  if (String(d.goal ?? '').trim()) lines.push(`独立目标（6.6）：${d.goal}`);
  if (String(d.plan ?? '').trim()) lines.push(`计划线（6.8）：${d.plan}`);
  if (String(d.arcProgress ?? '').trim()) lines.push(`自身弧光（6.10）：${d.arcProgress}`);
  const gaps = dossierGaps(card);
  if (gaps.length) lines.push(`档案缺口：${gaps.map((g) => `${g.label}（${g.section}）`).join('、')}`);
  return lines;
}

export function renderDossierCard(name, card) {
  const d = dossierOf(card);
  const head = [`${name}${d.role ? `（${d.role}）` : ''}`];
  if (d.realm) head.push(d.realm);
  if (d.location) head.push(`在${d.location}`);
  return [...head, ...dossierLines(card)];
}

export function renderHumanFlaws(protagonist) {
  const hf = protagonist?.humanFlaws ?? {};
  const lines = [];
  for (const f of HUMAN_FLAW_FIELDS) {
    const v = hf[f.key];
    if (f.array ? Array.isArray(v) && v.length : String(v ?? '').trim()) {
      lines.push(`${f.label}：${Array.isArray(v) ? v.join('、') : v}`);
    }
  }
  const gaps = humanFlawGaps(protagonist);
  if (gaps.length) lines.push(`（未填：${gaps.map((g) => `${g.label} ${g.section}`).join('、')}）`);
  return lines;
}

/**
 * 任务书用的档案快照：只装「写这一章时不能违反」的那几项，且限量。
 * 顺序按 lastChapter 由近及远——正在演戏的人排在前面。
 */
export function briefDossiers(state, { limit = 6 } = {}) {
  const current = toInt(state.progress?.currentChapter);
  const rows = [];
  const hero = state.protagonist ?? {};
  if (hero.name && (isMajorCard({ ...hero, role: '主角' }) || INFO_FIELDS.some((k) => Array.isArray(hero[k]) && hero[k].length))) {
    rows.push({ name: hero.name, role: '主角', lastChapter: current, ...dossierOf(hero) });
  }
  for (const [name, card] of Object.entries(state.characters ?? {})) {
    if (name === hero.name) continue;
    if (!isMajorCard(card)) continue;
    rows.push({ name, lastChapter: toInt(card.lastChapter), ...dossierOf(card) });
  }
  rows.sort((a, b) => toInt(b.lastChapter) - toInt(a.lastChapter));
  return rows.slice(0, limit).map((r) => ({
    name: r.name,
    role: r.role ?? '',
    relationLevel: r.relationLevel,
    secret: r.secret ?? '',
    desire: r.desire ?? '',
    fear: r.fear ?? '',
    contradiction: r.contradiction ?? '',
    fingerprint: r.voice?.fingerprint ?? '',
    knows: r.knows ?? [],
    notKnows: r.notKnows ?? [],
    mistaken: r.mistaken ?? [],
    gaps: dossierGaps(r).map((g) => g.label),
  }));
}

/** 深合并角色卡增量时走这里：保证 voice / 信息表的累积语义（state.js 调）。 */
export function applyDossierPatch(card, patch) {
  const { patch: clean, warnings } = normalizeDossierPatch(patch);
  const base = card ?? {};
  const merged = deepMerge(base, {
    ...clean,
    knows: undefined, notKnows: undefined, mistaken: undefined, voice: undefined,
  });
  for (const key of INFO_FIELDS) {
    if (clean[key]) merged[key] = mergeInfoList(base[key] ?? [], clean[key]);
  }
  if (clean.voice) merged.voice = deepMerge(base.voice ?? {}, clean.voice);
  return { card: merged, warnings };
}
