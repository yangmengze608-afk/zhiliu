/**
 * Provider 抽象测试。
 *
  * 2026-09-13 起 Zhida 已有真实凭证并真实调用过；本文件仍然只用假 fetch，
 * 因为它测的是**结构约束**：没凭证必须拒绝工作、绝不把假数据标成真数据、
 * 以及 R8 那一组实测暴露出来的缺陷不会回来。真实调用在 live-*.test.ts。
 * 以及**它绝不会把假数据标成真数据**。上一轮的教训全在这两条上。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExtractor, OpenAICompatibleExtractor, ZhidaExtractor, probeZhida,
  ZHIDA_BASE_URL, ZHIDA_MODELS, safeParse,
} from '../src/providers.ts';
import { PROMPT_VERSION } from '../src/llm.ts';

const input = { title: '测试', text: '正文'.repeat(60) };

/** 造一个可控的 fetch。 */
function fakeFetch(handler: (url: string, init: any) => { ok?: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: any }> = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.ok ?? true, status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('空凭证一律拒绝', () => {
  test('OpenAI 兼容 provider 没有 apiKey 就抛错，不发请求', () => {
    assert.throws(() => new OpenAICompatibleExtractor({ provider: 'openai_compatible', baseUrl: 'https://x/v1' }),
      /缺少 apiKey/);
  });
  test('没有 baseUrl 也抛错', () => {
    assert.throws(() => new OpenAICompatibleExtractor({ provider: 'openai_compatible', apiKey: 'k' }), /baseUrl/);
  });
  test('Zhida 没有 Access Secret 就抛错 —— 这是"绝不以空凭证调用官方 API"的可执行版本', () => {
    assert.throws(() => new ZhidaExtractor({ accessSecret: '' }), /ZHIHU_ACCESS_SECRET/);
    assert.throws(() => createExtractor({ provider: 'zhida' }), /ZHIHU_ACCESS_SECRET/);
  });
});

describe('OpenAI 兼容抽取器', () => {
  test('走 /chat/completions，带 Bearer，返回结果附 provenance', async () => {
    const { f, calls } = fakeFetch(() => ({
      body: {
        choices: [{ message: { content: '{"concepts":[{"canonical":"睡眠","confidence":0.9}],"ambiguous":false,"unknown":false}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      },
    }));
    const ex = new OpenAICompatibleExtractor({ provider: 'openai_compatible', baseUrl: 'https://x/v1', apiKey: 'sk-1', model: 'm1', fetchImpl: f });
    const r = await ex.extract(input);
    assert.equal(calls[0].url, 'https://x/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-1');
    assert.equal(r.status, 'llm');
    assert.deepEqual(r.concepts, [{ canonical: '睡眠', confidence: 0.9 }]);
    assert.equal(r.provenance.model, 'm1');
    assert.equal(r.provenance.promptVersion, PROMPT_VERSION);
    assert.equal(r.provenance.promptTokens, 100);
  });

  test('上游 500 → failed，绝不返回概念', async () => {
    const { f } = fakeFetch(() => ({ ok: false, status: 500, body: {} }));
    const r = await new OpenAICompatibleExtractor({ provider: 'openai_compatible', baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: f }).extract(input);
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.concepts, []);
    assert.equal(r.dropped[0], 'provider_http_500');
  });

  test('返回的不是 OpenAI 形状 → failed，而不是猜一个字段出来', async () => {
    const { f } = fakeFetch(() => ({ body: { data: { answer: '睡眠' } } }));
    const r = await new OpenAICompatibleExtractor({ provider: 'openai_compatible', baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: f }).extract(input);
    assert.equal(r.status, 'failed');
    assert.equal(r.dropped[0], 'missing_choices_content');
  });

  test('内容不是 JSON → failed', async () => {
    const { f } = fakeFetch(() => ({ body: { choices: [{ message: { content: '这篇讲的是睡眠。' } }] } }));
    const r = await new OpenAICompatibleExtractor({ provider: 'openai_compatible', baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: f }).extract(input);
    assert.equal(r.status, 'failed');
    assert.equal(r.dropped[0], 'malformed_json');
  });

  test('说了不是 unknown 却给空数组 → failed，不当成"这篇没有核心思想"', async () => {
    const { f } = fakeFetch(() => ({ body: { choices: [{ message: { content: '{"concepts":[],"unknown":false}' } }] } }));
    const r = await new OpenAICompatibleExtractor({ provider: 'openai_compatible', baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: f }).extract(input);
    assert.equal(r.status, 'failed');
  });
});

describe('Zhida 预接线', () => {
  test('打到官方端点，带 Bearer 与 X-Request-Timestamp，默认模型在已记录的清单内', async () => {
    const { f, calls } = fakeFetch(() => ({
      body: { choices: [{ message: { content: '{"concepts":[{"canonical":"AI","confidence":0.9}]}' } }] },
    }));
    const ex = new ZhidaExtractor({ accessSecret: 'secret-x', fetchImpl: f });
    assert.ok((ZHIDA_MODELS as readonly string[]).includes(ex.model));
    const r = await ex.extract(input);
    assert.equal(calls[0].url, `${ZHIDA_BASE_URL}/chat/completions`);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-x');
    assert.match(calls[0].init.headers['X-Request-Timestamp'], /^\d+$/);
    assert.equal(r.provenance.provider, 'zhida');
  });

  test('probe 报告"响应形状是否真的 OpenAI 兼容"，而不是替我们假定它是', async () => {
    const { f } = fakeFetch(() => ({ body: { data: { text: '好' } } })); // 非 OpenAI 形状
    const p = await probeZhida('secret-x', ZHIDA_MODELS[0], f);
    assert.equal(p.ok, true);
    assert.equal(p.shapeMatchesOpenAI, false, 'probe 必须能报出"形状对不上"，否则它就没有存在意义');
    assert.ok(p.rawPreview.includes('好'), 'probe 必须把原始响应给人看');
  });

  test('形状对得上时 probe 也如实说', async () => {
    const { f } = fakeFetch(() => ({ body: { choices: [{ message: { content: '好' } }] } }));
    assert.equal((await probeZhida('s', ZHIDA_MODELS[0], f)).shapeMatchesOpenAI, true);
  });
});

describe('createExtractor 是换模型的唯一入口', () => {
  test('ollama 分支返回本地抽取器', () => {
    const ex = createExtractor({ provider: 'ollama', model: 'qwen2.5:14b' });
    assert.equal(ex.provider, 'ollama');
    assert.equal(ex.model, 'qwen2.5:14b');
  });
  test('未知 provider 抛错而不是静默降级', () => {
    assert.throws(() => createExtractor({ provider: 'nope' as any }), /未知 provider/);
  });
});

/**
 * ───────────── R8：2026-09-13 真实调用官方 API 之后补的回归 ─────────────
 *
 * 这一组每一条都对应一个**真实发生过**的事实或缺陷，不是想象出来的边界：
 *   · 时间戳固化    —— 旧实现在构造函数里算一次，而服务端校验它
 *   · 429 不是配额  —— 实测连打 12 次后全量 429，当天额度只掉 12
 *   · 401 不该重试  —— 实测无效 secret 是诚实的 401，重试只是白等
 *   · 直答没 JSON mode —— response_format 传上去 200 静默忽略
 */
describe('R8 · 官方直答实测回归', () => {
  test('X-Request-Timestamp 每次请求重算，不是构造时算一次', async () => {
    const stamps: string[] = [];
    let now = 1_700_000_000_000;
    const realNow = Date.now;
    (Date as unknown as { now: () => number }).now = () => now;
    try {
      const ex = new ZhidaExtractor({
        accessSecret: 's',
        fetchImpl: (async (_u: unknown, init: RequestInit) => {
          stamps.push((init.headers as Record<string, string>)['X-Request-Timestamp']);
          return jsonResponse({ choices: [{ message: { content: '{"concepts":[{"canonical":"拖延","confidence":0.8}]}' } }] });
        }) as unknown as typeof fetch,
      });
      await ex.extract({ title: 'a', text: 'b' });
      now += 600_000; // 十分钟后
      await ex.extract({ title: 'a', text: 'b' });
    } finally {
      (Date as unknown as { now: () => number }).now = realNow;
    }
    assert.equal(stamps.length, 2);
    assert.notEqual(stamps[0], stamps[1], '时间戳被固化了——服务端会拿到一个过期的戳');
  });

  test('429 先退避再重试，成功后仍然是真实结果', async () => {
    let calls = 0;
    const ex = new ZhidaExtractor({
      accessSecret: 's', maxAttempts: 3, backoffBaseMs: 1, maxBackoffMs: 2,
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 3) return new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 });
        return jsonResponse({ choices: [{ message: { content: '{"concepts":[{"canonical":"拖延","confidence":0.8}]}' } }] });
      }) as unknown as typeof fetch,
    });
    const r = await ex.extract({ title: 'a', text: 'b' });
    assert.equal(calls, 3);
    assert.equal(r.status, 'llm');
    assert.equal(r.provenance.attempts, 3);
  });

  test('429 撞满上限 → failed，错误里保留 rate_limit_exceeded，绝不返回概念', async () => {
    const ex = new ZhidaExtractor({
      accessSecret: 's', maxAttempts: 2, backoffBaseMs: 1, maxBackoffMs: 2,
      fetchImpl: (async () => new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 })) as unknown as typeof fetch,
    });
    const r = await ex.extract({ title: 'a', text: 'b' });
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.concepts, []);
    assert.match(r.dropped[0], /429/);
    assert.match(r.dropped[0], /rate_limit_exceeded/);
  });

  test('401 不重试 —— 鉴权失败重试只是白等，且错误码要带出来', async () => {
    let calls = 0;
    const ex = new ZhidaExtractor({
      accessSecret: 'bad', maxAttempts: 4,
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 });
      }) as unknown as typeof fetch,
    });
    const r = await ex.extract({ title: 'a', text: 'b' });
    assert.equal(calls, 1, '401 被重试了');
    assert.equal(r.status, 'failed');
    assert.match(r.dropped[0], /invalid_api_key/);
  });

  test('直答没有 JSON mode：JSON 外面包着话也要能解析出来', () => {
    const wrapped = '好的，分析结果如下：\n```json\n{"concepts":[{"canonical":"拖延","confidence":0.8}],"unknown":false}\n```\n希望有帮助。';
    const parsed = safeParse(wrapped);
    assert.ok(parsed, '没能从散文里抠出 JSON');
    assert.equal((parsed as { concepts: Array<{ canonical: string }> }).concepts[0].canonical, '拖延');
  });

  test('抠不出 JSON 时老老实实返回 null，不瞎猜', () => {
    assert.equal(safeParse('模型今天不想回答'), null);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * 限速熔断。红队 R8-18：额度耗尽是唯一真正会在赛中发生的失败模式，
 * 而原来的实现对它的反应是"每一篇都打 2 次、睡 2 秒"——
 * 与官方「避免持续重试」的指引正好相反。
 */
describe('R8 · 限速熔断', () => {
  test('连续 429 到阈值后进入冷却：不再发请求，且错误可区分', async () => {
    let calls = 0;
    const ex = new ZhidaExtractor({
      accessSecret: 's', maxAttempts: 5, backoffBaseMs: 1, maxBackoffMs: 2,
      breakerAfter: 3, breakerCooldownMs: 60_000,
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 });
      }) as unknown as typeof fetch,
    });
    const first = await ex.extract({ title: 'a', text: 'b' });
    assert.equal(calls, 3, '应该在第 3 次 429 时熔断，而不是把 5 次尝试用完');
    assert.equal(first.dropped[0], 'rate_limited_breaker_open');
    assert.equal(ex.rateLimitState.open, true);

    // 冷却期内后续每一篇都必须 0 请求
    const before = calls;
    const second = await ex.extract({ title: 'c', text: 'd' });
    assert.equal(calls, before, '熔断期内还在发请求 —— 那就是在白烧额度');
    assert.equal(second.status, 'failed');
    assert.equal(second.dropped[0], 'rate_limited_breaker_open');
    assert.deepEqual(second.concepts, [], '熔断绝不能产出概念');
  });

  test('成功一次就把连续计数清零，不会因为历史 429 误熔断', async () => {
    let n = 0;
    const ex = new ZhidaExtractor({
      accessSecret: 's', maxAttempts: 3, backoffBaseMs: 1, maxBackoffMs: 2, breakerAfter: 3,
      fetchImpl: (async () => {
        n += 1;
        // 429, 429, 成功 —— 然后再来两次 429 也不该熔断
        if (n === 1 || n === 2 || n === 4 || n === 5) {
          return new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: '{"concepts":[{"canonical":"拖延","confidence":0.8}]}' } }],
        }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const ok = await ex.extract({ title: 'a', text: 'b' });
    assert.equal(ok.status, 'llm');
    assert.equal(ex.rateLimitState.consecutive429, 0, '成功之后计数没清零');
    assert.equal(ex.rateLimitState.open, false);
  });
});
