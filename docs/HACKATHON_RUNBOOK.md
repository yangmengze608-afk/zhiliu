# Hackathon Runbook · 提交 / 录 Demo 前 10 分钟

> ## 前提：这是一个**线上提交、远程评审**的项目
>
> 评委**不会接触作者本机**。他们能拿到的只有：
> 公开作品链接、GitHub、可下载的 Extension、Demo 视频。
>
> 因此本文档里没有任何"到场后""现场配置""会场网络"这类步骤 ——
> 那些前提不成立。下面每一步都是**在提交前、在作者自己的机器上**完成的准备工作，
> 目的是让上面那四样东西是真的能用的。
>
> 直接后果：**本地 Ollama 14B 只能是 DEV-ONLY / FALLBACK**，
> 它跑在作者的 Mac 上，评委够不到，所以它不可能是线上提交的主体验。

> 一页。照着做，不要临场发挥。

## 提交 / 录制前（按顺序，别跳）

> **2026-09-13 起主路径换了。** 以前第 0 步是「关掉别的应用给 14B 腾 9.5 GB」，
> 现在默认跑的是知乎官方直答 —— 云端，本机 0 内存，p50 2.2 秒。
> 那条内存风险**没有消失，只是挪到了降级预案里**（见最后一节）。
> 换来的新风险是：**公网 backend 的可达性**和**限速**。

### 0. 凭证 preflight —— 现在这一步排第一

```bash
export ZHIHU_ACCESS_SECRET=...      # 从 ~/.zhiliu/zhihu.env 读，别写进仓库
"$HOME/Library/Application Support/zhihu-cli/current/zhihu-cli" auth status --verify
# 期望：{"ok":true,..."verification":"valid"}
```

没有这一步，服务会**拒绝启动**（不是静默降级成本地模型）。那是故意的。

### 1. 查额度

```bash
"$HOME/Library/Application Support/zhihu-cli/current/zhihu-cli" quota --api-id zhida_openai
# 期望：RemainingQuota 还有几千
```

> **别被 5000 这个数骗了。** 日额度和瞬时限速是两回事：实测背靠背打 12 次
> 就开始连续 429。录 Demo 是一篇一篇读，撞不上；**但不要在录制前做批量回填。**

### 2. 直答 live probe

```bash
node -e "import('./packages/core/src/providers.ts').then(async m=>{
  const r = await m.probeZhida(process.env.ZHIHU_ACCESS_SECRET);
  console.log('HTTP', r.httpStatus, '| OpenAI 形状', r.shapeMatchesOpenAI);
})"
# 期望：HTTP 200 | OpenAI 形状 true
```

### 3. 起分析服务

```bash
node server/dev-server.ts
# 期望日志：模式：PROFILE A · 知乎官方直答（provider=zhida model=zhida-fast-1p5）
```

### 4. 健康检查 —— **必须看到 provider 是 zhida**

```bash
curl -s http://127.0.0.1:8732/health
# 期望：{"ok":true,"llm":{"provider":"zhida","model":"zhida-fast-1p5"}}
```

> 如果这里显示的是 `ollama`，说明你跑的是降级路径。**不要在没察觉的情况下录进 Demo。**

### 5. 打一篇真实分析，确认 provenance

```bash
curl -s -X POST http://127.0.0.1:8732/analyze -H 'Content-Type: application/json' \
  -d '{"contentId":"pre","contentType":"answer","title":"预演","text":"我最近总在深夜刷手机，第二天整个人是散的。试过把手机放客厅，坚持了四天又回去了。"}' \
  | python3 -m json.tool
# 期望：status "llm"，provenance.provider 是 "zhida"，latencyMs 两三千
```

**不需要预热。** 直答是云端的，没有冷加载；给它发预热请求只是白烧额度。

```bash
# 6. 构建扩展
node extension/build.mjs
```

7. `chrome://extensions` → 找到「知流 · 信息面板」→ 点**重新加载**
   （改了 `dist` 不重载 = 演示的是旧代码）

8. 打开一个**已验证过的回答页**：`/question/<qid>/answer/<aid>`
   —— 不要临时找新页面，不要用列表页

9. F12 → Console → **上下文下拉框切到「知流 · 信息面板」** → 敲 `__zhiliu()`

10. 确认这五行：

