/**
 * 外部查重（撞车名作）：从正文里抽特征句，去联网搜索里比对连续相同片段。
 *
 * 为什么必须「外部执行」而不是本地判：本地没有语料库，自己跟自己比永远不撞车。
 * 所以这里只做两件事：
 *   ① 抽句——10–16 字、含专名/低频词优先，尽量是「抄了就能被搜出来」的句子；
 *   ② 调 websearch MCP（零依赖 HTTP JSON-RPC），把命中与「待人工确认」分开报。
 *
 * 诚实性红线（与产品口径一致）：
 *   · 未配置 / 服务不可达 → `executed:false`，调用方必须明示「外部查重未执行，不等于通过」；
 *   · 搜索有结果但没有 ≥10 字连续相同 → 只算「待人工确认」，不算「已查重通过」；
 *   · 只有真的执行过且未命中，`executed:true + hits:[] + pending:[]` 才能说「未命中」。
 *
 * 为什么手写 MCP 客户端：本仓是零运行时依赖，不能为了一个搜索引 fastmcp SDK。
 * 只实现 initialize → notifications/initialized → tools/call 三步，够用且可控。
 */
import { stripMarkdown } from '../util.js';
import { readState, readTerms } from '../core/state.js';
import { knownProperNouns } from './terms.js';

/** 查重参数（唯一真相源，测试直接引用）。 */
export const PLAGIARISM_LIMITS = {
  minChars: 10,          // 特征句最短 10 字（再短就会满大街撞）
  maxChars: 16,          // 最长 16 字（再长搜索引擎很难整句命中）
  minMatchChars: 10,     // 命中口径：≥10 字连续相同
  maxPhrases: 5,         // 每章最多查 5 条，控制外部请求量
  maxResults: 5,         // 每条特征句最多看 5 个结果
  timeoutMs: 30000,      // 单次工具调用超时（原 12000：实测本引擎单句 3.4—90 秒，
                        // 12 秒下 5 句只查成 2 条＝预算太紧，2026-10-24 独占复测后调宽）
};

const SENTENCE_SPLIT = /[。！？!?…；;\n]+/;
const CLAUSE_SPLIT = /[，,、；;：:\s]+/;

/** 高频字（只用来给候选句降权，不参与判据本身）。 */
const COMMON_CHARS = new Set('的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞');

