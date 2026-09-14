/**
 * 真实 LLM 概念抽取。
 *
 * 这是仓库里**第一处真正的模型调用**。在此之前，"LLM-only 主链路"
 * 只是一个校验器加一组确定性 mock —— 那次自我欺骗被红队抓到过一次，
 * 所以这里的每一条约束都是为了让"假装调用"在结构上不可能发生：
 *
 * - `provider` / `model` 由实现自己声明，写进结果的 provenance
 * - 输出必须通过 schema 校验，畸形就重试，重试仍失败就 fail loud
 * - 超时 fail loud，不静默降级
 * - **任何失败都不会返回 mock**；调用方拿到的是 `status:'failed'`
 * - 返回 0 个概念且不是 unknown → 判为畸形，不当成"这篇没有核心思想"
 */
import { validateExtraction, MAX_CONCEPTS } from './extract.ts';
import type { ExtractionInput, ExtractionResult } from './extract.ts';
import { CONCEPTS } from './registry.ts';
import { ANALYSIS_VERSION } from './model.ts';

export interface LlmProvenance {
  provider: string;
  model: string;
  /** 产出该结果的 prompt 版本。跟着结果一路写进 ReadEvent。 */
  promptVersion: string;
  latencyMs: number;
  promptTokens?: number;
  outputTokens?: number;
  attempts: number;
}

export interface LlmExtractionResult extends ExtractionResult {
  provenance: LlmProvenance;
}

export interface LLMExtractor {
  readonly provider: string;
  readonly model: string;
  extract(input: ExtractionInput): Promise<LlmExtractionResult>;
}

const VOCAB = CONCEPTS.map((c) => c.canonical);

/** 正文截断上限。真正的截断策略在 sanitize.ts，这里只兜底。 */
const MAX_TEXT = 2000;

/**
 * Prompt 版本。**改 prompt 必须改这个常量**——它会写进每条 ReadEvent，
 * 否则 v1 和 v2 产出的标签混在同一个面板里，以后无法解释谁是谁。
 *
 * v1 → v2 的唯一实质变化：修掉「结构性单主题偏置」。
 *
 * v1 的规则 2 只有一句「宁少勿多」，没有任何反向配平；规则 5 又把
 * "可以读成两件事" 引向 `ambiguous` 而不是引向两个概念。两条叠加的结果是
 * 3B / 7B 在 18 条实测里输出 ≥2 概念的条数 **都是 0**——多主题文章被压成单主题。
 * v2 保留「不要凑数」，但补上对称的另一半，并把 ambiguous 的定义收窄。
 *
 * 对称性是刻意的：正例（真多主题 → 2 个）和反例（单主题 → 1 个）成对出现，
 * 否则这就是在用 prompt 人工制造多主题，而不是让模型识别多主题。
 *
 * v2 → v3：v2 的散文规则没起作用（3B / 7B 在 6 条多主题上都是 0/6）。
 * 抓原始输出发现问题不在"模型看不出两件事"，而在**它没法把两件事写出来**：
 *   as-21（房产 + 亲密关系）→ 7B 输出了 `财务问题与关系处理`
 *   as-03（职场关系）      → 7B 输出了 `沟通`
 * 它把两个主题**融成一个自造词**，然后因为不在词表里被整条丢弃。
 * 两个疑点因此浮出来：
 *   (a) 输出格式示例里 `concepts` 数组**只有一个元素**，小模型会照抄形状；
 *   (b) 从来没有一句话说过 canonical 必须逐字来自词表、不许自造。
 * v3 只修这两点：格式示例改成一个单概念 + 一个双概念**成对**出现，
 * 并补一条"逐字抄词表、不许合并造词"。仍然没有任何一句话在鼓励多给。
 *
 * **停止规则（先写死）**：prompt 到 v3 为止。v3 之后无论多主题结果如何，
 * 都不再改 prompt，只如实记录——再调下去就是在对着 29 条验收集过拟合。
 */
export const PROMPT_VERSION = 'v3-shape';

