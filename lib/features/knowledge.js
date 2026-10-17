/**
 * 多视角信息隔离（提示词 8.2）。
 *
 * 产品定位：多视角写法最容易出的错不是「谁在说话」，而是「谁知道什么」——
 * A 视角里看见的事，B 视角凭空拿来用；角色还没得知的真相，下一章就从他嘴里说出来。
 * 这类错读者会记很久（「他不是不知道吗」），而且改起来牵连整条线。
 *
 * 数据模型（加性演进，老书不填不报错）：
 *   commit 顶层    pov                 本章视角人物
 *   deltas.knowledge[]  { who, fact, mode: learn|use|reveal,
 *                         witnessedBy?, toldBy?, evidence? }
 *
 * 校验口径（review 与 commit 共用）：
 *   - pov / who / toldBy 必须是已登记角色（角色表或主角卡）；
 *   - learn 必须有 witnessedBy 或 toldBy；toldBy 必须自己已经知道这条信息；
 *   - use / reveal 的 who 必须已登记 knows，且不在 notKnows 里；
 *   - 违反 → review 🔴；commit 默认拦截（force 可过）。
 *
 * 「知道」的累积落在人物卡的 knows/notKnows 上（6.13 信息表），跨章可重放：
 * learn 写进 knows、同时从 notKnows 删除（得知之后就不再是「不知道」了）。
 * use/reveal 只校验、不改状态——它们不是新信息，只是把已有信息用了出来。
 */
/** 允许的认知模式。 */
export const KNOWLEDGE_MODES = ['learn', 'use', 'reveal'];

const MODE_LABEL = { learn: '得知', use: '使用', reveal: '透露' };

let seq = 0;

/** 稳定 id（仅用于报告定位，不落盘）。 */
function nextId() {
  seq += 1;
  return `k${seq}`;
}

/** 已登记人物名集合（角色表 + 主角）。 */
export function registeredNames(state) {
  const names = new Set(Object.keys(state?.characters ?? {}));
  const protagonist = String(state?.protagonist?.name ?? '').trim();
  if (protagonist) names.add(protagonist);
  return names;
}

/** 取某人物的知识表（返回副本，不直接改 state）。 */
function knowledgeOf(state, name) {
  const protagonistName = String(state?.protagonist?.name ?? '').trim();
  const card = name === protagonistName ? state?.protagonist : state?.characters?.[name];
  if (!card) return null;
  const list = (value) => (Array.isArray(value) ? value.map(String) : []);
  return {
    card,
    knows: new Set(list(card.knows)),
    notKnows: new Set(list(card.notKnows)),
  };
}

/** 规整的一条知识变更（去掉空字段，形状稳定，便于写入提交记录）。 */
function normalizeItem(item) {
  if (!item || typeof item !== 'object') {
    return { id: nextId(), who: '', fact: '', mode: 'learn', witnessedBy: '', toldBy: '', evidence: '' };
  }
  return {
    id: nextId(),
    who: String(item.who ?? item.character ?? item.name ?? '').trim(),
    fact: String(item.fact ?? item.what ?? item.info ?? '').trim(),
    mode: String(item.mode ?? 'learn').trim().toLowerCase(),
    witnessedBy: String(item.witnessedBy ?? item.witness ?? '').trim(),
    toldBy: String(item.toldBy ?? item.told ?? '').trim(),
    evidence: String(item.evidence ?? '').trim(),
  };
}

/**
 * 校验知识变更。
 *
 * 顺序很重要：同一章里先 learn 再 use 是合法的（刚刚得知、马上使用），
 * 所以校验必须按数组顺序推进临时知识表，不能拿章节开始时的快照一刀切。
 *
 * @returns {{
 *   pov:string,
 *   errors:Array<{message,evidence,suggestion,who,fact,mode}>,
 *   warnings:string[],
 *   accepted:Array<object>,
 *   learned:Array<{who,fact}>,
 * }}
 */
