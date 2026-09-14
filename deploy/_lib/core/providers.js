/**
 * ExtractorProvider —— 让"用哪个模型"变成一行配置，而不是一次重构。
 *
 * 业务代码只依赖 `LLMExtractor` 这个契约（`extract(input) → 概念 + provenance`）。
 * 换 provider 不影响 `/analyze`、不影响扩展、不影响聚合与面板。
 *
 * 现有三个实现：
 *   `ollama`             本地推理，当前默认（`llm.ts`）
 *   `openai_compatible`  任何 OpenAI 兼容的 `/chat/completions`（DashScope、自建网关…）
 *   `zhida`              知乎官方直答。**2026-09-13 起是服务端默认。** 见下面那张实测表。
 */
import { buildPrompt, OllamaExtractor, PROMPT_VERSION } from './llm.js';
                                                                  
import { validateExtraction, MAX_CONCEPTS } from './extract.js';
                                                    
import { ANALYSIS_VERSION } from './model.js';

                                                                             

                                 
                                  
                 
                   
                              
                  
                     
                           
 

/**
 * 通用 OpenAI 兼容抽取器。
 *
 * 协议面只用最保守的子集：`POST {baseUrl}/chat/completions`，
 * body 里 `model` / `messages` / `temperature`，读 `choices[0].message.content`。
 * 刻意**不使用** `response_format`、`tools`、`seed` 之类各家实现不一致的字段——
 * 用了就等于假设了一个我们没验证过的能力。
 */
export class OpenAICompatibleExtractor                         {
           provider        ;
           model        ;
  #baseUrl        ;
  #apiKey        ;
  #timeoutMs        ;
  #fetch              ;
  #extraHeaders                              ;
  #maxAttempts        ;
  #backoffBaseMs        ;
  #maxBackoffMs        ;
  /**
   * 限速熔断。
   *
   * 官方文档对 `Code/Message` 类接口明确写了「频率、并发限制和日额度耗尽
   * 均返回 30001，遇到限制时**避免持续重试**」。直答走 OpenAI 形状而不是那个信封，
   * 但指引是一样的，而原来的实现正好相反：**每一篇**都打 2 次、睡 2 秒，
   * 然后报同一个错。额度真耗尽的那一刻，这就是在给每篇内容白烧两次请求和两秒。
   *
   * 连续 `#breakerAfter` 次 429 之后进入冷却：立刻 fail，不重试不退避，
   * 并给出一个**可区分的** `rate_limited_breaker_open`，让上层能说
   * 「官方限速/额度」而不是笼统的分析失败。任何一次成功都清零。
   */
  #consecutive429 = 0;
  #breakerUntil = 0;
  #breakerAfter        ;
  #breakerCooldownMs        ;

  constructor(cfg                    
                           
       
                                                       
                                          
                                                
       
                                                
                         
                           
                          
                          
                               
   ) {
    if (!cfg.baseUrl) throw new Error('OpenAI 兼容 provider 必须提供 baseUrl');
    if (!cfg.apiKey) throw new Error('缺少 apiKey，拒绝以空凭证发起请求');
    this.provider = cfg.providerLabel ?? 'openai_compatible';
    this.model = cfg.model ?? 'unset';
    this.#baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.#apiKey = cfg.apiKey;
    this.#timeoutMs = cfg.timeoutMs ?? 30_000;
    this.#fetch = cfg.fetchImpl ?? fetch;
    this.#extraHeaders = cfg.extraHeaders ?? (() => ({}));
    this.#maxAttempts = cfg.maxAttempts ?? 1;
    this.#backoffBaseMs = cfg.backoffBaseMs ?? 2_000;
    this.#maxBackoffMs = cfg.maxBackoffMs ?? 15_000;
    this.#breakerAfter = cfg.breakerAfter ?? 3;
    this.#breakerCooldownMs = cfg.breakerCooldownMs ?? 60_000;
  }

