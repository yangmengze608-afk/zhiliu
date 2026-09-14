/** Service worker：接收有效阅读 → 抽取概念 → 写本地历史 → 计算聚合视图。 */
import { appendEvent, loadEvents, loadSettings, replaceEvents, saveSettings } from './storage.ts';
import { requestAnalysis } from './analysis.ts';
import { demoEvent, DEMO_TOTAL } from './demo.ts';
import { shouldRecord } from '../content/reading-session.ts';
import { CONFIG, FLAGS } from '../shared/config.ts';
import { buildAggregates, MIN_SAMPLES } from '../../../packages/core/src/aggregate.ts';
import { localId, ANALYSIS_VERSION } from '../../../packages/core/src/model.ts';
import type { ReadEvent } from '../../../packages/core/src/model.ts';
import type { PanelView } from '../content/dashboard.ts';

declare const chrome: {
  runtime: { onMessage: { addListener(cb: (msg: any, sender: unknown, send: (r: unknown) => void) => boolean | void): void } };
};

/**
 * 正在后台分析中的内容 id。用 Set 而不是计数器：乱序完成时计数器会算错，
 * 而且面板需要知道"是不是这一篇还在分析"，不只是"有几篇在分析"。
 */
const inFlight = new Set<string>();

/**
 * 在途分析的 Promise。只用于 `AWAIT_IDLE`：
 * 让测试和演示脚本能确定性地等到"所有分析都落盘了"，
 * 而不是靠 sleep 一个猜出来的毫秒数。产品代码从不 await 它。
 */
const inFlightPromises = new Map<string, Promise<void>>();

/** 占位记录的 analysisVersion 哨兵值。 */
const PENDING = 'pending';
/** 最近一次失败，用于面板错误态。 */
let lastError: string | null = null;

/**
 * 写操作串行队列。
 *
 * `appendEvent` 是"读全量 → 本地改 → 整体写回"，跨了 await。
 * 两个知乎标签页同时推进演示时，两条 DEMO_ADVANCE 几乎同时到达，
 * 后到的那次读到的是旧数组，写回时把前一次的结果覆盖掉——经典 lost update。
 * 实测现象：计数器认为推进了 2 条，storage 里只有 1 条，而且丢掉的那条
 * 永远不会补上，面板的分布和进度从此对不上，且没有任何报错。
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // 用 catch 断开链，避免一次失败让后续所有写操作都被 reject
  writeChain = next.catch(() => undefined);
  return next;
}

async function buildView(): Promise<PanelView> {
  await reapStalePlaceholders();
  const events = await loadEvents();
  const settings = await loadSettings();
  const agg = buildAggregates(events, CONFIG.WINDOW_SIZE);

  return {
    state: pickState(events.length, agg.sampleCount),
    concepts: agg.concepts.slice(0, 4).map((c) => ({
      label: c.canonical, share: c.share, direction: c.recentTrend,
    })),
    concentration: agg.concentration,
    sampleCount: agg.sampleCount,
    syntheticCount: agg.syntheticCount,
    sourceBreakdown: agg.sourceBreakdown,
    pendingCount: agg.pendingCount,
    analyzingCount: inFlight.size,
    analysisMix: agg.analysisMix,
    demoMode: settings.demoMode,
    error: lastError,
    zhihuSearchEnabled: FLAGS.ZHIHU_SEARCH_ENABLED,
    analyzeEndpointConfigured: Boolean(CONFIG.ANALYZE_ENDPOINT),
  };

  function pickState(total: number, stat: number): PanelView['state'] {
    // 注意：lastError 不再决定整体状态。
    // 早先一次网络抖动就会让 state 变成 'error'，柱状图和集中度全部不渲染，
    // 而同屏文案写着「已记录的阅读不受影响」——自相矛盾，且录 Demo 时会白屏。
    // 现在错误作为一条横幅叠加显示，已有数据照常渲染。
    if (inFlight.size > 0 && stat === 0) return 'analyzing';
    if (total === 0) return 'empty';
    // 必须用核心库的门槛。早先这里硬编码 5，而 MIN_SAMPLES 已经是 10，
    // 于是 5–9 篇时 state 被判成 ready，面板直接渲染出「信息集中度 null」。
    if (stat < MIN_SAMPLES) return 'collecting';
    return 'ready';
  }
}

/**
 * 有效阅读到达。
 *
 * **这个函数必须立刻返回。** 它只做一件事：原子地占位入库。
 * 真正的模型调用交给 `analyzeAndBackfill` 在后台跑。
 *
 * 为什么：7B 的 p90 是 6 秒，14B 是 11 秒。旧实现在这里 `await` 分析，
 * content script 那边的 `await send(...)` 就挂 6–11 秒，面板在这期间不更新。
 * 知流不是聊天机器人——用户读完一篇继续往下刷是常态，
 * 让他等模型返回才看到"已记录"是把产品做成了它最不该是的样子。
 *
 * 现在的顺序是：占位 → 立刻回视图（面板显示"分析中"）→ 后台分析 → 回填 → 面板自己刷新。
 */
