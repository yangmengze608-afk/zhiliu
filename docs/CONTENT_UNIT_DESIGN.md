# Content Unit 抽象 · 设计与迁移路径

> **本文只是设计，没有实现。** 提交前不动主链路。
>
> 起因：U-14 真人验收暴露出当前抽象的天花板 —— 产品被绑死在
> `Page Type → Extractor` 上，而知流的核心主张是
> **被动观察用户在知乎真正读过的内容**，那跟"他停在哪个 URL"并不是一回事。

---

## 1. 当前抽象错在哪

```
Page Type  →  Extractor
```

这条链隐含了一个假设：**一个页面 = 一篇内容**。

在知乎这个假设只对两种页面成立（独立回答页、专栏文章）。
而真实用户大量的阅读发生在**一页多内容**的场景里：问题页往下连着读五个回答、
首页 feed 里展开一张卡片、热榜点进去扫两眼。这些在当前抽象里只能 fail closed ——
不是因为做不了，是因为**抽象里没有"用户此刻在读哪一个"这个概念**。

U-14 那次失败正是这个天花板的第一次撞击：URL 层面的身份（`/answer/<aid>`）
和 DOM 层面此刻真正渲染的内容单元，**可能不一致**。

## 2. 目标抽象

```
Page
  → discoverContentUnits(document)      这一页上有哪些独立内容单元
  → getActiveContentUnit(units, viewport)  用户此刻在读哪一个
  → qualify(unit)                        可见面积 / 停留时长 / 归属唯一性
  → extractContentUnit(unit)             只抽那一个
  → analyze
  → local aggregation
```

关键变化：**"读过"从页面级事实降级成内容单元级事实。**

### ContentUnit

```ts
export interface ContentUnit {
  /** 语义类型。决定用哪套 selector 和哪种归属校验。 */
  type: 'answer' | 'article' | 'questionAnswer' | 'feedItem' | 'searchResult';

  /** 去重与归属的唯一键。拿不到稳定 id 的单元**不允许入库**。 */
  contentId: string;

  /** 该单元在 DOM 里的根。计时、可见性、抽取全部以它为界。 */
  rootElement: Element;

  title: string;
  /** 正文。摘要不算正文 —— 见第 5 节的语义下限。 */
  text: string;

  /** 这个单元自己的规范 URL，用于展示与跨会话去重。 */
  canonicalUrl: string;

  /**
   * 归属可信度：这段正文**确实**属于 contentId 的把握。
   *  - 'attributed'  单元根或其子孙带着这个 id（最强）
   *  - 'url-only'    只有 URL 说是它，DOM 里没有 id 线索（当前独立页就是这一档）
   *  - 'ambiguous'   DOM 里有 id 线索但对不上 → **不得入库**
   */
  ownership: 'attributed' | 'url-only' | 'ambiguous';
}
```

### 三个接口

```ts
/** 这一页上有哪些独立内容单元。纯 DOM 查询，无副作用。 */
function discoverContentUnits(doc: Document, page: PageIdentity): ContentUnit[];

/**
 * 用户此刻在读哪一个。
 * 不是"哪个在 DOM 里"，是"哪个占据了阅读视野"。
 * 返回 null 表示当前没有任何单元达到可归因标准 —— 那就什么都不记。
 */
function getActiveContentUnit(units: ContentUnit[], viewport: Viewport): ContentUnit | null;

/** 只抽这一个单元。当前的 extractContent 是它在"整页只有一个单元"时的特例。 */
function extractContentUnit(unit: ContentUnit): ExtractedContent;
```

### 可见性与计时（这部分是新的，也是最容易做错的）

现在的计时器是**页面级**的：一个 `MIN_VISIBLE_SECONDS` 计到底。
多内容页面必须改成**每个单元一个计时器**，且判据要同时满足：

| 条件 | 为什么 |
|---|---|
| 单元根进入视口 | 在 DOM 里 ≠ 被看到 |
| 可见面积 ≥ 阈值（建议单元高度的 50% 或视口高度的 30%，取小） | 擦边划过不算读 |
| 连续可见时长 ≥ `MIN_VISIBLE_SECONDS` | 和现在的 8s 一致 |
| `ownership !== 'ambiguous'` | 归属不确定就不记 |
| `contentId` 稳定可绑定 | 拿不到 id 的单元无法去重，记了就是脏数据 |

