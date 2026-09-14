# Claim → Evidence Registry

> **唯一规则：claim 的 scope 不得超过 evidence 的 scope。**
>
> 这份表是对外说话的**唯一授权来源**。README / PITCH / Demo 口径 / 比赛提交说明里
> 出现的每一条实质性 claim，都必须能在这里找到对应行；找不到就不许说。
>
> 校验：`npm run release-check`（失败返回非零退出码）。

## 证据等级

| 级别 | 含义 | 能支撑什么 |
|---|---|---|
| **L0** ASSUMPTION | 没有验证 | **什么都不能说** |
| **L1** UNIT | 单元测试 / 纯函数 | "这个函数的行为是……" |
| **L2** SYNTHETIC_INTEGRATION | 模拟 DOM / fixture / mock browser | "在我们构造的结构上成立" |
| **L3** LIVE_COMPONENT | 真实 HTTP / 真实 LLM / 真实 runtime，**非真实知乎页面** | "这条链路真的跑通了" |
| **L4** MANUAL_REAL_PAGE | 真人在真实 zhihu.com 上验证 | "在真实知乎上可用" |
| **L5** LIVE_ZHIHU_API | 真实知乎官方 API 调用 | "官方能力已接入" |

**为什么需要这张表。** 前六轮出现过三次同一个错误形状——
局部证据被扩大成系统 claim（R4 把实验分类器的准确率当产品准确率；
R5 把纯函数扫描说成整条链路成立；R6 把 synthetic DOM 的通过说成真实页面可用）。
三次都不是"测错了"，而是**结论的 scope 超过了证据的 scope**。

---

## 一、SUPPORTED（可以对外说，按写明的 scope）

### C-01 知乎回答页正文识别
- **Claim**：知流能识别知乎回答页（`/question/<qid>/answer/<aid>`）的正文
- **Evidence**：**L4** — 2026-09-09 首次真人验证 PASS，2026-09-10 复验 PASS
- **证据细节**：`contentType: answer` / `strategy: semantic` / `confidence: high` /
  正文 364 字 / preview 经人工确认是目标回答正文 /
  selector 链 `div.QuestionAnswer-content → .RichContent-inner → .RichText`
- **出处**：`docs/REAL_PAGE_TEST.md`
- **Status**：**SUPPORTED**

### C-02 知乎专栏文章正文识别
- **Claim**：知流能识别知乎专栏文章（`zhuanlan.zhihu.com/p/<id>`）的正文
- **Evidence**：**L4** — 2026-09-10 MANUAL RE-VERIFIED PASS
- **证据细节**：`article` / `semantic` / `high` / 1818 字（原文约 4239 字，结构化截断真实触发）/
  selector 链 `div.Post-content → .Post-RichTextContainer → .RichText`
- **出处**：`docs/REAL_PAGE_TEST.md`
- **Status**：**SUPPORTED**

### C-03 面板可安全放入回答页左侧 gutter
- **Claim**：在知乎**回答页**上，知流面板可以放进正文左侧空白，不遮挡正文
- **Evidence**：**L4** — 真人在真实回答页上实测
- **证据细节**：`viewportWidth 1450` / `protectedContentLeft 209` /
  `renderedRight 197` / `margin 12` / **`overlaps: false`**
- **Scope 限制**：**只覆盖回答页、只覆盖 1450 宽视口。**
  文章页的布局、其它视口宽度**都没有真人证据**（见 U-02、U-03）。
- **Status**：**SUPPORTED**

### C-04 概念抽取由真实模型完成
- **Claim**：概念抽取由真实大模型完成，不是关键词规则
- **Evidence**：**L5**（2026-09-13 起）— 真实知乎官方直答；**L3**（历史）— 真实 Ollama `qwen2.5:14b`
- **证据细节**：`packages/extension-test/live-e2e.test.ts` 三篇真实文章走完
  扩展 → `/analyze` → Ollama → 本地历史 → 面板；每条 `ReadEvent` 带
  `provenance: {provider:'ollama', model:'qwen2.5:14b', promptVersion:'v3-shape'}`；
  服务不可用时整体 skip，**不伪造结果**
