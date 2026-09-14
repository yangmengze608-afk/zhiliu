/**
 * /analyze —— 唯一需要服务端的原因：Access Secret 不能进浏览器扩展。
 *
 * ## 隐私边界（红队审查后重写，去掉了做不到的承诺）
 *
 * **做得到的**：
 *   - 请求体字段白名单强制执行，客户端无法夹带用户 ID / 会话 ID / 阅读历史 /
 *     既往概念 / 集中度；出现多余字段直接 400。
 *   - handler 无状态：不建库、不持久化正文、不做跨请求画像。
 *   - 不再接收完整 URL，只接收公开内容 ID —— 那是**内容**的标识，不是**用户**的标识。
 *   - 长期阅读画像、趋势、集中度只在扩展本地计算，从不上传。
 *
 * **做不到的（必须诚实说出来）**：
 *   逐篇请求本身仍然会到达服务端。同一来源 IP 的请求序列加上到达时间，
 *   在网络层理论上仍可被重建成阅读轨迹。代码层面阻止不了这件事。
 *   因此本项目**不宣称**"服务器技术上绝对无法推断任何阅读轨迹"，
 *   只宣称"长期阅读画像与跨页面聚合只保存在本地，且服务端不接收任何用户状态"。
 */
import { validateExtraction } from '../packages/core/src/index.ts';
import type { ZhihuSearchResponse } from '../packages/core/src/index.ts';

export interface AnalyzeRequestBody {
  /** 公开内容的 ID（知乎的 answer/article id）。这是**内容**的标识，不是**用户**的标识。 */
  contentId?: string;
  contentType?: 'answer' | 'article';
  title: string;
  text: string;
}

/**
 * 允许出现在请求体里的字段白名单。
 *
 * 这是一条**可执行的**隐私约束，而不是一句承诺：出现任何白名单之外的字段
 * 一律 400 拒绝。这样客户端在物理上无法把 用户 ID、会话 ID、阅读历史、
 * 既往概念、集中度分数 之类的状态夹带过来——即使将来有人不小心加了字段，
 * 也会在这里立刻失败，而不是悄悄流到服务端。
 */
const ALLOWED_REQUEST_FIELDS = new Set(['contentId', 'contentType', 'title', 'text']);

/**
 * 明确不接受的字段。单独列出来是为了给出可读的报错，
 * 也是为了把"我们决定不要什么"写进代码而不是只写进文档。
 */
const FORBIDDEN_FIELDS = [
  'userId', 'uid', 'sessionId', 'session', 'deviceId', 'clientId', 'anonymousId',
  'history', 'readingHistory', 'previousConcepts', 'concentration', 'trend',
  'url', 'referrer', 'cookie', 'timestamp', 'readAt',
];

const MAX_TEXT = 8000;

export interface HandlerDeps {
  /** 仅在启用知乎证据层（解释/溯源）时需要；不参与概念判定 */
  accessSecret?: string;
  fixtures?: Record<string, ZhihuSearchResponse>;
  debug?: boolean;
}

/**
 * LLM 概念抽取接缝。
 *
 * 实现由部署方注入（`server/dev-server.ts` 默认注入 `ZhidaExtractor`，
 * `ZHILIU_PROVIDER=ollama` 时注入 `OllamaExtractor`）。
 * 这是刻意留白：接入哪家模型、用什么 key，由部署方决定。
 * 没有注入实现时，handler **必须显式失败**——
 * 早先的版本在这里跑的是已经退役的关键词 grounding 链路，
 * 对真实语料返回 0 个概念却被标记成"已完成 LLM 分析"，
 * 面板既不报错也不打标记，静默停在"数据积累中"。那比直接报错糟糕得多。
 */
export interface LlmRawResult {
  concepts?: Array<{ canonical?: string; confidence?: number }>;
  ambiguous?: boolean;
  unknown?: boolean;
  /** 模型来源。**必须**返回，否则客户端无法区分真实模型与常量 JSON */
  provenance?: { provider: string; model: string; promptVersion?: string; latencyMs?: number };
}

