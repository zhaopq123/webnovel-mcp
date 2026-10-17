/**
 * 人物档案测试（v1.3.0 · 实施计划第 12 条：提示词第六节 + 3.6⑧ 归属核对 + 6.14 主角人味）。
 *
 * 三层，缺一层就是「绿着但机制是空的」：
 *   ① 纯函数：说话人归属判定（判据自己不能先犯张冠李戴）、字段归一；
 *   ② 落盘：走 MCP 工具层提交，断言 state.json 里的真实形状（只存非默认值、数组累积）；
 *   ③ 出口：review 能红（3.6⑧）、status 报缺口、任务书带「还不知道」、query 卡能看见档案。
 * 再加一条重放对账：档案字段必须能从提交链重放还原，否则 doctor 天天假红。
 * 全程独立临时目录，不碰任何真实书。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FILES } from '../lib/core/paths.js';
import { readState } from '../lib/core/state.js';
import { doctorCheck } from '../lib/features/doctor.js';
import {
  extractDialogue, infoKeys, normalizeDossierPatch, relationLevelOf, dossierGaps,
  humanFlawGaps, ownershipCheck, isMajorCard, dossierLines,
} from '../lib/features/dossier.js';
import { applyTool, loadConfig } from '../mcp/tools.mjs';

/* ------------------------------------------------------------------ *
 * 造书工具：一律走工具层，测的是真实入口
 * ------------------------------------------------------------------ */

async function book() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-dos-'));
  const config = { ...loadConfig({ WEBNOVEL_ROOT: root }), token: '' };
  await applyTool('webnovel_init', {
    bookId: 'b1', title: '档案测试', genre: '玄幻', targetWords: 600000, targetChapters: 200,
  }, config);
  return { root, config };
}

const stateOf = (root) => readState(path.join(root, 'b1')).value;

async function commitDelta(root, config, chapter, deltas, extra = {}) {
  return applyTool('webnovel_commit', {
    bookId: 'b1', chapter, title: `第${chapter}章`, summary: `第 ${chapter} 章摘要`, force: true, ...extra,
    ...(deltas ? { deltas } : {}),
  }, config);
}

/** 卡住两个人：陈三（重要配角，有秘密、有「不知道」）与周伯（反派，有秘密）。 */
const TWO_CHARS = {
  protagonist: {
    name: '林晚',
    desire: '查出灭门真相', fear: '连累唯一剩下的亲人', secret: '自己是被抱养的',
    contradiction: '既想查清又怕查到自己身上',
    voice: { fingerprint: '长句铺垫、句尾爱加反问', profanity: '全程不说' },
    humanFlaws: { habits: ['路痴', '死要面子'], selfishMotive: '想攒钱买条船出海', errorPlan: '第 30 章误信商人' },
  },
  characters: [
    {
      name: '陈三',
      patch: {
        role: '重要配角', desire: '活下去', fear: '再被卖一次', secret: '他是官府的眼线',
        contradiction: '既怕死又爱管闲事', voice: { fingerprint: '短句、爱反问' },
        relationLevel: '信任', knows: ['林晚想要一匹快马'], notKnows: ['玉佩是母亲的遗物'],
      },
    },
    { name: '周伯', patch: { role: '反派', secret: '当年灭林家的令是他下的', plan: '三步夺回兵符，已行至第二步' } },
  ],
};

/* ------------------------------------------------------------------ *
 * ① 纯函数：归属判定与字段归一
 * ------------------------------------------------------------------ */

test('档案 · 说话人判定：引号前、引号后、跨行不许抢别人的台词', () => {
  const names = ['林晚', '陈三', '周伯'];
  const one = (text) => {
    const d = extractDialogue(text, names);
    assert.equal(d.length, 1, `只该抽出一句：${text}`);
    return d[0].speaker;
  };
  assert.equal(one('陈三说道：“走。”'), '陈三');
  assert.equal(one('“走。”陈三冷笑。'), '陈三');
  assert.equal(one('林晚：“我先去。”'), '林晚');
  assert.equal(one('“都闭嘴。”林晚沉声道。'), '林晚');
  assert.equal(one('旁边有人道：“你来了。”'), null, '泛称不许猜');
  assert.deepEqual(extractDialogue('陈三擦着刀。林晚叹了口气。', names), [], '没有引号就不该抽出台词');
  // 跨行：前一句的归属不许被下一行的说话人抢走（这正是本判据要防的张冠李戴）
  const two = extractDialogue('周伯道：“玉佩是母亲的遗物。”\n陈三说道：“你少管我。”', names);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((x) => x.speaker), ['周伯', '陈三']);
});

