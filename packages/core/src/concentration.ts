/**
 * 信息集中度。
 *
 * 它只回答一句话：最近这些有效阅读，是否集中在少数几个核心概念上。
 * 它**不**回答用户是否陷入信息茧房、不归因推荐算法、也不判断好坏。
 * 高集中度同样可能只是用户正在系统性地学一个主题。
 *
 * ## 为什么换掉了归一化熵
 *
 * 旧实现是 `1 - H/ln(K)`，K 先是"窗口内观测到的概念数"、后改成固定的 31。
 * 两种都有同一个致命问题：**分数随样本量系统性漂移**。
 * 红队实测：一个行为完全不变的随机读者，n=5 时中位约 43，n=20 时约 21——
 * 分数腰斩，而这与他读了什么毫无关系。于是"上周 60、这周 30"根本不能解释成
 * "我最近读得更杂了"，这个数字失去了它唯一的用途。
 *
 * ## 新定义：Simpson 集中度
 *
 *   C = Σ pᵢ²        pᵢ = 概念 i 在窗口内的暴露占比
 *   score = round(100 × C)
 *
 * 它有一个**可以直接讲给用户听**的含义：
 *
 *   从你最近读到的内容里随机抽两次，
 *   两次抽到同一个概念的概率。
 *
 * 100 = 全部内容都在讲同一件事；25 = 大致相当于均匀地读四个主题。
 *
 * ## 可比性的真正来源：固定窗口
 *
 * 必须说清楚：**任何**基于经验分布的集中度指标都有有限样本偏差——
 * 样本越多，观测到的概念越多，经验分布越平。换公式解决不了这件事。
 * 真正让分数可比的是**把 n 固定住**：
 *
 *   - 窗口固定为最近 20 篇有效阅读
 *   - < 10 篇：不出分，显示"数据积累中"
 *   - 10–19 篇：出分但标记为"初步"，不与正式分数横向比较
 *   - ≥ 20 篇：正式分数
 *
 * 相对旧实现，Simpson 还多一个好处：**对样本复制免疫**。
 * 把同一个分布的样本量翻倍，pᵢ 不变，C 严格不变（见性质测试 D）。
 * 归一化熵做不到这一点，因为 K 会跟着变。
 */
import type { ReadingRecord } from './types.ts';

/** 统计窗口：最近 N 篇有效阅读。固定不变——这是分数可比的前提。 */
export const WINDOW_SIZE = 20;
/** 低于此篇数完全不出分。 */
export const MIN_SAMPLES = 10;
/** 达到此篇数才算正式分数；之间的区间标记为初步。 */
export const FULL_SAMPLES = 20;

export interface Distribution {
  /** canonical concept -> 占比，和为 1 */
  shares: Map<string, number>;
  /** 参与统计的文章数 */
  sampleCount: number;
}

/**
 * 每篇文章对总体统计的贡献恒为 1，再平均分给它的概念。
 *
 * 这条约束是刻意的：否则"被提取出 3 个概念的文章"会比"只有 1 个概念的文章"
 * 对历史产生 3 倍影响，而概念数量只反映模型的犹豫程度，不反映阅读量。
 */
export function buildDistribution(records: ReadingRecord[], windowSize = WINDOW_SIZE): Distribution {
  const window = records.slice(-windowSize).filter((r) => Array.isArray(r?.concepts) && r.concepts.length > 0);
  const weights = new Map<string, number>();

  for (const r of window) {
    const per = 1 / r.concepts.length;
    for (const c of r.concepts) weights.set(c.label, (weights.get(c.label) ?? 0) + per);
  }

  const total = [...weights.values()].reduce((s, v) => s + v, 0);
  const shares = new Map<string, number>();
  if (total > 0) for (const [k, v] of weights) shares.set(k, v / total);

  return { shares, sampleCount: window.length };
}

export type ConcentrationResult =
  | { state: 'collecting'; sampleCount: number; needed: number }
  | {
      state: 'ready';
      score: number;
      /** 样本未满窗口时为 true，分数只作初步参考，不与正式分数横向比较 */
      preliminary: boolean;
      sampleCount: number;
      conceptCount: number;
    };

/**
 * Simpson 集中度：从窗口内随机抽两次概念暴露，抽到同一个的概率 ×100。
 *
 * 值域 [100/K, 100]，K 为窗口内出现的概念数；概念全同为 100。
 */
export function concentration(dist: Distribution): ConcentrationResult {
  if (dist.sampleCount < MIN_SAMPLES) {
    return { state: 'collecting', sampleCount: dist.sampleCount, needed: MIN_SAMPLES };
  }

  const ps = [...dist.shares.values()].filter((p) => p > 0);
  if (ps.length === 0) {
    return { state: 'collecting', sampleCount: dist.sampleCount, needed: MIN_SAMPLES };
  }

  let c = 0;
  for (const p of ps) c += p * p;

  return {
    state: 'ready',
    score: Math.max(0, Math.min(100, Math.round(100 * c))),
    preliminary: dist.sampleCount < FULL_SAMPLES,
    sampleCount: dist.sampleCount,
    conceptCount: ps.length,
  };
}

/** 面板上的一句话解释，与公式绑定，改公式必须同步改这里。 */
export const CONCENTRATION_EXPLANATION =
  '从最近读到的内容里随机抽两次，抽到同一个概念的概率。不代表好坏。';
