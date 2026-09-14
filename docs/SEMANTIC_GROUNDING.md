# Semantic Grounding V0.1

> ⚠️ **历史文档：这是第一 / 第二轮的原始设计，其中的核心技术假设已被后续实验证伪。**
>
> 具体来说：把知乎语料当**判别器**（第一轮）在 LLM 之上重排是**修对 1 条、改坏 12 条**；
> 把它当**证据层**（第二轮 100 条盲测）四个层级两两之间 McNemar p 0.125–1.000，
> **测不出增益**。因此主链路现在是 LLM-only，知乎语料只保留"解释与溯源"的角色。
>
> 本文里凡是把「知乎 Grounding 判别」「Zhida 复核」写成产品组成部分的段落，
> 都应读作**当初的设想**，不是现在的实现。配额、端点、模型名等数字**未在本机复核**。
> 当前的真实状态见 [`../README.md`](../README.md) 的「当前状态与诚实边界」、
> [`MODEL_SELECTION.md`](MODEL_SELECTION.md) 与 [`../BLIND_TEST.md`](../BLIND_TEST.md)。


## 1. 核心问题

我们不是在做传统“关键词抽取”，而是在解决：

> **AI 对一篇知乎内容的核心思想有没有理解错？**

典型误判：

- 表层频繁出现“女性 / 男性 / 约会 / 外貌”；
- 但真正讨论的是“社交焦虑 / 害怕负面评价”；
- 单纯词频或单次 LLM 分类可能把它归到“性别议题”。

因此链路必须是：

```text
Article
  → Candidate Interpretations
  → Zhihu Semantic Neighborhoods
  → Adjudication
  → Canonical Concepts
```

而不是：

```text
Article → Keywords
```

## 2. 官方 API 在这里解决什么

知乎站内搜索：

`GET https://developer.zhihu.com/api/v1/content/zhihu_search`

核心字段（**已按官方 skill 包 `zhihu/references/http-api.md` 逐字核验，核验时间 2026-07-16**）：

| 字段 | 类型 | 本项目是否使用 | 用途 |
| :- | :- | :- | :- |
| `Title` | String | ✅ 权重 ×3 | 知乎标题通常就是问题本身，信息密度最高 |
| `ContentText` | String | ✅ | 邻域词汇分布的主要来源 |
| `RankingScore` | Float32 | ✅ 作为邻域加权 | 官方相关性排序分，让更代表该概念的内容说话更响 |
| `CommentInfoList` | Array | ✅ 低权重 | 精选评论常含社区口语表达（"社恐""上岸"） |
| `ContentType` | String | ⬜ | 暂未使用 |
| `ContentID` / `Url` | String | ⬜ | 仅 debug 展示 |
| `AuthorityLevel` | String | ❌ **刻意不用** | 它衡量作者权威度，与"这篇文章在讲什么"无关 |
| `VoteUpCount` / `CommentCount` | Int32 | ❌ **刻意不用** | 热度不等于语义代表性；用它会把判别偏向热门话题 |

`Count` 官方上限为 **10**（超过服务端自动截断），本项目每个候选取 8。

不使用权威度与点赞数是一个明确的设计决定：本项目判断的是**语义归属**，不是内容质量。

本项目主要使用 **Title + ContentText + RankingScore** 建立候选概念的“知乎语义邻域”。评论可作为辅助语境，但 V0.1 不使用点赞/权威度判断文章“好坏”。

知乎搜索当前 `Count` 最大为 10；V0.1 每个候选默认取 Top 5。

## 3. 两阶段识别

### Stage A — Candidate Extraction

对当前文章产生 3–5 个**互相有区分度的候选解释**，每个候选必须带：

- `label`
- `definition`
- `evidence`：原文中支持该解释的 1–3 个短证据
- `initial_confidence`
- `surface_keyword_risk`：是否可能只是被显眼词汇诱导

示例：

```json
[
  {
    "label": "社交焦虑",
    "definition": "在社交互动中对评价、尴尬或拒绝的持续担忧",
    "initial_confidence": 0.52,
    "surface_keyword_risk": false
  },
  {
    "label": "性别议题",
    "definition": "围绕性别角色、权利或结构性差异的讨论",
    "initial_confidence": 0.31,
    "surface_keyword_risk": true
  },
  {
    "label": "亲密关系压力",
    "definition": "在约会或亲密关系建立中的压力与冲突",
    "initial_confidence": 0.17,
    "surface_keyword_risk": false
  }
]
```

