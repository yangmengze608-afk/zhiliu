/**
 * 分析来源不可混淆 —— 回归测试。
 *
 * 上一轮的教训：validateExtraction 曾把所有结果无条件盖章成 status:'llm'，
 * 于是 mock 数据在前端看起来和真实 AI 分析一模一样。
 * 这组断言的存在是为了让那种情况**在结构上不可能再发生**。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 生产默认模型。选型依据见 `docs/MODEL_SELECTION.md`。
 * 这条常量存在的意义是：改默认模型时测试会**红**，逼你同时去改文档，
 * 而不是让文档和代码悄悄分家。
 */
const PRODUCTION_DEFAULT_MODEL = 'qwen2.5:14b';
import { sourceBadge } from '../../extension/src/content/dashboard.ts';
import { validateExtraction, buildAggregates, OllamaExtractor } from '../../packages/core/src/index.ts';
import { mockAnalysis } from '../../extension/src/background/analysis.ts';
import type { ReadEvent } from '../../packages/core/src/model.ts';

const b = (o: Partial<Record<'llm' | 'mock' | 'demo' | 'enriched' | 'other', number>>) =>
  ({ llm: 0, mock: 0, demo: 0, enriched: 0, other: 0, ...o });

describe('来源徽标', () => {
  test('窗口内只要有一条 mock/demo 就显示「演示数据」，不按多数决', () => {
    assert.equal(sourceBadge(b({ llm: 19, mock: 1 }))!.kind, 'demo');
    assert.equal(sourceBadge(b({ llm: 19, demo: 1 }))!.kind, 'demo');
    assert.match(sourceBadge(b({ llm: 19, mock: 1 }))!.text, /1\/20/);
  });

  test('全部来自模型才显示「AI 分析」', () => {
    const x = sourceBadge(b({ llm: 20 }))!;
    assert.equal(x.kind, 'llm');
    assert.equal(x.text, 'AI 分析');
  });

  test('有知乎语境增强时显示对应标签', () => {
    assert.equal(sourceBadge(b({ llm: 5, enriched: 3 }))!.kind, 'enriched');
  });

  test('没有任何已分析记录时不显示徽标', () => {
    assert.equal(sourceBadge(b({})), null);
  });
});

describe('status 不可能被错误盖章', () => {
  test('validateExtraction 默认不产出 llm —— 必须由调用方显式声明来源', () => {
    const r = validateExtraction({ concepts: [{ canonical: '稳定', confidence: 0.9 }] });
    assert.notEqual(r.status, 'llm', 'status 默认就是 llm，等于允许 mock 冒充真实分析');
  });

  test('显式传入来源时才标记为 llm', () => {
    const r = validateExtraction({ concepts: [{ canonical: '稳定', confidence: 0.9 }] }, 'llm');
    assert.equal(r.status, 'llm');
  });

  test('上游返回空 concepts 且未声明 unknown → 判失败，不当成"没有核心思想"', () => {
    const r = validateExtraction({ concepts: [] }, 'llm');
    assert.equal(r.status, 'failed');
  });

  test('mock 分析永远标记为 mock', () => {
    for (let i = 0; i < 8; i++) {
      assert.equal(mockAnalysis({ contentId: `c${i}`, title: 't', text: 'x' }).status, 'mock');
    }
  });
});

