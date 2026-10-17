/**
 * 专名账本的可执行部分：类别词表 + 「疑似未登记专名」启发式识别。
 *
 * 产品定位（提示词第一节 铁律 1「名词锁定」）：
 *   专有名词一旦确立即登记；后续输出只能用已登记名词；需要新名词必须先问作者，
 *   「禁止无声创造」。这条铁律光靠 agent 自觉守不住——它会在第 200 章顺口编出
 *   一个从没出现过的「凌霄宗」，读者记得，作者也看不出，只有账本记得。
 * 所以提交那一章正文时，把「正文里出现、但机器态里查无此名」的疑似专名挑出来，
 * 作为 warning 交给作者确认。**只提醒，不拦截**（拦截会卡在启发式的误报上）。
 *
 * 识别口径：宁漏报不误伤。
 * 漏报的代价是「这个新名字这次没被提醒」；误伤的代价是作者被噪声骚扰，
 * 进而无视全部警告——后者会毁掉整个机制。因此三类锚点都要求强上下文
 * （对话归属动词 / 显式命名动词 / 移动动词 + 专名后缀），再叠姓氏锚点、
 * 虚词否决、常用词黑名单层层收窄。
 *
 * 覆盖面因此不完整。**已知漏报清单**（逐条对应下面的实现，改口径必须同步改这里——
 * 清单与代码不符，比没有清单更坏：读的人会照着错的边界做判断）：
 * - **法号、纯音译外文名**：不以百家姓开头，过不了姓氏锚点（除非走 PERSON_INTRODUCE 的「法号/道号」前缀）。
 * - **地名与组织名**：三条同时满足才报——① 紧跟在 PLACE_INTRODUCE 的移动·方位动词之后；
 *   ② 本章出现次数 ≥ minRepeat（默认 2，见 detectUnregisteredTerms）；③ 切出来的候选末字是
 *   地名/组织后缀（PLACE_SUFFIX），且长度 ≥3 字。因此以下写法都不在覆盖内：
 *   「幽冥宗的山门紧闭」（有重复、无移动动词）、「X 山门」「X 的执事」（所有格/偏正，动词锚点接不上）、
 *   两字地名（如「楚城」，pickPlace 从 3 字起切）。
 * - **名字里含动态助词/虚词的**：虚词否决会把它砍掉——「杨过」的「过」正是被否决的字，这条救不了。
 * - **物品/功法名从「名叫X」出现的**：通称锚点 NAMED_INTRODUCE 只认「名为/叫做/取名/改名为/立名为/封号」，
 *   「名叫」那条路只喂给人名（PERSON_INTRODUCE）。
 * 这些是有意的取舍：工具兜底，不替代登记动作本身。
 */
import { termKeys } from '../core/state.js';
import { toInt } from '../util.js';

/* ------------------------------------------------------------------ *
 * 类别词表（提示词铁律 1 原文列举：人名、地名、功法、技术、组织、物品、案件、术语）
 * ------------------------------------------------------------------ */

export const TERM_TYPES = {
  person: '人名',
  place: '地名',
  org: '组织',
  item: '物品',
  skill: '功法/技术',
  term: '术语',
  case: '案件',
  other: '其它',
};

/** 模型/作者会传的各种说法，全部收敛到 TERM_TYPES 的键。认不出→other。 */
const TERM_TYPE_ALIASES = {
  person: ['person', 'human', 'character', '人名', '人物', '角色', '主角', '配角', '反派', 'npc'],
  place: ['place', 'location', '地名', '地点', '地点名', '区域', '场景', '地图', '城', '山', '秘境'],
  org: ['org', 'organization', 'faction', 'sect', '组织', '势力', '门派', '宗门', '团体', '家族', '王朝', '教派', '联盟'],
  item: ['item', 'object', 'treasure', 'relic', '物品', '道具', '法宝', '灵器', '武器', '宝物', '东西'],
  skill: ['skill', 'technique', 'ability', 'power', '功法', '技术', '能力', '武学', '招式', '神通', '秘术', '法术', '技能', '体系'],
  term: ['term', 'concept', 'jargon', '术语', '概念', '名词', '行话', '称谓'],
  case: ['case', 'incident', '案件', '案子', '事件'],
  other: ['other', 'misc', '其它', '其他'],
};

