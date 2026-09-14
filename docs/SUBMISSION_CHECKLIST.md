# 知乎黑客松 · 提交清单

> 字段与官方「创建项目」表单逐项对应。
> **只有全部必填项 READY，才算 SUBMISSION READY。**
>
> 最后更新：2026-09-14

## 当前状态：**SUBMISSION READY**

五个必填项全部有真实可填的东西。下面表格里的值可以直接粘进表单。

GitHub 也已经发布。只剩视频一个可选项，它**不阻塞提交**。

| 发布物 | 地址 |
|---|---|
| 作品链接 | https://zhiliu-analyze.vercel.app/ |
| GitHub | https://github.com/yangmengze608-afk/zhiliu |
| Release（最新） | https://github.com/yangmengze608-afk/zhiliu/releases/tag/v1.0.2 |

---

## 必填字段

| # | 字段 | 状态 | 值 / 说明 |
|---|---|---|---|
| ① | **项目名称** | ✅ READY | `知流` |
| ② | **主题** | ✅ READY | `灵魂匹配局`（只选这一个，不勾其他） |
| ③ | **作品链接** | ✅ READY | **`https://zhiliu-analyze.vercel.app/`**<br>公开可访问，无登录墙（`curl` 无 cookie 实测 HTTP 200，页面里搜不到任何 sign-in 字样）。<br>同一个域上还挂着扩展下载和 `/api/analyze`，评委点一个链接就能走完"看懂 → 下载 → 验证"。 |
| ④ | **封面图** | ✅ READY | `assets/cover-1920x1080.png`<br>1920×1080（16:9）· PNG · 477 KB（限制 ≤5MB） |
| ⑤ | **项目 ICON** | ✅ READY | `assets/icon-512.png`<br>512×512 正方形 · PNG · 14 KB |

## 重要评审材料

| # | 字段 | 状态 | 值 / 说明 |
|---|---|---|---|
| ⑥ | **产品说明计划书** | ✅ READY | `docs/SUBMISSION_PRODUCT_PLAN.md`（支持 Markdown，直接贴） |

## 可选字段

| # | 字段 | 状态 | 说明 |
|---|---|---|---|
| ⑦ | 知乎登录回调地址 | ⬜ 留空 | OAuth 是 P2，今天一行代码都没写。**不要为它耽误提交。** |
| ⑧ | GitHub 链接 | ✅ READY | **`https://github.com/yangmengze608-afk/zhiliu`**<br>公开仓库，153 文件 / 2.8MB，MIT。Release `v1.0.0` 附了两个 zip。<br>公开快照**不含**内部过程材料（盲测逐条记录、九轮红队报告、模型选型原始 run、协作 handoff），它们的结论都在 `docs/CLAIM_EVIDENCE.md` 里。 |
| ⑨ | 视频介绍链接 | ⬜ 待填 | 脚本见 `docs/DEMO_VIDEO_SCRIPT.md`，30–60 秒。**非必填，可以后补。** |

---

## 支撑材料（不填表单，但评委会点进去）

| 东西 | 状态 | 位置 |
|---|---|---|
| 公网分析服务 | ✅ **已上线** | `https://zhiliu-analyze.vercel.app/api/analyze`<br>`GET` 返回 `{"ok":true,"llm":{"provider":"zhida",...}}` |
| **公开下载页** | ✅ **已上线** | `https://zhiliu-analyze.vercel.app/`<br>两个 zip 直接可下载，SHA-256 与本地产物一致。<br>**这条把"评委怎么拿到扩展"从依赖 GitHub 变成了不依赖任何东西。** |
| production 扩展包 | ✅ READY · **已提交进仓库** | `release/zhiliu-production.zip`（71 KB，已烧进上面的端点）<br>刻意让它进 git —— 评委是从 GitHub 拿扩展的，ignore 掉等于他们下不到东西 |
| 演示扩展包 | ✅ READY · **已提交进仓库** | `release/zhiliu-demo.zip`（71 KB，无端点 → 面板挂「演示数据」） |
| 公网端到端实测 | ✅ 通过 | 扩展 → Vercel → 直答 → 概念，总耗时 3.1s |
| **发布包实跑验证** | ✅ 通过 | `npm run verify-release`：解开 production zip，用包里那份 `requestAnalysis` 真打公网后端 → `status:llm` / `provider:zhida` / 2673ms |

