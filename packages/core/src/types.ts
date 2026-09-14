/** 知流核心类型定义。所有跨模块契约集中在这里，避免 selector / 字段散落。 */

/** 从知乎页面抽取出的一篇内容。 */
export interface ExtractedContent {
  url: string;
  contentId?: string;
  type: 'answer' | 'article' | 'unknown';
  title: string;
  text: string;
}

/** Stage A 产出的候选解释。刻意保留多个，不过早收敛成单标签。 */
export interface CandidateConcept {
  /** canonical concept 名称 */
  label: string;
  /** 用于知乎搜索的消歧查询词 */
  query: string;
  /** 词面命中带来的初始分，仅表示"值得进入 Grounding"，不代表结论 */
  lexicalScore: number;
  /** 命中的词面证据，用于 debug 面板展示 */
  evidence: string[];
  /** 该候选是否主要由少数高频表层词撑起来 */
  surfaceKeywordRisk: boolean;
}

/** 官方 zhihu_search 单条结果。字段名与大小写严格对齐官方 HTTP API。 */
export interface ZhihuSearchItem {
  Title: string;
  ContentType: string;
  ContentID: string;
  ContentText: string;
  Url: string;
  CommentCount: number;
  VoteUpCount: number;
  AuthorName: string;
  /** 真实响应有、官方文档未声明。2026-09-13 三次 probe 都返回了它。 */
  AuthorSignature?: string;
  AuthorAvatar: string;
  AuthorBadge: string;
  AuthorBadgeText: string;
  EditTime: number;
  CommentInfoList?: Array<{ Content: string }>;
  AuthorityLevel: string;
  RankingScore: number;
}

export interface ZhihuSearchResponse {
  Code: number;
  Message: string;
  Data: {
    HasMore: boolean;
    SearchHashId?: string;
    EmptyReason?: string;
    Items: ZhihuSearchItem[];
  };
}

/** 一个候选概念在知乎语料中的语义邻域。 */
export interface SemanticNeighborhood {
  label: string;
  query: string;
  itemCount: number;
  /** term -> 加权词频（已按 RankingScore 加权并归一化） */
  profile: Map<string, number>;
  /** 用于展示的邻域样本标题 */
  sampleTitles: string[];
}

export type AnalysisStatus = 'grounded' | 'ungrounded' | 'failed';
export type ConceptStatus = 'confident' | 'ambiguous' | 'unknown';

export interface FinalConcept {
  label: string;
  confidence: number;
  reason: string;
}

export interface RejectedConcept {
  label: string;
  score: number;
  reason: string;
}

export interface AnalysisResult {
  concepts: FinalConcept[];
  rejected: RejectedConcept[];
  overallConfidence: number;
  status: AnalysisStatus;
  conceptStatus: ConceptStatus;
  /** 仅 debug 模式返回；生产响应置空 */
  debug?: {
    candidates: CandidateConcept[];
    scores: Array<{ label: string; raw: number; normalized: number }>;
    discriminativeTerms: Array<{ label: string; terms: string[] }>;
    searchCalls: number;
  };
}

/** 写入本地历史的一条有效阅读记录。 */
export interface ReadingRecord {
  id: string;
  url: string;
  title: string;
  readAt: number;
  concepts: Array<{ label: string; confidence: number }>;
  analysisStatus: AnalysisStatus | 'mock';
}
