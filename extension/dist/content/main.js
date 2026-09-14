/** Content script 入口：识别页面 → 计时 → 达标上报 → 渲染面板。 */
import { detectPage } from './detect-page.js';
import { extractContent, isAnalyzable } from './extract-content.js';
                                                             
import { installDiagnostics } from './diagnostics.js';
import { ReadingSession } from './reading-session.js';
import { Dashboard } from './dashboard.js';
                                                
import { CONFIG, DEFAULT_SETTINGS } from '../shared/config.js';
                                                    
import { DEMO_STEP_MS } from '../shared/demo-data.js';

                                                                                   

let dashboard                   = null;
let session                        = null;
let settings           = DEFAULT_SETTINGS;
let currentKey = '';
let demoTimer                                        = null;
/** 最近一次成功抽取的结果，仅供诊断模式显示。 */
let lastExtraction                          = null;

const send =     (msg         )             => chrome.runtime.sendMessage(msg)              ;

async function refresh()                {
  const view = await send                       ({ type: 'GET_VIEW' });
  if (view && dashboard) dashboard.render(view);
}

async function onQualified()                {
  const content = extractContent();
  // 正文抽取失败或可信度为 low 的页面不计入有效阅读，也不上报——宁可漏记，不要脏数据
  if (!isAnalyzable(content)) return;
  lastExtraction = content;
  await send({
    type: 'READING_QUALIFIED',
    content: {
      url: content.url, contentId: content.contentId, type: content.type,
      title: content.title, text: content.text,
      confidence: content.confidence,
      duration: session?.visibleMs ?? 0,
    },
  });
  // 后台立刻返回（只占位，不等模型），所以这次 refresh 拿到的是"分析中"。
  await refresh();
  followUp();
}

/**
 * 分析是异步的：占位入库时面板显示"分析中"，模型几秒后才回来。
 * 这里在之后的一小段时间里轮询几次，让结果**静默地**出现在面板上，
 * 而不是要求用户刷新页面。轮询在没有在途分析时立刻停止。
 */
let followTimer                                        = null;
function followUp()       {
  if (followTimer) return;
  let ticks = 0;
  followTimer = setInterval(async () => {
    ticks += 1;
    const view = await send                       ({ type: 'GET_VIEW' });
    if (view && dashboard) dashboard.render(view);
    if (!view || view.analyzingCount === 0 || ticks >= CONFIG.FOLLOW_UP_MAX_TICKS) {
      clearInterval(followTimer ); followTimer = null;
    }
  }, CONFIG.FOLLOW_UP_MS);
}

/**
 * 绑定当前页面。
 * key 用「归一化 URL」而不是 DOM 内容，这样 SPA 内部跳转、前进后退
 * 都能被识别成"换了一篇"，从而重置计时。
 */
function bindCurrent()       {
  const id = detectPage();
  const key = id.type === 'unknown' ? '' : id.url;
  // 换页了就把上一篇的抽取结果丢掉。
  // 不丢的话，从回答页跳到 /column-square 之后敲 __zhiliu()，
  // 显示的还是上一篇的标题和正文——一个看起来像"列表页被成功抽取了"的假象。
  if (key !== currentKey) lastExtraction = null;
  currentKey = key;
  // 换页可能换了版式（回答页 / 文章页 gutter 宽度不同），重新量一次
  dashboard?.applyLayout();
  if (!session) {
    session = new ReadingSession({
      isVisible: () => document.visibilityState === 'visible',
      now: () => Date.now(),
      onQualified: () => void onQualified(),
    });
  }
  session.bind(key);
}

function startDemo()       {
  stopDemo();
  demoTimer = setInterval(async () => {
    const r = await send                                    ({ type: 'DEMO_ADVANCE' });
    if (r?.view && dashboard) dashboard.render(r.view);
    if (r?.done) stopDemo();
  }, DEMO_STEP_MS);
}

function stopDemo()       {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
}

async function boot()                {
  settings = (await send          ({ type: 'GET_SETTINGS' })) ?? DEFAULT_SETTINGS;

  dashboard = new Dashboard(settings, {
    onToggleCollapse: (collapsed) => void send({ type: 'SET_SETTINGS', patch: { collapsed } }),
    onToggleTint: (tintByConcentration) => void send({ type: 'SET_SETTINGS', patch: { tintByConcentration } }),
    onToggleDemo: (demoMode) => {
      void (async () => {
        await send({ type: 'SET_SETTINGS', patch: { demoMode } });
        if (demoMode) startDemo(); else { stopDemo(); await refresh(); }
      })();
    },
    onDismissError: () => void send({ type: 'CLEAR_ERROR' }).then(refresh),
  });

  bindCurrent();
  // 首次量测：面板在量出来之前是 visibility:hidden 的，
  // 宁可晚一帧出现，也不要先在写死的位置闪一下——那一帧就压在正文上。
  dashboard.applyLayout();
  installDiagnostics(() => ({
    // 每次都现场重抽，不复用 lastExtraction —— 缓存会让诊断自相矛盾
    extraction: extractContent(),
    recorded: lastExtraction,
    layout: dashboard?.explain(),
    visibleMs: session?.visibleMs ?? 0,
    fired: session?.fired ?? false,
    thresholdSeconds: CONFIG.MIN_VISIBLE_SECONDS,
    view: () => send           ({ type: 'GET_VIEW' }),
  }));
  await refresh();
  if (settings.demoMode) startDemo();

  setInterval(() => session?.tick(CONFIG.TICK_MS), CONFIG.TICK_MS);

  // 知乎是 SPA：URL 变化时要按新内容重新计时，而不是继续累计上一篇的时长。
  // 同一个轮询顺便兜住版式变化——见 Dashboard.relayoutIfChanged 的注释：
  // resize 事件既漏后台标签页，也漏"右侧栏异步加载完把正文推走"这类无事件的版式变化。
  setInterval(() => {
    const id = detectPage();
    const key = id.type === 'unknown' ? '' : id.url;
    if (key !== currentKey) bindCurrent();
    else dashboard?.relayoutIfChanged();
  }, CONFIG.ROUTE_POLL_MS);

  // 视口变化就重新量 gutter。窗口拖窄、DevTools 打开、缩放，
  // 都会让正文左边界往左移；不重新量，面板就会留在原地压住正文。
  // 用 rAF 合并连续的 resize 事件，避免拖动窗口时每帧都重排。
  let resizePending = false;
  window.addEventListener('resize', () => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => { resizePending = false; dashboard?.applyLayout(); });
    // rAF 在后台标签页不执行，所以再同步兜一次：宁可多排一次，也不要停在旧位置压正文
    dashboard?.relayoutIfChanged();
  });

  // 前进 / 后退
  window.addEventListener('popstate', bindCurrent);
  // 页面隐藏或关闭：已达阈值但尚未触发的，补记一次，避免最后一篇丢失
  window.addEventListener('pagehide', () => session?.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') session?.flush();
  });
}

void boot();
