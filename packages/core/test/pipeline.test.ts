/**
 * 端到端集成测试：候选召回 → 知乎搜索 → 邻域 → 跨邻域 IDF → 判定。
 * 用一份自带的最小 fixture（3 个概念），与 bench/ 的大语料无关，
 * 保证核心链路在任何环境下都可独立验证。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, analyzeLexicalOnly, FixtureSearchTransport, ZhihuSearchClient } from '../src/index.ts';
import type { ZhihuSearchItem, ZhihuSearchResponse } from '../src/index.ts';

let seq = 1;
const it = (Title: string, ContentText: string, RankingScore: number): ZhihuSearchItem => ({
  Title,
  ContentType: 'Answer',
  ContentID: String(1000000 + seq++),
  ContentText,
  Url: `https://www.zhihu.com/answer/${1000000 + seq}`,
  CommentCount: 5,
  VoteUpCount: 300,
  AuthorName: '答主',
  AuthorAvatar: '',
  AuthorBadge: '',
  AuthorBadgeText: '',
  EditTime: 1750000000,
  CommentInfoList: [],
  AuthorityLevel: '2',
  RankingScore,
});

const resp = (items: ZhihuSearchItem[]): ZhihuSearchResponse => ({
  Code: 0,
  Message: 'success',
  Data: { HasMore: false, SearchHashId: 'test', Items: items },
});

/**
 * 三个邻域刻意共享「女性/男性/约会/外貌」这组表层词——真实知乎语料就是这样，
 * 相亲场景同时出现在社恐讨论和性别讨论里。测试要验证的正是：
 * 共享词被 IDF 中和后，独特词能否把归属拉回正确的一侧。
 */
const FIXTURES: Record<string, ZhihuSearchResponse> = {
  社交焦虑: resp([
    it('相亲的时候紧张到说不出话是什么体验', '和异性约会时手心冒汗、心跳加快，一直在想对方是不是在打量我的外貌，怕冷场，怕说错话。事后反复回放整个过程，越想越尴尬，只想回避下一次。', 0.97),
    it('社恐的人怎么熬过饭局', '人多我就紧张，不敢主动搭话，别人看我一眼我就觉得在被评价。女性男性都一样，跟性别没关系，是我自己怕出丑。', 0.93),
    it('为什么见陌生人会脸红手抖', '紧张反应、回避眼神、心跳加速都是身体信号，核心是害怕被负面评价，跟约会外貌这些具体场景无关。', 0.88),
    it('我在聚会上总是插不上话', '每次都要在心里排练很久才敢开口，说完又后悔。回避社交不是不想去，是怕被笑话。', 0.82),
  ]),
  性别议题: resp([
    it('如何看待相亲市场对女性外貌的要求', '相亲市场对女性的外貌要求明显高于男性，这背后是结构性的不平等：性别角色分工、话语权分配、彩礼制度都在强化它。', 0.96),
    it('职场中的性别歧视有多普遍', '女性在晋升上面临结构性障碍，男性同事更容易拿到机会。这是权利和资源分配问题，不是个人能力问题。', 0.91),
    it('彩礼争议背后的性别结构', '彩礼反映婚姻中权利义务的不对等，女性与男性承担的社会期待并不对称，是典型的结构性议题。', 0.86),
    it('为什么说双标是性别讨论的核心', '同样的行为放在女性和男性身上评价完全不同，这种双标正是性别不平等在日常生活里的体现。', 0.80),
  ]),
  亲密关系: resp([
    it('情侣之间怎么好好吵架', '伴侣相处最难的是表达需求。我和男朋友吵架多半是因为没说清楚期待，而不是谁对谁错。', 0.95),
    it('恋爱三年后我们决定分手', '感情走到后期，约会变成例行公事。我们都还爱对方，但相处方式已经消耗掉了彼此。', 0.90),
    it('结婚前应该聊清楚哪些事', '和对象把钱、家务、边界感聊透，比谈外貌和浪漫重要得多。', 0.84),
  ]),
};

