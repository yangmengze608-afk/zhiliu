/**
 * 真实知乎 API 契约验证探针。
 *
 *   ZHIHU_ACCESS_SECRET=xxx node server/api-probe.ts [查询词...]
 *
 * 它做的事：发起真实调用，把**实际返回的字段**原样记录下来，
 * 并与官方文档 `zhihu/references/http-api.md`（核验 2026-07-16）声明的字段对账。
 *
 * 为什么需要它：文档声明的字段和线上实际返回的字段可能不一致。
 * 在没有跑过一次真实调用之前，任何"我们使用了 X 字段"的说法都只是转述文档。
 * 本脚本的输出是唯一能支撑"真实调用过"的证据。
 *
 * 不打印 Access Secret，不把返回内容写进仓库（只写字段结构与统计）。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENDPOINT = 'https://developer.zhihu.com/api/v1/content/zhihu_search';

/** 官方文档声明 Item 必返的字段。 */
const DOCUMENTED_ITEM_FIELDS = [
  'Title', 'ContentType', 'ContentID', 'ContentText', 'Url',
  'CommentCount', 'VoteUpCount', 'AuthorName', 'AuthorAvatar',
  'AuthorBadge', 'AuthorBadgeText', 'EditTime', 'AuthorityLevel', 'RankingScore',
];
/** 文档标注为可选的字段。 */
const OPTIONAL_ITEM_FIELDS = ['CommentInfoList'];

const secret = process.env.ZHIHU_ACCESS_SECRET;
if (!secret) {
  console.error(`
缺少 ZHIHU_ACCESS_SECRET，无法进行真实调用。

需要你提供的是【知乎数据开放平台 Access Secret】，不是 OAuth App Key，也不是 App ID。

获取方式（官方 skill 文档 zhihu/references/open-platform.md）：
  1. 打开 https://developer.zhihu.com/profile
  2. 用知乎账号登录
  3. 点击「申请新 Access Secret」
  4. 复制得到的字符串

拿到后这样运行（不要把它写进任何文件或提交到 git）：
  ZHIHU_ACCESS_SECRET='<你的 secret>' node server/api-probe.ts
`);
  process.exit(2);
}

const queries = process.argv.slice(2).length ? process.argv.slice(2) : ['社交焦虑', '性别议题', '考公考编'];

interface Probe {
  query: string;
  httpStatus: number;
  bizCode: number | null;
  message: string | null;
  latencyMs: number;
  itemCount: number;
  /** 实际出现过的字段（并集） */
  observedFields: string[];
  /** 文档声明但实际缺失的字段 */
  missingDocumented: string[];
  /** 实际返回但文档未声明的字段 */
  undocumentedExtra: string[];
  /** 每个字段的实际类型 */
  fieldTypes: Record<string, string>;
  rateLimitHeaders: Record<string, string>;
  error?: string;
}

const results: Probe[] = [];

for (const query of queries) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('Query', query);
  url.searchParams.set('Count', '5');

  const t0 = performance.now();
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
    });
    const latencyMs = Math.round(performance.now() - t0);

    // 任何形似限流/配额的响应头都记下来——官方文档没写，只能实测
    const rateLimitHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      if (/rate|limit|quota|remain|retry/i.test(k)) rateLimitHeaders[k] = v;
    });

    const body = (await resp.json()) as {
      Code?: number; Message?: string;
      Data?: { Items?: Array<Record<string, unknown>> };
    };
    const items = body.Data?.Items ?? [];

    const observed = new Set<string>();
    const fieldTypes: Record<string, string> = {};
    for (const it of items) {
      for (const [k, v] of Object.entries(it)) {
        observed.add(k);
        fieldTypes[k] = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
      }
    }

    results.push({
      query,
      httpStatus: resp.status,
      bizCode: body.Code ?? null,
      message: body.Message ?? null,
      latencyMs,
      itemCount: items.length,
      observedFields: [...observed].sort(),
      missingDocumented: DOCUMENTED_ITEM_FIELDS.filter((f) => !observed.has(f)),
      undocumentedExtra: [...observed].filter(
        (f) => !DOCUMENTED_ITEM_FIELDS.includes(f) && !OPTIONAL_ITEM_FIELDS.includes(f),
      ),
      fieldTypes,
      rateLimitHeaders,
    });
  } catch (err) {
    results.push({
      query, httpStatus: 0, bizCode: null, message: null,
      latencyMs: Math.round(performance.now() - t0),
      itemCount: 0, observedFields: [], missingDocumented: [], undocumentedExtra: [],
      fieldTypes: {}, rateLimitHeaders: {},
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const report = {
  probedAt: new Date().toISOString(),
  endpoint: ENDPOINT,
  requestFields: { Query: 'string(必填)', Count: 'int(默认10，最大10)' },
  requestHeaders: ['Authorization: Bearer <access_secret>', 'X-Request-Timestamp: <unix秒>', 'Content-Type: application/json'],
  documentedItemFields: DOCUMENTED_ITEM_FIELDS,
  optionalItemFields: OPTIONAL_ITEM_FIELDS,
  latencyMs: {
    samples: results.map((r) => r.latencyMs),
    median: median(results.map((r) => r.latencyMs)),
  },
  results,
};

const out = join(import.meta.dirname, '..', 'bench', 'api-probe-report.json');
writeFileSync(out, JSON.stringify(report, null, 2));

console.log(`\n真实 API 探针结果  →  ${out}\n`);
for (const r of results) {
  console.log(`  ${r.query.padEnd(10)} HTTP ${r.httpStatus} Code=${r.bizCode} items=${r.itemCount} ${r.latencyMs}ms`);
  if (r.error) console.log(`     错误：${r.error}`);
  if (r.missingDocumented.length) console.log(`     ⚠ 文档声明但未返回：${r.missingDocumented.join(', ')}`);
  if (r.undocumentedExtra.length) console.log(`     ℹ 返回了文档未声明的字段：${r.undocumentedExtra.join(', ')}`);
  if (Object.keys(r.rateLimitHeaders).length) console.log(`     限流响应头：${JSON.stringify(r.rateLimitHeaders)}`);
}
console.log(`\n中位延迟 ${report.latencyMs.median}ms`);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