  /** 熔断状态。供 /health 与诊断如实上报，不让"被限速"看起来像"分析失败"。 */
  get rateLimitState()                                                                  {
    const left = this.#breakerUntil - Date.now();
    return { open: left > 0, consecutive429: this.#consecutive429, retryAfterMs: Math.max(0, left) };
  }

  async extract(input                 )                               {
    const { system, user } = buildPrompt(input);
    const started = Date.now();
    const prov = (attempts        ) => ({
      provider: this.provider, model: this.model, promptVersion: PROMPT_VERSION,
      latencyMs: Date.now() - started, attempts,
    });
    const fail = (why        )                      => ({
      concepts: [], ambiguous: false, status: 'failed',
      analysisVersion: ANALYSIS_VERSION, dropped: [why], provenance: prov(1),
    });

    let lastProblem = 'unknown';
    if (Date.now() < this.#breakerUntil) {
      // 熔断期内一次请求都不发。这既省额度，也让失败原因是可读的。
      return {
        concepts: [], ambiguous: false, status: 'failed',
        analysisVersion: ANALYSIS_VERSION,
        dropped: ['rate_limited_breaker_open'],
        provenance: prov(0),
      };
    }
    // 超时是**每次尝试**一个预算，不是整轮共享一个。共享的话，第一次
    // 退避 2 秒就把第二次的预算吃掉了，失败原因会被记成 timeout 而不是限速。
    let ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), this.#timeoutMs);
    try {
      for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
        if (attempt > 1) {
          clearTimeout(timer);
          ctrl = new AbortController();
          timer = setTimeout(() => ctrl.abort(), this.#timeoutMs);
        }
        const resp = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#apiKey}`,
            ...this.#extraHeaders(),
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0.2,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          }),
        });
        if (!resp.ok) {
          // 把服务端 error.code 带进 dropped：401 invalid_api_key、
          // 400 model_not_found、配额与限流因此可以区分，而不是笼统的 4xx。
          let code = '';
          try {
            const e = (await resp.json())                                 ;
            if (e?.error?.code) code = `_${e.error.code}`;
          } catch { /* 错误体不是 JSON，保持空 */ }
          lastProblem = `provider_http_${resp.status}${code}`;
          // 鉴权失败和请求非法重试不会变好。
          if (resp.status === 400 || resp.status === 401 || resp.status === 403) break;
          // 429 是**限速**不是配额耗尽：2026-09-13 实测，直答连打 12 次后开始
          // 全量 429，而当天额度只用掉 12（429 本身不扣额度）。立刻重试必然再撞，
          // 所以退避；`Retry-After` 存在就听它的，不存在用递增退避。
          if (resp.status === 429) {
            this.#consecutive429 += 1;
            if (this.#consecutive429 >= this.#breakerAfter) {
              this.#breakerUntil = Date.now() + this.#breakerCooldownMs;
              lastProblem = 'rate_limited_breaker_open';
              break;
            }
            const hinted = Number(resp.headers.get('retry-after'));
            const waitMs = Number.isFinite(hinted) && hinted > 0
              ? Math.min(hinted * 1000, this.#maxBackoffMs)
              : Math.min(this.#backoffBaseMs * attempt, this.#maxBackoffMs);
            await sleep(waitMs);
          }
          continue;
        }

        const body = (await resp.json())     
                                                              
                                                                         
         ;
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string') { lastProblem = 'missing_choices_content'; continue; }

        const raw = safeParse(content);
        if (!raw) { lastProblem = 'malformed_json'; continue; }
        const validated = validateExtraction(raw, 'llm');
        if (validated.status === 'failed') { lastProblem = validated.dropped[0] ?? 'schema_rejected'; continue; }
        if (validated.concepts.length === 0 && raw.unknown !== true) {
          lastProblem = 'empty_concepts_without_unknown'; continue;
        }

        this.#consecutive429 = 0; // 成功一次就清零
        return {
          ...validated,
          concepts: validated.concepts.slice(0, MAX_CONCEPTS),
          provenance: {
            ...prov(attempt),
            promptTokens: body.usage?.prompt_tokens,
            outputTokens: body.usage?.completion_tokens,
          },
        };
      }
      return { ...fail(lastProblem), provenance: prov(this.#maxAttempts) };
    } catch (err) {
      return fail(err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'provider_error');
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 知乎官方直答（Zhida）抽取器。
 *
 * ## 状态：**2026-09-13 已真实调用并核验**
 *
 * 上一版这段注释写的是"预接线，从未发生过一次真实调用"，并列了一张
 * 全是"未核实"的表。今天用真实 Access Secret 逐项打过一遍，结果如下。
 * 注意最后两行：**旧假设对了四条，错了两条**，错的那两条都在代码里改了。
 *
 * | 项 | 旧假设 | 2026-09-13 实测 |
 * |---|---|---|
 * | `POST https://developer.zhihu.com/v1/chat/completions` | 未核实 | ✅ VERIFIED |
 * | `Authorization: Bearer <secret>` + `X-Request-Timestamp` | 对 search 已核实 | ✅ 直答同样适用 |
 * | `zhida-fast-1p5` / `zhida-thinking-1p5` / `zhida-agent` | 未核实 | ✅ 三个都在；瞎编的名字返回 400 `model_not_found` |
 * | 响应体是 OpenAI 形状 `choices[0].message.content` | **假设** | ✅ VERIFIED，且鉴权失败是诚实的 401，不是 200 里塞 error |
 * | 可以用 `response_format` 强制 JSON | 代码里已刻意不用 | ❌ **传了会被静默忽略**（HTTP 200，不报错也不生效）→ `safeParse` 必须能从散文里抠 JSON |
 * | `X-Request-Timestamp` 构造一次即可 | 旧实现这么写的 | ❌ **服务端校验它**，构造函数里算一次会越来越旧 → 改成每请求重算 |
 *
 * 额度也和文档不一致：官方 Skill 文档写"默认每个能力组每日 100 次"，
 * 本账号 `zhida_openai` 实测 **5000/天**。以 `quota` 的返回为准。
 */
export const ZHIDA_BASE_URL = 'https://developer.zhihu.com/v1';
export const ZHIDA_MODELS = ['zhida-fast-1p5', 'zhida-thinking-1p5', 'zhida-agent']         ;

export class ZhidaExtractor extends OpenAICompatibleExtractor {
  constructor(cfg                                      
                                                                                              
   ) {
    if (!cfg.accessSecret) throw new Error('缺少 ZHIHU_ACCESS_SECRET，拒绝以空凭证调用知乎官方 AI');
    super({
      provider: 'zhida',
      providerLabel: 'zhida',
      model: cfg.model ?? 'zhida-fast-1p5',
      baseUrl: cfg.baseUrl ?? ZHIDA_BASE_URL,
      apiKey: cfg.accessSecret,
      timeoutMs: cfg.timeoutMs ?? 30_000,
      fetchImpl: cfg.fetchImpl,
      // 每次请求重算。服务端校验这个时间戳，构造函数里算一次是个真 bug。
      extraHeaders: () => ({ 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)) }),
      // 直答没有 JSON mode，畸形输出的概率结构性地高于 Ollama，给它一次重试。
      maxAttempts: cfg.maxAttempts ?? 2,
      // 这两个必须**显式转发**。第一版忘了转发，于是测试里传 backoffBaseMs:1
      // 实际仍然按默认 2 秒退避——参数看起来生效了，其实没接上。
      backoffBaseMs: cfg.backoffBaseMs,
      maxBackoffMs: cfg.maxBackoffMs,
    });
  }
}

/** 2026-09-13 `zhihu-cli quota` 实测值。官方 Skill 文档写的"默认 100"不适用于本账号。 */
export const ZHIDA_DAILY_QUOTA = 5000;

/**
 * 探针：拿到权限后**第一件该做的事**。
 *
 * 它不产出任何产品数据，只回答一个问题：真实响应长什么样，和我们假设的一致吗？
 * 返回原始 body 的前若干字符，让人**眼睛看一遍**再决定要不要改映射。
 */
export async function probeZhida(
  accessSecret        ,
  model         = ZHIDA_MODELS[0],
  fetchImpl               = fetch,
)                                                                                                {
  const resp = await fetchImpl(`${ZHIDA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessSecret}`,
      'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复一个字：好' }] }),
  });
  const text = await resp.text();
  let shapeMatchesOpenAI = false;
  try {
    const j = JSON.parse(text);
    shapeMatchesOpenAI = typeof j?.choices?.[0]?.message?.content === 'string';
  } catch { /* 非 JSON，保持 false */ }
  return { ok: resp.ok, httpStatus: resp.status, shapeMatchesOpenAI, rawPreview: text.slice(0, 800) };
}

