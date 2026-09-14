/**
 * 知流 · 公网分析端点（Vercel Serverless Function）。
 *
 * 它存在的唯一理由和本地 dev-server 一样：**Access Secret 不能进浏览器扩展**。
 * 扩展是分发给用户的，凭证只能待在服务端。
 *
 * 三条从第一行就不许松的规矩（和 dev-server 完全一致，不是另一套实现）：
 *
 *   1. 没有 ZHIHU_ACCESS_SECRET → 返回 503，**绝不**悄悄降级成别的 provider 或 mock。
 *   2. 只有真实模型调用成功并通过 schema 校验，才返回 status:'llm'。
 *   3. 请求体字段白名单强制执行 —— 多一个字段直接 400，
 *      客户端在物理上无法夹带 userId / 阅读历史 / 集中度。
 *
 * 复用的是同一个 `createAnalyzeHandler` 和同一个 `ZhidaExtractor`，
 * 不是"给线上再写一份"。线上线下行为不一致，是这类项目最常见的翻车方式。
 */
import { createAnalyzeHandler } from '../_lib/analyze.js';
import { ZhidaExtractor } from '../_lib/core/providers.js';
import { BUILD } from '../_lib/build.js';

const MODEL = process.env.ZHILIU_LLM_MODEL || 'zhida-fast-1p5';
const secret = process.env.ZHIHU_ACCESS_SECRET || '';

/**
 * 每个实例复用一个 extractor。
 * 除了省一点开销，更要紧的是**限速熔断的计数要跨请求保留** ——
 * 每次请求都新建一个，连续 429 永远攒不到阈值，熔断等于不存在。
 */
const extractor = secret
  ? new ZhidaExtractor({ accessSecret: secret, model: MODEL, timeoutMs: 25_000 })
  : null;

const handle = createAnalyzeHandler({
  llmExtract: extractor
    ? async (input) => {
        const r = await extractor.extract({ title: input.title, text: input.text });
        if (r.status === 'failed') {
          throw Object.assign(new Error(r.dropped[0] || 'llm_failed'), { name: r.dropped[0] || 'llm_failed' });
        }
        return {
          concepts: r.concepts,
          ambiguous: r.ambiguous,
          unknown: r.concepts.length === 0,
          provenance: {
            provider: r.provenance.provider,
            model: r.provenance.model,
            promptVersion: r.provenance.promptVersion,
            latencyMs: r.provenance.latencyMs,
          },
        };
      }
    : undefined,
});

export default async function (req, res) {
  // 扩展从 zhihu.com 发起跨域请求，需要 CORS。
  // 只允许知乎两个域，不开 `*` —— 这个端点会消耗我们的官方额度，
  // 开放给任意站点等于把额度送出去。
  const origin = req.headers.origin || '';
  const ALLOWED = ['https://www.zhihu.com', 'https://zhuanlan.zhihu.com'];
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    // /health 的等价物：如实上报当前 provider 与 model，让"现在到底是谁在分析"
    // 可以被外部核对，而不是只能相信我们的说法。
    return res.status(200).json({
      ok: true,
      llm: extractor ? { provider: 'zhida', model: MODEL } : null,
      rateLimit: extractor ? extractor.rateLimitState : null,
      // 报出构建时的 commit，让"线上跑的是不是当前源码"可以被外部核对，
      // 而不是只能信我们的说法。`-dirty` 后缀表示构建时工作区不干净。
      build: BUILD,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid json' }); }
  }
  const out = await handle(body);
  return res.status(out.status).json(out.json);
}