`IntersectionObserver` 天然适合这件事，而且比现在的轮询更省。

## 3. 迁移路径（每一步都可独立发布）

**M0 · 不动行为，只换形状**（约半天）
把现有 `extractContent` 包成 `extractContentUnit`，
`discoverContentUnits` 在独立回答页/文章页只返回一个单元。
行为逐字节不变，测试全绿 —— 这一步只是把接缝开出来。

**M1 · 问题页里的回答**（1–2 天，见第 4 节）
`discoverContentUnits` 在 `/question/<qid>` 上返回 N 个 answer 单元；
计时器改成 per-unit；`getActiveContentUnit` 用 IntersectionObserver。

**M2 · feed / 热榜 / 搜索**（3–5 天，见第 5 节）
新增语义下限判据：只有摘要、字数不够、或展开前的卡片一律不分析。

**M3 · 聚合页**（未排期）

> 每一步之间，`NO FALSE ATTRIBUTION > COVERAGE` 不松动。
> 宁可少记一篇，不可把 A 的正文记成 B。

## 4. 问题页支持的实现成本

**这是下一步最该做的。** 真实用户确实就在问题页里连着读好几个回答。

| 要做的 | 成本 | 风险 |
|---|---|---|
| `discoverContentUnits` 在问题页返回每个 `.List-item` / answer 容器 | 小 | 低 |
| 从每个单元自己的属性里取 answerId | **中** | **高** —— 必须拿真实 DOM 核对，不能凭记忆写 selector |
| per-unit 计时器 + IntersectionObserver | 中 | 中（要防抖：快速滚动不该触发） |
| 面板"当前正在读第几个回答"的呈现 | 小 | 低 |

**合计约 1–2 天，但其中"稳定拿到每个回答的 answerId"必须先做一次真人 DOM 勘察。**
拿不到稳定 id 的话整件事不成立 —— 那时候正确的结论是**继续不支持**，
而不是退而求其次用"第 N 个"当 id（那种 id 一刷新就漂）。

**明确不能做的两件事**：
- 把整个问题页当成一篇内容（正文会是多个回答拼起来的，标签必然是错的）
- 把第一个回答当成整个页面（用户可能根本没读它）

## 5. feed / 搜索 / 热榜的实现成本

| 要做的 | 成本 | 风险 |
|---|---|---|
| 卡片单元发现 + per-unit 可见性 | 中 | 中 |
| **语义下限判据** | **中** | **高** |
| 展开检测（用户点了"阅读全文"才算） | 中 | 中 |
| 虚拟列表 / 无限滚动下的单元生命周期管理 | **大** | **高** |

**合计 3–5 天，风险显著高于问题页。** 核心难点不是技术，是判据：

> 卡片进入 DOM ≠ 用户读了。
> 摘要有 80 个字 ≠ 有足够语义可以抽概念。

feed 里绝大多数卡片用户只是划过。如果判据放松一点，历史里会迅速被
"我根本没读的东西"填满 —— 那会**直接摧毁产品的核心主张**：
面板显示的不再是"你读了什么"，而是"信息流推了什么给你"。
那恰恰是知流存在的理由的反面。

所以 feed 支持的正确顺序是：**先把判据设计对，再写代码。**

## 6. 这次黑客松提交前做什么

**只做已经做完的那件**：U-14 的 SPA 归属误判修复（见 `CLAIM_EVIDENCE` C-14）。

**M0–M3 全部留到赛后。** 理由不是时间不够，是这套抽象一旦做一半，
会在"支持范围"上产生一个说不清楚的中间态 —— 而这个项目对外承诺的
整套 claim 体系，恰恰建立在"支持范围是可数、可验证的"之上。

提交前能安全做的、也已经做了的：
- 把 fail-closed contract 用测试钉死（`detect-page.test.ts` 28 条）
- 把归属校验的误判修掉，且**不降低**校验强度
- 把文案从"任意知乎回答页"收敛到"独立回答页 / 专栏文章"
- 诊断能直接打出 `location.href` 和"外来 id 是谁"，下次真人验收不用再猜
