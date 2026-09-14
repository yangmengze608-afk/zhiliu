# 真实知乎页面 · 人工 Field Test

```
Manual verification dates:  2026-09-09（首次）、2026-09-10（抽取复验 + 布局诊断 + 布局复验）
AUTO VERIFIED:              NO

Answer  extraction:  MANUAL RE-VERIFIED PASS      (L4)
Article extraction:  MANUAL RE-VERIFIED PASS      (L4)
Answer  layout:      MANUAL VERIFIED PASS         (L4)
Article layout:      UNVERIFIED                   (L2)
Listing fail-closed: 修复未经真人复验             (L2)
```

**证据登记在 [`CLAIM_EVIDENCE.md`](CLAIM_EVIDENCE.md)。** 下面是原始数据。

### Answer layout · L4（2026-09-10 真人复验）

```
viewportWidth        1450
protectedContentLeft  209
renderedRight         197
margin                 12
overlaps            false
```

面板右边界 197，受保护的正文列左边界 209，留出 12px。**不遮挡。**

> **证据出处（这一段是补记的，第一版漏了，红队据此怀疑数字是编的——怀疑得对）**
>
> 上面五个数**由使用者在 2026-09-10 的 Field Test 汇报中直接给出**，
> 不是本机测量，也不是从模拟页推算的。Claude 至今无法访问真实知乎
> （自动化访问被安全验证拦截，未绕过），因此**不可能自己产生这组数字**。
>
> **但这条证据的记录方式有缺陷，必须写明**：
> 当时只登记了这五个数，**没有保存 `__zhiliu()` 的原始输出块**——
> 缺 `layoutProbeCandidates`、`selectedProtectedProbe`、`matchedProbe` 等
> 无法手写、也无法反推的字段。所以它**可信但不可独立审计**。
>
> 下次复验请把 `面板布局` 整段原样贴回来，替换掉这五行。
> 从这一版起，`release-check` 增加了一条 meta 检查：
> **标 L4 的 claim 必须带原始输出块**，否则门禁失败。

**scope 就是这一行**：回答页 @ 1450 视口。
文章页布局、其它窗口宽度**都还没有真人看过**——见 `CLAIM_EVIDENCE.md` 的 U-02 / U-03。

## 一、验证结果

| 页面 | URL 形态 | 结论 |
|---|---|---|
| 知乎回答 | `/question/<qid>/answer/<aid>` | **[PASS]** |
| 知乎专栏文章 | `zhuanlan.zhihu.com/p/<id>` | 2026-09-09 **[PASS]** → 2026-09-10 **[FAIL, regression]** → 已修，**待复验** |
| 专栏广场 / 列表页 | `/column-square` | **[FAIL → bug 已确认并修复]** |

### [PASS] 回答页

```
contentType : answer
strategy    : semantic
confidence  : high
selector    : div.QuestionAnswer-content → .RichContent-inner → .RichText
标题        : 墨尔本大学是不是回国直接能当985用？
正文        : 约 364 字，未截断
preview     : 不能。首先我自己就墨大本科物理专业……
阅读计时    : 8s / 8s，已达标
```

真人核对：标题正确、正文正确、**没有**抓到评论 / 推荐 / 作者介绍 / 导航。

### [PASS] 专栏文章页

```
contentType : article
strategy    : semantic
confidence  : high
selector    : div.Post-content → .Post-RichTextContainer → .RichText
标题        : ACP：一个可能被低估的 Agent 接口协议
正文        : 约 1818 字（原文约 4239 字，结构化截断真实触发）
preview     : Claude Code 火了。OpenCode 火了。Gemini CLI、Codex CLI……
```

真人核对：标题正确、正文正确、截断标记如实。

### [FAIL] /column-square —— 已确认的真实 bug

```
contentType : unknown        ← 判对了
但抽取照样往下跑，命中：main.App-main
抓到约 1818 字，混有推荐、广告、搜索框、论文列表等整页 UI
```

