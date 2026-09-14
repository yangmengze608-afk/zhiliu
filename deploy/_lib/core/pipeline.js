/**
 * 核心链路：Article → Candidate Concepts → Zhihu Semantic Grounding → Final Concepts
 *
 * 三个 arm 共用同一份候选召回，差别只在判定方式，
 * 因此 benchmark 里 System 与 Baseline A 的差值可以干净地归因到知乎 API。
 */
import { extractCandidates } from './candidates.js';
import { DEFAULT_GROUNDING_CONFIG, buildNeighborhood, groundCandidates } from './grounding.js';
import { DEFAULT_ADJUDICATION_CONFIG, adjudicate } from './adjudicate.js';
                                                      
                                                          
import { ConceptCorpus } from './corpus.js';
import { CONCEPTS } from './registry.js';
                                                           
                                                                                     

                                 
     
            
                                              
                                                                
     
                             
                                  
                         
                         
                            
                              
                                    
                  
 

/** 正文截断长度：控制上游成本，同时保住开头（知乎回答的问题意识通常在前段）。 */
export const MAX_TEXT_CHARS = 4000;

const CONCEPT_LABELS = CONCEPTS.map((c) => c.canonical);

/**
 * Baseline A —— 只看正文表层线索词。
 * 这不是稻草人：它用的是与 System 完全相同的候选召回结果，
 * 唯一区别是直接采信词面排序，不做知乎语义校准。
 */
export function analyzeLexicalOnly(content                  , options                 = {})                 {
  const candidates = extractCandidates(content.title, clip(content.text), {
    maxCandidates: options.maxCandidates ?? 5,
  });
  if (candidates.length === 0) {
    return { concepts: [], rejected: [], overallConfidence: 0, status: 'ungrounded', conceptStatus: 'unknown' };
  }
  const total = candidates.reduce((s, c) => s + c.lexicalScore, 0);
  const top = candidates.slice(0, 3).filter((c, i) => i === 0 || c.lexicalScore >= candidates[0].lexicalScore * 0.62);
  return {
    concepts: top.map((c) => ({
      label: c.label,
      confidence: Math.round((c.lexicalScore / total) * 1000) / 1000,
      reason: `词面命中：${c.evidence.join('、')}`,
    })),
    rejected: candidates.slice(top.length).map((c) => ({
      label: c.label,
      score: Math.round((c.lexicalScore / total) * 1000) / 1000,
      reason: '词面强度较低',
    })),
    overallConfidence: Math.round((candidates[0].lexicalScore / total) * 1000) / 1000,
    status: 'ungrounded',
    conceptStatus: 'confident',
  };
}

