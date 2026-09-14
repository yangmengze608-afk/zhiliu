import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDistribution,
  concentration,
  MIN_SAMPLES,
  tokenize,
  canonicalize,
  extractCandidates,
  buildNeighborhood,
  groundCandidates,
  adjudicate,
  FixtureSearchTransport,
  ZhihuSearchClient,
  analyze,
  analyzeLexicalOnly,
  MAX_COUNT,
} from '../src/index.ts';
import type { ReadingRecord, ZhihuSearchItem } from '../src/index.ts';

const rec = (id: string, labels: string[]): ReadingRecord => ({
  id,
  url: `https://www.zhihu.com/answer/${id}`,
  title: `t-${id}`,
  readAt: Number(id.replace(/\D/g, '') || 0),
  concepts: labels.map((l) => ({ label: l, confidence: 0.8 })),
  analysisStatus: 'grounded',
});

describe('tokenize', () => {
  test('产出 unigram 与 bigram，并保留 ASCII 整词', () => {
    const t = tokenize('我在学习AI模型');
    assert.ok(t.includes('学习'));
    assert.ok(t.includes('模型'));
    assert.ok(t.includes('ai'));
  });

  test('不跨非中文边界拼出假 bigram', () => {
    const t = tokenize('稳定。就业');
    assert.ok(!t.includes('定就'));
  });
});

describe('canonicalize — 同义标签合并', () => {
  test('工作稳定/职业稳定性/稳定就业/体制稳定 都折叠到「稳定」', () => {
    for (const alias of ['工作稳定', '职业稳定性', '稳定就业', '体制稳定', '稳定']) {
      assert.equal(canonicalize(alias), '稳定', `${alias} 未正确合并`);
    }
  });

  test('不认识的标签返回 null，而不是硬造一个概念', () => {
    assert.equal(canonicalize('量子纠缠'), null);
  });
});

// 旧的集中度用例已迁移到 concentration-properties.test.ts。
// 那里用性质测试（A–G）覆盖，包括这一版专门修掉的样本量依赖，
// 保留两套断言只会互相打架。

// 趋势用例见 aggregate.test.ts —— 趋势计算已从 concentration.ts 移到 aggregate.ts，
// 且语义从「权重占比」改成了「文章出现率」。

// ---- Grounding 机制的核心断言 ----

const item = (title: string, body: string, rank: number): ZhihuSearchItem => ({
  Title: title,
  ContentType: 'Answer',
  ContentID: String(Math.floor(Math.random() * 1e12)),
  ContentText: body,
  Url: 'https://www.zhihu.com/answer/1',
  CommentCount: 3,
  VoteUpCount: 100,
  AuthorName: '答主',
  AuthorAvatar: '',
  AuthorBadge: '',
  AuthorBadgeText: '',
  EditTime: 1700000000,
  CommentInfoList: [],
  AuthorityLevel: '2',
  RankingScore: rank,
});

describe('grounding — 跨邻域 IDF 压制共享表层词', () => {
  // 两个邻域共享「女性/男性/约会/外貌」，但各自的独特词不同
  const anxiety = [
    item('相亲时紧张到说不出话是什么体验', '每次和异性约会都手心冒汗，心跳很快，一直在想对方怎么看我的外貌，害怕冷场，事后反复回放，越想越尴尬，只想回避这种场合。女性男性都一样。', 0.95),
    item('社恐在聚会上怎么办', '人多的场合我就紧张，不敢主动搭话，怕说错话被笑话，回避眼神，心跳加速，事后自责很久。约会更严重。', 0.9),
    item('为什么见陌生人会手心冒汗', '这是典型的紧张反应，回避、脸红、心跳都是身体信号，核心是害怕被别人评价。', 0.85),
  ];
  const gender = [
    item('如何看待相亲市场对女性外貌的要求', '相亲市场上对女性的外貌要求明显高于男性，这是一种结构性的不平等，背后是性别角色分工与话语权分配。彩礼和约会成本也体现了这一点。', 0.95),
    item('职场中的性别歧视有多普遍', '女性在晋升上面临结构性障碍，男性同事更容易获得机会，这是权利与资源分配问题，不是个人能力问题。', 0.9),
    item('彩礼争议背后的性别结构', '彩礼制度反映了婚姻中的权利义务分配，女性与男性承担的社会期待并不对等，属于结构性议题。', 0.85),
  ];

  const candidates = [
    { label: '社交焦虑', query: '社交焦虑', lexicalScore: 3, evidence: [], surfaceKeywordRisk: false },
    { label: '性别议题', query: '性别议题', lexicalScore: 9, evidence: [], surfaceKeywordRisk: true },
  ];

  const nbs = [
    buildNeighborhood('社交焦虑', '社交焦虑', anxiety),
    buildNeighborhood('性别议题', '性别议题', gender),
  ];

  // 一篇表层充满「女性/男性/约会/外貌」但真正谈紧张与怕被评价的文章
  const title = '为什么我一见到异性就说不出话';
  const text =
    '每次和女性约会我都紧张。对面的女性看我一眼，我就觉得她在打量我的外貌。' +
    '男性朋友说我想多了，可我控制不住。约会时我手心冒汗、心跳很快，怕冷场，' +
    '怕说错话被笑话。女性、男性、约会、外貌这些事本身我不在意，我在意的是' +
    '别人怎么看我。事后我会反复回放，越想越尴尬，只想回避下一次约会。' +
    '和异性说话前我要在心里排练很久，还是会脸红。';

  test('表层词面让「性别议题」召回分更高', () => {
    assert.ok(candidates[1].lexicalScore > candidates[0].lexicalScore);
  });

  test('经过知乎邻域 Grounding 后，「社交焦虑」反超「性别议题」', () => {
    const scores = groundCandidates(title, text, candidates, nbs);
    assert.equal(scores[0].label, '社交焦虑', `实际排序: ${scores.map((s) => `${s.label}=${s.raw.toFixed(4)}`).join(', ')}`);
  });

  test('判别性词汇里应出现紧张/回避类词，而不是女性/男性', () => {
    const scores = groundCandidates(title, text, candidates, nbs);
    const top = scores[0].topTerms.join('');
    assert.ok(/紧张|回避|冒汗|心跳|尴尬|脸红|笑话/.test(top), `topTerms=${scores[0].topTerms.join(',')}`);
  });

  test('单个邻域时不产生可信判别（调用方应降级为 ungrounded）', () => {
    const scores = groundCandidates(title, text, candidates, [nbs[0]]);
    assert.equal(scores.length, 1);
  });
});