const TERM_TYPE_INDEX = new Map();
for (const [key, words] of Object.entries(TERM_TYPE_ALIASES)) {
  for (const word of words) TERM_TYPE_INDEX.set(String(word).toLowerCase(), key);
}

/** 把任意写法（中英、单复数、错别字不管）归一到类别键。 */
export function normalizeTermType(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'other';
  const direct = TERM_TYPE_INDEX.get(raw.toLowerCase());
  if (direct) return direct;
  // 「人名/角色」「组织势力」「功法和技巧」这类长描述：命中词表里的词就算
  for (const [word, key] of TERM_TYPE_INDEX) {
    if (word.length >= 2 && raw.includes(word)) return key;
  }
  return 'other';
}

export function termTypeLabel(type) {
  return TERM_TYPES[type] ?? TERM_TYPES.other;
}

/* ------------------------------------------------------------------ *
 * 已登记 / 已知专名
 * ------------------------------------------------------------------ */

/**
 * 「已知的专名写法」全集——比账本本身宽得多。
 *
 * 为什么宽：检测的目标是「正文出现但系统完全不知道的写法」。
 * 角色卡、世界设定、时间线里的地点本来就已经登记在机器态里，
 * 只是还没抄进 terms.json。若只跟账本比，vivo 上那 4 本真实书（账本为空）
 * 会在下一次提交时把主角名、大宗门名全报成「疑似新专名」——
 * 一屏噪声，机制当场作废。
 */
export function knownProperNouns(state, terms) {
  const known = new Set();
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (text.length >= 2) known.add(text);
  };
  for (const key of termKeys(terms)) push(key);
  push(state?.protagonist?.name);
  push(state?.protagonist?.goldenFinger?.name);
  for (const name of Object.keys(state?.characters ?? {})) push(name);
  for (const item of state?.world?.factions ?? []) push(item && typeof item === 'object' ? (item.name ?? item.title) : item);
  for (const item of state?.world?.locations ?? []) push(item && typeof item === 'object' ? (item.name ?? item.title) : item);
  for (const item of state?.world?.powerSystem ?? []) push(item && typeof item === 'object' ? (item.name ?? item.title) : item);
  for (const entry of state?.timeline ?? []) push(entry?.location);
  return known;
}

/**
 * 命中判定：完全相等，或与已知写法互为包含。
 * 互为包含是为了「叶玄师兄」「青玄宗山门」这类派生写法不再重复告警；
 * 代价是「张三」与已知「张三丰」同现时会漏报一次——按宁漏报口径可接受。
 */
