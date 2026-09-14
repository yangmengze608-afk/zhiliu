/**
 * Stage B — 知乎语义 Grounding。
 *
 * ## 这一层到底在解决什么
 *
 * 候选召回是靠表层线索词做的，所以它天然会被"显眼但不代表主旨的词"带偏：
 * 一篇写社交焦虑的相亲经历，会因为反复出现「女性/男性/异性」而把「性别议题」
 * 顶到第一位。要修掉它，需要一个**外部的、知乎自己的**语义参照系。
 *
 * ## 机制
 *
 * 对每个候选概念 c，用官方 zhihu_search 取回它在知乎社区里的 Top-N 内容，
 * 构成它的「语义邻域」N(c)。然后判断：原文的用词分布更靠近哪一个邻域？
 *
 * 关键不在于"更像"，而在于**用什么词来判断更像**。这里用跨邻域 IDF：
 *
 *   df(t) = 含有词 t 的候选邻域数量
 *   w(t)  = ln(m / df(t))            // m = 候选数；df = m 时权重恰为 0
 *
 * 于是：
 * - 「女性/约会/外貌」在「性别议题」和「社交焦虑」两个邻域里**都**高频出现，
 *   df 高 → 权重被压到接近 0 → 它们不再能决定归属；
 * - 「紧张/回避/别人怎么看/心跳」只在社交焦虑邻域高频，df 低 → 权重高
 *   → 原文里这些词的出现变成决定性证据。
 *
 * 也就是说，**判别用的词表不是模型的先验，而是查询时从知乎语料现算出来的。**
 * 这正是"离开知乎语境后效果会下降"的原因：换一个语料，邻域重叠结构就变了，
 * 区分性词汇也就不同。
 */
import { dot, l2Normalize, termFrequency } from './tokenize.ts';
import { surfaceFormsOf } from './registry.ts';
import type { CandidateConcept, SemanticNeighborhood, ZhihuSearchItem } from './types.ts';

export interface GroundingConfig {
  /** 标题在邻域画像中的重复次数（标题信息密度高于摘要） */
  titleWeight: number;
  /** 精选评论权重，0 表示不使用 */
  commentWeight: number;
  /** RankingScore 的影响强度，0 = 完全不看排序分 */
  rankingInfluence: number;
  /** 判定某词"存在于该邻域"的最低归一化词频 */
  presenceThreshold: number;
  /** 抑制自指词面命中 */
  suppressSelfSurface: boolean;
}

export const DEFAULT_GROUNDING_CONFIG: GroundingConfig = {
  titleWeight: 3,
  commentWeight: 1,
  rankingInfluence: 1,
  presenceThreshold: 0.004,
  suppressSelfSurface: true,
};

/** 把一组知乎搜索结果压成一个加权词频画像。 */
export function buildNeighborhood(
  label: string,
  query: string,
  items: ZhihuSearchItem[],
  config: GroundingConfig = DEFAULT_GROUNDING_CONFIG,
): SemanticNeighborhood {
  const profile = new Map<string, number>();

  for (const item of items) {
    // RankingScore 是官方给的相关性排序分；用它加权，让更代表该概念的内容说话更响。
    const rank = Number.isFinite(item.RankingScore) ? item.RankingScore : 0.5;
    const weight = 1 + config.rankingInfluence * rank;

    const parts: string[] = [];
    for (let i = 0; i < config.titleWeight; i++) parts.push(item.Title ?? '');
    parts.push(item.ContentText ?? '');
    if (config.commentWeight > 0) {
      for (const c of item.CommentInfoList ?? []) {
        for (let i = 0; i < config.commentWeight; i++) parts.push(c.Content ?? '');
      }
    }

    const tf = termFrequency(parts.join('\n'));
    for (const [t, v] of tf) profile.set(t, (profile.get(t) ?? 0) + v * weight);
  }

  return {
    label,
    query,
    itemCount: items.length,
    profile: l2Normalize(profile),
    sampleTitles: items.slice(0, 3).map((i) => i.Title),
  };
}

export interface GroundingScore {
  label: string;
  raw: number;
  normalized: number;
  /** 对该候选贡献最大的区分性词，用于向用户与评委解释判定依据 */
  topTerms: string[];
  neighborhoodSize: number;
}

/**
 * 用跨邻域 IDF 加权，比较原文与各候选邻域的接近程度。
 *
 * 只有 >=2 个邻域时 IDF 才有意义；单邻域退化成普通余弦，此时调用方
 * 应当直接标记 ungrounded 而不是相信这个分数。
 */
const EMPTY_SET: Set<string> = new Set();