- **L5 证据细节**：`ZHILIU_REQUIRE_LIVE=1` 模式下 `live-zhida.test.ts` +
  `live-e2e.test.ts` 共 **7/7 通过（9.95 秒）**——该模式下任何 skip 都算 fail，
  所以"通过"不可能是"跳过"伪装的；
  `/analyze` 真实链路返回 `provenance:{provider:'zhida', model:'zhida-fast-1p5', promptVersion:'v3-shape'}`，
  延迟 2408ms；29 条冻结验收集全量真实跑通，schema 29/29
- **必须同时说的限定**：**仅当分析服务已启动且扩展配置了 `ANALYZE_ENDPOINT` 时成立。**
  见 F-08。
- **证据的时间点**：这条 L3 证据取自 commit `2cf0535` 的一次全绿运行（5/5）。
  RC 阶段（`397be91`）**没能在本机复现**——不是回归，是内存：
  三个 RC commit 对 `extension/src` / `packages/core/src` / `server` 的 diff **为空**，
  而当时机器 swap 已用 10.7 GB，14B 拿不到 9.5 GB，每次请求后立刻被驱逐。见 U-07。
- **Status**：**SUPPORTED WITH QUALIFIER**

### C-05 分析不阻塞浏览
- **Claim**：分析在后台进行，不阻塞用户继续浏览
- **Evidence**：**L3** — 真实模型端到端实测，上报耗时 **2ms**，三篇真实推理共 ~12s 在后台完成
- **Status**：**SUPPORTED**

### C-06 阅读历史只存在本地
- **Claim**：长期阅读画像、趋势、集中度只在浏览器本地计算，服务端不接收任何用户状态
- **Evidence**：**L1 + L3** — 请求体字段白名单强制执行（多余字段 400），
  `packages/extension-test/privacy.test.ts`
- **不得同时宣称**：见 F-09（服务端无法推断阅读轨迹）
- **Status**：**SUPPORTED**

### C-07 mock 与真实分析在界面上可区分
- **Claim**：未接真实模型时面板显示「演示数据」，不会伪装成 AI 分析
- **Evidence**：**L1 + L2** — `sourceBadge()` 只要窗口里有一条 mock/demo 就显示「演示数据」（不按多数决）；
  冒充防护测试：返回常量 JSON 但无 provenance 的服务器 → 降级为 `ungrounded`
- **Status**：**SUPPORTED**

### C-08 已真实调用知乎官方搜索 API
- **Claim**：知流已真实调用知乎开放平台 `zhihu_search`，并按真实响应字段处理结果
- **Evidence**：**L5** — 2026-09-13 四次真实查询全部 `Code:0`，延迟 0.67–0.97s
- **证据细节**：经 CLI 4 次查询（`社交焦虑` / `AI 替代工作` / `大学生就业稳定` /
  `亲密关系压力`，各 5 条），脱敏样本 `fixtures/live/zhihu-search-20260913.json`；
  另用 `server/api-probe.ts` 走**知流自己那条原生 HTTP 路径**再打三次，
  报告 `bench/api-probe-report.json`：官方文档声明的 14 个字段**一个不缺**，
  多返回一个未声明的 `AuthorSignature`（已补进 `types.ts`），延迟中位 615ms。
  回归 `packages/extension-test/live-zhida.test.ts`
- **出处**：`docs/API_LIVE_20260913.md` 第三节 + `bench/api-probe-report.json`
- **Status**：**SUPPORTED**

### C-09 已真实调用知乎直答并用于概念抽取
- **Claim**：知流已真实调用知乎官方直答（`/v1/chat/completions`），并用它完成真实的 1–3 概念抽取
- **Evidence**：**L5** — 2026-09-13 真实调用；29 条冻结验收集全量跑通
- **证据细节**：endpoint / Bearer / `X-Request-Timestamp` / 三个模型名 / OpenAI 响应形状
  **全部实测 VERIFIED**；瞎编的模型名返回 `400 model_not_found`（服务端真的在校验）；
  无效凭证返回诚实的 `401 invalid_api_key`（所以 `resp.ok` 可信）
- **出处**：`docs/API_LIVE_20260913.md` 第四节
- **Status**：**SUPPORTED**

### C-10 出货的 production provider 是知乎官方直答
- **Claim**：比赛默认 runtime 是 PROFILE A（知乎官方直答），本地 14B 降为 fallback
- **Evidence**：**L5** — 同一套冻结验收集、同一 prompt、独立盲评
- **证据细节**：14B 的 **p50 9.354s 没过**早就冻结的 Gate「p50 ≤ 8s」；直答 2.218s 过。
  直答的 schema 单次是 **28/29 = 96.6%，没过** Gate 1（≥98%），重试后 100% ——
  **两个都不是干净地四条全过**，差别在于直答差的那条一次重试就补上了，
  而 14B 的 p50 是这台机器上本地 14B 的物理下限，重试救不了