**根因**：`detectPage` 判 `unknown` 是对的，但 `extractContent` **不看页面类型就往下抽**。
旧的根容器列表里有 `main`，它在任何知乎页面上都能命中，等于把整页当根容器；
再往里找到第一张推荐卡的 `.RichText.ztext`，于是诊断显示
`strategy: semantic` / `confidence: high` —— 一段**看起来很像正文**的整页 UI。

当时唯一挡住它的是 `isAnalyzable()` 里的 `type !== 'unknown'`，
所以 `/analyze` 没被调用、history 没被写入。但那是**下游一个布尔值**在替上游兜底。

**已修**（见 §四）：抽取的第一步就按页面类型白名单 fail closed，且删掉了 `main`。

## 一点五、2026-09-10 复验：上一轮修复引入的 false negative（已修，待复验）

真人在**同一类此前 PASS 的专栏文章页**上跑，拿到：

```
contentType : article        ← 判对了
confidence  : low
reason      : article 页有 2 个根容器都满足
textLength  : 0
```

### 两个候选根到底是什么

在真实浏览器 DOM 上跑 `describeCandidates()` 复现（不是我编的假 DOM）：

| | 候选 A | 候选 B |
|---|---|---|
| selector | `.Post-content` | `article` |
| DOM 关系 | **是 `article` 的后代** | **是 `.Post-content` 的祖先** |
| depth | 4 | 3 |
| contentId 证据 | 无 | 无 |
| 命中的正文 selector | `.Post-RichTextContainer .RichText` | 同左（因为它包着 A） |
| 正文字数 | 200 | 200 |

**它们是同一篇文章的两层，不是两篇互相冲突的内容。**
（另一种同形的情况：`.Post-content` 里还有 `.Post-Main`。）

### 为什么旧逻辑判成 ambiguous

上一轮为了修「SPA 换回答时用新 id 记下旧回答正文」，加了一条
"多于一个候选根 → 必须用 contentId 归属，归属不上就 fail closed"。
那条规则**只看候选的数量，不看它们的关系**。
而正常的文章页天然就有嵌套候选，于是被当成"两篇冲突的内容"整篇丢弃。

一句话：**把"嵌套"误当成了"冲突"。**

### 怎么修

`pickRoots()` 改成两步：

1. **按包含关系分组。** 互为祖先/后代的候选属于**同一条 root chain**，
   组内按"越深越具体"排序。DOM 是树，所以两个都包含同一节点的候选必然互相可比，
   贪心分组不会漏合并。
2. **只有分出多个互不包含的组时**，才是真的有多个内容实体 —— 这时才用
   contentId 归属，归属不了才 fail closed。

抽取时沿 chain **从最具体往外**试正文 selector：最内层通常就是正文容器，
万一它不含正文（比如 `.Post-Main` 只包了操作栏），往外一层仍然是**同一篇文章**，可以安全地退。
结构兜底则**只在最具体的那个根之内**做，不往外退——兜底本来就是降级路径，不该同时放宽两个维度。

### 这次修复**没有**放松 fail closed

`/column-square` 与其它 unknown 页仍然在**页面类型白名单**那一层就被挡掉，
根本走不到根容器搜索。两条回归测试专门钉住这一点。

### 仍需真人复验

修复只在**本地模拟页 + 真实浏览器 DOM** 上验证过（`article` ⊃ `.Post-content`，
抽到 188 字、`semantic / high`）。**真实 zhuanlan 页面尚未复验。**

## 一点七、2026-09-10 布局诊断（**已由当日晚些时候的复验关闭**）

> 本节记录的是**当天早些时候**发现的 probe 选错问题及其修复过程。
> 修复后的复验结果见本文开头的 L4 证据块。保留本节是为了记录根因。

真人在**抽取已经 PASS** 的真实回答页上拿到的布局诊断：

```
viewportWidth       : 1450
contentLeft         : 0
contentRight        : 1450
matchedProbe        : ".QuestionHeader-content"
availableLeftGutter : 0
```

而肉眼看到的是：回答主列居中，**左边有明显空白**。

### `.QuestionHeader-content` 的实际矩形

`left: 0 / right: 1450 / width: 1450` —— **整个视口宽**。

