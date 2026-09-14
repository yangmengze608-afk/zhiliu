/**
 * 概念语料库 —— 让**召回**也由知乎语料决定，而不是由我们手写的线索词决定。
 *
 * ## 为什么要有这一层
 *
 * 最初的召回靠 `concepts.json` 里手写的 cues。诊断发现它是整条链路的瓶颈：
 * 在 27 条有 gold 的评测样本上，**33% 的 gold 概念根本没进入候选池**——
 * 判别做得再准也救不回来。而且手写 cues 还有个更根本的问题：
 * 它是我们塞进系统的先验，与"判别词表来自知乎语料"的主张自相矛盾。
 *
 * 解决办法不是去扩充 cues（那等于拿评测集反向调参），而是把 cues 从系统路径上拿掉：
 * 对全部 31 个 canonical 概念各取一次知乎语义邻域，用原文与哪些邻域最接近来做召回。
 *
 * ## 为什么这在额度上是可行的
 *
 * 概念表是固定的 31 个，所以 query 取值空间**有界**。配合 24h 缓存：
 *
 *   全平台每天的上游调用量 ≈ 31 次，**与文章数无关**。
 *
 * 官方限额是 1,000 次/日。也就是说这套设计的稳态用量只占额度的 3%。
 */
import { CONCEPTS } from './registry.js';
import { buildNeighborhood, DEFAULT_GROUNDING_CONFIG } from './grounding.js';
import { l2Normalize, termFrequency } from './tokenize.js';
                                                      
                                                           
                                                                         

export class ConceptCorpus {
  #client                   ;
  #config                 ;
  #size        ;
  #neighborhoods                                           = null;
  /** 跨全部概念的文档频率，用于召回阶段的粗粒度判别 */
  #globalDf                      = new Map();
  #failures           = [];

  constructor(client                   , size = 8, config                  = DEFAULT_GROUNDING_CONFIG) {
    this.#client = client;
    this.#config = config;
    this.#size = size;
  }

  /** 懒加载全部概念邻域。第一次调用付出 31 次搜索，之后全部命中缓存。 */
  async ensureLoaded()                                             {
    if (this.#neighborhoods) return this.#neighborhoods;

    const map = new Map                              ();
    const failures           = [];
    for (const c of CONCEPTS) {
      try {
        const items = await this.#client.neighborhoodItems(c.canonical, this.#size);
        if (items.length === 0) continue;
        map.set(c.canonical, buildNeighborhood(c.canonical, c.canonical, items, this.#config));
      } catch (err) {
        // 单个概念取不回来不应让整个语料库加载失败。
        // 更重要的是：无论成功多少个都必须落地缓存，否则被限流时
        // 每一篇文章都会重新发起 31 次请求，几分钟就能烧光当天 1000 次额度。
        failures.push(c.canonical);
      }
    }
    this.#failures = failures;

    const df = new Map                ();
    for (const n of map.values()) {
      for (const [t, v] of n.profile) {
        if (v >= this.#config.presenceThreshold) df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
    this.#globalDf = df;
    this.#neighborhoods = map;
    return map;
  }

  get loaded()          {
    return this.#neighborhoods !== null;
  }

  /** 加载失败的概念。非空意味着语料库不完整，判别结果的可信度相应下降。 */
  get failedConcepts()           {
    return [...this.#failures];
  }

  /** 成功加载的概念数。低于半数时调用方应考虑整体降级为 ungrounded。 */
  get size()         {
    return this.#neighborhoods?.size ?? 0;
  }

  neighborhoodsFor(labels          )                         {
    const out                         = [];
    for (const l of labels) {
      const n = this.#neighborhoods?.get(l);
      if (n) out.push(n);
    }
    return out;
  }

  /**
   * 语料召回：原文与哪些概念邻域最接近。
   *
   * 用全语料 IDF 加权（df 跨全部 31 个概念统计）：在几乎所有概念讨论里
   * 都出现的词（"觉得""其实""问题"）权重趋零，只有相对独特的词参与召回。
   */
  async recall(title        , text        , k = 5)                              {
    const map = await this.ensureLoaded();
    const m = map.size;
    if (m === 0) return [];

    const idf = (t        )         => {
      const d = this.#globalDf.get(t) ?? 0;
      if (d === 0 || d >= m) return 0;
      return Math.log(m / d);
    };

    const article = l2Normalize(termFrequency(`${title} ${title} ${text}`));

    const scored                                                                          = [];
    for (const [label, n] of map) {
      let sum = 0;
      const contrib                          = [];
      for (const [t, av] of article) {
        const nv = n.profile.get(t);
        if (nv === undefined) continue;
        const c = av * nv * idf(t);
        if (c > 0) {
          sum += c;
          contrib.push([t, c]);
        }
      }
      contrib.sort((a, b) => b[1] - a[1]);
      scored.push({ label, score: sum, terms: contrib });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, k).filter((s) => s.score > 0);
    const max = top[0]?.score ?? 0;

    return top.map((s) => ({
      label: s.label,
      query: s.label,
      lexicalScore: s.score,
      evidence: s.terms.slice(0, 3).map(([t]) => t),
      // 召回分几乎全部由一两个词撑起来时，标记表层词风险，交给判别层重点复核
      surfaceKeywordRisk: s.terms.length > 0 && s.terms[0][1] / Math.max(s.score, 1e-9) > 0.5,
    }));
  }
}