test('档案 · 名字互为前缀时先看长名（王林生的话不许算成王林说的）', () => {
  const d = extractDialogue('王林生道：“我来了。”王林没吭声。', ['王林', '王林生']);
  assert.equal(d[0].speaker, '王林生');
});

test('档案 · 同一行里取离引号更近的人，不取行首那个', () => {
  const d = extractDialogue('陈三推了推林晚，林晚说道：“我去。”', ['陈三', '林晚']);
  assert.equal(d[0].speaker, '林晚');
});

test('档案 · infoKeys：长句拆成能命中的片段，虚词开头的碎片不进表', () => {
  const keys = infoKeys('他一直隐瞒自己是官府的眼线');
  assert.ok(keys.some((k) => k.includes('眼线')), `拆不出关键片段：${keys.join('/')}`);
  assert.ok(!keys.some((k) => /^[的了是在有把被让]/.test(k)), `虚词开头的碎片会误伤：${keys.join('/')}`);
  assert.deepEqual(infoKeys(''), []);
  assert.deepEqual(infoKeys(null), []);
});

test('档案 · 关系级认 1-5、认五级名、认「三级」，认不出来返回 null（不猜）', () => {
  assert.equal(relationLevelOf(3), 3);
  assert.equal(relationLevelOf('信任'), 3);
  assert.equal(relationLevelOf('托付'), 5);
  assert.equal(relationLevelOf('三级'), 3);
  assert.equal(relationLevelOf('生死之交'), null);
  assert.equal(relationLevelOf(9), null);
});

test('档案 · 归一：未知键保留、坏形状当场说、空值不落盘', () => {
  const { patch, warnings } = normalizeDossierPatch({
    desire: '活下去', knows: ['甲', '甲', ' 乙 '], notKnows: '不是数组', relationLevel: '乱填',
    voice: { fingerprint: '短句', tic: null }, 自定义字段: '留着', empty: '',
  });
  assert.deepEqual(patch.knows, ['甲', '乙']);
  assert.deepEqual(warnings.length, 2, JSON.stringify(warnings));
  assert.equal(patch.notKnows, undefined);
  assert.equal(patch.relationLevel, undefined, '认不出来的关系级不写脏数据');
  assert.equal(patch.自定义字段, '留着', '作者写的东西不许被吃掉（additive 演进）');
  assert.equal(patch.empty, undefined);
  assert.equal(patch.voice.fingerprint, '短句');
  assert.equal(patch.voice.tic, undefined);
});

test('档案 · 只有主要人物吃完整性提醒（普通配角不该被催着填三维）', () => {
  assert.equal(isMajorCard({ role: '路人甲' }), false);
  assert.equal(isMajorCard({ role: '重要配角' }), true);
  assert.equal(isMajorCard({ role: '路人', desire: '有饭吃' }), true, '填过核心字段＝正在建主要人物');
  const gaps = dossierGaps({ role: '重要配角', desire: '活下去' });
  assert.deepEqual(gaps.map((g) => g.key).sort(), ['contradiction', 'fear', 'relationLevel', 'secret', 'voice']);
  assert.ok(dossierGaps({ role: '反派', secret: 'x', desire: 'a', fear: 'b', contradiction: 'c', voice: { fingerprint: 'y' }, relationLevel: 2, plan: 'p', baseline: 'q' }).length === 0,
    '补齐之后不许再喊缺口');
});

test('档案 · 主角人味三项（6.14）缺哪项点哪项', () => {
  assert.deepEqual(humanFlawGaps({ name: '林晚' }).map((g) => g.key), ['habits', 'selfishMotive', 'errorPlan']);
  assert.deepEqual(humanFlawGaps({ humanFlaws: { habits: ['路痴'], selfishMotive: '买船', errorPlan: '误信商人' } }), []);
  assert.deepEqual(humanFlawGaps({ humanFlaws: { habits: [], selfishMotive: '买船', errorPlan: 'x' } }).map((g) => g.key), ['habits'], '空数组算缺');
});