- **⚠️ 不许讲成"今天的发现"**：`bench/model-select/score-report.json` 从 R5 起就写着
  14B `gatePass: false`（`p50: false`）而它**仍被选为生产默认**。
  今天变的不是"14B 过不过 Gate"，而是**第一次出现了一个过 Gate 的候选**
- **必须同时说的限定**：见 Q-04 —— 选它**不是因为它更准**
- **Status**：**SUPPORTED**

### C-11 公网分析服务已上线并真实跑通
- **Claim**：知流的分析链路已部署到公网 HTTPS，评委无需接触作者本机即可验证
- **Evidence**：**L5** — 2026-09-14 对 `https://zhiliu-analyze.vercel.app/api/analyze` 的真实请求
- **证据细节**：`GET` 返回 `{"ok":true,"llm":{"provider":"zhida","model":"zhida-fast-1p5"}}`；
  `POST` 真实分析返回 `status:"llm"` / `provenance.provider:"zhida"` /
  模型延迟 2605ms / 端到端 3.1s；夹带 `userId` 被 **400** 拒绝；
  非知乎来源**不返回** `Access-Control-Allow-Origin`。
  出处 `docs/DEPLOY_BACKEND.md`
- **Status**：**SUPPORTED**

### C-12 出货扩展包分成两个，且互不混淆
- **Claim**：`zhiliu-production.zip` 连真实后端，`zhiliu-demo.zip` 不连任何服务
- **Evidence**：**L1** — `scripts/package-release.mjs` 打包后逐个解开校验，
  门禁「两个发布包各自是它声称的那个东西」再验一次
- **证据细节**：production 包 `ANALYZE_ENDPOINT` = 上面那个 https 地址且
  `host_permissions` 含对应 origin；demo 包端点为空字符串、`host_permissions` 为空
- **Status**：**SUPPORTED**

### C-13 作品链接、扩展下载、分析 API 都在同一个公开域上
- **Claim**：评委不接触作者本机，只点一个链接就能走完「看懂 → 下载扩展 → 验证后端在跑」
- **Evidence**：**L5** — 2026-09-14 用**无 cookie 的 curl** 逐个实测
- **证据细节**：`/` → 200，22504 bytes，`<title>知流</title>`，页面内 sign-in 字样计数 **0**；
  `/icon.png` 200 · `/screenshot.png` 200 · `/zhiliu-production.zip` 200（73213B，
  SHA-256 与 `release/` 产物一致）· `/zhiliu-demo.zip` 200 · `/api/analyze` 200。
  出处 `docs/DEPLOY_BACKEND.md`、`docs/SUBMISSION_CHECKLIST.md`
- **为什么不是 Claude Artifact**：那个默认私有，要作者手动改可见性 ——
  等于把「能不能交」挂在一个容易忘的手动步骤上
- **Status**：**SUPPORTED**

### C-15 production 扩展包在真实 Chrome 里真人复验通过
- **Claim**：`zhiliu-production.zip` 装进真实 Chrome、打开真实知乎回答页，面板会显示「AI 分析」并真实入库
- **Evidence**：**L4** — 2026-09-14 用户本人真机复验 PASS
- **证据细节**：真实回答页 → `strategy: semantic` / `confidence: high` → 正文 364 chars →
  可见停留 8s **qualified** → Dashboard **visible** → 徽标「**AI 分析**」（非「演示数据」）→ **1/10 入库**
- **意义**：这条把「评委真正会走的那条路径」从 L1（只核对包内容）升到 L4（真人真机跑通）。
  `verify-release` 只验网络链路，验不了 Chrome 渲染——这一条正是它验不了、只能靠真人的部分
- **Status**：**SUPPORTED**（原 U-14 已 CLOSED 并升级为此条）