---

## 关于作品链接：为什么没用 Claude Artifact

页面最早发在 `https://claude.ai/code/artifact/6d69c629-…`，做出来之后一验就发现
**它默认是私有的** —— 未登录访问显示「Sign in to view this page」。
要公开得由你手动去分享菜单改可见性，而且改完还得用无痕窗口复验。

那等于把"能不能交"挂在一个我替你做不了、又容易忘的手动步骤上。

所以改成把整页部署到已经在跑的那个 Vercel 服务上。
现在作品链接、扩展下载、分析 API 在**同一个域**，全部公开、全部实测过。
Artifact 那份仍然可用，但不是提交用的那个链接。

> 这条来自上一轮红队的第一条：「作品链接能否真正打开」。
> 在自己已登录的浏览器里能打开，**不等于**评委能打开 —— 所以这次是用
> `curl`（无 cookie、无会话）验的。

---

## 提交前最后一遍（逐条打勾）

- [ ] 作品链接在**无痕窗口**里能打开（已用无 cookie 的 curl 验过一次，再肉眼看一次更稳）
- [ ] 封面 16:9、≤5MB、PNG
- [ ] ICON 正方形、≤5MB、PNG
- [ ] 产品说明计划书已贴进表单（不是只给了文件路径）
- [ ] 主题只勾了「灵魂匹配局」
- [ ] `curl https://zhiliu-analyze.vercel.app/api/analyze` 返回 `provider: zhida`
- [ ] `npm run verify-release` 通过 —— 它解开 production zip，用**包里那份代码**
      真打一次公网后端，确认 `status: llm` / `provider: zhida`（消耗 1 次额度）
- [ ] `release/zhiliu-production.zip` 装进 Chrome 后，面板显示「AI 分析」而**不是**「演示数据」
      （这一条 `verify-release` 替不了 —— 它验的是网络链路，验不了 Chrome 里的渲染）
- [x] GitHub 已推送且公开：`https://github.com/yangmengze608-afk/zhiliu`
      （未登录的浏览器能打开、匿名 clone 能跑通 `npm test` 301 与 `release-check` 25）

## 明确**不**阻塞提交的

- OAuth / 知乎登录回调（表单可选，且我们没做）
- Demo 视频（表单可选，可后补）
- 本地 Ollama 14B（DEV-ONLY，评委接触不到，与提交无关）

---

## 看山 Coordinator 收官复核（2026-09-14, commit `7110ea1`）

> 由看山（Release / Integration / Submission Coordinator）在提交前做的一次独立整合复核。
> 不改核心代码，只核事实、补 handoff、对齐口径。

**实测通过：**

- ✅ 作品链接 `https://zhiliu-analyze.vercel.app/` → HTTP 200（无 cookie curl）
- ✅ `/api/analyze` → HTTP 200，返回 `{"ok":true,"llm":{"provider":"zhida","model":"zhida-fast-1p5"},"rateLimit":{"open":false...}}`（后端此刻活着，熔断未触发）
- ✅ `zhiliu-production.zip` → HTTP 200
- ✅ 封面 `assets/cover-1920x1080.png` = 1920×1080 PNG / 477 KB（16:9 · ≤5MB）
- ✅ ICON `assets/icon-512.png` = 512×512 PNG / 13.5 KB（正方形 · ≤5MB）
- ✅ `npm run release-check` → **25 通过 / 0 失败**（含无 overclaim、凭证不进扩展、OAuth 事实断言、封面/ICON 规格）
- ✅ production zip 27 文件，含端点烧录的 `shared/config.js`，无凭证文件

**已补的协调文档：**

