/**
 * 异步分析的并发与乱序测试。
 *
 * 这一轮把分析从"阻塞式 await"改成了"占位 → 后台跑 → 回填"。
 * 这个改动引入的所有新失效模式都必须在这里被钉死，因为它们**全都是静默的**：
 * 乱序回填不会报错，它只会让面板显示一个属于别的文章的概念。
 *
 * 用真实的 `requestAnalysis` 路径（打桩 `fetch`），不是打桩分析函数本身——
 * 否则 provenance 校验、超时、错误传播这几条一条都测不到。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../extension/src/shared/config.ts';

type Listener = (msg: any, sender: unknown, send: (r: unknown) => void) => boolean | void;
const store: Record<string, unknown> = {};
let listener: Listener | null = null;

(globalThis as any).chrome = {
  storage: { local: {
    get: async (k: any) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
    set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
  } },
  runtime: { onMessage: { addListener: (cb: Listener) => { listener = cb; } } },
};

/** 每个 contentId 一个可控的"什么时候返回、返回什么"。 */
const pending = new Map<string, { resolve: (v: unknown) => void; concept: string }>();
let served = 0;

(globalThis as any).fetch = async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  // contentId 可能相同（回答与专栏文章同号），所以桩键上带 contentType 前缀
  const raw = String(body.contentId);
  const id = pending.has(raw) ? raw : `${body.contentType === 'article' ? 'p' : 'a'}${raw}`;
  const entry = pending.get(id);
  if (!entry) throw new Error(`未预置 ${id} 的响应`);
  served += 1;
  await new Promise((r) => entry.resolve = r as any); // 挂起，等测试显式放行
  return {
    ok: true,
    json: async () => ({
      concepts: [{ canonical: entry.concept, confidence: 0.9 }],
      ambiguous: false,
      status: 'llm',
      provenance: { provider: 'fake', model: `m-${id}`, promptVersion: 'vX' },
    }),
  };
};

/** 预置一篇文章的应答，返回一个"现在放行"的函数。 */
function arm(id: string, concept: string): () => void {
  const e = { resolve: (() => {}) as (v: unknown) => void, concept };
  pending.set(id, e);
  return () => e.resolve(undefined);
}

const send = (msg: unknown): Promise<any> => new Promise((res) => listener!(msg, null, res));
const article = (n: number) => ({
  url: `https://www.zhihu.com/answer/${n}`, contentId: String(n), type: 'answer' as const,
  title: `文章 ${n}`, text: '正文'.repeat(80), duration: 9000, confidence: 'high',
});
const idle = () => send({ type: 'AWAIT_IDLE' });
/** 本地 id 带命名空间前缀（红队 F7），回答页是 `a` + contentId。 */
const lid = (n: number | string) => `a${n}`;
const events = async (): Promise<any[]> => (store['zhiliu.events.v2'] as any[]) ?? [];

(CONFIG as any).ANALYZE_ENDPOINT = 'http://127.0.0.1:1/analyze';
await import('../../extension/src/background/service-worker.ts');
assert.ok(listener);

describe('分析不阻塞浏览', () => {
  test('READING_QUALIFIED 在模型返回之前就回来了', async () => {
    const go = arm('1', '就业');
    const t0 = Date.now();
    const view = await send({ type: 'READING_QUALIFIED', content: article(1) });
    const elapsed = Date.now() - t0;

    // 模型还挂着没返回，但消息已经回了
    assert.ok(elapsed < 200, `上报被阻塞了 ${elapsed}ms`);
    assert.equal(view.analyzingCount, 1, '面板应显示 1 篇分析中');
    assert.equal(view.sampleCount, 0, '还没出结果，不该有统计样本');

    go();
    await idle();
    const after = await send({ type: 'GET_VIEW' });
    assert.equal(after.analyzingCount, 0);
    assert.equal(after.sampleCount, 1);
    assert.equal(after.concepts[0].label, '就业');
  });
});