### 为什么它不能当 protected probe

它是**外层 wrapper**，不是用户阅读的那一列。旧算法问的问题是
"页面上最大的内容容器从哪里开始"，答案必然是 page wrapper，于是
`contentLeft = 0` → `gutter = 0` → 面板永远 hidden，而且**静默成立**：
诊断输出里只有一个 `{mode:'hidden'}`，看不出哪里错了。

### 新定义

> **protectedContentLeft** = 包着「我们正在记录的这篇正文」的那一列中，
> **最外层的、仍然不是满宽 wrapper 的**那个祖先的左边界。

做法是从**抽取层定位到的正文元素**向上走祖先链，逐个量矩形，
越往上越宽，直到某一层达到 `视口宽 × 0.9` 就判定为 page-level wrapper 并拒绝。
在幸存者里取 **left 最小**的——最保守的那条边界。

**不允许取更靠右的元素。** 正文元素自己（`.RichText`）的 left 含卡片内边距，
拿它当边界能凭空多出几十像素 gutter，但"再往右"其实早已进入阅读区。
规则写死为「取 left 最小」，并有一条专门的测试钉住这一点。

**找不到可信的阅读列（全是满宽 wrapper，或根本没抽到正文）→ 返回 null → 面板隐藏。**
`NO OVERLAP > PANEL VISIBILITY` 这条原则没有变。

### 在真实浏览器里按真人给的几何复现

模拟页照搬真人量到的形状：满宽 `.QuestionHeader-content`（1450）包着居中的
694px 回答列，视口 1450。跑真实构建产物：

| 候选 | left | right | width | 结果 |
|---|---|---|---|---|
| `div.RichText.ztext` | 249 | 895 | 646 | 通过体检，但 **left 更大，未选中**（防作弊） |
| `div.RichContent-inner` | 249 | 895 | 646 | 同上 |
| **`div.QuestionAnswer-content`** | **225** | **919** | **694** | ✅ **选中** |
| `div.wrap` | 0 | 1450 | 1450 | ❌ page-level wrapper |
| `div.QuestionHeader-content` | 0 | 1450 | 1450 | ❌ page-level wrapper |
| `body` / `html` | 0 | 1450 | 1450 | ❌ page-level wrapper |

结果：`protectedContentLeft = 225` → `availableLeftGutter = 201` → **full / 201px**，
渲染后右边界 213，距正文列 **12px**，`overlaps: false`，无裁切。
手动折叠态 197.1px、右边界 209.1、同样不重叠。

**但这是模拟页，不是真实知乎。** 真实知乎的回答列宽度和居中方式可能不同，
`.QuestionAnswer-content` 在真实页面上是不是那一列也**没有被证实**——
新算法不依赖这个类名（它从正文元素往上走），但选中的到底是哪个元素，
只有下一次真人验证能回答。

## 二、当前正式支持的页面

| | |
|---|---|
| **支持** | `answer`（回答独立页 / 问题页内的回答）、`article`（专栏文章） |
| **fail closed** | 其余全部：首页 feed、热榜、搜索页、个人主页、**不带 `/answer/` 的问题页**、**专栏广场 / 各类列表页** |

fail closed 的含义是**一个字都不抽**：不做 DOM 扫描、不发 `/analyze`、不写长期 history。
诊断里会显示 `strategy: unsupported`，并明确说明这是预期行为、不是故障。

<!-- gate:allow F-01 这一行正是在禁止这个读法 -->
**不要**读成"所有知乎页面都支持"。也**不要**再写"DOM 从未在真实知乎页面验证过"——
回答页与文章页现在有真人证据；其余页面类型仍然没有，只是它们已经 fail closed 了。

## 二点五、面板布局的**模拟页**验证（真实知乎的结果见开头 L4 证据块）

`layout.ts` 的判断在 Chrome 里跑过一遍，页面是按知乎版式复刻的本地模拟页
（正文列 690 + 内边距 48，右侧栏 296，居中；顶栏 52px）——**不是 zhihu.com 本身**。

量到的东西直接改了实现：