- ✅ `docs/CLAUDE_HANDOFF.md` — 4 条工程问题（H-01..H-04）交给 Claude
- ✅ `docs/AGENT_HANDOFF.md` — 分工 / 等待用户 / Blockers / 单一事实来源
- ✅ `expert-os/CAPABILITY_MAP_R9.md` — RC 收官 Capability Map（本轮零 Expert 调用，理由已记）

**距离「点发布」最重要的一件事 — ✅ 已完成：**

### U-14 现状（2026-09-14）— ✅ CLOSED

历经两轮真人验收各暴露一问题（均已修），**第三次真人验收 PASS**：

| 轮次 | 现象 | 结论 |
|---|---|---|
| 第一次 | 地址栏是 `/question/…/answer/…`，面板判 unknown | **不是 bug** —— `location.href` 实际是纯问题页，判 unknown 是 contract。真正的问题是诊断看不到真实 href，以及文案写成了"任意知乎回答页" |
| 第二次 | `location.href` 保留了 `/answer/<aid>`，route 正确，但抽不出正文 | **是 bug** —— 归属校验把 URL 自带的问题 id 当成了"别人的 id"。已修（v1.0.2），且没有降低校验强度 |
| **第三次（终验）** | 装 v1.0.2 production 包，真实回答页读满 8s | ✅ **PASS**：`semantic/high` → 364 chars → 8s qualified → Dashboard visible → 「**AI 分析**」→ 1/10 入库 |

**落档**：已升级 `CLAIM_EVIDENCE.md` **C-16（L4）**，U-14 CLOSED；`CLAUDE_HANDOFF.md` H-01 CLOSED；`AGENT_HANDOFF.md` HO-3 / B-01 CLOSED。

- ✅ **B-01 / H-01 / U-14 已 CLOSED**，**不再列为 blocker**。评委真正会走的那条路径已由真人真机跑通。

---

## FINAL SUBMISSION AUDIT（2026-09-14 @ commit `3b923fe`）

> 看山在 Claude 最终交付后做的提交前终审。基准从 `7110ea1` 前推到 `3b923fe`。

**HEAD 与线上一致性：**
- ✅ 本地 HEAD = `3b923fe`，工作区干净
- ✅ `/api/analyze` 报出 `build.commit=3b923fe`，**与本地 HEAD 逐字一致** —— 线上跑的就是这份代码

**重跑门禁：**
- ✅ `npm run release-check` → **25 通过 / 0 失败**
- ✅ 离线测试 → **tests 301 / pass 301 / fail 0 / skipped 0**（无靠跳过伪装）

**三入口实测（无 cookie curl）：**
- ✅ landing `/` → HTTP 200
- ✅ `/zhiliu-production.zip` → HTTP 200
- ✅ `/api/analyze` → HTTP 200，`provider:zhida / zhida-fast-1p5`，熔断 `open:false`

**内容与最新 production 一致性：**
- ✅ `MIN_SAMPLES=10`（`concentration.ts:48`），面板分母改读 `needed`，5/5 bug 仅存于注释
- ✅ README 无「production=默认 mock」旧描述
- ✅ production zip 端点 = `https://zhiliu-analyze.vercel.app/api/analyze`（非空、公网）
- ✅ 封面诚实声明已补齐（`COVER_BRIEF.md`）
- ✅ 计划书 / 封面 / ICON 规格与最新状态一致

**文档冲突检查：** Claude 在 `4f50776` 将看山的 4 份协调文档以纯新增方式纳入仓库，**未改写内容，无 Claude/看山冲突**。

**Submission Readiness：核心必填项 100% READY。** 五个必填项 + 产品说明计划书全部 READY，线上闭环已核。
原剩余 3%（用户本人的真机 production-extension 验收 B-01/U-14）**已于 2026-09-14 真人复验 PASS**（升级为 C-16 / L4），**不再列为 blocker**。

> 说明：这里的「100%」指**核心必填项 + 关键真机路径**全部就绪、可以点「发布」。
> 仍保留的可选/增强项（GitHub 公开仓库、大陆生产部署、Demo 视频）不阻塞提交，见 `AGENT_HANDOFF.md` 的 HO-1 / HO-2 分派。