async function handleQualified(content: {
  url: string; contentId?: string; type?: 'answer' | 'article' | 'unknown';
  title: string; text: string; duration: number; confidence?: string;
}): Promise<void> {
  const id = localId(content.contentId, content.url);
  const contentType = content.type === 'unknown' ? 'unknown' : (content.type ?? 'answer');

  // 抽取可信度低的页面绝不入库。宁可漏记一篇，也不要往长期历史里写
  // 一条"从评论区总结出来的"概念——那种脏数据事后无法分辨，也无法撤销。
  if (content.confidence === 'low') return;
  // **页面类型白名单也要在这一层再查一遍。**
  // 早先这里唯一的闸门是 confidence，于是一条 `type:'unknown'` + `confidence:'high'`
  // 的消息可以直接进 `/analyze` 并入库。content script 那边确实已经拦了，
  // 但 fail closed 不该只有一道门 —— /column-square 那次事故正是因为
  // 全部希望都押在下游一个布尔判断上。
  if (contentType !== 'answer' && contentType !== 'article') return;

  // 去重检查必须和"占位入库"在**同一个**串行事务里。
  // 只把 appendEvent 包进队列而 loadEvents/shouldRecord 在队列外，
  // 会让两个标签页同时读同一篇时都通过去重检查，最后入库两条。
  const reserved = await serialize(async () => {
    const events = await loadEvents();
    if (!shouldRecord(id, events, Date.now())) return false;
    await appendEvent({
      id, contentId: content.contentId, contentType,
      title: content.title, timestamp: Date.now(), duration: content.duration,
      concepts: [], analysisStatus: 'ungrounded', analysisVersion: PENDING,
    });
    return true;
  });
  if (!reserved) return;

  inFlight.add(id);
  lastError = null;
  // 刻意不 await：把分析踢到后台，本函数立刻返回。
  const p = analyzeAndBackfill(id, contentType, content);
  inFlightPromises.set(id, p);
  void p;
}

/**
 * 后台分析 + 回填。
 *
 * ## 乱序返回
 *
 * 用户连读 A / B / C，三次分析可能以任意顺序完成。这里靠两点保证不串：
 * 1. 回填**按 id 定位占位记录**，不靠数组下标、不靠"最后一条"；
 * 2. 找不到占位记录就**丢弃结果**（见下），而不是 push 一条新的。
 *
 * ## 迟到的结果
 *
 * 第 2 点是这一轮修的真 bug。旧实现在 `idx < 0` 时 `events.push(event)`。
 * 于是：用户关掉演示模式 → demoReset 清掉记录 → 一条在途的分析回来了 →
 * 被 push 回历史，变成一条**没有对应占位、永远解释不了**的残留。
 * 记录被 MAX_RECORDS 淘汰之后迟到的结果同理，会把已经滚出窗口的文章又塞回来。
 * 现在一律丢弃：占位不在了，说明这条阅读已经不该存在。
 */
async function analyzeAndBackfill(
  id: string,
  contentType: 'answer' | 'article' | 'unknown',
  content: { contentId?: string; type?: string; title: string; text: string; duration: number },
): Promise<void> {
  try {
    const result = await requestAnalysis({
      contentId: content.contentId,
      contentType: content.type === 'article' ? 'article' : 'answer',
      title: content.title,
      text: content.text,
    });

    const event: ReadEvent = {
      id, contentId: content.contentId, contentType,
      title: content.title,
      timestamp: Date.now(),
      duration: content.duration,
      concepts: result.concepts,
      analysisStatus: result.status,
      analysisVersion: result.analysisVersion,
      analysis: result.analysis,
      ambiguous: result.ambiguous,
    };
    if (result.status === 'failed') lastError = result.dropped[0] ?? '分析失败';

    await serialize(async () => {
      const events = await loadEvents();
      const idx = events.findIndex((e) => e.id === id && e.analysisVersion === PENDING);
      if (idx < 0) return; // 占位已消失 —— 丢弃迟到结果，绝不复活
      // 保留占位时的 timestamp：那才是"用户读它的时刻"。
      // 用回填时刻会让一次慢分析把文章推到窗口最前面，顺序整个错乱。
      events[idx] = { ...event, timestamp: events[idx].timestamp };
      await replaceEvents(events);
    });
  } finally {
    inFlight.delete(id);
    inFlightPromises.delete(id);
  }
}