// 一篇表层充满性别词、真正在讲社交焦虑的文章
const TRAP_TITLE = '为什么我一见到异性就完全说不出话';
const TRAP_TEXT = [
  '相亲这件事我已经被安排了七八次。每次对面坐着一个女性，我就说不出话。',
  '女性朋友说我条件不差，男性朋友说我想太多。可只要是异性，只要涉及外貌评价，',
  '我整个人就僵住。女性看我一眼，我脑子里就开始跑：她是不是觉得我长得不行？',
  '男性在相亲里好像天然要主动，可我连开场白都要在心里排练很久。',
  '约会前我会照很久镜子，约会时我一直在猜对方怎么看我，约会后我反复回放',
  '刚才哪句话说错了，会不会被当成笑话。外貌、身高、收入这些女性会看重的条件，',
  '我一条条对照自己。异性面前我手心冒汗，可同性朋友面前我话很多。',
  '女性、男性、约会、外貌——这些词填满了我最近所有的对话，但真正让我睡不着的',
  '不是这些，是我怕在任何人面前出丑。人多的场合我只想躲开。',
].join('');

describe('端到端：表层关键词陷阱', () => {
  test('Baseline A 被表层词带偏，判成性别议题', () => {
    const r = analyzeLexicalOnly({ url: 'https://www.zhihu.com/answer/1', type: 'answer', title: TRAP_TITLE, text: TRAP_TEXT });
    assert.equal(r.concepts[0]?.label, '性别议题', `实际：${r.concepts.map((c) => c.label).join(',')}`);
  });

  test('System 经知乎 Grounding 后修正为社交焦虑', async () => {
    const client = new ZhihuSearchClient(new FixtureSearchTransport(FIXTURES));
    const r = await analyze(
      { url: 'https://www.zhihu.com/answer/1', type: 'answer', title: TRAP_TITLE, text: TRAP_TEXT },
      client,
      { debug: true },
    );
    assert.equal(r.status, 'grounded');
    assert.equal(r.concepts[0]?.label, '社交焦虑', `实际：${JSON.stringify(r.debug?.scores)}`);
  });

  test('性别议题被明确拒绝，且给得出理由', async () => {
    const client = new ZhihuSearchClient(new FixtureSearchTransport(FIXTURES));
    const r = await analyze({ url: 'https://www.zhihu.com/answer/1', type: 'answer', title: TRAP_TITLE, text: TRAP_TEXT }, client);
    const rej = r.rejected.find((x) => x.label === '性别议题');
    assert.ok(rej, '性别议题应出现在 rejected 中');
    assert.ok(rej!.reason.includes('表层词'), `理由未说明表层词问题：${rej!.reason}`);
  });

  test('判别依据不含另一候选的特征词，且不输出碎片', async () => {
    const client = new ZhihuSearchClient(new FixtureSearchTransport(FIXTURES));
    const r = await analyze({ url: 'https://www.zhihu.com/answer/1', type: 'answer', title: TRAP_TITLE, text: TRAP_TEXT }, client, { debug: true });
    const terms = r.debug!.discriminativeTerms.find((d) => d.label === '社交焦虑')!.terms;
    const joined = terms.join('');

    // 机制保证的核心断言：判定为社交焦虑的依据里，
    // 绝不能是性别议题邻域的特征词。这正是跨邻域 IDF 要做到的事。
    assert.ok(
      !/女性|男性|性别|彩礼|结构|歧视|双标|权利/.test(joined),
      `社交焦虑的判别依据里混入了性别议题特征词：${terms.join('、')}`,
    );

    // 展示层不得输出共享汉字的碎片（说不 / 不出 / 出话 只能留一个）
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) {
        const shared = [...terms[i]].some((c) => terms[j].includes(c));
        assert.ok(!shared, `展示了共享字的碎片：${terms[i]} / ${terms[j]}`);
      }
    }
    assert.ok(terms.length >= 4, `判别依据太少，无法向用户解释：${terms.join('、')}`);
  });

  test('上游调用量以概念表大小封顶，且第二篇完全命中缓存', async () => {
    const client = new ZhihuSearchClient(new FixtureSearchTransport(FIXTURES));
    const a = { url: 'https://www.zhihu.com/answer/1', type: 'answer' as const, title: TRAP_TITLE, text: TRAP_TEXT };
    const b = { url: 'https://www.zhihu.com/answer/2', type: 'answer' as const, title: '另一篇完全不同的文章', text: TRAP_TEXT };

    await analyze(a, client);
    const first = client.upstreamCalls;
    await analyze(b, client);

    assert.equal(client.upstreamCalls, first, '第二篇应完全命中缓存——这正是额度能撑住的原因');
    // 语料召回会遍历概念表，但概念表是固定的，所以上游用量与文章数无关
    assert.ok(first <= 31, `上游调用 ${first} 次，超过概念表大小`);
  });
});