export function buildPrompt(input: ExtractionInput): { system: string; user: string } {
  const text = input.text.length > MAX_TEXT ? input.text.slice(0, MAX_TEXT) : input.text;
  return {
    system: '你是中文内容的核心思想抽取器。只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。',
    user: [
      '判断下面这篇内容**真正在讨论什么**，输出 1–3 个核心概念。',
      '',
      `只能从这个词表里选：${VOCAB.join('、')}`,
      '',
      '规则：',
      '1. 看作者对什么提出了问题，而不是看什么词出现得多。',
      '2. **不要凑数**。只有一个核心思想，就只给一个。',
      '3. 但如果这篇**确实同时在讨论两件不同的事**（比如既谈某个技术变化，又谈它逼着某个制度做什么调整），',
      '   那就**两个都给**。把它压成一个，等于丢掉了作者一半的意思。',
      '   判据：去掉其中任何一个，文章的主张都不再完整 → 两个都要。',
      '4. confidence 是 0–1 的小数，如实给，不要一律给高分。',
      '5. 没有稳定核心思想（太琐碎、纯情绪宣泄、纯闲聊、流水账）→ unknown 为 true，concepts 为空数组。',
      '6. ambiguous 只用于**同一个**核心思想有两种互斥读法、你无法确定是哪一种。',
      '   "文章确实同时讲了两件事" **不是** ambiguous——那种情况按规则 3 输出两个概念。',
      '7. canonical 必须**逐字**是上面词表里的词。不许自己造词，不许把两个词合并成一个新词。',
      '   如果你想说的意思要用两个词才说得完，就在数组里放两个元素，而不是拼成一个词。',
      '',
      '两个例子（注意它们方向相反）：',
      '· "AI 让很多岗位消失，所以大学专业设置必须跟着改" → 两个：工作替代 + 学习方法 …… 因为去掉任一个都讲不通。',
      '· "我面试老是紧张，一进会议室手就抖" → 一个：社交焦虑 …… 不要再补上"就业"来凑数。',
      '',
      '输出格式（必须包含 confidence）。上面两个例子分别长这样：',
      '· 单主题：{"concepts":[{"canonical":"社交焦虑","confidence":0.85}],"ambiguous":false,"unknown":false}',
      '· 双主题：{"concepts":[{"canonical":"工作替代","confidence":0.85},{"canonical":"学习方法","confidence":0.7}],"ambiguous":false,"unknown":false}',
      '',
      `标题：${input.title}`,
      `正文：${text}`,
    ].join('\n'),
  };
}

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  /**
   * 模型在显存/内存里保留多久。Ollama 默认 5 分钟，之后卸载。
   *
   * 这在本产品里是个真问题：14B 冷加载实测 **48 秒**，而分析超时是 20 秒。
   * 用户中午读完几篇、下午再打开知乎，第一篇必然撞上冷加载并**超时失败**。
   * 启动预热只解决"服务刚起来"那一次，解决不了"闲置五分钟之后"。
   */
  keepAlive?: string;
}

/**
 * Ollama 本地推理服务。
 *
 * 选它的原因很实际：当前环境里 DashScope 的 key 有效但配额已耗尽、
 * Gemini CLI 的账号层级不再受支持，Ollama 是唯一能真正跑起来的模型服务。
 * 它是本地的、免费的、可复现的，对"证明链路真实"这个目标完全够用。
 * 换成任何 OpenAI 兼容端点只需要再写一个 LLMExtractor 实现。
 */
export class OllamaExtractor implements LLMExtractor {
  readonly provider = 'ollama';
  readonly model: string;
  #baseUrl: string;
  #timeoutMs: number;
  #maxAttempts: number;
  #fetch: typeof fetch;
  #keepAlive: string;

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? 'qwen2.5:14b';
    this.#baseUrl = opts.baseUrl ?? 'http://127.0.0.1:11434';
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    this.#maxAttempts = opts.maxAttempts ?? 2;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#keepAlive = opts.keepAlive ?? '30m';
  }

  async extract(input: ExtractionInput): Promise<LlmExtractionResult> {
    const { system, user } = buildPrompt(input);
    const started = Date.now();
    let lastProblem = 'unknown';
    let promptTokens: number | undefined;
    let outputTokens: number | undefined;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs);
      try {
        const resp = await this.#fetch(`${this.#baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: this.model,
            stream: false,
            format: 'json',
            keep_alive: this.#keepAlive,
            options: { temperature: 0.2, num_predict: 300 },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        });

        if (!resp.ok) {
          lastProblem = `provider_http_${resp.status}`;
          continue;
        }

        const body = (await resp.json()) as {
          message?: { content?: string };
          eval_count?: number;
          prompt_eval_count?: number;
        };
        promptTokens = body.prompt_eval_count;
        outputTokens = body.eval_count;

        const raw = safeParse(body.message?.content ?? '');
        if (!raw) {
          lastProblem = 'malformed_json';
          continue;
        }

        const validated = validateExtraction(raw, 'llm');
        if (validated.status === 'failed') {
          lastProblem = validated.dropped[0] ?? 'schema_rejected';
          continue;
        }
        // 模型没说 unknown 却一个概念都没给 → 视为畸形输出而不是"没有核心思想"
        if (validated.concepts.length === 0 && raw.unknown !== true) {
          lastProblem = 'empty_concepts_without_unknown';
          continue;
        }

        return {
          ...validated,
          concepts: validated.concepts.slice(0, MAX_CONCEPTS),
          provenance: {
            provider: this.provider, model: this.model, promptVersion: PROMPT_VERSION,
            latencyMs: Date.now() - started,
            promptTokens, outputTokens, attempts: attempt,
          },
        };
      } catch (err) {
        lastProblem = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'provider_error';
      } finally {
        clearTimeout(timer);
      }
    }

    // 全部尝试失败 —— fail loud，绝不返回 mock 也绝不盖章成 llm
    return {
      concepts: [], ambiguous: false, status: 'failed',
      analysisVersion: ANALYSIS_VERSION,
      dropped: [lastProblem],
      provenance: {
        provider: this.provider, model: this.model, promptVersion: PROMPT_VERSION,
        latencyMs: Date.now() - started,
        promptTokens, outputTokens, attempts: this.#maxAttempts,
      },
    };
  }
}

function safeParse(s: string): { unknown?: boolean; [k: string]: unknown } | null {
  const t = s.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const v = JSON.parse(t);
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}