### C-14 问题页里的单个回答可以正常抽取
- **Claim**：`/question/<qid>/answer/<aid>` 这种 URL 上，知流能正确抽到**那一篇**回答的正文
- **Evidence**：**L1 + L2** — 归属校验修复 + 5 条针对性回归
- **证据细节**：`packages/extension-test/real-page.test.ts` 的
  「U-14：问题页里的单个回答」三条 + 原有两条张冠李戴用例。
  修的是 `foreignIdNear`：祖先上挂的**问题 id** 是本次 URL 自带的，
  不该被当成"别人的 id"；`mentionsId` 同时看子孙，因为 answerId 常挂在根容器里层
- **必须同时说的限定**：**这条还没有真人复验**（U-16）。修复本身有测试覆盖，
  但真人是在真实知乎页面上撞到这个 bug 的，也只有真人能确认它真的好了
- **绝不可以**：说"支持问题页"。`/question/<qid>`（不带 `/answer/`）仍然**不支持**，
  见 F-15
- **Status**：**SUPPORTED WITH QUALIFIER**

### C-15 面板在所有知乎页面上都在，但只有支持的页面会采集
- **Claim**：知流的入口与已有历史在任何 `zhihu.com` / `zhuanlan.zhihu.com` 页面上都能看到；
  但只有独立回答页与专栏文章会计时、抽正文、调模型、写历史
- **Evidence**：**L1** — 两条判据完全解耦，各有测试与门禁
- **证据细节**：可见性由布局量测决定（放不下就退成 40px 贴边 dock，**不再整块消失**）；
  采集资格只由 `detectPage` 的路由判定决定。
  `packages/extension-test/visibility-vs-collection.test.ts` 17 条把两条线分别钉住；
  门禁「量不到阅读列时只退到贴边 dock」与「面板到处都在，但采集范围没放宽」
  各有一个 PoC 验证过会失败
- **必须同时说的限定**：**dock 这一版还没有真人复验**（U-18）。
  另外"不遮挡"对 dock 的判据是"与阅读列不相交"，
  在量不出阅读列的页面（搜索、feed）上按安全处理 —— 那里没有"正文列"这个概念
- **Status**：**SUPPORTED WITH QUALIFIER**

---

## 二、QUALIFIED（可以说，但必须带限定语）

### Q-04 这套盲评测不出直答与本地 14B 的质量差别
- **Claim**：**这套 29 条盲评 rubric 分辨不出**直答与 `qwen2.5:14b` 的标签质量差别
  （注意这是关于**仪器**的断言，不是关于两个模型"打平"的断言）
- **Evidence**：**L2 语料 + L5 调用** — 两轮独立盲评 + 一次判官重测
- **证据细节**：**同一份 `qwen2.5:14b` 输出**（`bench/model-select/runs-qwen2_5_14b.json`，
  逐字节相同）被三个独立判官打出 **1.8276 / 1.6552 / 1.4828**，判官间极差 **0.3448**；
  而两个系统的差是 **+0.103**（R8）/ **+0.172**（R8b，去掉 confidence 指纹后）。
  **噪声是效应的 2–3 倍，也大于 rubric 冻结的 0.25 并列阈值。**
  两轮的符号一致（直答赢 5:2 / 6:2），双侧符号检验 p = 0.453 / 0.289，**都不显著**。
  出处 `docs/API_LIVE_20260913.md` 第五节
- **必须带的限定**：① 29 条是作者手写的**合成语料**；
  ② 第一版 packet 通过 `confidence` 数值泄露了系统身份（13/29 条可 100% 揭盲，
  其中 5 条落在决定分差的 7 条里）；重出不含 confidence 的 packet 重判后
  **直答的优势反而扩大**，所以指纹不是在给直答加分，但结论仍是"测不出"；
  ③ RUBRIC 第五节的 0.25 是为**模型大小**写的反偏置规则，
  本地 vs 云端之间没有"较小/较大"的序，**不再引用它做显著性阈值**
- **绝不可以**：说「直答比本地模型更准」，也不要说「两个模型打平」——
  能说的只有「这套评分分辨不出差别」。选它的理由是延迟 Gate 与 0 内存占用
- **Status**：**QUALIFIED**

### Q-05 知乎搜索对知流的作用
- **Claim**：搜索可以为「为什么归到这个主题」提供知乎语境参考
- **Evidence**：**L5** — 5 个概念词各取前 3 条真实结果人工核对
- **证据细节**：`考公考编` / `拖延` / `消费观` 三个返回的标题一看就懂；
  `亲密关系` 同一个问题重复返回两次（需按 `Title` 去重）；
  `算法推荐` 串台，返回的是推荐系统工程论文（Dense Scaling / Netflix 精排），
  不是「被算法喂养」的读者语境。出处 `docs/API_LIVE_20260913.md` 第三节