test('档案 · 归属核对：notKnows 被说出=🔴，别人的秘密=🟡，登记过知情就不响', () => {
  const state = {
    protagonist: { name: '林晚', secret: '自己是被抱养的' },
    characters: TWO_CHARS.characters.reduce((acc, c) => ({ ...acc, [c.name]: c.patch }), {}),
  };
  const hot = ownershipCheck(state, '陈三说道：“玉佩是母亲的遗物，你以为我不知道？”');
  assert.equal(hot.issues.length, 1, JSON.stringify(hot.issues));
  assert.equal(hot.issues[0].level, 'error');
  assert.match(hot.issues[0].message, /归属核对（3\.6⑧）/);
  assert.match(hot.issues[0].message, /陈三/);

  const warm = ownershipCheck(state, '周伯冷笑道：“他是官府的眼线。”');
  assert.equal(warm.issues.length, 1);
  assert.equal(warm.issues[0].level, 'warning', '别人的秘密由非主人说出口＝先提醒（他可能已知情）');
  assert.match(warm.issues[0].message, /陈三/);

  const okKnows = ownershipCheck(
    { ...state, characters: { ...state.characters, 周伯: { ...state.characters.周伯, knows: ['陈三是官府的眼线'] } } },
    '周伯冷笑道：“他是官府的眼线。”',
  );
  assert.equal(okKnows.issues.length, 0, `登记过知情就不该再响——噪音会让人关掉整个核对：${JSON.stringify(okKnows.issues)}`);

  const selfTalk = ownershipCheck(state, '陈三低声说：“我是官府的眼线，我早想走了。”');
  assert.equal(selfTalk.issues.length, 0, `自己的秘密自己说不算违规：${JSON.stringify(selfTalk.issues)}`);

  // 主角的秘密也受保护（主角不在 characters 里，最容易漏的就是这一路）
  const hero = ownershipCheck(state, '陈三凑近道：“其实你是被抱养的。”');
  assert.equal(hero.issues.length, 1, JSON.stringify(hero.issues));
  assert.equal(hero.issues[0].owner, '林晚');
  assert.equal(hero.issues[0].level, 'warning');

  assert.deepEqual(ownershipCheck(state, '').issues, [], '空正文不炸');
  assert.equal(ownershipCheck({ protagonist: {}, characters: {} }, '陈三说道：“玉佩。”').issues.length, 0);
});

/* ------------------------------------------------------------------ *
 * ② 落盘：走工具层，断言 state.json 的真实形状
 * ------------------------------------------------------------------ */