/** System —— 候选召回 + 知乎语义 Grounding + 允许不确定的判定。 */
export async function analyze(
  content                  ,
  client                   ,
  options                 = {},
)                          {
  const text = clip(content.text);
  const maxCandidates = options.maxCandidates ?? 5;
  const size = options.neighborhoodSize ?? 8;
  const groundingCfg = options.grounding ?? DEFAULT_GROUNDING_CONFIG;
  const mode = options.recall ?? 'corpus';

  const corpus = options.corpus ?? new ConceptCorpus(client, size, groundingCfg);

  const candidates                     =
    mode === 'corpus'
      ? await corpus.recall(content.title, text, maxCandidates)
      : extractCandidates(content.title, text, { maxCandidates });

  if (candidates.length === 0) {
    // 区分两种"没有候选"：
    //  - 语料库本身取不回来（上游失败/无凭证）→ ungrounded，不能声称已校准
    //  - 语料库正常但原文与任何概念都不接近 → grounded 的 unknown，是一个真实结论
    const corpusAvailable = mode === 'cues' || corpus.neighborhoodsFor(CONCEPT_LABELS).length > 0;
    return {
      concepts: [],
      rejected: [],
      overallConfidence: 0,
      status: corpusAvailable ? 'grounded' : 'ungrounded',
      conceptStatus: 'unknown',
    };
  }

  // 单候选时没有可比较对象，跨邻域 IDF 无意义 —— 直接降级，不假装已校准。
  if (candidates.length === 1) {
    return {
      concepts: [],
      rejected: [{ label: candidates[0].label, score: 0, reason: '只召回到一个候选，无法做跨邻域判别' }],
      overallConfidence: 0,
      status: 'ungrounded',
      conceptStatus: 'unknown',
    };
  }

  // corpus 模式下邻域已经在召回阶段取过，直接复用，不再重复请求。
  const neighborhoods =
    mode === 'corpus'
      ? corpus.neighborhoodsFor(candidates.map((c) => c.label))
      : await Promise.all(
          candidates.map(async (c) =>
            buildNeighborhood(c.label, c.query, await client.neighborhoodItems(c.query, size), groundingCfg),
          ),
        );

  const usable = neighborhoods.filter((n) => n.itemCount > 0);
  if (usable.length < 2) {
    // 知乎侧没给回足够语料，就不要声称已经做过校准。
    return {
      concepts: [],
      rejected: [],
      overallConfidence: 0,
      status: 'ungrounded',
      conceptStatus: 'unknown',
    };
  }

  const scores = groundCandidates(content.title, text, candidates, usable, groundingCfg);
  const verdict = adjudicate(scores, options.adjudication ?? DEFAULT_ADJUDICATION_CONFIG);

  const result                 = {
    concepts: verdict.concepts,
    rejected: verdict.rejected,
    overallConfidence: verdict.overallConfidence,
    status: 'grounded',
    conceptStatus: verdict.status,
  };

  if (options.debug) {
    result.debug = {
      candidates,
      scores: scores.map((s) => ({ label: s.label, raw: s.raw, normalized: s.normalized })),
      discriminativeTerms: scores.map((s) => ({ label: s.label, terms: s.topTerms })),
      searchCalls: usable.length,
    };
  }
  return result;
}

function clip(text        )         {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

/**
 * 用**外部给定的候选**跑知乎语义 Grounding。
 *
 * 这是 `docs/SEMANTIC_GROUNDING.md` 原本设计的形态：Stage A 由 LLM 生成候选解释，
 * Stage B 用知乎语料裁决。它把"LLM 理解力"和"知乎语料校准"解耦，
 * 因此可以单独回答那个真正重要的问题：
 *
 *   **在一个已经很强的 LLM 之上，知乎 Grounding 还能不能再降低误判？**
 *
 * 只做重排，不新增也不删除候选——保证与"LLM 直接分类"的对照是干净的。
 */
export async function analyzeGivenCandidates(
  content                  ,
  corpus               ,
  candidateLabels          ,
  options                 = {},
)                          {
  const text = clip(content.text);
  const groundingCfg = options.grounding ?? DEFAULT_GROUNDING_CONFIG;

  await corpus.ensureLoaded();
  const neighborhoods = corpus.neighborhoodsFor(candidateLabels);

  if (neighborhoods.length < 2) {
    return { concepts: [], rejected: [], overallConfidence: 0, status: 'ungrounded', conceptStatus: 'unknown' };
  }

  const candidates                     = candidateLabels.map((label, i) => ({
    label,
    query: label,
    lexicalScore: candidateLabels.length - i, // 保留 LLM 给的排序，仅作记录
    evidence: [],
    surfaceKeywordRisk: false,
  }));

  const scores = groundCandidates(content.title, text, candidates, neighborhoods, groundingCfg);
  const verdict = adjudicate(scores, options.adjudication ?? DEFAULT_ADJUDICATION_CONFIG);

  const result                 = {
    concepts: verdict.concepts,
    rejected: verdict.rejected,
    overallConfidence: verdict.overallConfidence,
    status: 'grounded',
    conceptStatus: verdict.status,
  };
  if (options.debug) {
    result.debug = {
      candidates,
      scores: scores.map((x) => ({ label: x.label, raw: x.raw, normalized: x.normalized })),
      discriminativeTerms: scores.map((x) => ({ label: x.label, terms: x.topTerms })),
      searchCalls: neighborhoods.length,
    };
  }
  return result;
}
