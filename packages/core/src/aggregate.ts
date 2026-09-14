/**
 * 本地聚合：把 ReadEvent 列表变成面板需要的 ConceptAggregate。
 *
 * 全部在浏览器本地计算，不上传。
 */
import { concentration, buildDistribution, MIN_SAMPLES, WINDOW_SIZE } from './concentration.ts';
import type { ConcentrationResult } from './concentration.ts';
import type { ConceptAggregate, ReadEvent } from './model.ts';

/**
 * 趋势对比窗口：最近 N 篇 vs 再前 N 篇。
 *
 * 取 10 而不是 5，有两个理由：
 * 1. **噪声**。段长 5 时出现率的最小刻度就是 20 个百分点（差一篇），
 *    ±20pp 阈值等价于"没有阈值"——独立统计审查精确算出：真实行为完全不变时，
 *    仅噪声就有 68%–75% 的概率触发箭头。段长 10 + 阈值 40pp 把这个数压到 5%–11%。
 * 2. **与柱状图口径一致**。柱状图看的是最近 20 篇；段长 5 时趋势只看最近 10 篇，
 *    于是会出现"某概念在柱状图上还有 50%、趋势却显示已经不读了"的割裂。
 *    10 + 10 正好覆盖同一个 20 篇窗口。
 */
export const TREND_SEGMENT = 10;

/**
 * 出现率变化达到该值（百分点）才算上升 / 下降。
 *
 * 段长 10 时的假箭头率（真实行为不变，纯噪声触发）：
 *   阈值 20pp → 39%–50%
 *   阈值 30pp → 16%–26%
 *   阈值 40pp → **5%–11%**  ← 采用
 *   阈值 50pp →  1%– 4%（过于迟钝，真实变化也看不见）
 *
 * 冻结于第四轮。改动需同步更新 docs 与面板 tooltip。
 */
export const TREND_THRESHOLD = 0.40;

/**
 * 只有"真的读出了概念"的记录才参与统计。
 * 歧义、未知、失败的记录保留在历史里（用户能看到"N 篇待分析"），
 * 但不进入分布——否则它们会稀释真实的信息结构。
 */
export function statEvents(events: ReadEvent[]): ReadEvent[] {
  // Array.isArray 不是多余的：损坏或迁移遗留的记录可能整个缺 concepts 字段，
  // 直接读 .length 会抛 TypeError，并把整条消息链锁死。
  return events.filter(
    (e) => Array.isArray(e?.concepts) && e.concepts.length > 0 && !e.ambiguous && e.analysisStatus !== 'failed',
  );
}

/**
 * 某概念的**出现率**：它出现在这段文章里的**篇数比例**。
 *
 * 趋势用出现率，而不是权重占比。这是第四轮修掉的一个反直觉 bug：
 * 旧实现比较的是"该概念在所有概念权重里的相对 share"，于是会出现
 * **某概念出现在最近 10 篇中的 10 篇、箭头却显示 ↓** —— 因为那几篇里
 * 恰好还有别的概念，把它的权重占比稀释了。对用户来说这完全无法解释。
 *
 * 出现率的语义是用户能直接验证的：「最近 5 篇里有 4 篇提到它」。
 */
function prevalenceIn(events: ReadEvent[], canonical: string): number {
  if (events.length === 0) return 0;
  return countIn(events, canonical) / events.length;
}

/** 出现篇数。趋势判定用整数比较，避免浮点误差。 */
function countIn(events: ReadEvent[], canonical: string): number {
  return events.filter((e) => e.concepts.some((c) => c.canonical === canonical)).length;
}

export interface AggregateView {
  concepts: ConceptAggregate[];
  concentration: ConcentrationResult;
  /** 参与统计的文章数 */
  sampleCount: number;
  /** 窗口内由 mock / demo 产生的条数，面板必须据此标注 */
  syntheticCount: number;
  /** 按分析来源分类的条数。面板据此决定显示「演示数据 / AI 分析 / 知乎语境增强」 */
  sourceBreakdown: { llm: number; mock: number; demo: number; enriched: number; other: number };
  /** 已记录但未产出概念的条数（歧义/未知/失败） */
  pendingCount: number;
  /**
   * 当前窗口里出现过的分析出处组合。长度 > 1 说明这 20 篇是**混着不同模型**打的标签，
   * 面板必须提示，否则用户会把模型切换造成的分布变化当成自己兴趣变了。
   */
  analysisMix: Array<{ key: string; count: number }>;
}

/** 把一条记录的出处压成一个可读的 key。 */
export function analysisKey(e: ReadEvent): string {
  if (e.analysisStatus === 'demo') return 'demo';
  if (e.analysisStatus === 'mock') return 'mock';
  const a = e.analysis;
  if (!a) return e.analysisStatus === 'llm' ? 'llm/未记录出处' : e.analysisStatus;
  return `${a.provider ?? '?'}/${a.model ?? '?'}/${a.promptVersion}`;
}