describe('乱序完成', () => {
  test('三篇乱序返回，每条结果都落在自己那篇上', async () => {
    const goA = arm('11', '就业'); const goB = arm('12', '睡眠'); const goC = arm('13', '房产');
    await send({ type: 'READING_QUALIFIED', content: article(11) });
    await send({ type: 'READING_QUALIFIED', content: article(12) });
    await send({ type: 'READING_QUALIFIED', content: article(13) });

    // 完成顺序 C → A → B，和发起顺序完全相反/交错
    goC(); goA(); goB();
    await idle();

    const evs = await events();
    const byId = new Map(evs.map((e) => [e.id, e]));
    assert.equal(byId.get(lid(11))!.concepts[0].canonical, '就业');
    assert.equal(byId.get(lid(12))!.concepts[0].canonical, '睡眠');
    assert.equal(byId.get(lid(13))!.concepts[0].canonical, '房产');
    // provenance 也必须跟着各自的结果，不能串
    assert.equal(byId.get(lid(12))!.analysis.model, 'm-12');
  });

  test('回填保留占位时的 timestamp，慢分析不会把文章插到最前面', async () => {
    const goSlow = arm('21', '就业'); const goFast = arm('22', '睡眠');
    await send({ type: 'READING_QUALIFIED', content: article(21) });
    const tsSlow = (await events()).find((e) => e.id === lid(21))!.timestamp;
    await new Promise((r) => setTimeout(r, 5));
    await send({ type: 'READING_QUALIFIED', content: article(22) });

    goFast(); await new Promise((r) => setTimeout(r, 5)); goSlow();
    await idle();

    const evs = await events();
    assert.equal(evs.find((e) => e.id === lid(21))!.timestamp, tsSlow, '慢分析把阅读时刻改成了回填时刻');
    assert.ok(evs.find((e) => e.id === lid(21))!.timestamp < evs.find((e) => e.id === lid(22))!.timestamp);
  });
});

describe('迟到的结果不得污染历史', () => {
  test('占位记录已被清掉时，迟到的分析结果被丢弃而不是 push 回去', async () => {
    const go = arm('31', '就业');
    await send({ type: 'READING_QUALIFIED', content: article(31) });
    assert.ok((await events()).some((e) => e.id === lid(31)));

    // 模拟"用户在分析途中清掉了历史"（关演示模式 / 记录被淘汰都是这个形态）
    store['zhiliu.events.v2'] = ((store['zhiliu.events.v2'] as any[]) ?? []).filter((e) => e.id !== lid(31));

    go();
    await idle();
    assert.equal((await events()).filter((e) => e.id === lid(31)).length, 0, '被删掉的记录被迟到的结果复活了');
  });
});

describe('同一内容不重复分析', () => {
  test('两个标签页同时读同一篇：只发一次请求、只入库一条', async () => {
    served = 0;
    const go = arm('41', '就业');
    await Promise.all([
      send({ type: 'READING_QUALIFIED', content: article(41) }),
      send({ type: 'READING_QUALIFIED', content: article(41) }),
    ]);
    go();
    await idle();
    assert.equal(served, 1, `同一篇发了 ${served} 次分析请求`);
    assert.equal((await events()).filter((e) => e.id === lid(41)).length, 1);
  });
});

describe('service worker 被回收后的残留占位', () => {
  test('超时未回填的占位会被改判为 failed，而不是永远显示"分析中"', async () => {
    // 直接写一条陈旧的占位记录，模拟 worker 在分析中途被回收
    store['zhiliu.events.v2'] = [
      ...((store['zhiliu.events.v2'] as any[]) ?? []),
      { id: '51', contentType: 'answer', title: '孤儿占位', concepts: [],
        timestamp: Date.now() - CONFIG.ANALYZE_TIMEOUT_MS * 10,
        duration: 9000, analysisStatus: 'ungrounded', analysisVersion: 'pending' },
    ];
    await send({ type: 'GET_VIEW' });
    const e = (await events()).find((x) => x.id === '51')!;
    assert.notEqual(e.analysisVersion, 'pending', '孤儿占位没有被回收');
    assert.equal(e.analysisStatus, 'failed');
  });
});

describe('多来源提示不得对正在分析中的记录报假警', () => {
  /**
   * 红队 F6：`analysisMix` 原本对 window（全部记录）算，
   * 而在途的占位记录 `analysisKey` 是 `'ungrounded'`。
   * 结果是**每读完一篇**，接下来十几秒面板都会指控自己
   * 「这 N 篇由 2 种分析来源混合产生（… / ungrounded）」——
   * 一个每次阅读都必然出现的假警报，会让这条真正重要的提示彻底失效。
   */
  test('有一篇在分析中时，不出现"多来源混合"提示', async () => {
    const go = arm('71', '就业');
    await send({ type: 'READING_QUALIFIED', content: article(71) });
    try {
      const during = await send({ type: 'GET_VIEW' });
      assert.ok(during.analyzingCount > 0, '前提：确实有在途分析');
      // 精确断言：在途的占位记录（analysisKey='ungrounded'）不得出现在出处清单里。
      // 不能断言"只有一种来源"——这个测试文件的假 provider 刻意给每篇不同的 model，
      // 好让"乱序不串"那条测试能验证 provenance 跟着各自的结果走。
      assert.ok(!during.analysisMix.some((m: any) => m.key === 'ungrounded'),
        `在途占位被算成了一种分析来源：${JSON.stringify(during.analysisMix)}`);
    } finally {
      // 必须放行，否则断言失败会留下一个永不 resolve 的请求，测试进程挂到超时
      go();
      await idle();
    }
  });

  test('真的混了两种来源时仍然提示', async () => {
    const evs = (store['zhiliu.events.v2'] as any[]);
    evs.push({
      id: 'old-1', contentType: 'answer', title: '旧模型打的标签', timestamp: Date.now(),
      duration: 9000, concepts: [{ canonical: '睡眠', confidence: 0.8 }],
      analysisStatus: 'llm', analysisVersion: 'llm-only-v1',
      analysis: { version: 'llm-only-v1', promptVersion: 'v1', provider: 'ollama', model: 'qwen2.5:3b' },
    });
    const v = await send({ type: 'GET_VIEW' });
    assert.ok(v.analysisMix.length >= 2, `该提示的时候没提示：${JSON.stringify(v.analysisMix)}`);
  });

  test('旧数据完全没有 analysis 字段时，也算作一种独立来源而不是静默并入', async () => {
    (store['zhiliu.events.v2'] as any[]).push({
      id: 'legacy-1', contentType: 'answer', title: '更早的记录', timestamp: Date.now(),
      duration: 9000, concepts: [{ canonical: '房产', confidence: 0.8 }],
      analysisStatus: 'llm', analysisVersion: 'llm-only-v1',
    });
    const v = await send({ type: 'GET_VIEW' });
    assert.ok(v.analysisMix.some((m: any) => m.key.includes('未记录出处')),
      `旧数据被静默并进了某个已知来源：${JSON.stringify(v.analysisMix)}`);
  });
});

