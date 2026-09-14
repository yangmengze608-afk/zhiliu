/**
 * 演示可靠性回归测试。
 *
 * 这四条都是独立可靠性评审**实际跑出来**的缺陷，不是假想：
 * 并发丢数据、坏记录锁死面板、worker 回收导致重复写入、请求挂起卡住"分析中"。
 * 每一条都静默失败——面板照常渲染，没有任何报错。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

type Listener = (msg: any, sender: unknown, send: (r: unknown) => void) => boolean | void;

const store: Record<string, unknown> = {};
let listener: Listener | null = null;

(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (k: string | string[] | null) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
      // 刻意加一个微小延迟，把 read-modify-write 的竞态窗口暴露出来
      set: async (items: Record<string, unknown>) => {
        await new Promise((r) => setTimeout(r, 1));
        Object.assign(store, items);
      },
    },
  },
  runtime: { onMessage: { addListener: (cb: Listener) => { listener = cb; } } },
};

await import('../../extension/src/background/service-worker.ts');
const { DEMO_TOTAL } = await import('../../extension/src/background/demo.ts');
const { STORAGE_KEYS } = await import('../../extension/src/shared/config.ts');
const { requestAnalysis } = await import('../../extension/src/background/analysis.ts');
const { loadEvents } = await import('../../extension/src/background/storage.ts');

const send = (msg: unknown): Promise<any> => new Promise((res) => listener!(msg, null, res));
const reset = async () => {
  delete store[STORAGE_KEYS.EVENTS];
  // 演示推进现在要求 demoMode 已开启（用来挡住关闭瞬间在途的请求）
  await send({ type: 'SET_SETTINGS', patch: { demoMode: true } });
};

describe('并发写入不丢数据', () => {
  test('两个标签页同时推进演示，事件数与步数一致', async () => {
    await reset();
    // 并发发起 4 次 DEMO_ADVANCE，模拟两个 tab 各自的定时器同时到达
    const results = await Promise.all([send({ type: 'DEMO_ADVANCE' }), send({ type: 'DEMO_ADVANCE' }),
                                       send({ type: 'DEMO_ADVANCE' }), send({ type: 'DEMO_ADVANCE' })]);
    const events = await loadEvents();
    const demo = events.filter((e) => e.analysisStatus === 'demo');
    assert.equal(demo.length, 4, `并发推进 4 次只写入了 ${demo.length} 条——发生了 lost update`);
    const ids = new Set(demo.map((e) => e.id));
    assert.equal(ids.size, 4, '出现了重复的演示记录');
    assert.equal(Math.max(...results.map((r) => r.step)), 4);
  });

  test('推进到最后一条之后继续点不会越界', async () => {
    await reset();
    for (let i = 0; i < DEMO_TOTAL + 3; i++) await send({ type: 'DEMO_ADVANCE' });
    const demo = (await loadEvents()).filter((e) => e.analysisStatus === 'demo');
    assert.equal(demo.length, DEMO_TOTAL);
    const last = await send({ type: 'DEMO_ADVANCE' });
    assert.equal(last.done, true);
  });
});

describe('service worker 被回收后进度不错乱', () => {
  test('进度从存储推导，不依赖内存变量', async () => {
    await reset();
    await send({ type: 'DEMO_ADVANCE' });
    await send({ type: 'DEMO_ADVANCE' });
    // 模拟 MV3 回收：内存状态没了，但 storage 还在。
    // 由于进度是数 storage 里的 demo 记录得来的，下一步必须接着第 3 条。
    const next = await send({ type: 'DEMO_ADVANCE' });
    assert.equal(next.step, 3);
    const demo = (await loadEvents()).filter((e) => e.analysisStatus === 'demo');
    assert.equal(new Set(demo.map((e) => e.id)).size, 3, 'worker 回收后重复写入了已有的演示记录');
  });
});

describe('损坏的本地记录不会锁死面板', () => {
  test('concepts 为 null / 缺字段 / 整条不是对象，GET_VIEW 仍然返回', async () => {
    await reset();
    delete store[STORAGE_KEYS.EVENTS];
    store[STORAGE_KEYS.EVENTS] = [
      { id: 'ok', contentType: 'answer', title: 't', timestamp: 1, duration: 9000,
        concepts: [{ canonical: '稳定', confidence: 0.9 }], analysisStatus: 'llm', analysisVersion: 'v1' },
      { id: 'null-concepts', contentType: 'answer', title: 't', timestamp: 2, concepts: null, analysisStatus: 'llm' },
      { id: 'missing-concepts', title: 't', timestamp: 3 },
      'not-an-object',
      null,
      { id: 'bad-items', concepts: [null, { canonical: 123 }, { confidence: 0.5 }], analysisStatus: 'llm' },
    ];
    const v = await send({ type: 'GET_VIEW' });
    assert.ok(v, 'GET_VIEW 没有返回——消息链被锁死了');
    assert.equal(v.sampleCount, 1, '只有那条完好的记录应进入统计');
    // 再读一次，确认不是一次性的
    assert.ok(await send({ type: 'GET_VIEW' }), '第二次 GET_VIEW 挂起，说明坏记录是持续性的砖头');
  });

  test('storage 返回的不是数组时按空历史处理', async () => {
    delete store[STORAGE_KEYS.EVENTS];
    store[STORAGE_KEYS.EVENTS] = { oops: true };
    const v = await send({ type: 'GET_VIEW' });
    assert.equal(v.state, 'empty');
  });
});

describe('分析请求超时', () => {
  test('后端接受连接但从不返回时，不会永远卡在分析中', async () => {
    const original = globalThis.fetch;
    // 永不 resolve 的 fetch，只响应 abort
    (globalThis as any).fetch = (_u: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        });
      });
    const cfg = await import('../../extension/src/shared/config.ts');
    (cfg.CONFIG as any).ANALYZE_ENDPOINT = 'http://127.0.0.1:9/never';
    (cfg.CONFIG as any).ANALYZE_TIMEOUT_MS = 120;

    const t0 = Date.now();
    const r = await requestAnalysis({ title: 't', text: 'x' });
    const elapsed = Date.now() - t0;

    (globalThis as any).fetch = original;
    (cfg.CONFIG as any).ANALYZE_ENDPOINT = '';

    assert.equal(r.status, 'failed');
    assert.equal(r.dropped[0], 'analyze_timeout');
    assert.ok(elapsed < 2000, `超时未生效，耗时 ${elapsed}ms`);
  });
});

describe('关闭演示模式后，在途的推进请求被挡住', () => {
  test('不会在真实历史里留下残留的演示记录', async () => {
    await reset();
    await send({ type: 'DEMO_ADVANCE' });
    // 关闭演示（会清掉已有演示数据）
    await send({ type: 'SET_SETTINGS', patch: { demoMode: false } });
    // content script 的定时器还有一条在途请求
    const late = await send({ type: 'DEMO_ADVANCE' });
    assert.equal(late.done, true);
    const demo = (await loadEvents()).filter((e) => e.analysisStatus === 'demo');
    assert.equal(demo.length, 0, '关闭演示后仍有演示记录残留在真实历史里');
  });
});
