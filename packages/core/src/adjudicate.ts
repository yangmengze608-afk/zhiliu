/**
 * 判定层：把 Grounding 分数变成 1–3 个最终概念，并且**允许说"不知道"**。
 *
 * 设计前提：错误的确定比诚实的不确定伤害更大。一个被强行分类的 ambiguous 文章
 * 会永久污染占比、趋势和集中度；一个被标记为 unknown 的文章只是暂时不计入。
 */
import { commonParent } from './registry.ts';
import type { GroundingScore } from './grounding.ts';
import type { ConceptStatus, FinalConcept, RejectedConcept } from './types.ts';

export interface AdjudicationConfig {
  /**
   * Top1 相对**均匀分布**的提升倍数下限，低于此值 → unknown。
   *
   * 不能用绝对阈值：归一化分的量纲取决于候选数 m。m=5 时均匀分布每个就是 0.2，
   * 一个 0.3 的绝对门槛等于要求 1.5 倍提升；m=3 时均匀是 0.333，同一个门槛
   * 反而低于均匀分布，永远不会触发。原实现正是栽在这里——
   * 30 条评测样本里有 15 条被误判成 unknown。
   *
   * lift = top1 × m：lift=1 表示与均匀分布无异（候选之间没有区分度），
   * lift=m 表示全部质量集中在一个候选上。
   */
  minLift: number;
  /** Top1 与 Top2 的**相对**差距低于此值 → ambiguous。同样必须是相对量。 */
  ambiguityMargin: number;
  /** 次要概念被保留所需的、相对 Top1 的最低比例 */
  secondaryRatio: number;
  /** 最多输出概念数 */
  maxConcepts: number;
}

export const DEFAULT_ADJUDICATION_CONFIG: AdjudicationConfig = {
  // 要求 Top1 至少比均匀分布高 25%——一个温和且可解释的门槛，
  // 不是在评测集上扫出来的最优值。
  minLift: 1.25,
  // Top1 比 Top2 高不到 15% 就不强行二选一。
  ambiguityMargin: 0.15,
  secondaryRatio: 0.62,
  maxConcepts: 3,
};

export interface Adjudication {
  concepts: FinalConcept[];
  rejected: RejectedConcept[];
  status: ConceptStatus;
  overallConfidence: number;
}

export function adjudicate(
  scores: GroundingScore[],
  config: AdjudicationConfig = DEFAULT_ADJUDICATION_CONFIG,
): Adjudication {
  if (scores.length === 0) {
    return { concepts: [], rejected: [], status: 'unknown', overallConfidence: 0 };
  }

  const sorted = [...scores].sort((a, b) => b.normalized - a.normalized);
  const top = sorted[0];
  const second = sorted[1];
  const lift = top.normalized * sorted.length;

  // 候选之间没有区分度：原文与哪个知乎邻域都差不多近，等于没有信息
  if (lift < config.minLift || top.raw <= 0) {
    return {
      concepts: [],
      rejected: sorted.map((s) => ({
        label: s.label,
        score: round(s.normalized),
        reason: `候选之间区分度不足（Top1 相对均匀分布仅 ${round(lift)}×），不强行分类`,
      })),
      status: 'unknown',
      overallConfidence: round(top.normalized),
    };
  }

  const margin = second && top.normalized > 0 ? (top.normalized - second.normalized) / top.normalized : 1;
  const ambiguous = second !== undefined && margin < config.ambiguityMargin;

  const kept: FinalConcept[] = [
    {
      label: top.label,
      confidence: round(top.normalized),
      reason: `原文与「${top.label}」的知乎语义邻域最接近，判别性词汇：${top.topTerms.slice(0, 5).join('、')}`,
    },
  ];

  if (second && second.normalized >= top.normalized * config.secondaryRatio) {
    kept.push({
      label: second.label,
      confidence: round(second.normalized),
      reason: ambiguous
        ? `与「${top.label}」接近度相当（相对差距 ${round(margin)}），并列保留而非强行二选一`
        : `作为次级核心思想保留，判别性词汇：${second.topTerms.slice(0, 4).join('、')}`,
    });
  }

  const third = sorted[2];
  if (!ambiguous && third && third.normalized >= top.normalized * config.secondaryRatio && kept.length < config.maxConcepts) {
    kept.push({
      label: third.label,
      confidence: round(third.normalized),
      reason: `作为次级核心思想保留，判别性词汇：${third.topTerms.slice(0, 4).join('、')}`,
    });
  }

  const keptLabels = new Set(kept.map((k) => k.label));
  const rejected: RejectedConcept[] = sorted
    .filter((s) => !keptLabels.has(s.label))
    .map((s) => ({
      label: s.label,
      score: round(s.normalized),
      reason:
        s.normalized > 0
          ? `与原文共享部分表层词，但知乎语义邻域中的问题意识不同（得分 ${round(s.normalized)} < ${round(top.normalized)}）`
          : '无有效判别性重合',
    }));

  return {
    concepts: kept.slice(0, config.maxConcepts),
    rejected,
    status: ambiguous ? 'ambiguous' : 'confident',
    overallConfidence: round(top.normalized),
  };
}

/**
 * ambiguous 时的可选回退：若 Top1/Top2 同属一个上位概念，
 * 可以退回该上位概念，用"更粗但正确"换掉"更细但可能错"。
 */
export function fallbackToParent(a: Adjudication): string | null {
  if (a.status !== 'ambiguous' || a.concepts.length < 2) return null;
  return commonParent(a.concepts[0].label, a.concepts[1].label);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
