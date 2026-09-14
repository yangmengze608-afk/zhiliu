# Architecture V0.1

> ⚠️ **历史文档：这是第一 / 第二轮的原始设计，其中的核心技术假设已被后续实验证伪。**
>
> 具体来说：把知乎语料当**判别器**（第一轮）在 LLM 之上重排是**修对 1 条、改坏 12 条**；
> 把它当**证据层**（第二轮 100 条盲测）四个层级两两之间 McNemar p 0.125–1.000，
> **测不出增益**。因此主链路现在是 LLM-only，知乎语料只保留"解释与溯源"的角色。
>
> 本文里凡是把「知乎 Grounding 判别」「Zhida 复核」写成产品组成部分的段落，
> 都应读作**当初的设想**，不是现在的实现。配额、端点、模型名等数字**未在本机复核**。
> 当前的真实状态见 [`../README.md`](../README.md) 的「当前状态与诚实边界」、
> [`MODEL_SELECTION.md`](MODEL_SELECTION.md) 与 `../BLIND_TEST.md`（记录留在私有工作仓库）。


## 1. 总览

```text
┌──────────────────────────────┐
│ Chrome Extension             │
│                              │
│ Content Script               │
│ - 识别知乎页面               │
│ - 提取标题/正文              │
│ - 有效阅读计时               │
│ - 渲染 Mini Dashboard        │
│                              │
│ Background / Service Worker  │
│ - 调度分析                   │
│ - Local Storage / IndexedDB  │
│ - 聚合 & Concentration       │
└──────────────┬───────────────┘
               │ 当前公开文章内容
               ▼
┌──────────────────────────────┐
│ Backend / Serverless         │
│                              │
│ /analyze                     │
│ - Candidate extraction       │
│ - Zhihu Search grounding     │
│ - Canonicalization           │
│ - Ambiguity adjudication     │
│                              │
│ Secrets only here            │
│ - ZHIHU_ACCESS_SECRET        │
│ - optional LLM API secret    │
└───────┬──────────────────────┘
        │
        ├── Zhihu Search API
        └── Zhida API (P1 ambiguity only)
```

## 2. 为什么必须有后端

知乎开放平台 HTTP API 使用：

```http
Authorization: Bearer <Access Secret>
X-Request-Timestamp: <unix seconds>
```

**Access Secret 绝不能写进 Chrome Extension。**

扩展代码会下发给用户，任何内置 Secret 都视为泄露。因此官方 API 必须通过 server-side proxy / serverless function 调用。

推荐：

- Cloudflare Worker；或
- Vercel Functions / Next API Route。

P0 不接 OAuth，所以不需要 App ID / OAuth App Key。

## 3. 隐私边界

### 浏览器本地保存

- URL / ContentID（可考虑 hash）；
- 阅读时间；
- final concepts；
- 时间戳；
- 聚合概念计数；
- trend；
- concentration；
- UI 设置。

### 后端只处理

- 当前公开知乎文章的必要文本；
- 当前分析请求；
- 候选概念与搜索结果；
- 可短期缓存公共 query 的 Search 结果。

### 后端默认不保存

- 用户完整浏览历史；
- 跨页面个人画像；
- 最近 20 篇完整 URL 列表；
- concentration 历史。

比赛 Pitch 可简化成：

> **长期阅读画像和跨页面聚合只保存在本地。**

准确边界：服务端只接收当前这一篇的 `title` + `text`（外加公开的 `contentId`），
不接收任何用户状态；但**逐篇请求序列在网络层仍可被关联成阅读轨迹**，
本项目不宣称服务器技术上无法推断轨迹。

## 4. 模块

### Extension

```text
src/
  content/
    detect-page.ts
    extract-content.ts
    reading-session.ts
    dashboard.tsx
  background/
    analysis-queue.ts
    storage.ts
    aggregation.ts
    concentration.ts
  shared/
    types.ts
```

### Backend