describe('LLM 失败绝不降级成 mock', () => {
  test('provider 不可达时返回 failed 且 concepts 为空', async () => {
    const ex = new OllamaExtractor({
      baseUrl: 'http://127.0.0.1:1', maxAttempts: 1, timeoutMs: 500,
    });
    const r = await ex.extract({ title: 't', text: 'x' });
    assert.equal(r.status, 'failed');
    assert.equal(r.concepts.length, 0, '失败时凭空产出了概念');
    assert.equal(r.provenance.provider, 'ollama');
  });

  test('畸形 JSON 会重试，重试仍失败则 fail loud', async () => {
    let calls = 0;
    const ex = new OllamaExtractor({
      maxAttempts: 2,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ message: { content: '这不是 JSON' } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const r = await ex.extract({ title: 't', text: 'x' });
    assert.equal(calls, 2, '畸形输出没有触发重试');
    assert.equal(r.status, 'failed');
    assert.equal(r.dropped[0], 'malformed_json');
  });

  test('provenance 始终记录 provider / model / 尝试次数', async () => {
    const ex = new OllamaExtractor({ baseUrl: 'http://127.0.0.1:1', maxAttempts: 1, timeoutMs: 300 });
    const r = await ex.extract({ title: 't', text: 'x' });
    assert.equal(r.provenance.model, PRODUCTION_DEFAULT_MODEL);
    assert.equal(r.provenance.attempts, 1);
    assert.ok(r.provenance.latencyMs >= 0);
  });
});

describe('聚合层按来源分类', () => {
  const mk = (status: ReadEvent['analysisStatus'], i: number): ReadEvent => ({
    id: `e${status}${i}`, contentType: 'answer', title: 't', timestamp: i, duration: 9000,
    concepts: [{ canonical: '稳定', confidence: 0.8 }],
    analysisStatus: status, analysisVersion: 'v1',
  });

  test('sourceBreakdown 如实反映窗口内各来源条数', () => {
    const v = buildAggregates([
      ...Array.from({ length: 6 }, (_, i) => mk('llm', i)),
      ...Array.from({ length: 3 }, (_, i) => mk('mock', i)),
      ...Array.from({ length: 2 }, (_, i) => mk('demo', i)),
    ]);
    assert.deepEqual(v.sourceBreakdown, { llm: 6, mock: 3, demo: 2, enriched: 0, other: 0 });
    assert.equal(sourceBadge(v.sourceBreakdown)!.kind, 'demo');
  });
});

describe('冒充防护：200 响应不等于模型产出', () => {
  const withServer = async (payload: unknown, fn: () => Promise<void>) => {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    try { await fn(); } finally { (globalThis as any).fetch = orig; }
  };

  test('自称 llm 但不带 provenance → 降级为 ungrounded，不显示「AI 分析」', async () => {
    const cfg = await import('../../extension/src/shared/config.ts');
    const { requestAnalysis } = await import('../../extension/src/background/analysis.ts');
    (cfg.CONFIG as any).ANALYZE_ENDPOINT = 'http://127.0.0.1:9/analyze';
    await withServer(
      { concepts: [{ canonical: '稳定', confidence: 0.99 }], status: 'llm' },
      async () => {
        const r = await requestAnalysis({ contentId: 'x', title: 't', text: '正文'.repeat(80) });
        assert.notEqual(r.status, 'llm',
          '一个返回常量 JSON 的服务器就能让面板打出「AI 分析」——这正是上一轮被抓到的问题');
        assert.equal(r.status, 'ungrounded');
      },
    );
    (cfg.CONFIG as any).ANALYZE_ENDPOINT = '';
  });

  test('带完整 provenance 时才认作 llm', async () => {
    const cfg = await import('../../extension/src/shared/config.ts');
    const { requestAnalysis } = await import('../../extension/src/background/analysis.ts');
    (cfg.CONFIG as any).ANALYZE_ENDPOINT = 'http://127.0.0.1:9/analyze';
    await withServer(
      {
        concepts: [{ canonical: '稳定', confidence: 0.9 }], status: 'llm',
        provenance: { provider: 'ollama', model: PRODUCTION_DEFAULT_MODEL, latencyMs: 900 },
      },
      async () => {
        const r = await requestAnalysis({ contentId: 'x', title: 't', text: '正文'.repeat(80) });
        assert.equal(r.status, 'llm');
      },
    );
    (cfg.CONFIG as any).ANALYZE_ENDPOINT = '';
  });

  test('服务端自称 mock 时如实标记为 mock', async () => {
    const cfg = await import('../../extension/src/shared/config.ts');
    const { requestAnalysis } = await import('../../extension/src/background/analysis.ts');
    (cfg.CONFIG as any).ANALYZE_ENDPOINT = 'http://127.0.0.1:9/analyze';
    await withServer(
      { concepts: [{ canonical: '稳定', confidence: 0.9 }], status: 'mock' },
      async () => {
        const r = await requestAnalysis({ contentId: 'x', title: 't', text: '正文'.repeat(80) });
        assert.equal(r.status, 'mock');
      },
    );
    (cfg.CONFIG as any).ANALYZE_ENDPOINT = '';
  });
});