/** 清洗：去引号、空白与首尾标点，只留正文。 */
function cleanSegment(segment) {
  return String(segment ?? '')
    .replace(/[“”「」『』"'‘’《》【】…—\-·]/g, '')
    .replace(/\s+/g, '')
    .replace(/^[，,、；;：:]+|[，,、；;：:]+$/g, '');
}

function scoreCandidate(phrase, priorities) {
  let score = 0;
  let priorityHits = 0;
  for (const word of priorities) {
    if (word.length >= 2 && phrase.includes(word)) {
      priorityHits += 1;
      score += 6;
    }
  }
  let rare = 0;
  for (const ch of phrase) if (!COMMON_CHARS.has(ch)) rare += 1;
  score += rare * 0.2;
  if (/[0-9A-Za-z]/.test(phrase)) score += 1;
  // 越接近 12–14 字越适合整句搜索
  score += Math.max(0, 3 - Math.abs(phrase.length - 13) * 0.4);
  return { score, priorityHits };
}

/**
 * 抽取特征句（纯函数，不联网）。
 * @param {string} text 正文
 * @param {{priorities?:string[], max?:number, minChars?:number, maxChars?:number}} [options]
 * @returns {Array<{phrase:string,score:number,priorityHits:number}>}
 */
export function extractFeatureSentences(text, options = {}) {
  const minChars = Math.max(4, Number(options.minChars) || PLAGIARISM_LIMITS.minChars);
  const maxChars = Math.max(minChars, Number(options.maxChars) || PLAGIARISM_LIMITS.maxChars);
  const max = Math.max(1, Number(options.max) || PLAGIARISM_LIMITS.maxPhrases);
  const priorities = (Array.isArray(options.priorities) ? options.priorities : [])
    .map((w) => String(w ?? '').trim())
    .filter((w) => w.length >= 2)
    .sort((a, b) => b.length - a.length);

  const body = stripMarkdown(String(text ?? '')).replace(/\r\n/g, '\n');
  const candidates = [];
  const push = (raw) => {
    let phrase = cleanSegment(raw);
    if (phrase.length < minChars) return;
    if (phrase.length > maxChars) phrase = phrase.slice(0, maxChars);
    candidates.push({ phrase, ...scoreCandidate(phrase, priorities) });
  };

  for (const sentence of body.split(SENTENCE_SPLIT)) {
    const cleanSentence = cleanSegment(sentence);
    if (cleanSentence.length < minChars) continue;
    if (cleanSentence.length <= maxChars) {
      push(cleanSentence);
    } else {
      // 长句先按逗号/顿号切；有专名的句子再额外取一个「专名居中」窗口。
      for (const clause of sentence.split(CLAUSE_SPLIT)) {
        if (cleanSegment(clause).length >= minChars) push(clause);
      }
      const hit = priorities.find((word) => cleanSentence.includes(word));
      if (hit) {
        const idx = cleanSentence.indexOf(hit);
        const start = Math.max(0, Math.min(cleanSentence.length - maxChars, idx - 3));
        push(cleanSentence.slice(start, start + Math.min(maxChars, cleanSentence.length - start)));
      }
    }
  }

  // 去重：完全相同只留一条；已选长句包含的短候选降为重复（避免同一段文字换窗口重复查）
  const sorted = candidates.sort((a, b) => b.score - a.score || b.phrase.length - a.phrase.length);
  const picked = [];
  for (const cand of sorted) {
    if (picked.some((p) => p.phrase === cand.phrase || p.phrase.includes(cand.phrase) || cand.phrase.includes(p.phrase))) continue;
    picked.push(cand);
    if (picked.length >= max) break;
  }
  return picked;
}

/** 从搜索结果的标题/摘要/URL 里找与特征句 ≥minMatchChars 的连续相同片段。 */
/** 回显型结果：搜索站把查询串回显成标题与 URL（`…/s?q=<查询串>`）。
 *  这类结果当证据＝拿自己发出去的句子撞自己，必须剔除。 */
function isEchoResult(phrase, title, link) {
  const norm = (s) => String(s || '').replace(/[\s“”「」『』"'《》【】]/g, '');
  const q = norm(phrase);
  if (!q) return false;
  let decoded = String(link || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* 保持原样 */ }
  if (!decoded.includes(q)) return false;
  return norm(title).startsWith(q);
}

function findOverlap(phrase, haystack, minMatchChars) {
  const text = String(haystack ?? '');
  if (!text) return null;
  const size = Math.max(4, Number(minMatchChars) || PLAGIARISM_LIMITS.minMatchChars);
  if (text.includes(phrase)) return phrase;
  if (phrase.length <= size) return null;
  for (let i = 0; i + size <= phrase.length; i += 1) {
    const window = phrase.slice(i, i + size);
    if (text.includes(window)) return window;
  }
  return null;
}

function endpointOf(rawUrl) {
  const base = String(rawUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/mcp$/i.test(base) ? base : `${base}/mcp`;
}

/** 解析 MCP 响应：application/json 或 text/event-stream 都认。 */
function parseRpcBody(raw, contentType = '') {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/text\/event-stream/i.test(contentType) || /^event:|^data:/m.test(text)) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const msg = JSON.parse(payload);
        if (msg && (msg.result !== undefined || msg.error !== undefined)) last = msg;
      } catch { /* 非 JSON 的心跳行跳过 */ }
    }
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toolData(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/**
 * 走 Streamable HTTP 调 websearch MCP 的 web_search。
 * @returns {Promise<object>} web_search 的结构化返回（{results, meta}）
 */
/**
 * 打开一次 MCP 会话（initialize → notifications/initialized），返回可复用的句柄。
 * 查重是一章 5 条特征句的批量外部调用，握手只做一次：实测 initialize 单程就要 2 秒以上，
 * 逐句握手会把 12 秒预算吃光，稍一负载就整批 abort（ch86 实测 5 句只查成 1 句）。
 */
async function openSearchSession({ url, token, fetchImpl, timeoutMs }) {
  const endpoint = endpointOf(url);
  if (!endpoint) throw new Error('搜索服务地址为空');
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('当前 Node 没有 fetch（需要 Node 18+）');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || PLAGIARISM_LIMITS.timeoutMs));
  try {
    const baseHeaders = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (token) baseHeaders.authorization = `Bearer ${token}`;

    const initRes = await doFetch(endpoint, {
      method: 'POST',
      headers: baseHeaders,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'webnovel-mcp', version: '1.4.0' },
        },
      }),
    });
    if (!initRes.ok) throw new Error(`initialize HTTP ${initRes.status}`);
    const initMsg = parseRpcBody(await initRes.text(), initRes.headers.get('content-type'));
    if (initMsg?.error) throw new Error(`initialize 失败：${initMsg.error.message ?? '未知错误'}`);
    const sessionId = initRes.headers.get('mcp-session-id') || '';
    const headers = {
      ...baseHeaders,
      'mcp-protocol-version': '2025-03-26',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    };

    // initialized 是通知，没有 id；服务端可能返回 202 空体。
    try {
      await doFetch(endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    } catch {
      // 通知失败不阻断 tools/call：有些实现会直接 202，有些实现不校验这条
    }
    return { endpoint, doFetch, headers };
  } finally {
    clearTimeout(timer);
  }
}

