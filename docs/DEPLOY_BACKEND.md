# 公网分析服务

> **已上线**：`https://zhiliu-analyze.vercel.app/api/analyze`
>
> 这是评委唯一需要能访问到的服务端。它存在的唯一理由和本地 dev-server 一样：
> **Access Secret 不能进浏览器扩展。**

## 现状

```bash
curl https://zhiliu-analyze.vercel.app/api/analyze
# {"ok":true,"llm":{"provider":"zhida","model":"zhida-fast-1p5"},
#  "rateLimit":{"open":false,"consecutive429":0,"retryAfterMs":0}}
```

实测（2026-09-14，公网）：

| | |
|---|---|
| 真实分析 POST | `status:"llm"`，`provenance.provider:"zhida"` |
| 模型延迟 | 2605 ms |
| 端到端总耗时 | 3.1 s |
| 夹带 `userId` | **400 拒绝** |
| 非知乎来源的 CORS | **不返回 `Access-Control-Allow-Origin`** |

## 为什么选 Vercel

不是因为它最好，是因为它**当时已经登录好了**。

在"赶提交"这件事上，部署方案的正确选法是"哪条路最短且不引入新东西"，
不是"哪个云最漂亮"。没有 Redis、没有数据库、没有队列，
整个服务是一个无状态函数 —— 换成任何支持 Node 的 HTTPS 托管都能跑。

## 它还兼了下载页

`https://zhiliu-analyze.vercel.app/` 是扩展的公开下载页，
两个 zip 直接挂在 `deploy/public/` 下由 Vercel 当静态文件发。

这一条是为了解掉一个依赖：作品链接页（Claude Artifact）的沙箱**不允许页面
自己发起下载**，所以扩展必须有一个真实的 HTTP 地址。原本那个地址只能是
GitHub —— 而 GitHub 在表单里是**可选**字段。也就是说，
"评委能不能拿到扩展"本来挂在一个可选项上。

把 zip 挂到已经部署好的这个服务上，这个依赖就没了。

```bash
curl -sI https://zhiliu-analyze.vercel.app/zhiliu-production.zip
# HTTP 200 · application/zip · 73213 bytes
# SHA-256 与 release/zhiliu-production.zip 一致
```

## 结构

```
deploy/
  api/analyze.js   Serverless Function（唯一入口）
  public/          扩展下载页 + 两个 zip（静态）
  _lib/            由 scripts/build-backend.mjs 生成，不手写
  vercel.json      只设了 maxDuration: 30
  package.json     type: module，无依赖
```

`_lib/` 是把 `server/analyze.ts` + `packages/core/src/` 用 Node 内置类型擦除
编译出来的纯 JS。**不让 Vercel 直接跑 .ts**，因为类型擦除要 Node 22.18+，
而运行时版本不由我们控制——部署环节最不该引入的就是"在我机器上能跑"。

复用的是同一个 `createAnalyzeHandler` 和同一个 `ZhidaExtractor`，
不是给线上另写一份。线上线下行为不一致是这类项目最常见的翻车方式。

## 凭证

Access Secret 只存在于 **Vercel 的 Production 环境变量**（Encrypted），
不在仓库、不在 `deploy/` 目录、不在扩展包里。

```bash
vercel env ls production     # 应看到 ZHIHU_ACCESS_SECRET / Encrypted
```

没有它时函数**返回 503**，不会悄悄降级成别的 provider 或 mock。

## 重新部署

```bash
node scripts/build-backend.mjs          # 先把 TS 擦成 JS
cd deploy && vercel deploy --prod --yes
```

改了 `server/analyze.ts` 或 `packages/core/src/` 之后**必须先跑第一条**，
否则部署的还是上一次的 `_lib/`。

## 已知的风险

| 风险 | 状态 |
|---|---|
| 冷启动 | Serverless 首次请求会慢一些。分析是完全异步的，不阻塞浏览，所以只影响第一篇的出数时间。 |
| 直答限速 | 日额度 5000 很宽，但瞬时限速会撞（实测背靠背 12 次后连续 429）。已加「连续 3 次 429 → 熔断 60 秒」。**真实用户一篇一篇读撞不上；不要对这个端点做批量压测。** |
| 额度耗尽的返回值 | **未测**。官方文档没写直答耗尽返回什么，也不打算为了测它烧掉 5000 次额度。熔断对 429 和耗尽都成立。 |
| 单点 | 换成云端 provider 之后，网络与官方服务可用性成了新的单点。降级预案是本地 14B，但那是 **DEV-ONLY**——评委接触不到作者本机。 |