describe('id 命名空间', () => {
  /**
   * 红队 F7：知乎的回答 id 和专栏文章 id 是两套独立编号，会撞。
   * 旧实现直接把 contentId 当本地 id，于是后读的那一篇被去重**静默丢弃**——
   * 用户确实读了，面板不记，也不报错。
   */
  test('同号的回答与专栏文章是两条记录，不会被去重吃掉', async () => {
    const goA = arm('a777', '就业'); const goP = arm('p777', '房产');
    // 注意 contentId 都是 777，只有域名不同
    await send({ type: 'READING_QUALIFIED', content: {
      url: 'https://www.zhihu.com/answer/777', contentId: '777', type: 'answer',
      title: '回答 777', text: '正文'.repeat(80), duration: 9000, confidence: 'high' } });
    await send({ type: 'READING_QUALIFIED', content: {
      url: 'https://zhuanlan.zhihu.com/p/777', contentId: '777', type: 'article',
      title: '文章 777', text: '正文'.repeat(80), duration: 9000, confidence: 'high' } });
    goA(); goP();
    await idle();
    const titles = (await events()).filter((e) => e.contentId === '777').map((e) => e.title).sort();
    assert.deepEqual(titles, ['回答 777', '文章 777'], '同号的回答和文章被当成同一篇');
  });
});

describe('低可信度 / 不支持的页面不入库、不发请求', () => {
  test('confidence=low 的页面不占位、不发请求', async () => {
    served = 0;
    const before = (await events()).length;
    await send({ type: 'READING_QUALIFIED', content: { ...article(61), confidence: 'low' } });
    await idle();
    assert.equal((await events()).length, before);
    assert.equal(served, 0);
  });

  /**
   * 端到端版本的 fail closed：真人在 /column-square 上抓到的那个 bug，
   * 最坏情况就是这条链路被走通。这里从 content script 的入口走一遍，
   * 确认 `/analyze` 一次都没被调用、history 一条都没多。
   */
  test('走完整链路：unsupported 页面既不发 /analyze 也不写 history', async () => {
    const { extractContent, isAnalyzable } = await import('../../extension/src/content/extract-content.ts');
    const { El, makeDocument } = await import('./dom-shim.ts');

    // 真人样本 3 的形态：main.App-main 里全是带 RichText 的推荐卡
    const cards = Array.from({ length: 10 }, (_, i) =>
      new El('div', 'ColumnItem').append(
        new El('div', 'RichText ztext').append(new El('p', '', `第 ${i} 张卡片摘要。`.repeat(12))),
      ));
    const doc = makeDocument(new El('body').append(new El('main', 'App-main').append(...cards)), '专栏广场 - 知乎');

    const c = extractContent(doc, 'https://www.zhihu.com/column-square');
    assert.equal(c.strategy, 'unsupported');
    assert.equal(isAnalyzable(c), false);

    served = 0;
    const before = (await events()).length;
    // 模拟"如果 content script 真的把它上报了"——service worker 也必须挡住
    await send({ type: 'READING_QUALIFIED', content: {
      url: c.url, contentId: c.contentId, type: c.type,
      title: c.title, text: c.text, confidence: c.confidence, duration: 9000,
    } });
    await idle();
    assert.equal(served, 0, `/analyze 被调用了 ${served} 次`);
    assert.equal((await events()).length, before, 'history 多了记录');
  });
});
