/**
 * 隐私边界的**可执行**测试。
 *
 * 这些断言存在的意义是：把"我们不上传用户状态"从一句承诺变成一条会失败的约束。
 * 将来谁不小心往请求里加了字段，这里会红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzeHandler, validate } from '../../server/analyze.ts';
import { toWirePayload } from '../../extension/src/background/analysis.ts';

describe('客户端发出的载荷', () => {
  test('只包含 contentId / contentType / title / text', () => {
    const payload = toWirePayload({ contentId: '123', contentType: 'answer', title: 't', text: 'x' });
    assert.deepEqual(Object.keys(payload).sort(), ['contentId', 'contentType', 'text', 'title']);
  });

  test('调用方多传的字段不会被发出去', () => {
    const dirty = {
      contentId: '1', title: 't', text: 'x',
      userId: 'u-42', sessionId: 's-9', history: ['a', 'b'], concentration: 68, url: 'https://www.zhihu.com/answer/1',
    } as never;
    const payload = toWirePayload(dirty);
    for (const leaked of ['userId', 'sessionId', 'history', 'concentration', 'url']) {
      assert.ok(!(leaked in payload), `${leaked} 泄漏到了请求体`);
    }
  });

  test('不发送完整 URL —— 只发内容 ID', () => {
    const payload = toWirePayload({ contentId: '1903044959663284716', title: 't', text: 'x' });
    assert.equal(payload.url, undefined);
    assert.equal(payload.contentId, '1903044959663284716');
  });
});

describe('服务端字段白名单', () => {
  test('拒绝夹带用户状态的请求', () => {
    for (const extra of ['userId', 'sessionId', 'deviceId', 'history', 'previousConcepts', 'concentration', 'readAt']) {
      const r = validate({ title: 't', text: 'x', [extra]: 'whatever' });
      assert.ok('error' in r, `${extra} 未被拒绝`);
      assert.ok((r as { error: string }).error.includes(extra), `报错未指出 ${extra}`);
    }
  });

  test('拒绝完整 URL', () => {
    const r = validate({ title: 't', text: 'x', url: 'https://www.zhihu.com/answer/1' });
    assert.ok('error' in r);
  });

  test('接受最小合法载荷', () => {
    const r = validate({ contentId: '1', contentType: 'answer', title: 't', text: 'x' });
    assert.ok(!('error' in r));
  });

  test('title/text 缺失被拒绝', () => {
    assert.ok('error' in validate({ contentId: '1' }));
  });

  test('正文超长被拒绝', () => {
    assert.ok('error' in validate({ title: 't', text: 'x'.repeat(8001) }));
  });

  test('contentType 只接受 answer/article', () => {
    assert.ok('error' in validate({ title: 't', text: 'x', contentType: 'feed' }));
  });
});

describe('handler 行为', () => {
  const stubLlm = async () => ({ concepts: [{ canonical: '稳定', confidence: 0.9 }] });

  test('夹带用户状态时返回 400 且不进行分析', async () => {
    let called = 0;
    const h = createAnalyzeHandler({ llmExtract: async () => { called++; return stubLlm(); } });
    const out = await h({ title: 't', text: 'x'.repeat(300), userId: 'u1' });
    assert.equal(out.status, 400);
    assert.equal(called, 0, '校验未通过就不应调用上游');
  });

  test('响应里不回显任何请求侧标识', async () => {
    const h = createAnalyzeHandler({ llmExtract: stubLlm });
    const out = await h({ contentId: 'abc123', title: 't', text: '正文'.repeat(100) });
    assert.ok(!JSON.stringify(out.json).includes('abc123'), '响应回显了 contentId');
  });

  test('未注入 LLM 时 fail loud，而不是返回一个看起来正常的空结果', async () => {
    const h = createAnalyzeHandler({});
    const out = await h({ title: 't', text: '正文'.repeat(100) });
    assert.equal(out.status, 503);
    assert.equal((out.json as any).error, 'llm_not_configured');
    assert.equal((out.json as any).status, 'failed');
  });
});
