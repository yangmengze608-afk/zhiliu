/**
 * 概念抽取契约（LLM-only）。
 *
 * 上一轮 100 条盲测的结论是：知乎 Search 证据带不来可检测的准确率增益
 * （四个证据层两两之间 McNemar p 0.125–1.000），因此主链路**不再**把知乎
 * Grounding 放在前面，只保留 LLM。
 *
 * 注意那次盲测里的「LLM」是 **Claude 实验分类器**，不是本产品出货时跑的模型。
 * 那组数字（0.889 等）只支持"证据层无增益"这个结论，**不能**当作本产品的准确率。
 * 产品自己的模型选型见 `docs/MODEL_SELECTION.md`。
 *
 * 这一层的职责不是"更准"，而是**输出可靠**：
 * schema 校验、拒绝凑数、允许说不知道、失败时明确降级。
 *
 * ## 重要：这个模块只做校验，不做调用
 *
 * 真正的模型调用在 `llm.ts`（`OllamaExtractor`）和 `providers.ts`。
 * 本模块**只**负责校验，因此 `validateExtraction` 绝不能无条件把结果
 * 盖章成 `status:'llm'`：那会让 mock 数据和"服务端返回空"都伪装成真实分析，
 * 面板不打标记、不报错，静默停在"数据积累中"。
 * 调用方必须显式告诉它这批概念的**真实来源**——`source` 参数默认是
 * `'ungrounded'` 而不是 `'llm'`，就是为了让"忘了传"的后果是保守而不是撒谎。
 */
import { canonicalizeAll } from './canonicalize.js';
import { ANALYSIS_VERSION } from './model.js';
                                                   

                                  
                
               
                     
                                     
 

/** LLM 返回的原始结构（未经校验）。 */
                                
                                                                                
                      
                    
 

                                   
                                                             
                     
                           
                          
                                  
                    
                                                  
                      
 

/** 低于此置信度的概念不进入统计。 */
export const MIN_CONFIDENCE = 0.35;
export const MAX_CONCEPTS = 3;

/**
 * 模型漏给 confidence 时使用的中性值。
 *
 * 为什么不是"漏给就丢掉"：实测 qwen2.5:3b 在 29 条验收集上会输出
 * `{"concepts":[{"canonical":"睡眠"},{"confidence":0.95}]}` 或干脆整条不带 confidence——
 * 概念判断是**对的**，只是把那个数字漏了或拆成了另一个对象。
 * 旧逻辑把这些整条丢弃，于是 29 条里 13 条被判成 `empty_concepts_without_unknown`。
 * 那衡量的是本解析器的脆弱，不是模型的语义能力。
 *
 * 取 0.5 而不是取高值：模型没表态，我们就不替它表态成"很确信"。
 * 补过的字段一律记进 `repaired`，可审计。
 */
export const MISSING_CONFIDENCE_DEFAULT = 0.5;

/**
 * 校验并规范化 LLM 输出。
 *
 * 三条硬规则：
 * 1. 最多 3 个概念，**不足 3 个不补齐**——凑数会稀释统计；
 * 2. 低置信度概念直接丢弃，而不是留着"聊胜于无"；
 * 3. 归一化后为空 → unknown，不产出任何概念。
 */
export function validateExtraction(raw         , source                   = 'ungrounded')                   {
  const fail = (why        )                   => ({
    concepts: [], ambiguous: false, status: 'failed', analysisVersion: ANALYSIS_VERSION, dropped: [why],
  });

  if (typeof raw !== 'object' || raw === null) return fail('返回不是对象');
  const r = raw                 ;
  if (r.unknown === true) {
    return { concepts: [], ambiguous: false, status: source, analysisVersion: ANALYSIS_VERSION, dropped: [] };
  }
  if (!Array.isArray(r.concepts)) return fail('缺少 concepts 数组');

  const dropped           = [];
  const repaired           = [];
  const candidates                                               = [];
  for (const c of r.concepts) {
    const label = (c?.canonical ?? c?.label ?? '').trim();
    const given = typeof c?.confidence === 'number' ? c.confidence : NaN;
    // 只有"漏给"才补默认值；给了但越界（-1、5、NaN）说明模型在乱写，仍然丢弃。
    const missing = c === null || c === undefined || c.confidence === undefined || c.confidence === null;
    const conf = missing ? MISSING_CONFIDENCE_DEFAULT : given;
    if (!label) { dropped.push('(空标签)'); continue; }
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) { dropped.push(`${label}(置信度非法)`); continue; }
    if (missing) repaired.push(`${label}(置信度缺失→${MISSING_CONFIDENCE_DEFAULT})`);
    if (conf < MIN_CONFIDENCE) { dropped.push(`${label}(置信度${conf.toFixed(2)}过低)`); continue; }
    candidates.push({ label, confidence: conf });
  }

  const { concepts, unresolved } = canonicalizeAll(candidates);
  for (const u of unresolved) dropped.push(u.note ?? '无法归一');

  const kept = concepts.slice(0, MAX_CONCEPTS).map((c) => ({ canonical: c.canonical, confidence: round2(c.confidence) }));

  // 服务端明明返回了东西却一个概念都留不下来，说明上游没有真的做分析。
  // 这种情况必须报失败，不能静默当成"这篇没有核心思想"。
  if (kept.length === 0 && candidates.length === 0 && (r.concepts?.length ?? 0) === 0) {
    return fail('上游返回了空的 concepts 数组——未做真实分析');
  }

  return {
    concepts: kept,
    ambiguous: r.ambiguous === true,
    status: source,
    analysisVersion: ANALYSIS_VERSION,
    dropped,
    repaired,
  };
}

/** 是否应计入统计。歧义、未知、失败都不进主统计。 */
export function countsTowardStats(r                  )          {
  return r.status !== 'failed' && !r.ambiguous && r.concepts.length > 0;
}

                                   
                                  
                                                             
 

function round2(n        )         {
  return Math.round(n * 100) / 100;
}