/** 等到所有在途分析都完成并落盘。 */
async function awaitIdle(): Promise<void> {
  // 循环：一次分析落盘的过程中可能又有新的进来
  for (let i = 0; i < 50 && inFlightPromises.size > 0; i++) {
    await Promise.allSettled([...inFlightPromises.values()]);
  }
  await serialize(async () => undefined); // 排空写队列
}

/**
 * 回收超时的占位记录。
 *
 * MV3 的 service worker 会被回收：一次分析跑到一半 worker 没了，
 * `inFlight` 清零，但 storage 里的占位记录还在，`analysisVersion` 永远停在 pending。
 * 面板会一直显示"1 篇待分析"，而那次分析再也不会发生。
 * 每次构建视图时把明显超时的占位改判为 failed，让它变成一个**可解释**的状态。
 */
async function reapStalePlaceholders(): Promise<void> {
  const cutoff = Date.now() - CONFIG.ANALYZE_TIMEOUT_MS * 3;
  await serialize(async () => {
    const events = await loadEvents();
    let changed = false;
    for (const e of events) {
      if (e.analysisVersion === PENDING && !inFlight.has(e.id) && e.timestamp < cutoff) {
        e.analysisVersion = ANALYSIS_VERSION;
        e.analysisStatus = 'failed';
        changed = true;
      }
    }
    if (changed) await replaceEvents(events);
  });
}

/**
 * 演示模式：推进一步。
 *
 * 进度**从存储推导**（数一下已有多少条 demo 记录），而不是放在模块级变量里。
 * MV3 的 service worker 大约 30 秒无事件就会被回收，下次消息到达时以干净作用域重启；
 * 如果进度存在内存里，路演中途停顿超过半分钟再继续点，计数器会归零，
 * 于是 demo-01 被重复写入一次，柱状图权重加倍，而进度显示和实际数据对不上。
 * 用存储推导天然对回收免疫。
 */
async function demoAdvance(): Promise<{ step: number; total: number; done: boolean }> {
  return serialize(async () => {
    // 关闭演示模式的瞬间，content script 的定时器可能还有一条在途的 DEMO_ADVANCE。
    // 不挡住它会在真实历史里留下一条永久残留的 demo-01。
    const settings = await loadSettings();
    if (!settings.demoMode) return { step: 0, total: DEMO_TOTAL, done: true };
    const events = await loadEvents();
    const step = events.filter((e) => e.analysisStatus === 'demo').length;
    if (step >= DEMO_TOTAL) return { step, total: DEMO_TOTAL, done: true };
    await appendEvent(demoEvent(step));
    return { step: step + 1, total: DEMO_TOTAL, done: step + 1 >= DEMO_TOTAL };
  });
}

async function demoReset(): Promise<void> {
  return serialize(async () => {
    lastError = null;
    const events = await loadEvents();
    // 只清演示数据，保留用户真实历史
    await replaceEvents(events.filter((e) => e.analysisStatus !== 'demo'));
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  (async () => {
    // 兜底：任何未预料的异常都必须 send() 回去。
    // 否则 content script 里的 await 会永久挂起，面板从此不再更新，
    // 而且只要坏数据还在 storage 里，每次 GET_VIEW 都会同样崩——是持续性的砖头。
    try {
    switch (msg?.type) {
      case 'GET_VIEW': send(await buildView()); break;
      case 'GET_SETTINGS': send(await loadSettings()); break;
      case 'SET_SETTINGS': {
        const next = { ...(await loadSettings()), ...msg.patch };
        // 先落盘：demoAdvance 会读这个值来挡住在途请求
        await saveSettings(next);
        if (msg.patch?.demoMode === false) await demoReset();
        send(next);
        break;
      }
      case 'READING_QUALIFIED':
        // handleQualified 只占位，不等模型；这里的 buildView 立刻就能回。
        await handleQualified(msg.content);
        send(await buildView());
        break;
      case 'DEMO_ADVANCE': send({ ...(await demoAdvance()), view: await buildView() }); break;
      case 'DEMO_RESET': await demoReset(); send(await buildView()); break;
      case 'CLEAR_ERROR': lastError = null; send(await buildView()); break;
      // 测试 / 演示脚本用：等到所有后台分析落盘。产品路径不使用。
      case 'AWAIT_IDLE': await awaitIdle(); send(await buildView()); break;
      default: send(null);
    }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'internal_error';
      console.warn('[知流] 消息处理失败', err);
      try {
        send(await buildView());
      } catch {
        send(null);
      }
    }
  })();
  return true; // 保持消息通道开启以便异步回复
});