```text
server/
  routes/analyze.ts
  services/candidate-extractor.ts
  services/zhihu-search.ts
  services/grounding.ts
  services/canonicalizer.ts
  services/zhida-review.ts      # P1
  services/cache.ts
```

## 5. `/analyze` contract

Request：

```json
{
  "contentId": "optional-public-id",
  "url": "https://www.zhihu.com/...",
  "title": "...",
  "text": "..."
}
```

Response：

```json
{
  "concepts": [
    {"label": "社交焦虑", "confidence": 0.84},
    {"label": "负面评价恐惧", "confidence": 0.69}
  ],
  "overallConfidence": 0.80,
  "status": "grounded",
  "debug": null
}
```

生产模式不要返回内部 prompts 或完整 search evidence。比赛 Debug 模式可以本地展示 Grounding 前后对比。

## 6. 调用预算

**两份官方材料对额度的说法不一致，这里如实并列，不替平台做裁决：**

| 来源 | 知乎搜索额度 |
| :- | :- |
| 《知乎黑客松 2026 校园新锐季开发者手册》第 12 页 | **1,000 次/天**（单用户总调用量上限，用完即止） |
| 官方 skill 包 `zhihu/references/open-platform.md`（核验 2026-07-16） | **5,000 次/天**（邀测免费额度） |

前者是本届赛事文档，后者是平台通用邀测文档。本项目**按保守值 1,000 做容量规划**，
但不声称 5,000 那个数字是错的——它有官方出处。
（此处更正了本仓库早先的一次误判：曾把项目文档里的 5,000 当成错误"改正"为 1,000，
实际上 5,000 与官方 skill 文档一致。）

> **2026-09-13：上面这段推测全部作废，下面是真实查询到的数字。**
> 别再按"保守取值"猜额度 —— `zhihu-cli quota` 一条命令就能问到。

`zhihu-cli quota` 实测（本账号，2026-09-13）：

| APIID | 真实日额度 | 此前文档里的猜测 |
|---|---|---|
| `zhihu_search` | **5,000** | 1,000（保守取值） |
| `global_search` | **5,000** | 1,000 |
| `hot_list` | 100 | 100 ✓ |
| `zhida_openai` | **5,000** | 100 |
| `knowledge` | 500 | — |
| `user_data` | 10,000 | — |
| `creator` / `question_answers` | 100 | — |
| `tools` | 10 | — |

**但真正的约束不是日额度，是瞬时限速。** 实测背靠背打 12 次直答之后
连续 17 次 `429 rate_limit_exceeded`，而当天额度只掉了 12（**429 不扣额度**）。
以约 13.5 秒间隔连打 20 次，仍会撞到一次 429 —— 它是概率性的，不是干净阈值。

所以缓存和退避的理由变了：**不是因为日额度紧张（5,000 很宽），
而是因为任何批量操作都会撞限速**。真实用户一篇一篇读，撞不上；
跑 benchmark、回填历史、演示前预热数据，一定会撞。

V0.1 只依赖知乎搜索。

每篇：

- 3 个候选 × 1 次搜索 ≈ 3 Search calls；
- 搜索结果 Count=5；
- 24h query cache 大幅减少重复候选调用。

Zhida 只处理少数 ambiguous cases。

## 7. 失败降级

### Search API 失败

- 不反复重试；
- 当前文章标记 `ungrounded`；
- 可以展示 baseline concepts，但**默认不写入集中度统计**，或在设置中明确标记实验模式。

### LLM 失败

- 不创建概念；
- 本地记录 `analysis_failed`；
- UI 不弹强错误，只在面板状态显示“1 篇待分析”。

### DOM 失败

- 页面不计入有效阅读；
- Debug 模式记录 selector diagnostics。

## 8. 安全

- Access Secret 仅服务器环境变量；
- 不写日志；
- 不 commit `.env`；
- API 端点加 rate limit；
- 限制单篇文本长度；
- 后端只允许知乎来源 URL；
- 对 LLM prompt 注入做内容边界：文章正文永远作为 untrusted quoted content，不执行正文中的指令。
