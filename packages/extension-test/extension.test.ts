/**
 * 扩展侧的存储与分析契约测试。
 * 有效阅读的时序边界见 session.test.ts；隐私载荷见 privacy.test.ts。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trim } from '../../extension/src/background/storage.ts';
import { mockAnalysis } from '../../extension/src/background/analysis.ts';
import { CONFIG, FLAGS } from '../../extension/src/shared/config.ts';
import { DEMO_ARTICLES } from '../../extension/src/shared/demo-data.ts';
import { demoEvent, DEMO_TOTAL } from '../../extension/src/background/demo.ts';
import type { ReadEvent } from '../../packages/core/src/model.ts';

const mk = (i: number): ReadEvent => ({
  id: String(i), contentType: 'answer', title: `t${i}`, timestamp: i, duration: 9000,
  concepts: [{ canonical: '稳定', confidence: 0.8 }],
  analysisStatus: 'llm', analysisVersion: 'v1',
});

describe('本地存储上限', () => {
  test('最多保留 100 条，且保留的是最近的', () => {
    const t = trim(Array.from({ length: 150 }, (_, i) => mk(i)));
    assert.equal(t.length, CONFIG.MAX_RECORDS);
    assert.equal(t[t.length - 1].id, '149');
    assert.equal(t[0].id, '50');
  });

  test('不足上限时原样保留', () => {
    assert.equal(trim(Array.from({ length: 7 }, (_, i) => mk(i))).length, 7);
  });
});

describe('Mock 分析确定性', () => {
  test('同一内容多次调用结果完全一致（刷新不跳变）', () => {
    const req = { contentId: '123', title: 't', text: 'x' };
    assert.deepEqual(mockAnalysis(req), mockAnalysis(req));
  });

  test('mock 结果一律标记为 mock，绝不冒充真实分析', () => {
    for (let i = 0; i < 10; i++) {
      assert.equal(mockAnalysis({ contentId: `c${i}`, title: 't', text: 'x' }).status, 'mock');
    }
  });

  test('每篇产出 1-3 个概念，不凑数', () => {
    for (let i = 0; i < 20; i++) {
      const n = mockAnalysis({ contentId: `u${i}`, title: 't', text: 'x' }).concepts.length;
      assert.ok(n >= 1 && n <= 3, `产出了 ${n} 个概念`);
    }
  });
});

describe('Feature flags', () => {
  test('知乎 Search 默认关闭 —— 主链路不依赖它', () => {
    assert.equal(FLAGS.ZHIHU_SEARCH_ENABLED, false);
  });

  test('演示模式默认关闭', () => {
    assert.equal(FLAGS.DEMO_MODE, false);
  });
});

describe('演示数据', () => {
  test('样例数量足以让 20 篇窗口发生滚动', () => {
    // 窗口固定 20，样例必须多于 20 才能看到"早期分散内容滑出、集中度爬升"
    assert.ok(DEMO_ARTICLES.length > 20, `只有 ${DEMO_ARTICLES.length} 条，窗口不会滚动`);
    assert.ok(DEMO_ARTICLES.length <= 30, `${DEMO_ARTICLES.length} 条太长，20 秒 Demo 讲不完`);
  });

  test('每条演示事件都标记为 demo，面板据此打标签', () => {
    for (let i = 0; i < DEMO_TOTAL; i++) {
      assert.equal(demoEvent(i).analysisStatus, 'demo', '演示数据必须可被识别，不能冒充真实数据');
    }
  });

  test('剧本后半段由「稳定」主导，前半段则不是', () => {
    const half = Math.floor(DEMO_ARTICLES.length / 2);
    const late = DEMO_ARTICLES.slice(half).filter((a) => a.concepts.some((c) => c.canonical === '稳定')).length;
    const early = DEMO_ARTICLES.slice(0, half).filter((a) => a.concepts.some((c) => c.canonical === '稳定')).length;
    assert.ok(late >= (DEMO_ARTICLES.length - half) * 0.7, `后半段只有 ${late} 篇含「稳定」`);
    assert.ok(early <= 2, `前半段就有 ${early} 篇含「稳定」，看不出从分散到集中`);
  });

  test('剧本包含一次趋势变化：至少一个概念只出现在前半段', () => {
    const half = Math.floor(DEMO_ARTICLES.length / 2);
    const early = new Set(DEMO_ARTICLES.slice(0, half).flatMap((a) => a.concepts.map((c) => c.canonical)));
    const late = new Set(DEMO_ARTICLES.slice(half).flatMap((a) => a.concepts.map((c) => c.canonical)));
    const vanished = [...early].filter((c) => !late.has(c));
    assert.ok(vanished.length > 0, '没有任何概念消失，演示中看不到 ↓ 趋势');
  });

  test('演示事件 id 唯一，不会互相去重掉', () => {
    const ids = new Set(Array.from({ length: DEMO_TOTAL }, (_, i) => demoEvent(i).id));
    assert.equal(ids.size, DEMO_TOTAL);
  });
});
