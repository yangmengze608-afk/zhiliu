/** 全部可调参数与开关集中在此，不散落在业务代码里。 */
export const CONFIG = {
  /** 有效阅读所需的可见停留秒数 */
  MIN_VISIBLE_SECONDS: 8,
  /** 同一内容的去重窗口（毫秒） */
  DEDUPE_WINDOW_MS: 30 * 60 * 1000,
  /** 本地最多保留的阅读记录条数 */
  MAX_RECORDS: 100,
  /** 统计窗口：最近 N 篇 */
  WINDOW_SIZE: 20,
  /** 正文最短字数，低于此认为抽取失败 */
  MIN_TEXT_CHARS: 120,
  /** 计时器 tick */
  TICK_MS: 1000,
  /** SPA 路由轮询间隔 */
  ROUTE_POLL_MS: 1000,
  /** 后端分析端点；为空时走本地 mock */
  ANALYZE_ENDPOINT: '',
  /**
   * 分析请求超时。fetch 本身没有超时上限，不设会让面板永远停在"分析中"。
   *
   * 60 秒。这个数字由**冷加载**决定，不是由推理决定：
   *   - 热模型推理：14B p50 9.4s / p90 10.8s / max 13.7s
   *   - 冷加载：实测 43.7s 与 48s
   * 而 Ollama 默认闲置 5 分钟就卸载模型，所以"中午读完、下午再打开知乎"
   * 必然撞上一次冷加载。20 秒会让那一篇**必然失败**——而那恰好是用户
   * 重新回来时读的第一篇。
   *
   * 两条一起用：这里放宽到 60s，`OllamaExtractor` 同时把 `keep_alive` 设成 30m
   * （实测 `ollama ps` 的 UNTIL 从 5 分钟变成 29 分钟）。
   * 放宽超时的代价只是面板多显示一会儿"分析中"——因为分析已经完全异步、
   * 不阻塞任何浏览操作。
   */
  ANALYZE_TIMEOUT_MS: 60000,
  /**
   * 分析发出后，面板轮询结果的间隔与最多轮询次数。
   *
   * **必须覆盖住 `ANALYZE_TIMEOUT_MS`。** 这里曾经是 20 次 × 1500ms = 30 秒，
   * 而注释里写着"20s 超时 → 覆盖得住"—— 超时后来改成 60 秒，注释和次数都没跟上。
   * 结果：超过 30 秒才回来的分析，结果会入库但**当次面板不再刷新**，
   * 一直挂在"正在分析"，直到 180 秒后才被 reaper 翻成 failed。
   *
   * 直答 p90 不到 3 秒，happy path 撞不上。但这恰好覆盖两个**已知会慢**的场景：
   * 公网 backend 的网络抖动，以及降级到本地 14B（冷加载实测 34–124 秒）。
   * 也就是说文档指定的降级路径下，面板刷新窗口原本是坏的。
   */
  FOLLOW_UP_MS: 1500,
  FOLLOW_UP_MAX_TICKS: 40,
} as const;

/**
 * Feature flags。
 *
 * ## 这两个 flag 在 2026-09-13 之后**仍然是 false，但理由变了**
 *
 * 以前的理由是"还没拿到权限"。权限今天拿到了，官方能力也真接上了，
 * 但这两个 flag 还是 false —— 新理由是：
 * **扩展永远不该自己调官方 API。** 调用要带 Access Secret，
 * 而扩展是分发给用户的。官方能力只在服务端用。
 *
 * 如果哪天有人因为"我们已经接入了"就把它们打开，那才是真正的泄漏路径。
 *
 * ZHIHU_SEARCH_ENABLED 另有一条独立理由：100 条盲测显示知乎 Search 证据
 * 带不来可检测的准确率增益，所以它连在服务端也没有进分析主链路。
 */
export const FLAGS = {
  ZHIHU_SEARCH_ENABLED: false,
  /**
   * 知乎官方 AI（直答）。**2026-09-13 已真实调用，并且是服务端的默认 provider。**
   * 但这个**扩展侧**的 flag 保持 false，而且应该一直是 false：
   * 打开它需要 Access Secret，而 Access Secret 只能待在服务端。
   * 权限开放后的顺序是：配 secret → 跑 `probeZhida` 看真实响应形状 → 再决定启用。
   */
  ZHIHU_AI_ENABLED: false,
  /** 演示模式：用预置样例驱动面板，必须在 UI 上显式标注 */
  DEMO_MODE: false,
} as const;

export const STORAGE_KEYS = {
  EVENTS: 'zhiliu.events.v2',
  SETTINGS: 'zhiliu.settings',
} as const;

export interface Settings {
  tintByConcentration: boolean;
  collapsed: boolean;
  demoMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  tintByConcentration: false,
  collapsed: false,
  demoMode: false,
};
