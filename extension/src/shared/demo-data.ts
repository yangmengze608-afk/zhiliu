/**
 * 演示数据。
 *
 * 用途：真实知乎 Search API 权限可能要到赛前才到位，且概念抽取需要 LLM 调用。
 * 演示模式让整个产品链路在**完全离线**的情况下也能完整展示。
 *
 * 纪律：由本文件驱动的每一条记录都标记为 `analysisStatus: 'demo'`，
 * 面板必须显式打上「演示数据」标记。**绝不能让评委误以为是真实用户数据。**
 *
 * 剧本设计：前几篇围绕"稳定"反复出现 → 稳定这根柱子肉眼可见地变长，
 * 信息集中度随之上升；中间插入一篇 AI 内容并在后段消失 → 产生一次 ↓ 趋势变化。
 * 目标是让第一次看到的人在 20 秒内理解："原来我最近一直在看同一类信息。"
 */

export interface DemoArticle {
  contentId: string;
  contentType: 'answer' | 'article';
  title: string;
  /** 演示用的预置概念。真实模式下这一步由 LLM 产出。 */
  concepts: Array<{ canonical: string; confidence: number }>;
}

export const DEMO_ARTICLES: DemoArticle[] = [
  // —— 前段：主题分散。集中度低，面板上是一堆短条 ——
  {
    contentId: 'demo-01', contentType: 'answer',
    title: 'AI 真的会取代我这个岗位吗？我认真算了一遍',
    concepts: [{ canonical: 'AI', confidence: 0.86 }],
  },
  {
    contentId: 'demo-02', contentType: 'answer',
    title: '毕业三年，薪水涨到多少才算正常',
    concepts: [{ canonical: '收入', confidence: 0.83 }],
  },
  {
    contentId: 'demo-03', contentType: 'article',
    title: '这两年我把定投停了，说说为什么',
    concepts: [{ canonical: '投资理财', confidence: 0.85 }],
  },
  {
    contentId: 'demo-04', contentType: 'answer',
    title: '间隔重复到底有没有用，我试了半年',
    concepts: [{ canonical: '学习方法', confidence: 0.82 }],
  },
  {
    contentId: 'demo-05', contentType: 'answer',
    title: '健身两年，身材变了，别的没变',
    concepts: [{ canonical: '健身', confidence: 0.8 }],
  },
  {
    contentId: 'demo-06', contentType: 'answer',
    title: '长期熬夜之后我失去了什么',
    concepts: [{ canonical: '睡眠', confidence: 0.84 }],
  },
  {
    contentId: 'demo-07', contentType: 'answer',
    title: '和伴侣吵架时，我们其实在吵什么',
    concepts: [{ canonical: '亲密关系', confidence: 0.81 }],
  },
  {
    contentId: 'demo-08', contentType: 'article',
    title: '首付攒到一半，我开始怀疑这件事本身',
    concepts: [{ canonical: '房产', confidence: 0.83 }],
  },
  {
    contentId: 'demo-09', contentType: 'answer',
    title: '写了八年代码，最难的从来不是代码',
    concepts: [{ canonical: '编程', confidence: 0.79 }],
  },
  {
    contentId: 'demo-10', contentType: 'answer',
    title: '二战考研值不值得，我的答案变了',
    concepts: [{ canonical: '考研', confidence: 0.82 }],
  },
  // —— 中段：开始向「稳定」收拢，考公考编短暂出现 ——
  {
    contentId: 'demo-11', contentType: 'answer',
    title: '这一届秋招到底难在哪',
    concepts: [{ canonical: '就业', confidence: 0.84 }, { canonical: '收入', confidence: 0.7 }],
  },
  {
    contentId: 'demo-12', contentType: 'answer',
    title: '二十八岁裸辞考公，是不是太晚了',
    concepts: [{ canonical: '稳定', confidence: 0.85 }, { canonical: '考公考编', confidence: 0.79 }],
  },
  {
    contentId: 'demo-13', contentType: 'answer',
    title: '从大厂跳到国企，我后悔了吗',
    concepts: [{ canonical: '稳定', confidence: 0.89 }, { canonical: '考公考编', confidence: 0.7 }],
  },
  {
    contentId: 'demo-14', contentType: 'article',
    title: '上岸之后才发现的三件事',
    concepts: [{ canonical: '考公考编', confidence: 0.83 }, { canonical: '风险', confidence: 0.66 }],
  },
  {
    contentId: 'demo-15', contentType: 'answer',
    title: '体制内待了五年，我最大的感受是什么',
    concepts: [{ canonical: '稳定', confidence: 0.9 }, { canonical: '考公考编', confidence: 0.74 }],
  },
  // —— 后段：几乎全是同一类内容。集中度爬升，考公考编退场产生 ↓ ——
  {
    contentId: 'demo-16', contentType: 'answer',
    title: '要不要为了编制放弃现在的薪水',
    concepts: [{ canonical: '稳定', confidence: 0.87 }, { canonical: '考公考编', confidence: 0.76 }],
  },
  {
    contentId: 'demo-17', contentType: 'article',
    title: '关于确定性，我这两年想明白的三件事',
    concepts: [{ canonical: '稳定', confidence: 0.88 }],
  },
  {
    contentId: 'demo-18', contentType: 'answer',
    title: '三十五岁之后，什么样的工作才算安全',
    concepts: [{ canonical: '稳定', confidence: 0.91 }],
  },
  {
    contentId: 'demo-19', contentType: 'answer',
    title: '我为什么劝身边的朋友别轻易辞职',
    concepts: [{ canonical: '稳定', confidence: 0.85 }],
  },
  {
    contentId: 'demo-20', contentType: 'answer',
    title: '把生活押在一份不会消失的工作上，值吗',
    concepts: [{ canonical: '稳定', confidence: 0.86 }],
  },
  // —— 尾段：窗口开始滚动，前段的分散内容滑出，集中度明显爬升 ——
  {
    contentId: 'demo-21', contentType: 'answer',
    title: '在同一个岗位待满十年是什么体验',
    concepts: [{ canonical: '稳定', confidence: 0.88 }],
  },
  {
    contentId: 'demo-22', contentType: 'answer',
    title: '我把跳槽的念头压下去的第三年',
    concepts: [{ canonical: '稳定', confidence: 0.86 }],
  },
  {
    contentId: 'demo-23', contentType: 'article',
    title: '为什么这两年身边的人都在谈抗风险能力',
    concepts: [{ canonical: '稳定', confidence: 0.84 }, { canonical: '风险', confidence: 0.71 }],
  },
  {
    contentId: 'demo-24', contentType: 'answer',
    title: '父母眼里的好工作，和我眼里的',
    concepts: [{ canonical: '稳定', confidence: 0.87 }],
  },
  {
    contentId: 'demo-25', contentType: 'answer',
    title: '不确定的时代，什么东西还能算数',
    concepts: [{ canonical: '稳定', confidence: 0.89 }],
  },
  {
    contentId: 'demo-26', contentType: 'answer',
    title: '如果只能选一个，我选不会消失的那个',
    concepts: [{ canonical: '稳定', confidence: 0.9 }],
  },
];

/** 演示推进的默认间隔（毫秒）。 */
export const DEMO_STEP_MS = 700;