| 视口 | 正文左边界 | 可用 gutter | 面板 |
|---|---|---|---|
| 1600 | 278 | 254 | 完整，224px，离正文 42px |
| **1440** | **198** | **174** | 完整，174px，离正文 12px |
| 1000 | 0 | 0 | **隐藏** |

**1440 那一行是这次改实现的原因。** 原本 `MIN_FULL_WIDTH = 196`，
意味着最常见的桌面宽度会直接掉进胶囊态。实测 174px 放得下四行柱状图，
于是阈值下调到 168。

还抓到一个真实失效：视口从 1440 拖到 1000 之后，面板**仍停在 174px 宽、右边界 186**，
而正文左边界已经是 0——直接压在正文上。原因有两层：`resize` 回调用了 `requestAnimationFrame`
而 **rAF 在后台标签页不执行**；更根本的是知乎版式会在**完全没有 resize** 的情况下移动
（右侧栏异步加载完、登录横幅出现/消失）。现在的兜底是每秒量一次、变了才重排。

**已验证**：回答页 @ 1450 —— 见开头的 L4 证据块（数字由使用者提供）。
**仍未验证**：文章页布局、其它窗口宽度、以及完整的 `__zhiliu()` 原始输出。

## 三、还没有人验证过的

- 回答的「展开阅读全文 / 收起」前后
- 万字长回答（文章页的截断已验证，回答页的没有）
- 视频回答、专栏付费墙、盐选内容
- SPA 内部从回答页跳到另一篇回答
- **回答页布局的完整原始输出** —— 第一优先级。L4 结论已有（见开头），
  但只有五个数字，缺 `layoutProbeCandidates` / `selectedProtectedProbe` 等
  无法手写的字段，**可信但不可独立审计**。跑 `__zhiliu()` 把 `面板布局` 整段贴回来
- **文章页布局**（仍是 L2）
- ~~修复后的 article 抽取（§1.5）~~ —— 真人已复验 PASS
- 面板在**真实 zhihu.com** 上的位置（只在本地模拟页上验过，见 §2.5）
- 真实知乎的正文左边界到底是多少（模拟页量到 1440→198，真实值可能不同）
- 面板与知乎自身悬浮元素（回到顶部、客服气泡、登录弹窗）的叠放关系

## 四、五分钟怎么跑

### 0. 装上

```bash
cd zhiliu/extension && node build.mjs
```

Chrome → `chrome://extensions` → 打开开发者模式 → 加载已解压的扩展程序 → 选 `extension/dist`。

### 1. 三种页面各开一个，每个停留 10 秒以上