test('档案 · 提交后落盘只存非默认值，老卡形状不漂移', async () => {
  const { root, config } = await book();
  try {
    await commitDelta(root, config, 1, TWO_CHARS);
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'b1', FILES.state), 'utf8'));
    const ch = raw.characters.陈三;
    assert.equal(ch.secret, '他是官府的眼线');
    assert.equal(ch.relationLevel, 3, '「信任」要归一成 3 级');
    assert.deepEqual(ch.knows, ['林晚想要一匹快马']);
    assert.deepEqual(ch.voice, { fingerprint: '短句、爱反问' }, 'voice 存成对象，不拍平成字符串');
    // 只存非默认值：没写的键不许被撑出来
    for (const k of ['arcProgress', 'goal', 'trauma', 'desirePriority', 'mistaken']) {
      assert.equal(ch[k], undefined, `${k} 没写就不该出现在盘上`);
    }
    // 主角人味三项
    assert.deepEqual(raw.protagonist.humanFlaws.habits, ['路痴', '死要面子']);
    assert.equal(raw.protagonist.humanFlaws.selfishMotive, '想攒钱买条船出海');
    assert.equal(raw.protagonist.secret, '自己是被抱养的', '主角的档案也挂在 protagonist 上');

    // 老卡（一个新字段都没有）读出来不报错、也不硬凑缺口刷屏
    const legacy = { ...raw, characters: { 路人: { role: '路人', realm: '练气', location: '山下', firstChapter: 1, lastChapter: 1, notes: '' } } };
    fs.writeFileSync(path.join(root, 'b1', FILES.state), JSON.stringify(legacy, null, 2));
    const lines = dossierLines(legacy.characters.路人);
    assert.deepEqual(lines, [], '普通配角不吃 6.1 完整性，档案行该是空的');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('档案 · 信息表跨章累积、voice 深合并，坏值当场警告不静默吞', async () => {
  const { root, config } = await book();
  try {
    await commitDelta(root, config, 1, TWO_CHARS);
    const out = await commitDelta(root, config, 2, {
      characters: [{ name: '陈三', patch: { knows: ['周伯是内奸'], notKnows: ['林晚是被抱养的'], voice: { profanity: '情绪峰值才爆粗' }, relationLevel: '依赖', bad: 'x', desire: '活下去' } }],
      protagonist: { humanFlaws: { habits: ['挑食'], errorPlan: '第 30 章误信商人' } },
    });
    const card = stateOf(root).characters.陈三;
    assert.deepEqual(card.knows, ['林晚想要一匹快马', '周伯是内奸'], '每章新知道的事不该冲掉前面的');
    assert.deepEqual(card.notKnows, ['玉佩是母亲的遗物', '林晚是被抱养的']);
    assert.equal(card.voice.fingerprint, '短句、爱反问', 'voice 深合并不整份覆盖');
    assert.equal(card.voice.profanity, '情绪峰值才爆粗');
    assert.equal(card.relationLevel, 4, '3→4 级要覆盖写入，不是数组累积');
    assert.equal(card.bad, 'x', '未知键原样保留（不许吃作者的东西）');
    assert.deepEqual(stateOf(root).protagonist.humanFlaws.habits, ['路痴', '死要面子', '挑食'], '小毛病也是累积的');
    assert.equal(stateOf(root).protagonist.humanFlaws.errorPlan, '第 30 章误信商人', '同一条重写＝覆盖');
    assert.doesNotMatch(out, /不是 1-5|必须是数组/, '这一笔全是合法形状，不该冒出档案警告');

    const bad = await commitDelta(root, config, 3, { characters: [{ name: '周伯', patch: { relationLevel: '九级', knows: '不是数组' } }] });
    assert.match(bad, /relationLevel="九级" 不是 1-5/);
    assert.match(bad, /knows 必须是数组/);
    assert.equal(stateOf(root).characters.周伯.relationLevel, undefined, '认不出来就不登记');

    const check = doctorCheck(path.join(root, 'b1'));
    assert.equal(check.ok, true, `体检必须全绿：${JSON.stringify(check.issues)}`);
    assert.deepEqual(check.issues.filter((i) => i.code.startsWith('replay')), [], '档案必须能从提交链重放还原');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * ③ 出口：review 红、status 缺口、任务书、query
 * ------------------------------------------------------------------ */

/**
 * 3.6⑧ 的三种情况各占一段，顺序不能换：
 * 先证明能红（不红的判据等于没有判据），再证明合法揭穿不响（乱响的判据作者会关掉）。
 */
test('档案 · 审查能红：说了他不知道的事=🔴，说出别人的秘密=🟡，登记过知情就不响', async () => {
  const { root, config } = await book();
  try {
    await commitDelta(root, config, 1, TWO_CHARS);

    // ① 陈三卡上登记「不知道玉佩是母亲的遗物」，这句话却由他亲口说出 → 硬错
    const blunder = '# 第一章\n陈三擦着刀，忽然道：“玉佩是母亲的遗物，你一直想知道。”\n';
    const r = await applyTool('webnovel_review', { bookId: 'b1', chapter: 1, text: blunder }, config);
    assert.match(r, /归属核对（3\.6⑧）/, `审查没抓到张冠李戴：\n${r}`);
    assert.match(r, /🔴/, 'notKnows 被说出要是硬错级（3.6⑧：说错人=设定崩塌，不是风格问题）');
    assert.match(r, /「陈三」不知道/, `要点名是谁说漏的：\n${r}`);

    // ② 陈三的秘密从周伯嘴里出来 → 🟡（低一档：作者完全可能安排反派就是知道）
    const leak = '# 第一章\n周伯冷笑道：“你以为我不知道？那姓陈的就是官府的眼线。”\n';
    const y = await applyTool('webnovel_review', { bookId: 'b1', chapter: 1, text: leak }, config);
    assert.match(y, /归属核对（3\.6⑧）/, `别人的秘密被非主人说出，没抓到：\n${y}`);
    assert.match(y, /「陈三」的秘密/, `要说清这秘密是谁的：\n${y}`);
    assert.ok(!/🔴.*归属核对/.test(y), '「反派可能就是知情者」不能判成硬错，只能提醒');

    // ③ 给周伯登记 knows 之后，同一句一字不改再审，就不许再响（判据不吵才有人信）
    await commitDelta(root, config, 1, { characters: [{ name: '周伯', patch: { knows: ['陈三是官府的眼线'] } }] });
    const ok = await applyTool('webnovel_review', { bookId: 'b1', chapter: 1, text: leak }, config);
    assert.doesNotMatch(ok, /归属核对（3\.6⑧）：「官府/, `登记过知情还报＝噪音：\n${ok}`);

    // ④ 说话人判定不出来时整条核对必须沉默（宁可漏报不误伤）
    const anon = await applyTool('webnovel_review', { bookId: 'b1', chapter: 1, text: '# 第一章\n旁边有人道：“玉佩是母亲的遗物。”\n' }, config);
    assert.doesNotMatch(anon, /归属核对/, '泛称说话人不许猜人');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('档案 · 审查红到提交：不带 force 时归属核对拦住 commit', async () => {
  const { root, config } = await book();
  try {
    await commitDelta(root, config, 1, TWO_CHARS);
    fs.mkdirSync(path.join(root, 'b1', '正文'), { recursive: true });
    fs.writeFileSync(path.join(root, 'b1', '正文', '第0002章.md'), '# 第二章\n陈三说道：“玉佩是母亲的遗物。”\n');
    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_chapter', chapter: 2, text: '# 第二章\n- 场景：客栈\n- 目标：试探\n- 钩子：门外有脚步声\n',
    }, config);
    const reviewed = await applyTool('webnovel_review', { bookId: 'b1', chapter: 2 }, config);
    assert.match(reviewed, /归属核对/);
    await assert.rejects(
      () => applyTool('webnovel_commit', { bookId: 'b1', chapter: 2, title: '第二章', summary: '试探' }, config),
      /归属核对|审查/,
      '有 🔴 的章节默认不许提交（L0 客户端没有钩子，服务器是唯一能设门的地方）',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('档案 · status 报缺口与主角人味，任务书带「还不知道」铁律', async () => {
  const { root, config } = await book();
  try {
    await commitDelta(root, config, 1, TWO_CHARS);
    const status = await applyTool('webnovel_status', { bookId: 'b1' }, config);
    assert.match(status, /人物档案：主要 2 人/, `status 没带档案行：\n${status.slice(0, 500)}`);
    assert.match(status, /缺口 \d+ 处/);
    assert.match(status, /信息表 2 条/, '信息表条目数要在档案行里');
    assert.match(status, /补齐主要人物档案/, '缺口要变成一条能照着做的待办');
    assert.ok(stateOf(root).characters.周伯.secret, '周伯的秘密登记过');

    await applyTool('webnovel_outline', {
      bookId: 'b1', action: 'write_chapter', chapter: 2, text: '# 第二章\n- 场景：客栈\n- 目标：试探\n- 钩子：门外有脚步声\n',
    }, config);
    const brief = await applyTool('webnovel_context', { bookId: 'b1', chapter: 2 }, config);
    assert.match(brief, /主要人物档案（第六节/);
    assert.match(brief, /还不知道.*玉佩是母亲的遗物/);
    assert.match(brief, /3\.6⑧/);
    assert.match(brief, /语言指纹：短句、爱反问/);
    assert.match(brief, /秘密：他是官府的眼线/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('档案 · query 角色卡展示三维/语言指纹/信息表，主角卡带人味', async () => {
  const { root, config } = await book();
  try {
    await commitDelta(root, config, 1, TWO_CHARS);
    const card = await applyTool('webnovel_query', { bookId: 'b1', kind: 'character', name: '陈三' }, config);
    for (const needle of ['最想要的', '最怕的', '秘密', '内在矛盾', '语言指纹', '关系推进级：3/5', '不知道：玉佩是母亲的遗物']) {
      assert.match(card, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `卡上少了「${needle}」：\n${card}`);
    }
    const hero = await applyTool('webnovel_query', { bookId: 'b1', kind: 'character', name: '林晚' }, config);
    assert.match(hero, /三个小毛病：路痴、死要面子/);
    assert.match(hero, /一个私心：想攒钱买条船出海/);
    assert.match(hero, /犯错预案：第 30 章误信商人/);
    assert.match(hero, /秘密（6\.1 隐藏层）：自己是被抱养的/);
    assert.match(hero, /语言指纹（遮名能认出是谁）：长句铺垫/);
    // 6.12 五级是「他与主角」的距离：主角跟自己没有这一级，报这个缺口是逼作者填假字段
    assert.doesNotMatch(hero, /档案缺口：关系推进级/, `主角卡上冒出「关系推进级」缺口：\n${hero}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('档案 · 没建过档案的老书：查询/状态/审查都不报错，也不硬凑档案行', async () => {
  const { root, config } = await book();
  try {
    await commitDelta(root, config, 1, { characters: [{ name: '老王', patch: { role: '店主', location: '镇上' } }] });
    const card = await applyTool('webnovel_query', { bookId: 'b1', kind: 'character', name: '老王' }, config);
    assert.match(card, /境界：未记录/);
    assert.doesNotMatch(card, /档案缺口/);
    const status = await applyTool('webnovel_status', { bookId: 'b1' }, config);
    assert.doesNotMatch(status, /人物档案：/, '一本主要人物都没有的书，不该占 status 一行');
    assert.match(status, /填主角人味三项/, '6.14 的待办要按缺口点名（这本书主角三项全空）');
    const r = await applyTool('webnovel_review', { bookId: 'b1', chapter: 1, text: '# 第一章\n老王道：“住店三文钱。”\n' }, config);
    assert.doesNotMatch(r, /归属核对/);
    assert.equal(doctorCheck(path.join(root, 'b1')).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