### Stage B — Zhihu Grounding

对每个候选调用知乎搜索：

```text
Query = 候选 label + 必要的定义消歧词
Count = 5
```

不要直接拿“搜索结果最多”作为答案。

每个候选构建一个 `semantic_neighborhood`：

- Top 5 的标题；
- Top 5 的 ContentText；
- RankingScore；
- 必要时精选评论。

然后进行第二次判定：

> 原文的论证、问题意识、反复出现的抽象概念，与哪个候选语义邻域最接近？

重点压制“共享几个表层词”但问题意识不同的候选。

## 4. Final Adjudication 输出

建议统一 JSON：

```json
{
  "final_concepts": [
    {
      "label": "社交焦虑",
      "confidence": 0.84,
      "reason": "原文核心围绕害怕评价、回避与互动紧张；与知乎社交焦虑语义邻域高度一致",
      "aliases": ["社交紧张"]
    },
    {
      "label": "负面评价恐惧",
      "confidence": 0.69,
      "reason": "作为更具体的次级核心思想保留",
      "aliases": []
    }
  ],
  "rejected": [
    {
      "label": "性别议题",
      "reason": "主要依赖女性/男性/约会等表层词，原文并未围绕性别权利或结构性差异展开"
    }
  ],
  "overall_confidence": 0.80,
  "needs_review": false
}
```

## 5. 置信度规则

V0.1 建议：

- `overall_confidence >= 0.70`：直接入统计；
- `0.50–0.69`：仅保留最高置信概念，标记 weak；
- `< 0.50`：不进入主统计，进入 `unresolved`；
- Top1 与 Top2 非常接近（例如差 < 0.10）且语义冲突明显：进入歧义复核。

数值只是工程启发式，不宣称概率已校准；上线前需要用人工标注集调整。

## 6. 歧义复核：Zhida Agent（P1）

官方直答 API：

`POST https://developer.zhihu.com/v1/chat/completions`

支持 `zhida-fast-1p5`、`zhida-thinking-1p5`、`zhida-agent`。当前免费额度较低，因此不对每篇调用。

只在：

- overall confidence 低；
- Top1/Top2 接近；
- 候选存在明显“表层关键词诱导”风险；

时，用 `zhida-thinking-1p5` 作为 adjudicator，输入：

- 原文的压缩表示；
- 候选解释；
- 每个候选的知乎 Search 语义邻域摘要；

让它只做**消歧选择**，不生成新的长答案。

## 7. Canonicalization：避免标签碎裂

即使中心思想判断正确，也可能出现：

- 工作稳定
- 职业稳定性
- 稳定就业

如果直接计数，面板会碎裂。

因此 final concept 写入历史前，再经过本地/服务端 Concept Registry：

```json
{
  "canonical": "稳定",
  "aliases": ["工作稳定", "职业稳定性", "稳定就业"]
}
```

P0 简化规则：

1. 先与已有 canonical labels 做语义匹配；
2. 高相似则复用旧 label；
3. 无高相似项才创建新 label；
4. 不允许仅凭词形相近强制合并。

## 8. 缓存策略

为减少官方 Search API 调用：

- `candidate_query → search results` 缓存 24h；
- 同一 `ContentID / URL hash → final concepts` 本地缓存；
- 已有稳定 canonical concept 可减少重复搜索；
- 同一文章刷新不重新 Grounding。

## 9. 测试集

在正式开发 AI 前先建至少 30 条人工 gold cases，优先收集“容易被表层词带偏”的文章。

每条记录：

- 原文 / 摘要；
- 人工认为的 1–3 个核心思想；
- 常见错误标签；
- 为什么错误；
- Grounding 前输出；
- Grounding 后输出。

核心指标不是普通关键词 F1，而是：

### `Major Misclassification Rate`

> 是否把文章归到了一个与主要问题意识明显不同的大类。

目标：Grounding 后该错误率明显低于单次 LLM baseline。

## 10. Demo 必做案例

至少一个“第一遍会错、Grounding 后修正”的案例。

理想演示：

```text
表层：女性 / 约会 / 异性 / 外貌
Baseline：性别议题
         ↓
Zhihu Search semantic grounding
         ↓
Final：社交焦虑 / 负面评价恐惧
```

这就是官方 API 与产品核心机制之间最直接的连接。
