/**
 * 知乎开放平台 zhihu_search 客户端。
 *
 * 协议依据：官方 Skill 包 `zhihu/references/http-api.md`。
 * **2026-09-13 真实调用核验**：4 次查询全部 `Code:0`，返回字段与
 * `types.ts` 的 `ZhihuSearchItem` 逐字段对得上（`AuthorSignature` 除外，真实响应有、类型里没声明）。
 *   GET https://developer.zhihu.com/api/v1/content/zhihu_search
 *   Header: Authorization: Bearer <access_secret> / X-Request-Timestamp: <unix秒>
 *   Query:  Query(必填) / Count(默认10，最大10)
 *   错误码: 0成功 10001参数错误 20001鉴权失败 30001频率限制 90001内部错误
 *
 * Access Secret 只允许存在于服务端环境变量，绝不进入扩展包。
 */
                                                                       

export const ZHIHU_SEARCH_URL = 'https://developer.zhihu.com/api/v1/content/zhihu_search';

/** 官方文档明确：Count 上限 10，超过会被服务端截断。 */
export const MAX_COUNT = 10;

/**
 * 每日限额。**2026-09-13 `zhihu-cli quota` 实测值，不是文档推测值。**
 * 旧值 1000 是按"保守取值"猜的，实际是 5000。
 *
 * 但真正会咬人的不是这个数：实测背靠背连打十几次就会 `429 rate_limit_exceeded`，
 * 而 429 **不扣**日额度。也就是说 5000 不代表你能连着打 5000 次。
 * 限速的处理在 `providers.ts` 的退避里，不在这个常量里。
 */
export const DAILY_SEARCH_QUOTA = 5000;

                                  
                                                                     
                             
                                    
 

export class ZhihuApiError extends Error {
  code        ;
  retryable         ;
  constructor(message        , code        , retryable         ) {
    super(message);
    this.name = 'ZhihuApiError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 真实 HTTP 传输层。需要 ZHIHU_ACCESS_SECRET。 */
export class LiveSearchTransport                            {
  kind         = 'live';
  #secret        ;
  #fetch              ;
  #calls = 0;

  constructor(accessSecret        , fetchImpl               = fetch) {
    if (!accessSecret) throw new Error('缺少 ZHIHU_ACCESS_SECRET，拒绝以空凭证发起请求');
    this.#secret = accessSecret;
    this.#fetch = fetchImpl;
  }

  get callCount()         {
    return this.#calls;
  }

  async search(query        , count        )                               {
    if (!query.trim()) throw new Error('Query 不能为空');
    const url = new URL(ZHIHU_SEARCH_URL);
    url.searchParams.set('Query', query);
    url.searchParams.set('Count', String(Math.min(Math.max(1, count), MAX_COUNT)));

    this.#calls += 1;
    const resp = await this.#fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.#secret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      throw new ZhihuApiError(`HTTP ${resp.status}`, resp.status, resp.status >= 500 || resp.status === 429);
    }
    const body = (await resp.json())                       ;
    if (body.Code !== 0) {
      // 30001 频率限制是唯一值得退避的业务错误；其余 fail loud。
      throw new ZhihuApiError(`知乎 API Code=${body.Code} ${body.Message}`, body.Code, body.Code === 30001);
    }
    return body;
  }
}

/** 离线 fixture 传输层：无 Access Secret 时让链路可确定性运行与测试。 */
export class FixtureSearchTransport                            {
  kind            = 'fixture';
  #fixtures                                     ;
  #calls = 0;

  constructor(fixtures                                     ) {
    this.#fixtures = fixtures;
  }

  get callCount()         {
    return this.#calls;
  }

  async search(query        , count        )                               {
    this.#calls += 1;
    const hit = this.#fixtures[query];
    if (!hit) {
      return { Code: 0, Message: 'success', Data: { HasMore: false, EmptyReason: 'fixture miss', Items: [] } };
    }
    return {
      ...hit,
      Data: { ...hit.Data, Items: hit.Data.Items.slice(0, Math.min(count, MAX_COUNT)) },
    };
  }
}

/**
 * 带 24h 缓存的搜索客户端。
 *
 * 实测限额：知乎搜索 5000 次/天（2026-09-13 `quota`）。日额度其实很宽，
 * 缓存真正要挡的是**瞬时限速**——实测背靠背十几次就开始 429。
 * 每篇文章要为 3–5 个候选各搜一次，没有缓存时批量操作必然撞限速。
 */
export class ZhihuSearchClient {
  #transport                 ;
  #ttlMs        ;
  #now              ;
  #cache = new Map                                                  ();

  constructor(transport                 , ttlMs = 24 * 60 * 60 * 1000, now               = Date.now) {
    this.#transport = transport;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get transportKind()                     {
    return this.#transport.kind;
  }

  /** 实际打到上游的次数（缓存命中不计）。 */
  get upstreamCalls()         {
    return this.#transport.callCount;
  }

  async neighborhoodItems(query        , count = 8)                             {
    const key = `${query}::${count}`;
    const cached = this.#cache.get(key);
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.value;

    const resp = await this.#transport.search(query, count);
    const items = resp.Data?.Items ?? [];
    this.#cache.set(key, { at: this.#now(), value: items });
    return items;
  }
}