export function buildAggregates(all: ReadEvent[], windowSize = WINDOW_SIZE): AggregateView {
  const window = all.slice(-windowSize);
  const stat = statEvents(window);

  // 趋势分段：最近 5 篇 vs 再往前 5 篇
  const recent = stat.slice(-TREND_SEGMENT);
  const prior = stat.slice(-TREND_SEGMENT * 2, -TREND_SEGMENT);

  const byConcept = new Map<string, { weight: number; count: number; lastSeen: number }>();
  for (const e of stat) {
    const per = 1 / e.concepts.length;
    for (const c of e.concepts) {
      const cur = byConcept.get(c.canonical) ?? { weight: 0, count: 0, lastSeen: 0 };
      cur.weight += per;
      cur.count += 1;
      cur.lastSeen = Math.max(cur.lastSeen, e.timestamp);
      byConcept.set(c.canonical, cur);
    }
  }

  const total = [...byConcept.values()].reduce((s, v) => s + v.weight, 0);

  const concepts: ConceptAggregate[] = [...byConcept.entries()].map(([canonical, v]) => {
    // 前段没有数据时不谈趋势——"从无到有"不是上升，是刚开始记录
    const delta = prior.length === 0 ? 0 : prevalenceIn(recent, canonical) - prevalenceIn(prior, canonical);
    // 用整数篇数做判定，避免浮点误差：段长 5 时 0.8-1.0 得到 -0.19999999999999996，
    // 与 -0.2 比较会被判成 flat，而 0.4-0.2 得到的 0.2 却判成 up——同一个差值两种结果。
    const dir = trendDirection(recent.length, prior.length, countIn(recent, canonical), countIn(prior, canonical));
    return {
      canonical,
      totalWeight: round3(v.weight),
      articleCount: v.count,
      recentPrevalence: round3(prevalenceIn(recent, canonical)),
      priorPrevalence: round3(prevalenceIn(prior, canonical)),
      // share 保留完整精度：在模型层四舍五入会让各项之和变成 1.001，
      // 面板上就会出现"占比加起来 101%"。取整是展示层的事。
      share: total > 0 ? v.weight / total : 0,
      trendDelta: round3(delta),
      recentTrend: dir,
      lastSeen: v.lastSeen,
    };
  });

  concepts.sort((a, b) => b.share - a.share || a.canonical.localeCompare(b.canonical));

  const dist = buildDistribution(
    stat.map((e) => ({
      id: e.id, url: '', title: e.title, readAt: e.timestamp,
      concepts: e.concepts.map((c) => ({ label: c.canonical, confidence: c.confidence })),
      analysisStatus: 'grounded' as const,
    })),
    windowSize,
  );

  return {
    concepts,
    concentration: concentration(dist),
    sampleCount: stat.length,
    syntheticCount: window.filter((e) => e.analysisStatus === 'mock' || e.analysisStatus === 'demo').length,
    sourceBreakdown: {
      llm: stat.filter((e) => e.analysisStatus === 'llm').length,
      mock: stat.filter((e) => e.analysisStatus === 'mock').length,
      demo: stat.filter((e) => e.analysisStatus === 'demo').length,
      enriched: stat.filter((e) => e.analysisStatus === 'zhihu_enriched').length,
      other: stat.filter((e) => !['llm', 'mock', 'demo', 'zhihu_enriched'].includes(e.analysisStatus)).length,
    },
    pendingCount: window.length - stat.length,
    // **对 stat 算，不是对 window 算。**
    // window 里包含正在分析中的占位记录（analysisKey = 'ungrounded'）。
    // 对 window 算的话，用户每读完一篇，接下来十几秒面板都会指控自己
    // 「这 N 篇由 2 种分析来源混合产生（ollama/qwen2.5:14b/v3-shape / ungrounded）」——
    // 一个每次阅读都必然出现的假警报，会让这条真正重要的提示彻底失效。
    analysisMix: [...stat.reduce((m, e) => m.set(analysisKey(e), (m.get(analysisKey(e)) ?? 0) + 1), new Map<string, number>())]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * 用整数篇数判定方向，规避浮点比较。
 * 条件：|recentCount/recentN - priorCount/priorN| >= TREND_THRESHOLD
 * 等价于：|recentCount*priorN - priorCount*recentN| >= TREND_THRESHOLD*recentN*priorN
 */
export function trendDirection(
  recentN: number, priorN: number, recentCount: number, priorCount: number,
): 'up' | 'down' | 'flat' {
  if (recentN === 0 || priorN === 0) return 'flat';
  const lhs = recentCount * priorN - priorCount * recentN;
  const rhs = TREND_THRESHOLD * recentN * priorN;
  // 加一个极小容差吸收 TREND_THRESHOLD 本身的二进制表示误差
  if (lhs >= rhs - 1e-9) return 'up';
  if (lhs <= -rhs + 1e-9) return 'down';
  return 'flat';
}

export { MIN_SAMPLES, WINDOW_SIZE };

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