export function groundCandidates(
  title: string,
  text: string,
  candidates: CandidateConcept[],
  neighborhoods: SemanticNeighborhood[],
  config: GroundingConfig = DEFAULT_GROUNDING_CONFIG,
): GroundingScore[] {
  const usable = neighborhoods.filter((n) => n.itemCount > 0);
  const m = usable.length;
  if (m === 0) return [];

  // 跨邻域文档频率
  const df = new Map<string, number>();
  for (const n of usable) {
    for (const [t, v] of n.profile) {
      if (v >= config.presenceThreshold) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  // 判别权重。用标准 IDF ln(m/df) 而不是 ln(1+m/df)：
  // 一个在**所有**候选邻域里都出现的词，按定义没有任何判别力，权重应当正好是 0，
  // 而不是保留 ln(2)≈0.69 的残余话语权。ln(1+m/df) 那条曲线太平——
  // m=3 时 df=1 得 1.386、df=3 仍有 0.693，只差 2 倍，
  // 「女性/约会/外貌」这类共享表层词照样能压过独有词。
  const idf = (t: string): number => {
    const d = df.get(t) ?? 0;
    if (d === 0) return 0; // 原文里有但所有邻域都没有的词，无判别力
    return Math.log(m / d);
  };

  const articleTf = l2Normalize(termFrequency(`${title} ${title} ${text}`));

  // 自指抑制：**只抑制候选自己的**词面，不抑制其他候选的。
  //
  // 原实现把所有候选的词面并成一个全局黑名单，后果是灾难性的：
  // 判定「社交焦虑」时，因为别名里有「社交紧张」，"紧张"这个词被永久删除——
  // 而"紧张"恰恰是社交焦虑最强的判别证据之一。同理被误删的还有
  // 「负面评价恐惧」带走的"评价"、「情绪调节」带走的"情绪"、
  // 「收入」带走的"工资"、「睡眠」带走的"失眠"。
  //
  // 抑制自指是为了防同义反复，防的是 c 对 c，不是 c 对 d。
  const selfSuppressed = new Map<string, Set<string>>();
  if (config.suppressSelfSurface) {
    for (const c of candidates) {
      const set = new Set<string>();
      for (const form of surfaceFormsOf(c.label)) {
        const chars = [...form];
        for (let i = 0; i < chars.length; i++) {
          set.add(chars[i]);
          if (i + 1 < chars.length) set.add(chars[i] + chars[i + 1]);
        }
      }
      selfSuppressed.set(c.label, set);
    }
  }

  const scores: GroundingScore[] = [];
  for (const n of usable) {
    let sum = 0;
    const contrib: Array<[string, number]> = [];
    const suppressed = selfSuppressed.get(n.label) ?? EMPTY_SET;
    // 遍历原文词表：只有原文出现过的词才可能提供证据
    for (const [t, av] of articleTf) {
      if (suppressed.has(t)) continue;
      const nv = n.profile.get(t);
      if (nv === undefined) continue;
      const w = idf(t);
      if (w <= 0) continue; // 所有邻域共享的词：判别力为零，直接跳过
      const c = av * nv * w;
      if (c > 0) {
        sum += c;
        contrib.push([t, c]);
      }
    }
    contrib.sort((a, b) => b[1] - a[1]);
    scores.push({
      label: n.label,
      raw: sum,
      normalized: 0,
      topTerms: pickExplanationTerms(contrib),
      neighborhoodSize: n.itemCount,
    });
  }

  const total = scores.reduce((s, x) => s + x.raw, 0);
  for (const s of scores) s.normalized = total > 0 ? s.raw / total : 0;
  scores.sort((a, b) => b.raw - a.raw);
  return scores;
}

/** 供 grounding 使用的余弦，便于单测直接调用。 */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  return dot(l2Normalize(a), l2Normalize(b));
}


/**
 * 挑选给人看的"判别依据"。
 *
 * 打分用全部 term，但**展示**不能直接把打分靠前的 term 倒出来：
 * 「说不出话」在 bigram 下会拆成 说不 / 不出 / 出话 三个相邻 shingle，
 * 它们会连续占掉三个展示位，读起来像乱码，而信息量只有一个词。
 *
 * 因此展示层只保留双字词，并且丢掉与任何已选词共享汉字的候选——
 * 「说不」「不出」「出话」共享字，只会留下最高分的那一个。
 * 这是展示层的多样性启发式：宁可少给一个词，也不要给三个碎片。
 * 它只影响解释文案，不影响任何得分。
 */
export function pickExplanationTerms(contrib: Array<[string, number]>, limit = 8): string[] {
  const kept: string[] = [];
  for (const [t] of contrib) {
    if ([...t].length !== 2) continue; // 单字太歧义，长 ASCII 词另算
    const chars = new Set([...t]);
    const overlaps = kept.some((k) => [...k].some((c) => chars.has(c)));
    if (overlaps) continue;
    kept.push(t);
    if (kept.length >= limit) break;
  }
  // 双字词不够时用 ASCII 词补位（AI、gpt 这类本来就是完整词）
  if (kept.length < limit) {
    for (const [t] of contrib) {
      if (/^[a-z][a-z0-9+#.]+$/.test(t) && !kept.includes(t)) {
        kept.push(t);
        if (kept.length >= limit) break;
      }
    }
  }
  return kept;
}