| # | 页面 | 打开什么 |
|---|---|---|
| A | 回答独立页 | `https://www.zhihu.com/answer/<任意id>` |
| B | 问题页里的回答 | `https://www.zhihu.com/question/<qid>/answer/<aid>` |
| C | 专栏文章 | `https://zhuanlan.zhihu.com/p/<id>` |
| D | 问题页（多回答，**不带 /answer/**） | `https://www.zhihu.com/question/<qid>` |
| E | 首页 feed | `https://www.zhihu.com/` |

### 2. 每个页面按 F12 打开 Console，**先切上下文**，再敲

> ⚠️ **这一步不能跳。** 扩展的 content script 跑在 Chrome 的
> **isolated world** 里，`__zhiliu` 不在页面自己的 `window` 上。
> 直接在默认上下文里敲会得到 `Uncaught ReferenceError: __zhiliu is not defined`——
> 那**不代表扩展坏了**，只代表你在另一个世界里找它。

在 Console 左上角的**上下文下拉框**（默认显示 `top`）里，选 **`知流 · 信息面板`**，
然后敲：

```javascript
__zhiliu()
```

会立刻打印一份诊断。**要看的是这几行：**

```
contentType     answer (id=123456789)
抽取策略        semantic → 可信度 high
命中 selector   div.QuestionAnswer-content .RichText.ztext
标题            9 字：大厂和小公司怎么选
正文            1420 字（未截断）
阅读计时        12s / 8s  已达标
面板布局
  { viewportWidth: 1440, contentLeft: 198, contentRight: 936,
    matchedProbe: '.Post-Header', availableLeftGutter: 174,
    computedMode: 'full', computedWidth: 174, computedLeft: 12, computedTop: 72,
    renderedLeft: 12, renderedRight: 186, renderedWidth: 174,
    overlaps: false, visibility: 'visible' }
根容器候选
  [ { selector: '.Post-content', depth: 4, isDescendantOf: ['article'],
      bodySelector: '.Post-RichTextContainer .RichText', bodyTextLength: 200,
      chosen: true, chosenRank: 0 }, … ]
正文前 200 字
  我在大厂待了三年然后跳去了小公司……
```

> **`__zhiliu()` 现在每次都重新抽取，不复用缓存。**
> 上一次复验报告里出现过 `strategy: semantic` 配 `textLength: 0` 这种自相矛盾的组合——
> 早先的实现是 `lastExtraction ?? extractContent()`，会把上一次**成功**时的结果显示出来。
> 现在现场抽取与"最近一次真正入库的记录"（`lastRecorded`）分两段显示，不会再混。
>
> **`面板布局` 和 `根容器候选` 这两段是 2026-09-10 新加的。**
> 上一次复验拿到的布局输出只有 `{mode:'hidden',left:12,top:74,width:0}`——
> 除了"藏起来了"什么也说明不了：既不知道正文左边界量到多少，也不知道哪个探针命中。
> 现在这两段能直接回答"为什么是这个结果"，不需要猜。

### 3. 逐条对照

| 检查 | 通过标准 | 不通过说明 |
|---|---|---|
| 标题 | 就是这篇的标题，不是 "知乎" 或问题页大标题 | `TITLE_SELECTORS` 要更新 |
| 正文起点 | 前 200 字**就是正文第一句** | 混进了作者简介 / 导航 → `STRIP_SELECTORS` 要更新 |
| 正文里没有 | 「赞同」「添加评论」「相关推荐」「京ICP备」、别人的回答 | 同上，或根容器 `ROOT_SELECTORS` 收缩失效 |
| 可信度 | A/B/C 三种页面都应该是 **high** | 出现 `medium` = selector 过期了但兜底救回来了；出现 `low` = 完全抓不到，这一篇不会被记录 |
| D（多回答问题页） | `contentType: unknown` + `strategy: unsupported` + 正文 **0 字** | 若还能抽到字，fail closed 失效了 |
| E（首页 feed） | 同上 | 同上 |
| **面板位置** | 完整面板整个待在正文**左侧**空白里，不压标题 / 正文 / 导航 | 见诊断里的 `面板布局` 一行 |
| **窗口拖窄** | 面板自动收成胶囊，再窄则消失，**始终不进正文** | 同上 |
| SPA 跳转 | 在页面内点进另一篇，再 `__zhiliu()`，`contentId` 应该跟着变 | 路由轮询失效 |
| 展开/收起 | 点「展开阅读全文」前后各敲一次，正文字数应变大 | 收起状态下抓到的是截断版（可接受，但要知道） |
| 长回答 | 万字回答应显示「原文 N 字，已结构化截断」 | 截断策略失效 |

### 4. 把结果贴回来

不通过时**最有用的一行是 `命中 selector`**。把它连同一段 `preview` 贴出来，
selector 的修改全部集中在 `extension/src/content/extract-content.ts` 顶部的三个数组里
（`TITLE_SELECTORS` / `ROOT_SELECTORS` / `BODY_SELECTORS`）和
`extension/src/content/sanitize.ts` 的 `STRIP_SELECTORS`，改这四处就够，不用动别的。

## 抽取失败时会发生什么（这是刻意设计的）

- `low` → 这一篇**不上报、不入库、不分析**。宁可漏记一篇，也不要往长期历史里写
  一条从评论区总结出来的概念——那种脏数据事后无法分辨，也无法撤销。
- **任何情况下都不会退回 `document.body.innerText`。** 这一条有测试钉着
  （`extract.test.ts` → 「三层抽取 · 第三层：必须 fail loud」）。
