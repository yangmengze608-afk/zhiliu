/**
 * Background service worker 集成测试。
 * 用假的 chrome.storage / chrome.runtime，验证「有效阅读 → 分析 → 写本地 → 聚合视图」整条路。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

type Listener = (msg: any, sender: unknown, send: (r: unknown) => void) => boolean | void;

const store: Record<string, unknown> = {};
let listener: Listener | null = null;

(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (keys: string | string[] | null) => {
        if (typeof keys === 'string') return { [keys]: store[keys] };
        return { ...store };
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      },
    },
  },
  runtime: {
    onMessage: { addListener: (cb: Listener) => { listener = cb; } },
  },
};

/**
 * 上报一次有效阅读，并等到后台分析落盘。
 *
 * 这一轮把分析改成了异步：`READING_QUALIFIED` 只占位就立刻返回，
 * 所以测试不能再假设"上报返回时概念已经写好了"。
 */
async function qualify(content: unknown): Promise<any> {
  await send({ type: 'READING_QUALIFIED', content });
  return send({ type: 'AWAIT_IDLE' });
}

/** 把 callback 风格的消息处理包成 Promise。 */
function send(msg: unknown): Promise<any> {
  return new Promise((resolve) => {
    listener!(msg, null, resolve);
  });
}

// 顶层 await：必须在 describe 注册之前完成导入，
// 放在 before() 里会让 describe 的子测试在 hook 完成前被取消。
await import('../../extension/src/background/service-worker.ts');
assert.ok(listener, 'service worker 未注册 onMessage 监听');

const article = (n: number) => ({
  url: `https://www.zhihu.com/answer/${n}`,
  contentId: String(n),
  type: 'answer' as const,
  title: `测试文章 ${n}`,
  text: '正文'.repeat(80),
  duration: 9000,
});

describe('service worker 端到端', () => {
  test('首次视图是空状态', async () => {
    const v = await send({ type: 'GET_VIEW' });
    assert.equal(v.state, 'empty');
    assert.equal(v.sampleCount, 0);
  });

  test('有效阅读会写入本地并更新视图', async () => {
    await qualify(article(1));
    const v = await send({ type: 'GET_VIEW' });
    assert.equal(v.sampleCount, 1);
    assert.equal(v.state, 'collecting');
    assert.ok(v.concepts.length > 0, '应产生概念');
  });

  test('同 URL 重复上报不会重复计入', async () => {
    const before = (await send({ type: 'GET_VIEW' })).sampleCount;
    await qualify(article(1));
    await qualify(article(1));
    const after = (await send({ type: 'GET_VIEW' })).sampleCount;
    assert.equal(after, before, '同 URL 在去重窗口内被重复计入');
  });

  test('积累到 10 篇后才出集中度分数（窗口固定，低于门槛不给假精确数字）', async () => {
    for (let i = 2; i <= 10; i++) await qualify(article(i));
    const v = await send({ type: 'GET_VIEW' });
    assert.equal(v.state, 'ready');
    assert.equal(v.concentration.state, 'ready');
    assert.ok(v.concentration.score >= 0 && v.concentration.score <= 100, `分数越界: ${v.concentration.score}`);
  });

  test('面板视图只给前 4 个概念（占比之和因此可以小于 1）', async () => {
    const v = await send({ type: 'GET_VIEW' });
    assert.ok(v.concepts.length <= 4, `面板收到 ${v.concepts.length} 个概念，超出展示上限`);
    const sum = v.concepts.reduce((s: number, c: any) => s + c.share, 0);
    assert.ok(sum > 0 && sum <= 1 + 1e-9, `占比和越界：${sum}`);
    // 「每篇总权重恒为 1」的完整断言在 core 的 aggregate.test.ts 里，
    // 那里拿得到未截断的分布。
  });

  test('设置可读可写并持久化', async () => {
    const d = await send({ type: 'GET_SETTINGS' });
    assert.equal(d.tintByConcentration, false);
    const next = await send({ type: 'SET_SETTINGS', patch: { tintByConcentration: true } });
    assert.equal(next.tintByConcentration, true);
    assert.equal((await send({ type: 'GET_SETTINGS' })).tintByConcentration, true);
  });

  test('未知消息类型返回 null 而不是崩溃', async () => {
    assert.equal(await send({ type: 'NOT_A_REAL_MESSAGE' }), null);
  });

  test('演示模式逐步推进并标记为演示数据', async () => {
    await send({ type: 'SET_SETTINGS', patch: { demoMode: true } });
    const before = (await send({ type: 'GET_VIEW' })).sampleCount;
    let last: any = null;
    for (let i = 0; i < 4; i++) last = await send({ type: 'DEMO_ADVANCE' });
    assert.equal(last.step, 4);
    assert.ok(last.view.syntheticCount >= 4, '演示条数未被单独计数，面板无法打标签');
    assert.ok(last.view.sampleCount > before);
  });

  test('关闭演示模式只清演示数据，保留真实历史', async () => {
    const before = await send({ type: 'GET_VIEW' });
    const v = await send({ type: 'DEMO_RESET' });
    // 真实阅读在本测试里走 mock 分析，同样计入 syntheticCount；
    // 因此这里断言的是"样本数减少了演示的那几条"，而不是 syntheticCount 归零。
    assert.ok(v.sampleCount < before.sampleCount, '演示数据未被清除');
    assert.equal(v.sampleCount, 10, '真实历史被误删（应保留此前记录的 10 篇）');
  });
});
