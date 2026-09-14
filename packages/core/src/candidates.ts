/**
 * Stage A — 候选概念召回。
 *
 * 这一层刻意**只做召回，不做判定**：它用词面证据挑出 3–5 个"值得被认真比较"的
 * 候选解释，把判定权交给 Stage B 的知乎语义 Grounding。
 *
 * 单独使用这一层就是 Baseline A（纯关键词方法）——benchmark 里正是用它做对照，
 * 从而把"知乎 API 到底贡献了什么"隔离出来。
 */
import { CONCEPTS, recallFormsOf } from './registry.ts';
import { termFrequency } from './tokenize.ts';
import type { CandidateConcept } from './types.ts';

export interface CandidateOptions {
  maxCandidates?: number;
  /** 单个表层词贡献占比超过该值时，标记 surfaceKeywordRisk */
  surfaceRiskRatio?: number;
}

/**
 * 词面召回：统计文章中每个 canonical concept 的别名/本名出现强度。
 *
 * 用出现次数的平方根而不是原始次数，避免一个词狂刷 30 次就锁死结果——
 * 表层词高频恰恰是本项目要防的失败模式。
 */
export function extractCandidates(
  title: string,
  text: string,
  options: CandidateOptions = {},
): CandidateConcept[] {
  const maxCandidates = options.maxCandidates ?? 5;
  const surfaceRiskRatio = options.surfaceRiskRatio ?? 0.6;

  // 标题权重高于正文：知乎标题通常就是问题本身
  const haystack = `${title} ${title} ${text}`;
  const tf = termFrequency(haystack);

  const scored: CandidateConcept[] = [];
  for (const c of CONCEPTS) {
    const hits: Array<{ form: string; count: number }> = [];
    for (const form of recallFormsOf(c.canonical)) {
      const count = countForm(tf, form);
      if (count > 0) hits.push({ form, count });
    }
    if (hits.length === 0) continue;

    const total = hits.reduce((s, h) => s + h.count, 0);
    const score = hits.reduce((s, h) => s + Math.sqrt(h.count), 0);
    const top = hits.reduce((a, b) => (a.count >= b.count ? a : b));
    scored.push({
      label: c.canonical,
      query: c.canonical,
      lexicalScore: score,
      evidence: hits
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map((h) => `${h.form}×${h.count}`),
      surfaceKeywordRisk: hits.length === 1 || top.count / total >= surfaceRiskRatio,
    });
  }

  scored.sort((a, b) => b.lexicalScore - a.lexicalScore);
  return scored.slice(0, maxCandidates);
}

/**
 * 一个概念词面在 tf 中的出现强度。
 * 多字词按其 bigram 的最小值估计（"社交焦虑" -> min(社交, 交焦, 焦虑)），
 * 这样"社交"和"焦虑"分别出现但从不相邻时不会被误判成命中。
 */
function countForm(tf: Map<string, number>, form: string): number {
  const chars = [...form];
  if (chars.length === 1) return tf.get(form) ?? 0;
  let min = Infinity;
  for (let i = 0; i + 1 < chars.length; i++) {
    const bg = chars[i] + chars[i + 1];
    min = Math.min(min, tf.get(bg) ?? 0);
  }
  return min === Infinity ? 0 : min;
}
