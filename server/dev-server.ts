/**
 * 本地开发服务器。生产建议部署为 Cloudflare Worker / Vercel Function。
 *
 * ## 三个 Runtime Profile（2026-09-13 起）
 *
 *   ZHILIU_PROVIDER=zhida   PROFILE A · 知乎官方直答（**默认**）
 *   ZHILIU_PROVIDER=ollama  PROFILE B · 本地 qwen2.5:14b
 *   ZHILIU_LLM=off          无模型 —— /analyze 一律 503 llm_not_configured
 *
 * PROFILE C（演示数据）**不在服务端**：它是扩展在拿不到 /analyze 时的
 * 本地降级，且必须在面板上打「演」标记。服务端永远不产出演示数据。
 *
 * ## 为什么默认变成了直答
 *
 * 同一套冻结的 29 条验收集、同一个 prompt、同一套校验，2026-09-13 实测：
 *
 *   |              | schema | 平均主分(盲评) | p50    | p90    | 本机常驻 |
 *   | qwen2.5:14b  | 29/29  | 1.655         | 9354ms | 11278ms| 9.5 GB  |
 *   | zhida-fast   | 29/29  | 1.759         | 2218ms | 2984ms | 0       |
 *
 * 质量差 +0.103 —— 按冻结 rubric 的并列裁决口径（<0.25）这叫**打平**，
 * 不叫直答更准。真正决定选型的是另外两条：
 *   1. 14B 的 p50 = 9.4s **没过** rubric 早就写死的 Gate「p50 ≤ 8s」；直答过了。
 *   2. 14B 要在 16GB 的演示机上常驻 9.5GB。实测开着几个 Electron 应用时
 *      ollama 每次请求后就把模型驱逐掉，预热 34s→124s，一个 5 token 请求 280s。
 *      那是录 Demo 或评委远程体验时会翻车的东西，而它和模型质量无关。
 *      更要紧的是：它只能跑在作者自己的 Mac 上，而本项目线上提交、
 *      评委不接触作者本机 —— 所以本地 14B 天然只能是 DEV-ONLY / FALLBACK。
 *
 * ## 绝不静默降级
 *
 * 选了 zhida 却没有 Access Secret → **拒绝启动**，不偷偷换成 ollama。
 * 上一轮红队抓到过这一类：后台是 mock，前端看起来像真实分析。
 */
import { createServer } from 'node:http';
import { createAnalyzeHandler } from './analyze.ts';
import { OllamaExtractor, ZhidaExtractor } from '../packages/core/src/index.ts';
import type { LLMExtractor } from '../packages/core/src/index.ts';

const PORT = Number(process.env.PORT ?? 8732);
const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const enabled = process.env.ZHILIU_LLM !== 'off';
const provider = (process.env.ZHILIU_PROVIDER ?? 'zhida') as 'zhida' | 'ollama';

let extractor: LLMExtractor | null = null;
let modelLabel = '(none)';

if (enabled) {
  if (provider === 'zhida') {
    const secret = process.env.ZHIHU_ACCESS_SECRET ?? '';
    if (!secret) {
      console.error(
        '\n拒绝启动：ZHILIU_PROVIDER=zhida 但没有 ZHIHU_ACCESS_SECRET。\n' +
        '  这里**不会**自动降级成本地模型，因为那会让前端看起来一切正常。\n' +
        '  要么   export ZHIHU_ACCESS_SECRET=...（服务端进程环境，不要写进仓库）\n' +
        '  要么   ZHILIU_PROVIDER=ollama node server/dev-server.ts\n' +
        '  要么   ZHILIU_LLM=off node server/dev-server.ts（/analyze 一律 503）\n',
      );
      process.exit(1);
    }
    modelLabel = process.env.ZHILIU_LLM_MODEL ?? 'zhida-fast-1p5';
    extractor = new ZhidaExtractor({ accessSecret: secret, model: modelLabel, timeoutMs: 30_000 });
  } else if (provider === 'ollama') {
    modelLabel = process.env.ZHILIU_LLM_MODEL ?? 'qwen2.5:14b';
    extractor = new OllamaExtractor({ model: modelLabel, baseUrl: OLLAMA });
  } else {
    console.error(`拒绝启动：未知 ZHILIU_PROVIDER=${String(provider)}（只支持 zhida / ollama）`);
    process.exit(1);
  }
}

const handle = createAnalyzeHandler({
  llmExtract: extractor
    ? (input) => extractor!.extract({ title: input.title, text: input.text }).then(toRaw)
    : undefined,
  debug: process.env.ZHILIU_DEBUG === '1',
});

/**
 * LLMExtractor 已经做过校验；这里还原成 handler 期望的原始结构。
 * **provenance 必须带上**——早先这里把它剥掉了，于是客户端无从判断
 * 返回结果到底来自模型还是来自一个返回常量 JSON 的服务器。
 */
function toRaw(r: Awaited<ReturnType<LLMExtractor['extract']>>) {
  if (r.status === 'failed') {
    throw Object.assign(new Error(r.dropped[0] ?? 'llm_failed'), { name: r.dropped[0] ?? 'llm_failed' });
  }
  return {
    concepts: r.concepts,
    ambiguous: r.ambiguous,
    unknown: r.concepts.length === 0,
    provenance: {
      provider: r.provenance.provider, model: r.provenance.model,
      promptVersion: r.provenance.promptVersion, latencyMs: r.provenance.latencyMs,
    },
  };
}

console.log(
  extractor
    ? `模式：${provider === 'zhida' ? 'PROFILE A · 知乎官方直答' : 'PROFILE B · 本地 Ollama'}` +
      `（provider=${provider} model=${modelLabel}${provider === 'ollama' ? ` @ ${OLLAMA}` : ''}）`
    : '模式：无模型 —— /analyze 将返回 503 llm_not_configured',
);

/**
 * 启动预热。**只对本地模型有意义。**
 *
 * 14B 的第一次请求实测 50.8 秒——全部是模型加载，不是推理。
 * 直答是云端的，没有冷加载这回事；给它发一次预热请求纯粹是白烧额度，
 * 所以这里按 provider 分开，而不是无条件预热。
 */
if (extractor && provider === 'ollama') {
  void extractor.extract({ title: '预热', text: '这是一次启动预热请求，用来把模型加载进内存。'.repeat(4) })
    .then((r) => console.log(`预热完成：${r.provenance.latencyMs}ms（${r.status}）`))
    .catch((e) => console.warn('预热失败（不影响启动）：', e instanceof Error ? e.message : e));
}

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();

  if (req.url === '/health') {
    // provider / model 如实上报，让「现在到底是谁在分析」可以被外部核对，
    // 而不是只能相信启动日志。
    return void res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, llm: extractor ? { provider, model: modelLabel } : null }));
  }
  if (req.method !== 'POST' || req.url !== '/analyze') return void res.writeHead(404).end();

  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 64_000) req.destroy(); });
  req.on('end', async () => {
    let body: unknown;
    try { body = JSON.parse(raw); }
    catch { return void res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid json"}'); }
    const out = await handle(body);
    res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.json));
  });
}).listen(PORT, () => console.log(`/analyze 监听 http://127.0.0.1:${PORT}`));