export function validateKnowledge(state, { pov = '', knowledge = [] } = {}) {
  const errors = [];
  const warnings = [];
  const accepted = [];
  const learned = [];
  const names = registeredNames(state);
  const povName = String(pov ?? '').trim();
  // 临时知识表：按数组顺序推进，同一章「先 learn 再 use」才合法。
  // 每轮重新从 state 取副本会让本章刚学到的信息在后面判成「不知道」——
  // 这里一次建表、循环内共用。
  const knowledgeMap = new Map();
  for (const name of names) {
    const k = knowledgeOf(state, name);
    if (k) knowledgeMap.set(name, k);
  }

  if (povName && !names.has(povName)) {
    errors.push({
      who: povName,
      fact: '',
      mode: 'pov',
      message: `本章视角人物「${povName}」不在角色表/主角卡里——先登记再标视角`,
      evidence: null,
      suggestion: '用 deltas.characters 登记该角色，或把 pov 改成已登记的名字；泛称（「众人」「路人」）不能当视角人物。',
    });
  }

  for (const raw of Array.isArray(knowledge) ? knowledge : []) {
    const item = normalizeItem(raw);
    if (!item.who) {
      errors.push({
        who: '', fact: item.fact, mode: item.mode,
        message: `信息变更缺少 who（第 ${accepted.length + 1} 条${item.fact ? `：${item.fact}` : ''}）`,
        evidence: null,
        suggestion: '每条知识变更都要写 who（谁知道/用了/透露了这条信息）。',
      });
      continue;
    }
    if (!item.fact) {
      errors.push({
        who: item.who, fact: '', mode: item.mode,
        message: `「${item.who}」的信息变更缺少 fact（不知道是哪条信息）`,
        evidence: null,
        suggestion: 'fact 写成一句可核对的事实，例如「城主是内奸」。',
      });
      continue;
    }
    if (!KNOWLEDGE_MODES.includes(item.mode)) {
      errors.push({
        who: item.who, fact: item.fact, mode: item.mode,
        message: `「${item.who}」的信息变更 mode="${item.mode}" 不认识`,
        evidence: null,
        suggestion: `可用：${KNOWLEDGE_MODES.join(' / ')}（learn=得知 / use=使用 / reveal=透露）。`,
      });
      continue;
    }
    if (!names.has(item.who)) {
      errors.push({
        who: item.who, fact: item.fact, mode: item.mode,
        message: `信息变更的主角「${item.who}」不在角色表/主角卡里`,
        evidence: item.evidence || null,
        suggestion: '先登记角色卡，再记录他知道了什么。',
      });
      continue;
    }

    const k = knowledgeMap.get(item.who);
    if (!k) continue; // names 已保证存在，这里只是防御

    if (item.mode === 'learn') {
      if (!item.witnessedBy && !item.toldBy) {
        errors.push({
          who: item.who, fact: item.fact, mode: item.mode,
          message: `「${item.who}」得知「${item.fact}」没有来源：必须写 witnessedBy（亲眼所见）或 toldBy（谁告诉的）`,
          evidence: item.evidence || null,
          suggestion: '信息不能凭空出现在角色脑子里——8.2 要的是可追溯的获知路径。',
        });
        continue;
      }
      if (item.toldBy) {
        if (!names.has(item.toldBy)) {
          errors.push({
            who: item.who, fact: item.fact, mode: item.mode,
            message: `「${item.who}」的消息来源「${item.toldBy}」不在角色表/主角卡里`,
            evidence: item.evidence || null,
            suggestion: 'toldBy 必须是已登记角色（转述的转述也要写清源头）。',
          });
          continue;
        }
        const teller = knowledgeMap.get(item.toldBy);
        if (!teller?.knows.has(item.fact)) {
          errors.push({
            who: item.who, fact: item.fact, mode: item.mode,
            message: `「${item.toldBy}」告诉「${item.who}」「${item.fact}」，但「${item.toldBy}」自己并不知道这条信息`,
            evidence: item.evidence || null,
            suggestion: `先给「${item.toldBy}」登记 learn（他是怎么知道的），或者换一个真正知情的转述人。`,
          });
          continue;
        }
      }
      if (k.notKnows.has(item.fact)) {
        warnings.push(`「${item.who}」此前登记为不知道「${item.fact}」，本章起改为已知——notKnows 已同步移除。`);
      }
      // 临时知识表推进：同一章后面 use/reveal 才合法
      k.knows.add(item.fact);
      k.notKnows.delete(item.fact);
      learned.push({ who: item.who, fact: item.fact });
      accepted.push(item);
      continue;
    }

    // use / reveal
    if (k.notKnows.has(item.fact)) {
      errors.push({
        who: item.who, fact: item.fact, mode: item.mode,
        message: `「${item.who}」登记为不知道「${item.fact}」，本章却${MODE_LABEL[item.mode]}了它`,
        evidence: item.evidence || null,
        suggestion: '要么改成他确实知道的信息，要么先补一条 learn 写清获知路径；'
          + '若是有意反转（他其实一直知道），先更新 knows/notKnows 再提交。',
      });
      continue;
    }
    if (!k.knows.has(item.fact)) {
      errors.push({
        who: item.who, fact: item.fact, mode: item.mode,
        message: `「${item.who}」还没登记知道「${item.fact}」，本章却${MODE_LABEL[item.mode]}了它`,
        evidence: item.evidence || null,
        suggestion: `先在本章（或之前章节）用 learn 登记「${item.who}」是怎么知道的；`
          + '凭空使用＝8.2 的信息隔离被打穿。',
      });
      continue;
    }
    accepted.push(item);
  }

  return { pov: povName, errors, warnings, accepted, learned };
}

/**
 * 把知识变更写进人物卡（applyChapterFacts 调用；实时提交与重放共用）。
 * 只处理 learn：use/reveal 不产生状态变化。返回新 state（不原地改）。
 */
export function applyKnowledge(state, knowledge = []) {
  const items = Array.isArray(knowledge) ? knowledge : [];
  const learns = items
    .map((item) => normalizeItem(item))
    .filter((item) => item.mode === 'learn' && item.who && item.fact);
  if (learns.length === 0) return state;

  const protagonistName = String(state?.protagonist?.name ?? '').trim();
  const characters = { ...(state.characters ?? {}) };
  let protagonist = state.protagonist;

  for (const item of learns) {
    const target = item.who === protagonistName ? protagonist : characters[item.who];
    if (!target) continue; // 未登记人物：实时层已拦，重放时跳过坏记录
    const knows = Array.isArray(target.knows) ? target.knows : [];
    const notKnows = Array.isArray(target.notKnows) ? target.notKnows : [];
    const next = {
      ...target,
      knows: knows.includes(item.fact) ? knows : [...knows, item.fact],
      notKnows: notKnows.filter((f) => f !== item.fact),
    };
    if (item.who === protagonistName) protagonist = next;
    else characters[item.who] = next;
  }

  return { ...state, protagonist, characters };
}

/** 给人看的一句话（回执/报告共用）。 */
export function renderKnowledgeItem(item) {
  const verb = item.mode === 'learn' ? '得知' : item.mode === 'reveal' ? '透露' : '使用';
  const source = item.mode === 'learn' && (item.witnessedBy || item.toldBy)
    ? `（${item.witnessedBy ? `目击自 ${item.witnessedBy}` : `听 ${item.toldBy} 说`}）`
    : '';
  return `${item.who}${verb}「${item.fact}」${source}`;
}