- **必须带的限定**：① 5 个里 **3 个好、1 个重复、1 个串台**
  （`算法推荐` 搜出的是推荐系统工程论文，不是「被算法喂养」的读者语境）；
  ② 它**不提高分类准确率**（见 F-04），只做展示层的语境补充；
  ③ **尚未接进产品界面**，当前只有 probe 证据
- **Status**：**QUALIFIED**

### Q-01 关键词统计会被表层词系统性欺骗
- **Claim**：纯关键词统计每三篇就有一篇被判到问题意识完全不同的大类
- **Evidence**：**L1/L2** — 100 条盲测，Baseline A 重大误分类率 0.295
- **必须带的限定**：这是**实验结论**，对照组是 **Claude 实验分类器**，不是出货的 14B
- **Status**：**QUALIFIED**

### Q-02 生产模型在验收集上的表现
- **Claim**：`qwen2.5:14b` 在 29 条验收集上主分 1.83/2、0 条判错领域、多主题 6/6
- **Evidence**：**L2** — 29 条是**作者手写的合成语料**，独立 subagent 平衡盲评
- **必须带的限定**：① 合成语料，不是真实知乎内容；② 「0 条判错领域」**不等于**「没有多余标签」——
  21 条明确单主题里有 10 条给了第二个概念，判官认定其中 4 条确属凑数
- **绝不可以**：把 1.83 说成"准确率"，或与 0.889 并列比较
- **⚠️ 跨轮不可比**：这里的 **1.83** 是 **R5 判官**给的。同一份输出 R8 判官给 1.655、
  R8b 判官给 1.483（见 Q-04）。**这三个数不能互相引用、也不能和别的轮次比大小。**
  `bench/model-select/score-report.json` 里写的 1.828 是 R5 那次，不是失效数据，
  但它只在 R5 的判分口径内有意义
- **Status**：**QUALIFIED**

### Q-03 未支持页面 fail closed
- **Claim**：首页 feed / 热榜 / 搜索 / 个人页 / 不带 `/answer/` 的问题页 / 专栏广场
  一律不抽取、不分析、不入库
- **Evidence**：**L2**（修复）+ **L4**（bug 本身）
- **证据细节**：bug 是真人在 `/column-square` 上发现的（L4）；
  **修复只有 synthetic 测试**（20 项，`packages/extension-test/real-page.test.ts`），
  **没有真人在真实列表页上复验过修复**
- **Status**：**QUALIFIED** —— 说"设计为 fail closed 且有测试覆盖"，
  不说"已在真实页面验证不会误抓"

---

## 三、FORBIDDEN（禁止出现在任何对外文案里）

| # | 禁止的说法 | 为什么 |
|---|---|---|
| **F-01** | 「知流支持知乎所有页面」/「全部页面」 | 证据只覆盖 answer 与 article 两种。其余是 fail closed，**不是支持** |
| **F-02** | ~~「已接入知乎 Search API」~~ **2026-09-13 解除** | 已由 C-08 以 L5 证据取代。新禁令见 F-11 |
| **F-03** | ~~「已接入 Zhida / 知乎官方 AI」~~ **2026-09-13 解除** | 已由 C-09 以 L5 证据取代。新禁令见 F-12 / F-13 |
| **F-04** | 「知乎 API 提高主题分类准确率」 | 100 条盲测四个证据层 McNemar p 0.125–1.000，**测不出增益**。数据反对这个说法 |
| **F-05** | 「知流产品准确率 88.9%」 | 0.889 来自 **Claude 实验分类器**，不是出货的 14B；语料与评分口径也不同 |
| **F-06** | 「我们主题分类比别人准」 | 没有与任何第三方产品做过对照 |
| **F-07** | 「打破信息茧房」/「诊断你的偏见」/「纠正知乎算法」/「AI 判断你被困住了」 | 产品不做价值判断。集中度**不代表好坏**，这是写进代码的文案约束 |
| **F-08** | 「出货扩展默认就是实时 AI」 | 默认构建 `ANALYZE_ENDPOINT` 为空 → 走本地 mock → 面板显示「演示数据」 |
| **F-09** | 「服务器技术上绝对无法推断任何阅读轨迹」 | 逐篇请求仍会到达服务端，同源 IP + 到达时间在网络层理论上可重建。代码层面阻止不了 |
| **F-10** | 「面板在所有页面/所有窗口宽度下都不遮挡正文」 | L4 证据只有**回答页 @ 1450**。见 C-03 的 scope 限制 |
| **F-11** | 「知乎搜索让知流的主题判断更准」/「搜索已进入分析主链路」 | 搜索**没有**进主链路，也测不出准确率增益。见 Q-05 与 F-04 |
| **F-12** | 「直答比本地 14B 更准」/「换成官方模型提升了准确率」 | 分差 +0.103，冻结口径 <0.25 = 打平，符号检验 p≈0.23 不显著。见 Q-04 |
| **F-13** | 「已接入知乎登录 / OAuth」 | **今天没做**，一行代码都没写。见 U-08 |
| **F-15** | 「支持知乎问题页」/「打开任意知乎回答页就能用」 | `/question/<qid>`（不带 `/answer/`）**不支持**。那一页同时挂着很多个回答，无法确定用户读的是哪一篇，硬抽会把别人的正文记成这一篇。只支持**独立回答页**与专栏文章。升级路径见 `docs/CONTENT_UNIT_DESIGN.md` |
| **F-14** | 「每天 5000 次直答额度，够随便调用」 | 日额度与**瞬时限速**是两回事：实测背靠背 12 次后连续 429。见 U-09 |