async function callWebSearch({ url, token, query, fetchImpl, timeoutMs, session }) {
  const ms = Math.max(1000, Number(timeoutMs) || PLAGIARISM_LIMITS.timeoutMs);
  const sess = session || await openSearchSession({ url, token, fetchImpl, timeoutMs: ms });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const callRes = await sess.doFetch(sess.endpoint, {
      method: 'POST',
      headers: sess.headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'web_search',
          arguments: { query, max_results: PLAGIARISM_LIMITS.maxResults, use_cache: true },
        },
      }),
    });
    if (!callRes.ok) throw new Error(`tools/call HTTP ${callRes.status}`);
    const callMsg = parseRpcBody(await callRes.text(), callRes.headers.get('content-type'));
    if (callMsg?.error) throw new Error(`web_search 失败：${callMsg.error.message ?? '未知错误'}`);
    const data = toolData(callMsg?.result);
    if (!data || typeof data !== 'object') throw new Error('web_search 返回格式无法解析');
    if (data.error) throw new Error(String(data.error));
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`超时（${Math.round(ms)}ms）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查重主入口。
 * @param {string} root 书项目目录（用于读取专名做候选加权；可为 null）
 * @param {string} text 正文
 * @param {object} options { url, token, timeoutMs, maxPhrases, fetchImpl, priorities }
 * @returns {Promise<{
 *   executed:boolean, reason:string|null, phrases:string[], hits:Array, pending:Array,
 *   searched:number, errors:string[], meta:object|null
 * }>}
 */
export async function checkPlagiarism(root, text, options = {}) {
  const url = String(options.url ?? '').trim();
  const token = String(options.token ?? '').trim();
  const limits = {
    ...PLAGIARISM_LIMITS,
    ...(Number(options.timeoutMs) > 0 ? { timeoutMs: Number(options.timeoutMs) } : {}),
    ...(Number(options.maxPhrases) > 0 ? { maxPhrases: Number(options.maxPhrases) } : {}),
  };

  let priorities = Array.isArray(options.priorities) ? options.priorities : null;
  if (!priorities && root) {
    try {
      const { value: state } = readState(root);
      const { value: terms } = readTerms(root);
      priorities = [...knownProperNouns(state, terms)];
    } catch {
      priorities = [];
    }
  }
  priorities = (priorities ?? []).map(String).filter((w) => w.length >= 2);

  const features = extractFeatureSentences(text, {
    priorities,
    max: limits.maxPhrases,
    minChars: limits.minChars,
    maxChars: limits.maxChars,
  });
  const phrases = features.map((f) => f.phrase);
  const base = {
    executed: false,
    reason: null,
    phrases,
    hits: [],
    pending: [],
    searched: 0,
    errors: [],
    meta: null,
  };

  if (!url) {
    return { ...base, reason: '未配置 WEBNOVEL_SEARCH_URL' };
  }
  if (phrases.length === 0) {
    return { ...base, reason: `正文里没有 ${limits.minChars} 字以上的特征句` };
  }

  const hits = [];
  const pending = [];
  const errors = [];
  let searched = 0;
  let lastMeta = null;

  // 一次握手，整批复用；握手本身失败就直接说明未执行，不拿 5 个超时冒充结果。
  let session = null;
  try {
    session = await openSearchSession({
      url, token, fetchImpl: options.fetchImpl, timeoutMs: limits.timeoutMs,
    });
  } catch (err) {
    const why = err?.name === 'AbortError' ? '搜索服务握手超时' : '搜索服务不可达';
    return { ...base, reason: `${why}：${err?.message ?? '未知错误'}（外部查重未执行）` };
  }

  for (const feature of features) {
    try {
      const data = await callWebSearch({
        url, token, query: feature.phrase,
        fetchImpl: options.fetchImpl,
        timeoutMs: limits.timeoutMs,
        session,
      });
      searched += 1;
      if (data.meta && typeof data.meta === 'object') lastMeta = data.meta;
      const results = Array.isArray(data.results) ? data.results.slice(0, limits.maxResults) : [];
      let phraseHit = false;
      let firstPending = null;
      for (const result of results) {
        const title = String(result?.title ?? '');
        const snippet = String(result?.snippet ?? result?.content ?? '');
        const link = String(result?.url ?? '');
        // 回显型结果不作证据：搜索站会把查询串回显成标题＋URL（如 tv.360kan.com/s?q=…），
        // 拿它比对等于自己撞自己（2026-10-24 ch6／ch17 各报 1 条假命中，实测全是这种）。
        if (isEchoResult(feature.phrase, title, link)) continue;
        const haystack = `${title}\n${snippet}\n${link}`;
        const matched = findOverlap(feature.phrase, haystack, limits.minMatchChars);
        if (matched) {
          phraseHit = true;
          hits.push({
            phrase: feature.phrase,
            matched,
            title: title || link || '（无标题）',
            url: link,
            engine: result?.source ?? result?.engine ?? null,
          });
          break;
        }
        if (!firstPending) firstPending = { phrase: feature.phrase, title: title || link || '（无标题）', url: link };
      }
      if (!phraseHit && firstPending) pending.push(firstPending);
    } catch (err) {
      errors.push(`${feature.phrase.slice(0, 12)}…：${err?.message ?? String(err)}`);
    }
  }

  if (searched === 0) {
    return {
      ...base,
      reason: `搜索服务不可达（${errors[0] ?? '未知错误'}）`,
      errors,
    };
  }

  return {
    executed: true,
    reason: null,
    phrases,
    hits,
    pending,
    searched,
    errors,
    meta: lastMeta,
    partial: errors.length > 0,
  };
}

/** 查重结果给人看的几行（review 报告与回执共用）。 */
export function renderPlagiarismLines(result) {
  if (!result) return ['外部查重：未请求'];
  if (!result.executed) {
    return [`外部查重：未执行（${result.reason ?? '未知原因'}）——这**不等于通过**`];
  }
  const lines = [`外部查重：已执行 ${result.searched}/${result.phrases?.length ?? 0} 条特征句`];
  if (result.hits?.length) {
    for (const hit of result.hits) {
      lines.push(`🔴 疑似撞车：「${hit.matched}」与《${hit.title}》连续相同（${hit.url || '无链接'}）`);
    }
  }
  if (result.pending?.length) {
    for (const p of result.pending) {
      lines.push(`🟡 待人工确认：《${p.title}》命中了搜索词但没有 ${PLAGIARISM_LIMITS.minMatchChars} 字连续相同（${p.url || '无链接'}）`);
    }
  }
  if (!result.hits?.length && !result.pending?.length) lines.push('✅ 已执行，未发现连续相同片段');
  if (result.partial) lines.push(`⚠ 有 ${result.errors?.length ?? 0} 条特征句查询失败，结果不完整`);
  return lines;
}