| 看什么 | 必须是 |
|---|---|
| `抽取策略` | `semantic → 可信度 high` |
| `正文` | 几百字，preview 是目标正文 |
| `面板布局` → `overlaps` | **`false`** |
| 面板徽标 | **「AI 分析」**，不是「演示数据」 |
| `/health` 的 provider | **`zhida`**，不是 `ollama` |

11. 徽标是「演示数据」= **没接上**。回到第 3 步，别开始录。

12. 开始录 Demo / 截图。

## 真实分析挂了怎么办

**允许切演示模式。绝不允许假装。**

- 勾上面板右下角「演示模式」；
- 面板会自己显示 **「演示数据」** 徽标——**不要遮住它，不要解释掉它**；
- 如果评委问，直接说：这是预置样例，实时分析服务现在没跑起来。

代码层面已经堵死了静默 fallback：`sourceBadge()` 只要窗口里有**一条** mock/demo
就显示「演示数据」（不按多数决）；服务端没模型时返回 503 而不是空结果；
客户端拿不到 provenance 一律降级成 `ungrounded`。
**这些不是可以关掉的开关。**

## 演示中不要说的话

见 [`CLAIM_EVIDENCE.md`](CLAIM_EVIDENCE.md) 第三节。最容易脱口而出的三条：

- ✅「我们真的在用知乎官方直答」→ **这句现在可以说了**（C-09，L5）
- ❌「官方模型让我们更准了」→ 盲评分差 +0.103，冻结口径 <0.25 算打平。
  选它的理由是**延迟过 Gate、本机 0 内存**，不是准确率
- ❌「我们接了知乎登录」→ OAuth 今天一行代码都没写
- ❌「准确率 88.9%」→ 那是 Claude 实验分类器，不是这个产品
- ❌「支持知乎所有页面」→ 只有回答页和专栏文章页
- ❌「搜索让分类更准」→ 搜索没进主链路，也测不出增益

---

## 降级预案 · PROFILE B（本地 14B）—— **DEV-ONLY**

**什么时候切**：直答连续失败（`/health` 正常但 `/analyze` 一直 `provider_http_5xx`）、
额度耗尽、或者 backend 连不上 developer.zhihu.com。
**注意：切到 B 之后这条链路只在作者本机成立，评委够不到** —— 所以它只能用于
本地排查和录制备份，不能当成线上提交的主体验。

```bash
# 先关掉浏览器以外的大应用 —— 14B 常驻 9.5 GB，这台机器 16 GB
ZHILIU_PROVIDER=ollama node server/dev-server.ts
curl -s http://127.0.0.1:8732/health   # 必须看到 provider":"ollama"
ollama ps                              # 必须看到 14B 真的常驻，空的就是被驱逐了
```

> 2026-09-10 实测：开着几个 Electron 应用时 swap 用到 10.7 GB，
> ollama 每次请求后立刻驱逐模型，预热从 34 秒涨到 124 秒，
> 一个 5 token 的请求要 280 秒。**切到 B 之前一定要先腾内存。**

## 最后的降级 · PROFILE C（演示数据）

> ### ⚠️ **不会自动降级。这一步必须手动。**
>
> 这一段原本写的是「扩展在拿不到 `/analyze` 时会走本地确定性数据，面板上会有「演」标记」。
> **代码不是这样。** `analysis.ts` 只在 `ANALYZE_ENDPOINT` **为空**时走 mock；
> 演示配置下端点是填好的，于是超时 / 网络失败走的是
> `failed('analyze_timeout')` / `failed('network_error')`，
> `analysisStatus` 变成 `'failed'` —— **不是 mock、不是 demo、没有「演」标记**，
> 面板会显示一片"分析失败"。
>
> 这是「绝不静默降级」的**反面风险**：台上以为会自动兜住，结果没有，
> 而你按 runbook 没准备手动那一步。

两条路都断了就不要硬撑，**手动勾选**面板右下角的「演示模式」：

1. 勾上之后面板会出现 **「演示数据」** 徽标；
2. **不要遮住它，不要解释掉它**；
3. 评委问就直接说：这是预置样例，实时分析服务现在没跑起来。

这条语义已经用门禁钉住（"配了端点 + 请求失败 ⇒ status 是 failed 而不是 mock"），
所以它不会哪天悄悄变成自动降级而没人发现。