function isKnown(candidate, known) {
  if (known.has(candidate)) return true;
  for (const name of known) {
    if (name.length >= 2 && (candidate.includes(name) || name.includes(candidate))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 启发式识别
 * ------------------------------------------------------------------ */

const HAN = '一-鿿';

/**
 * 绝不可能出现在中文人名里的虚词/量词/语气词：候选含任一字即否决。
 * 刻意不含 无/未/之/若/明/白/成 这类「修仙名字里常见」的字——
 * 它们是漏报源，不是误报源（误报另有姓氏锚点与泛称黑名单兜着）。
 */
const FORBIDDEN_IN_NAME = new Set([
  '的', '了', '着', '过', '是', '在', '有', '这', '那', '些', '个', '座', '片', '处', '位', '名',
  '与', '和', '及', '或', '而', '但', '被', '让', '叫', '向', '对', '从', '把', '给', '又', '也',
  '都', '就', '还', '才', '很', '更', '最', '太', '不', '没', '别', '再', '已', '经',
  '呢', '吗', '吧', '啊', '呀', '哦', '嗯', '嘛', '么', '此', '该', '各', '每', '谁', '何',
]);

/**
 * 不能收尾的字：动词/介词/方位/泛指称谓——切歪时它们最常落在尾巴上
 * （「杨过知道」剥掉「道」剩「杨过知」，尾字「知」直接否决）。
 * 不含 门/宗/城/阁 等专名后缀：地名候选正要靠它们收尾。
 */
const FORBIDDEN_TAIL = new Set([
  '的', '了', '着', '过', '是', '在', '有', '这', '那', '不', '很', '就', '都', '也', '又', '被',
  '让', '向', '对', '从', '把', '给', '说', '道', '知', '觉', '看', '见', '闻', '想', '来', '去',
  '到', '为', '作', '做', '地', '得', '而', '但', '或', '及', '与', '和', '则', '其', '已', '经',
  '未', '仍', '却', '才', '更', '最', '太', '么', '呢', '吗', '吧', '啊', '呀', '哦', '嗯',
  '者', '人', '客', '翁', '僧', '童', '子', '女', '男', '兄', '弟', '姐', '妹', '叔', '伯', '婶',
  '姑', '爷', '奶', '父', '母', '师', '徒', '众', '等', '辈', '伙', '兵', '将', '帅', '官', '差',
  '贼', '匪', '盗', '魔', '鬼', '怪', '兽', '禽', '主', '头', '们', '方', '边', '面', '里', '中',
  '间', '所', '时', '候', '物', '修', '类', '种',
  // 外貌描述词的尾巴：「白须老者拱手道」剥掉「老者」剩「白须」，白又是姓，
  // 不加这层就会把「白须」当人名报出来（这类修饰词 + 泛称的组合很常见）。
  '须', '眉', '髯', '庞', '睛',
]);

/** 整词否决：常见泛指称谓与自称，切出来也像名字。 */
const GENERIC_WORDS = new Set([
  '少年', '青年', '中年', '老者', '老人', '老头', '大汉', '壮汉', '汉子', '妇人', '女子', '男子',
  '童子', '孩童', '孩子', '众人', '两人', '二人', '三人', '四人', '本人', '此人', '那人', '这人',
  '某人', '大家', '大伙', '前辈', '晚辈', '同门', '师兄', '师姐', '师弟', '师妹', '师父',
  '师尊', '长老', '宗主', '掌门', '家主', '城主', '皇帝', '陛下', '殿下', '大人', '公子', '小姐',
  '少爷', '老爷', '夫人', '太太', '小哥', '姑娘', '兄弟', '姐妹', '朋友', '敌人', '对手', '家伙',
  '东西', '什么', '那里', '这里', '对方', '自己', '我们', '你们', '咱们', '他们',
  '她们', '它们', '一声', '一阵', '一次', '一番', '片刻', '半晌', '须臾', '刹那',
  // 副词+声/笑/点头 这类「像名字」的情态词：剥掉归属动词后正好剩两个字
  '高声', '低声', '大声', '小声', '连声', '沉声', '冷声', '厉声', '柔声', '朗声', '尖声', '细声',
  '应声', '急忙', '赶忙', '连忙', '缓缓', '慢慢', '轻轻', '淡淡', '微微', '冷冷', '笑笑', '哈哈',
  '嘻嘻', '呵呵', '哼哼', '皱眉', '摇头', '点头', '苦笑', '大笑', '冷笑', '叹气', '叹息', '开口',
  '接口', '插话', '追问', '反问', '回答', '说道', '问道',
]);

/** 泛指地点/场所：移动动词后面跟着它们不算专名。 */
const GENERIC_PLACES = new Set([
  '大殿', '正殿', '主殿', '石殿', '山门', '门口', '屋内', '室内', '院中', '院子', '房间', '小屋',
  '木屋', '竹屋', '洞府', '洞穴', '山洞', '广场', '平台', '高台', '擂台', '校场', '演武场', '通道',
  '走廊', '回廊', '城墙', '城门', '城头', '屋顶', '空中', '地下', '外面', '里面', '前面', '后面',
  '远处', '近处', '深处', '岸边', '水面', '半空', '原地', '院落', '楼阁', '房屋', '街道', '巷口',
]);

/** 常见单姓（百家姓为主，剔除明显不用于人名的生僻字）。 */
const SURNAMES = new Set([
  ...'赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛',
  ...'奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康',
  ...'伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵',
  ...'季贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲',
  ...'邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴',
  ...'弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟溥印宿白',
  ...'怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴鬱胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿',
  ...'通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文',
  ...'寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆',
  ...'红游竺权逯盖益桓公',
].flatMap((chunk) => [...chunk]));

/** 复姓：两字开头才算，避免「独/慕」这类单字误判。 */
const COMPOUND_SURNAMES = [
  '欧阳', '司马', '上官', '独孤', '慕容', '东方', '南宫', '西门', '北宫', '东郭', '西郭', '南郭',
  '北郭', '百里', '皇甫', '令狐', '轩辕', '宇文', '长孙', '完颜', '呼延', '纳兰', '淳于', '申屠',
  '公孙', '仲孙', '叔孙', '太史', '左丘', '公羊', '澹台', '万俟', '司寇', '巫马', '颛孙', '公西',
  '公良', '南荣', '东里', '鲜于', '闾丘', '梁丘', '王孙', '宰父', '穀梁', '胡毋', '母丘',
];

/** 对话归属尾巴（长写法排前面，先剥长的）。 */
const ATTRIBUTION_TAILS = [
  '低声说道', '沉声说道', '开口问道', '厉声喝道', '朗声说道', '急忙说道', '连连说道', '开口说道',
  '冷笑着说道', '苦笑着说道', '沉声问道', '低声问道', '高声问道', '厉声问道', '柔声说道', '轻声说道',
  '皱眉说道', '摇头说道', '点头说道', '拱手说道', '抱拳说道', '追问道', '反问道', '接口道', '插话道',
  '沉声道', '低声道', '高声道', '朗声道', '轻声道', '柔声道', '厉声道', '急声道', '喃喃道', '嘟囔道',
  '皱眉道', '摇头道', '点头道', '拱手道', '抱拳道', '冷哼道', '冷笑道', '苦笑道', '惊叫道', '大喊大叫道',
  '说道', '问道', '答道', '回道', '喝道', '叫道', '喊道', '吼道', '骂道', '应道', '叹道', '怒道', '笑道',
  '大喊', '高呼', '低呼', '惊呼', '开口', '说道', '说', '道',
];

/** 人名命名锚点：后面要跟的必须是人名，仍要姓氏锚点兜一层（「人称废物」不算）。 */
const PERSON_INTRODUCE = '(?:名叫|唤作|人称|外号|道号|法号)';

/**
 * 通称命名锚点：物品/功法/术语的名字（「名为洗髓丹」「叫做吞天魔鼎」）。
 * 这类名字基本不以姓氏开头，所以不套姓氏锚点；精度全靠锚点本身。
 * 刻意不收「号称/自称」——它们后面跟着的多是「无敌」「本座」这类情态词。
 */
const NAMED_INTRODUCE = '(?:名为|叫做|取名|改名为|立名为|封号)';

/**
 * 移动/方位锚点：后面跟着的才是地名或宗门名。
 * 收词口径：动词后面**只接处所**的才收。「退回」这类还有「退回款项」义，
 * 靠后面的「末字必须是地名后缀 + 本章重复≥2」两道闸门挡误伤（precision 在那两步，不在这一步）。
 * 漏收的代价很实在：「两人赶到幽冥宗」这种最常见的一句，曾经整条链上没人提醒（C4）。
 */
const PLACE_INTRODUCE = '(?:来到|抵达|到达|回到|返回|前往|直奔|进入|走进|冲出|逃出|离开|退到|逃到|路过|途经|身在|困于|位于|赶往|赶到|赶赴|奔赴|撤到|撤往|移到|迁到|退回|折返|潜入|闯入|搬到|驻守|盘踞|坐镇)';

/** 组织后缀（其余后缀算地名）。 */
const ORG_SUFFIX = new Set(['宗', '派', '阁', '塔', '楼', '斋', '轩', '堂', '馆', '寺', '观', '宫', '殿', '门', '院']);
const PLACE_SUFFIX = new Set([...ORG_SUFFIX, ...'城府州县村镇谷山湖海林原域界观洞崖峰岭渡关寺塔楼桥码头坡窟坛坪潭江河渊沼岛殿园苑斋轩']);

function containsForbidden(word) {
  for (const ch of word) {
    if (FORBIDDEN_IN_NAME.has(ch)) return true;
  }
  return false;
}

/** 疑似专名的合法性判定（不含「是否已知」）。 */
function looksLikeProperNoun(word) {
  if (word.length < 2 || word.length > 8) return false;
  if (containsForbidden(word)) return false;
  if (FORBIDDEN_TAIL.has(word[word.length - 1])) return false;
  if (word[0] === word[1]) return false;          // 微微 / 淡淡 / 白白：副词重叠，不是名字
  if (GENERIC_WORDS.has(word)) return false;
  return true;
}

function startsWithSurname(word) {
  if (COMPOUND_SURNAMES.some((s) => word.startsWith(s) && word.length >= s.length + 1)) return true;
  return SURNAMES.has(word[0]);
}

/**
 * 从「对话归属尾巴剥掉之后」的汉字串里取人名。
 * 取尾 4→3→2 字，返回第一个「姓氏锚定 + 不含虚词 + 不以后缀虚词收尾」的候选。
 * 从长往短试：名字通常比修饰语更靠近动词（「青玄宗的叶玄」取到叶玄，取不到「宗的叶玄」——后者含「的」被否）。
 */
function pickPerson(tail) {
  for (let len = Math.min(4, tail.length); len >= 2; len -= 1) {
    const word = tail.slice(-len);
    if (looksLikeProperNoun(word) && startsWithSurname(word)) return word;
  }
  return null;
}

/**
 * 汉字串末尾若是对话归属动词，剥掉动词返回剩余部分；不是则返回 null。
 * 最多连剥三层：「叶玄开口说」先剥「说」剩「叶玄开口」，再剥「开口」才拿到名字。
 */
function stripAttribution(run) {
  let rest = String(run);
  let stripped = false;
  for (let round = 0; round < 3; round += 1) {
    const hit = ATTRIBUTION_TAILS.find(
      (tailWord) => rest.length > tailWord.length && rest.endsWith(tailWord),
    );
    if (!hit) break;
    rest = rest.slice(0, rest.length - hit.length);
    stripped = true;
  }
  if (!stripped) return null;
  // 剥掉归属动词后，尾巴上常常还挂着一层情态词：「王林高声应道」剥「应道」得「王林高声」，
  // 直接交给 pickPerson 就会把修饰语当名字（姓氏锚点救不了——王确实是姓）。
  // 只剥到剩两字为止：宁可剩下的一截短一点，也不能把「高声」本身剥成空。
  for (let round = 0; round < 3 && rest.length > 2; round += 1) {
    const tail2 = rest.slice(-2);
    if (!GENERIC_WORDS.has(tail2)) break;
    rest = rest.slice(0, -2);
  }
  return rest;
}

/**
 * 从锚点后面贪婪匹配到的汉字串里截出候选。
 * 贪婪匹配会连着后面的修饰语（「名叫叶玄的少年」抓到「叶玄的少年」），
 * 所以遇到第一个虚词就截断；虚词出现在第 0/1 字时不截（交给合法性判定否决，
 * 免得把「他的」这类截成空串）。
 */
function cutAfterAnchor(raw) {
  const word = String(raw ?? '');
  const chars = [...word];
  const cut = chars.findIndex((ch) => FORBIDDEN_IN_NAME.has(ch));
  return cut >= 2 ? chars.slice(0, cut).join('') : word;
}

/**
 * 从锚点后贪婪匹配到的汉字串里，取**最短**的「以专名后缀收尾」前缀当候选。
 * 贪婪匹配会把后面的修饰语一起吞进来（「来到幽冥宗山门外」吞成「幽冥宗山门外」），
 * 而从短往长试能在第一个专名后缀处收口：幽冥宗 ✓（而不是「幽冥宗山门」）。
 */
function pickPlace(word, body, minRepeat) {
  for (let len = Math.max(3, word.length); len >= 3; len -= 1) {
    const candidate = word.slice(0, len);
    if (!looksLikeProperNoun(candidate)) continue;
    if (GENERIC_PLACES.has(candidate)) continue;
    if (!PLACE_SUFFIX.has(candidate[candidate.length - 1])) continue;
    // 本章只提一次的位置感太强（「来到青玄宗山门外」这种一笔带过），要求重复提及
    if (body.split(candidate).length - 1 < minRepeat) continue;
    return candidate;
  }
  return null;
}

/**
 * 扫描正文，返回「疑似未登记专名」候选。
 *
 * @param {string} text 本章正文
 * @param {Set<string>} known 已知写法全集（见 knownProperNouns）
 * @param {{limit?: number, minRepeat?: number}} options
 * @returns {Array<{name:string,type:string,evidence:string}>} 按出现顺序
 */
export function detectUnregisteredTerms(text, known = new Set(), options = {}) {
  const limit = options.limit ?? 12;
  const minRepeat = toInt(options.minRepeat, 2);   // 地名/组织要求重复提及，压误报
  const body = String(text ?? '');
  if (!body.trim()) return [];

  const found = new Map();                        // name → {name,type,evidence}
  const add = (name, type, evidence) => {
    if (!name || isKnown(name, known) || found.has(name)) return;
    found.set(name, { name, type, evidence });
  };

  // ① 对话归属 → 人名（「叶玄说道」「白起沉声道」）
  for (const run of body.match(new RegExp(`[${HAN}]+`, 'g')) ?? []) {
    const tail = stripAttribution(run);
    if (!tail) continue;
    const word = pickPerson(tail);
    if (word) add(word, 'person', run);
  }

  // ② 显式命名：人名锚点要姓氏；通称锚点不要求姓氏（法宝/丹药名基本不以姓开头）
  for (const match of body.matchAll(new RegExp(`${PERSON_INTRODUCE}([${HAN}]{2,6})`, 'g'))) {
    const word = cutAfterAnchor(match[1]);
    if (!looksLikeProperNoun(word)) continue;
    if (startsWithSurname(word)) {
      add(word, 'person', match[0]);
      continue;
    }
    // 「名叫幽冥宗」「外号藏剑阁」：人名锚点后面跟的其实是势力/地点。姓氏锚点会把它否掉，
    // 但结尾的专名后缀足够硬，按类别收下。物品/功法名（洗髓丹）仍以 名为/叫做 为锚点，
    // 从 名叫 这条路会漏——漏报是有意取舍，误报才会让作者无视整套提醒。
    const bySuffix = classifyBySuffix(word);
    if (bySuffix) add(word, bySuffix, match[0]);
  }
  for (const match of body.matchAll(new RegExp(`${NAMED_INTRODUCE}([${HAN}]{2,6})`, 'g'))) {
    const word = cutAfterAnchor(match[1]);
    if (!looksLikeProperNoun(word)) continue;
    add(word, classifyBySuffix(word) ?? 'other', match[0]);
  }

  // ③ 移动/方位锚点 → 地名/组织（「来到青玄宗」），要求本章重复提及
  for (const match of body.matchAll(new RegExp(`${PLACE_INTRODUCE}([${HAN}]{2,8})`, 'g'))) {
    const word = cutAfterAnchor(match[1]);
    if (word.length < 3 || !looksLikeProperNoun(word)) continue;
    const candidate = pickPlace(word, body, minRepeat);
    if (!candidate) continue;
    add(candidate, ORG_SUFFIX.has(candidate[candidate.length - 1]) ? 'org' : 'place', match[0]);
  }

  return [...found.values()].slice(0, limit);
}

/** 按结尾字猜类别（猜不出返回 null，交给调用方兜底）。 */
export function classifyBySuffix(word) {
  const text = String(word ?? '').trim();
  if (text.length < 2) return null;
  const last = text[text.length - 1];
  if (ORG_SUFFIX.has(last)) return 'org';
  if (PLACE_SUFFIX.has(last)) return 'place';
  return null;
}

/**
 * 组装给作者看的告警文案。
 * 关键：把「依据」原文片段带上，作者一眼能判断是真新专名还是切错了；
 * 并给出处置动作（登记 or 忽略），不说空话。
 */
export function renderUnregisteredWarning(candidates, maxShow = 8) {
  if (!candidates || candidates.length === 0) return null;
  const head = candidates.slice(0, maxShow)
    .map((c) => `${c.name}（${termTypeLabel(c.type)}，依据「${c.evidence}」）`)
    .join('、');
  const more = candidates.length > maxShow ? `；另有 ${candidates.length - maxShow} 处` : '';
  return '疑似未登记专名（启发式识别，可能误报）：'
    + `${head}${more}。`
    + '这些写法在专名账本、角色卡与世界设定里都查不到。'
    + '若确是本立新下的专名，请用 deltas.terms 登记（形如 [{"name":"青玄宗","type":"org","note":"东域宗门"}]），'
    + '不登记则后续章节无法知道它存在；若是既有专名的变体或切错了，忽略本条即可。';
}