---

## 四、UNVERIFIED（还没有证据，不许说，且要主动披露）

| # | 能力 | 当前等级 | 缺什么 |
|---|---|---|---|
| ~~U-01~~ | ~~知乎官方 Search API~~ | **已升级 L5** | 2026-09-13 真实调用，见 C-08 |
| **U-02** | 文章页的面板布局 | L2 | 真人在真实专栏页上看一眼 |
| **U-03** | 非 1450 视口下的面板布局 | L1/L2 | 真人在不同窗口宽度下看 |
| **U-04** | 展开/收起、万字长回答、视频回答、付费墙 | L0 | 真人验证 |
| **U-05** | 真实知乎内容上的抽取质量（不是"能不能抓到"，是"抓对没有"） | L0 | 真人对一批真实文章核对概念标签。**换成直答之后这条仍然是 L0** —— 29 条验收集是手写合成语料 |
| **U-06** | 长期使用（几十上百篇后）的集中度/趋势是否有意义 | L1 | 真实连续使用 |
| **U-07** | **14B 在演示机器上能否稳定常驻** | — | 2026-09-10 实测：同时开着几个 Electron 应用时 swap 用到 10.7 GB，模型每次请求后被立刻驱逐，`keep_alive: 30m` 形同虚设，预热从 34 秒涨到 124 秒，一个 5 token 请求要 280 秒。**这不是代码问题，是内存问题**，但它会让演示当场失败。见 `HACKATHON_RUNBOOK.md`。**2026-09-13 起 14B 降为 fallback，这条从「演示主路径风险」降级成「降级预案风险」** |
| **U-08** | 知乎登录 / OAuth | **L0** | 今天没做。人气奖看登录用户数，所以它是 P1 不是 P0 |
| **U-09** | 直答限速的**确切**阈值 | L3（现象测到了，阈值没测准） | 背靠背 12 次后连续 429；13.5 秒间隔连打 20 次仍撞到 1 次。**它是概率性的，不是干净阈值**，所以代码里做退避而不做速率预算 |
| ~~U-10~~ | ~~公网 backend 上的直答可用性~~ | **已升级 L5** | 2026-09-14 部署后实测通过，见 C-11。原文保留如下 |
| （原 U-10） | 公网 backend 上的直答可用性 | — | 换成云端 provider 之后网络成了新的单点。本项目线上提交、远程评审，要验的是「部署到公网的 backend 能不能稳定打到 developer.zhihu.com」，不是任何线下场地的网络 |
| **U-18** | **贴边 dock 的真人复验** | L2 | 浏览器里验过渲染与交互闭环（40px → 点开 224px → × 回到 40px），但没有真人在真实知乎的搜索页 / feed / 问题页上看过它。尤其要看的是：dock 会不会压住知乎自己的右侧栏或悬浮按钮 |
| **U-16** | **C-14 的真人复验** | L2 | 归属校验的修复只有合成测试。真人是在真实知乎上撞到这个 bug 的，也只有真人能确认它真的好了 —— 新包已就绪，等一次真人验收 |
| **U-17** | 问题页 / feed / 热榜 / 搜索里的多内容单元阅读 | **L0** | 当前抽象是 `Page Type → Extractor`，一页只能有一篇内容。真实用户大量阅读发生在一页多内容的场景里。设计与成本估算见 `docs/CONTENT_UNIT_DESIGN.md`，**赛后做** |
| **U-15** | **同一篇内容重复分析会不会给出同一组概念** | L3（现象测到了，没量过幅度） | 2026-09-14 模拟评委随手试的路径时撞到：同一段正文连打两次，一次返回**空概念**（unknown），一次返回 `算法推荐(0.6)`。原因清楚 —— 直答**没有 temperature 控制**（传了会被静默忽略，见 C-09），所以输出本来就是随机的。产品里这件事影响有限（同一篇内容有 30 分钟去重窗口，不会反复分析），但**评委如果拿同一段文字试两次，可能看到不同结果**。没量过复现率，因为量它要烧掉不少额度 |
| **U-11** | **额度耗尽时直答返回什么** | **L0** | 已实测 401 / 400 / 429 三种失败，**耗尽没测**——而它是唯一真正会在赛中发生的那一种。官方文档只对 `Code/Message` 类接口写明 30001，直答走 OpenAI 形状，所以没人知道。推测是 429，不打算为了测它烧掉 5000 次额度；代码上已加「连续 3 次 429 → 熔断 60 秒」，对 429 与耗尽都成立 |
| ~~U-13~~ | ~~作品链接是否对外可访问~~ | **已解决** | 最早发在 Claude Artifact 上，实测**默认私有**（未登录显示「Sign in to view this page」）。改成部署到自有 Vercel 域：`https://zhiliu-analyze.vercel.app/`，用**无 cookie 的 curl** 实测 HTTP 200 且页面内无任何 sign-in 字样。见 C-13 |
| ~~U-14~~ | ~~production 扩展包在真实 Chrome 里装上之后的表现~~ | **已升级 L4 · CLOSED** | 2026-09-14 真人复验 PASS：真实回答页 → `semantic/high` → 364 chars → 8s qualified → Dashboard visible → 徽标「**AI 分析**」→ 1/10 入库。已升级为 SUPPORTED claim **C-15** |
| **U-12** | 知流自己那条搜索 HTTP 路径的真实调用留档 | L3（跑过，没留档） | 提交的 fixture 是官方 `zhihu-cli` 打出来的，不是 `LiveSearchTransport`。后者在 `live-zhida.test.ts` 里真跑过并验了字段，但**那次运行的输出没有存成 artifact** |