/**
 * 按配置造一个抽取器。
 *
 * 这个函数是整个"换模型"的**唯一**入口。业务代码里不应该出现 `new OllamaExtractor`。
 */
export function createExtractor(cfg                                            )               {
  switch (cfg.provider) {
    case 'ollama':
      return new OllamaExtractor({
        model: cfg.model, baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, fetchImpl: cfg.fetchImpl,
      });
    case 'openai_compatible':
      return new OpenAICompatibleExtractor(cfg);
    case 'zhida':
      return new ZhidaExtractor({ ...cfg, accessSecret: cfg.accessSecret ?? '' });
    default: {
      const never        = cfg.provider;
      throw new Error(`未知 provider: ${String(never)}`);
    }
  }
}

/**
 * 解析模型返回的 JSON。
 *
 * Ollama 那条路有 `format:'json'`，推理引擎保证输出是 JSON。
 * **直答没有 JSON mode**——`response_format` 传上去是 HTTP 200 静默忽略
 * （2026-09-13 实测）。所以这里必须多退一步：去掉 markdown 围栏之后，
 * 如果整段还不是合法 JSON，就取第一个 `{` 到最后一个 `}`。
 *
 * 这一步是对**缺少 JSON mode** 的补偿，不能反过来当成
 * "直答输出和本地模型一样规整"的证据。
 */
export function safeParse(s        )                                                     {
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const direct = tryJson(t);
  if (direct) return direct;
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return tryJson(t.slice(a, b + 1));
  return null;
}

function sleep(ms        )                {
  return new Promise((r) => setTimeout(r, ms));
}

function tryJson(t        )                                                     {
  try {
    const v = JSON.parse(t);
    return typeof v === 'object' && v !== null ? (v                           ) : null;
  } catch { return null; }
}