describe('adjudicate — 允许不确定', () => {
  const mk = (label: string, normalized: number) => ({
    label,
    raw: normalized,
    normalized,
    topTerms: ['a', 'b'],
    neighborhoodSize: 8,
  });

  test('Top1 与 Top2 非常接近时标记 ambiguous，不强行二选一', () => {
    const a = adjudicate([mk('社交焦虑', 0.46), mk('亲密关系', 0.42), mk('性别议题', 0.12)]);
    assert.equal(a.status, 'ambiguous');
    assert.equal(a.concepts.length, 2);
  });

  test('没有候选贴合时输出 unknown 且不产出任何概念', () => {
    const a = adjudicate([mk('AI', 0.26), mk('编程', 0.25), mk('自动化', 0.25), mk('风险', 0.24)]);
    assert.equal(a.status, 'unknown');
    assert.equal(a.concepts.length, 0);
  });

  test('优势明显时输出 confident 且保留被拒绝候选的理由', () => {
    const a = adjudicate([mk('稳定', 0.7), mk('就业', 0.2), mk('风险', 0.1)]);
    assert.equal(a.status, 'confident');
    assert.equal(a.concepts[0].label, '稳定');
    assert.ok(a.rejected.length >= 1);
    assert.ok(a.rejected[0].reason.length > 0);
  });

  test('空输入不崩溃，返回 unknown', () => {
    assert.equal(adjudicate([]).status, 'unknown');
  });
});

describe('ZhihuSearchClient', () => {
  const fixtures = {
    社交焦虑: { Code: 0, Message: 'success', Data: { HasMore: false, Items: [item('a', 'b', 0.9)] } },
  };

  test('Count 不超过官方上限 10', () => {
    assert.equal(MAX_COUNT, 10);
  });

  test('24h 缓存命中不再打上游', async () => {
    const transport = new FixtureSearchTransport(fixtures as never);
    const client = new ZhihuSearchClient(transport);
    await client.neighborhoodItems('社交焦虑', 8);
    await client.neighborhoodItems('社交焦虑', 8);
    await client.neighborhoodItems('社交焦虑', 8);
    assert.equal(client.upstreamCalls, 1, '缓存未生效会直接打爆 1000 次/天 的额度');
  });

  test('fixture miss 返回空 Items 而不是抛错', async () => {
    const client = new ZhihuSearchClient(new FixtureSearchTransport(fixtures as never));
    const items = await client.neighborhoodItems('不存在的概念', 8);
    assert.deepEqual(items, []);
  });
});

describe('pipeline', () => {
  test('没有可比较的第二个邻域时降级为 ungrounded，不伪称已校准', async () => {
    const client = new ZhihuSearchClient(new FixtureSearchTransport({}));
    const r = await analyze(
      { url: 'https://www.zhihu.com/answer/1', type: 'answer', title: '考公上岸后我后悔了吗', text: '编制 稳定 考公 上岸 体制内 工资 找工作 面试'.repeat(8) },
      client,
    );
    assert.equal(r.status, 'ungrounded');
    assert.equal(r.concepts.length, 0);
  });

  test('Baseline A 直接采信词面排序', () => {
    const r = analyzeLexicalOnly({
      url: 'u',
      type: 'answer',
      title: '女性和男性在约会里的差异',
      text: '女性 男性 女生 男生 性别 女权 彩礼'.repeat(10),
    });
    assert.equal(r.status, 'ungrounded');
    assert.equal(r.concepts[0].label, '性别议题');
  });
});