---

## 五、维护规则

1. 想在对外文案里加一句新的实质性 claim → **先在这里加一行**，写清 evidence 与 scope。
2. 证据升级了（比如 U-02 被真人验证）→ 改这里，再改文案。
3. `npm run release-check` 会扫 production 文档里的禁止措辞。**它挡不住所有 overclaim**，
   只挡已知的那些——这张表本身仍然需要人读。
4. **新增一个证据等级、或者新写一条禁令时，先问"上一条同类的坑在哪"。**
   R8 的红队抓到同一个形状两次：L4 有门禁但新引入的 L5 没有；
   R7 修掉了「正则太窄」，而今天新写的 F-11..F-14 又写窄了（15 个改写 14 个能过）。
   两次都不是没想到要建门禁，是**建的时候没去看上一次是怎么被绕过的**。
5. **布尔能力型 claim（做了 / 没做）用事实断言，不用措辞正则。**
   例如知乎登录这件事**没做**，就该由"代码里有没有 OAuth"来判定，
   而不是猜别人会写「已接入」还是「已支持」还是「已上线」。
   <!-- gate:allow F-13 本条规则讨论的就是 F-13 的判定方式 -->
6. **豁免必须是显式的、可审计的。** 用一个 HTML 注释标记：
   `<!--` + `gate:allow` + 禁令编号 + 理由 + `-->`（写全了这行自己就会被门禁挡下来，
   所以这里拆开写；真实例子见 `docs/PITCH.md` 开头那行官方赛道引用）。
   不要用"附近出现否定词就免检"这种启发式——它在两个方向上都会错：
   漏掉真 overclaim，又误伤"为了禁止某句话而引用它"的正常写法。