export type LlmExtract = (input: { title: string; text: string }) => Promise<LlmRawResult>;

export interface HandlerDeps2 {
  llmExtract?: LlmExtract;
  debug?: boolean;
}

export function createAnalyzeHandler(deps: HandlerDeps & HandlerDeps2 = {}) {
  return async function handle(body: unknown): Promise<{ status: number; json: unknown }> {
    const parsed = validate(body);
    if ('error' in parsed) return { status: 400, json: { error: parsed.error } };

    if (!deps.llmExtract) {
      // fail loud：未接模型就说未接模型，不要返回一个看起来正常的空结果
      return {
        status: 503,
        json: {
          error: 'llm_not_configured',
          message:
            '本服务需要注入 llmExtract 才能工作。仓库不含任何模型调用实现；' +
            '扩展在未配置 ANALYZE_ENDPOINT 时会走本地确定性 mock 并在面板上标注。',
          concepts: [],
          status: 'failed',
        },
      };
    }

    try {
      const raw = await deps.llmExtract({ title: parsed.title, text: parsed.text });
      // 没有 provenance 就不能声称是模型产出——这是客户端唯一能据以判断的东西
      if (!raw.provenance?.provider || !raw.provenance?.model) {
        return { status: 502, json: { concepts: [], status: 'failed', error: 'missing_provenance' } };
      }
      const result = validateExtraction(raw, 'llm');
      return {
        status: 200,
        json: {
          concepts: result.concepts,
          ambiguous: result.ambiguous,
          // **必须显式回传 unknown。**
          // 客户端会再校验一次（它不信任任何服务端），而它那一层有一条硬规则：
          // "concepts 是空数组、又没说 unknown" → 判为上游没做真实分析。
          // 那条规则是对的（一个返回常量 JSON 的假服务器正是这个形状），
          // 但如果这里不把 unknown 传下去，模型**正当地**说"这篇没有核心思想"
          // 就会在客户端变成一次**错误**：面板弹错误横幅、记录标成 failed。
          // 纯流水账、纯情绪宣泄在真实阅读里很常见，这不是异常路径。
          unknown: result.concepts.length === 0,
          status: result.status,
          provenance: raw.provenance,
          dropped: deps.debug ? result.dropped : undefined,
        },
      };
    } catch (err) {
      return {
        status: 502,
        json: {
          concepts: [], status: 'failed',
          error: err instanceof Error ? err.name : 'upstream_error',
        },
      };
    }
  };
}

export function validate(body: unknown): AnalyzeRequestBody | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body 必须是 JSON 对象' };
  const b = body as Record<string, unknown>;

  // 先查夹带。放在最前面，避免"字段齐全就放行"把多余状态一起收下。
  const smuggled = Object.keys(b).filter((k) => !ALLOWED_REQUEST_FIELDS.has(k));
  if (smuggled.length > 0) {
    const named = smuggled.filter((k) => FORBIDDEN_FIELDS.includes(k));
    return {
      error:
        `请求体只允许 ${[...ALLOWED_REQUEST_FIELDS].join('/')}，` +
        `收到多余字段：${smuggled.join(', ')}` +
        (named.length ? `（其中 ${named.join(', ')} 属于明确禁止上传的用户状态）` : ''),
    };
  }

  if (typeof b.title !== 'string' || typeof b.text !== 'string') {
    return { error: 'title / text 必填' };
  }
  if (b.text.length > MAX_TEXT) return { error: `正文过长（上限 ${MAX_TEXT}）` };
  if (b.contentType !== undefined && b.contentType !== 'answer' && b.contentType !== 'article') {
    return { error: 'contentType 只能是 answer / article' };
  }
  return {
    contentId: typeof b.contentId === 'string' ? b.contentId : undefined,
    contentType: b.contentType as 'answer' | 'article' | undefined,
    title: b.title,
    text: b.text,
  };
}