// ---- 红队反例回归测试 ----

describe('信息集中度：红队反例回归', () => {
  const mk = (id: string, label: string): ReadingRecord => ({
    id,
    url: `https://www.zhihu.com/answer/${id}`,
    title: id,
    readAt: Number(id.replace(/\D/g, '') || 0),
    concepts: [{ label, confidence: 0.9 }],
    analysisStatus: 'grounded',
  });

  test('主概念占比相同的两组，读得更杂的那组分数必须更低', () => {
    const base = Array.from({ length: 16 }, (_, i) => mk(`a${i}`, '稳定'));
    // 两组主概念占比都是 80%，唯一区别是剩下 20% 的长尾有多长
    const narrow = [...base, ...Array.from({ length: 4 }, (_, i) => mk(`b${i}`, '就业'))];
    const wide = [...base, mk('c1', '就业'), mk('c2', '风险'), mk('c3', 'AI'), mk('c4', '房产')];

    const sn = concentration(buildDistribution(narrow, 20));
    const sw = concentration(buildDistribution(wide, 20));
    assert.equal(sn.state, 'ready');
    assert.equal(sw.state, 'ready');
    if (sn.state === 'ready' && sw.state === 'ready') {
      assert.ok(
        sw.score < sn.score,
        `读得更杂的一组(${sw.score})分数不应高于更集中的一组(${sn.score})——` +
          '这正是用观测 K 做分母时出现的反例',
      );
    }
  });

  test('归一化分母与窗口内实际概念数无关，保证跨窗口可比', () => {
    const two = Array.from({ length: 10 }, (_, i) => mk(`t${i}`, i % 2 ? '稳定' : '就业'));
    const five = Array.from({ length: 10 }, (_, i) => mk(`f${i}`, ['稳定', '就业', '风险', 'AI', '房产'][i % 5]));
    const s2 = concentration(buildDistribution(two, 20));
    const s5 = concentration(buildDistribution(five, 20));
    // 两者都是各概念均匀分布，但概念数不同；分数必须体现"5 个更分散"
    if (s2.state === 'ready' && s5.state === 'ready') {
      assert.ok(s5.score < s2.score, `均匀分布下 5 概念(${s5.score}) 应比 2 概念(${s2.score}) 更分散`);
    }
  });
});

describe('grounding：自指抑制只作用于候选自己', () => {
  test('「紧张」不因别名「社交紧张」而在其他候选的判别中被删除', () => {
    // 回归红队发现的缺陷：原实现把所有候选的词面并成全局黑名单，
    // 导致判定任何候选时「紧张」都被删掉，而它是社交焦虑最强的证据之一。
    const anx = [
      { Title: '面试前紧张到失眠', ContentType: 'Answer', ContentID: '1', ContentText: '一紧张就手抖，越想越紧张，紧张到胃疼。', Url: 'u', CommentCount: 0, VoteUpCount: 1, AuthorName: 'a', AuthorAvatar: '', AuthorBadge: '', AuthorBadgeText: '', EditTime: 1, CommentInfoList: [], AuthorityLevel: '2', RankingScore: 0.9 },
      { Title: '怎么缓解紧张', ContentType: 'Answer', ContentID: '2', ContentText: '紧张是正常反应，紧张时深呼吸。', Url: 'u', CommentCount: 0, VoteUpCount: 1, AuthorName: 'a', AuthorAvatar: '', AuthorBadge: '', AuthorBadgeText: '', EditTime: 1, CommentInfoList: [], AuthorityLevel: '2', RankingScore: 0.8 },
    ];
    const other = [
      { Title: '房价走势', ContentType: 'Article', ContentID: '3', ContentText: '首付比例与月供压力。', Url: 'u', CommentCount: 0, VoteUpCount: 1, AuthorName: 'a', AuthorAvatar: '', AuthorBadge: '', AuthorBadgeText: '', EditTime: 1, CommentInfoList: [], AuthorityLevel: '2', RankingScore: 0.9 },
    ];
    const nbs = [
      buildNeighborhood('社交焦虑', '社交焦虑', anx as never),
      buildNeighborhood('房产', '房产', other as never),
    ];
    const cands = [
      { label: '社交焦虑', query: '社交焦虑', lexicalScore: 1, evidence: [], surfaceKeywordRisk: false },
      { label: '房产', query: '房产', lexicalScore: 1, evidence: [], surfaceKeywordRisk: false },
    ];
    const scores = groundCandidates('面试', '我一到面试就紧张，紧张得说不出话。', cands, nbs);
    assert.equal(scores[0].label, '社交焦虑');
    assert.ok(scores[0].raw > 0, '「紧张」被误删会让证据归零');
  });
});
