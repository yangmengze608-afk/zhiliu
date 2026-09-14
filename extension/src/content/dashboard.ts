/**
 * 左侧 gutter 里的 Mini Dashboard。
 *
 * 设计约束（来自 PRD，不可破坏）：
 * - 待在正文主列**左侧的空白 gutter** 里，深色、克制，像常驻仪表盘而不是比赛海报；
 * - **不遮挡知乎正文与核心操作**——这条优先于"面板能显示多少信息"。
 *   位置和宽度由 `layout.ts` 用**量出来的 gutter** 决定，不写死；
 * - 不做 K 线 / 持仓等金融隐喻；
 * - 颜色只表达"更集中 / 更分散"，绝不做绿=健康红=危险的价值判断。
 *
 * 用 Shadow DOM 隔离，避免与知乎自身样式互相污染。
 */
import type { Settings } from '../shared/config.ts';
import { computeLayout, explainLayout, measure, measurementChanged, staysOutOfContent, FULL_WIDTH, MARGIN, MIN_TOP, DOCK_WIDTH } from './layout.ts';
import { locateContentElement } from './extract-content.ts';
import type { LayoutInput, PanelLayout } from './layout.ts';

export type PanelState = 'empty' | 'collecting' | 'analyzing' | 'ready' | 'error';

export type ConcentrationView =
  | { state: 'collecting'; sampleCount: number; needed: number }
  | { state: 'ready'; score: number; preliminary: boolean; sampleCount: number; conceptCount: number };

export interface PanelView {
  state: PanelState;
  concepts: Array<{ label: string; share: number; direction: 'up' | 'down' | 'flat' }>;
  concentration: ConcentrationView;
  sampleCount: number;
  /** 窗口内 mock/demo 条数 —— >0 必须显式标注 */
  syntheticCount: number;
  sourceBreakdown: { llm: number; mock: number; demo: number; enriched: number; other: number };
  pendingCount: number;
  analyzingCount: number;
  demoMode: boolean;
  /**
   * 当前页面**是否在采集**。
   *
   * 这和"面板显不显示"是两件事，2026-09-14 之前被绑在一起：
   * 不可采集的页面直接把面板藏掉，用户读到的是"扩展坏了"。
   * 现在面板always在，由这个字段决定要不要挂一行「当前页面不记录」。
   *
   * `undefined` = 调用方没告诉我们（老测试、演示模式），按"在采集"渲染，
   * 也就是不显示那行状态 —— 不确定时不主动制造噪音。
   */
  collecting?: boolean;
  error: string | null;
  zhihuSearchEnabled: boolean;
  /** 是否真的配置了分析服务。未配置时面板不得声称"分析在服务端完成" */
  analyzeEndpointConfigured: boolean;
  /**
   * 当前窗口里出现过的分析出处组合。>1 说明这些标签是**不同模型**打的，
   * 必须提示——否则用户会把"换了模型"造成的分布变化读成"我兴趣变了"。
   */
  analysisMix?: Array<{ key: string; count: number }>;
}

export interface DashboardCallbacks {
  onToggleCollapse(collapsed: boolean): void;
  onToggleTint(on: boolean): void;
  onToggleDemo?(on: boolean): void;
  onDismissError?(): void;
}

const ARROW = { up: '↑', down: '↓', flat: '—' } as const;

/**
 * 分析来源徽标。
 *
 * 规则很硬：**只要窗口里还有一条 mock 或 demo，就显示「演示数据」**，
 * 不按多数决。宁可过度标注，也不能让评委把哈希函数的输出当成 AI 分析。
 */
export function sourceBadge(b: PanelView['sourceBreakdown']): { text: string; kind: 'demo' | 'llm' | 'enriched' } | null {
  if (!b) return null;
  // **缺字段一律按"演示数据"处理，不能 fail open。**
  //
  // 这个 bug 是在给作品链接做截图时踩出来的：截图脚本只传了 `{mock:20, llm:0}`，
  // 于是 `b.mock + b.demo` = `20 + undefined` = NaN，`NaN > 0` 为 false，
  // 一路落到最后 `return null` —— **面板显示了 20 条演示数据，却一个标记都没有**。
  // 那正好是这个项目最不能出的那种错，而且差点被我自己贴到封面上。
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
  const mock = num(b.mock), demo = num(b.demo), llm = num(b.llm), enriched = num(b.enriched);
  if ([mock, demo, llm, enriched].some(Number.isNaN)) {
    return { text: '演示数据', kind: 'demo' };
  }
  const synthetic = mock + demo;
  const real = llm + enriched;
  if (synthetic > 0) {
    return { text: real > 0 ? `演示数据 ${synthetic}/${synthetic + real}` : '演示数据', kind: 'demo' };
  }
  // 2026-09-13 起知乎 Search 已真实调用过（CLAIM_EVIDENCE C-08，L5），
  // 但它**没有进分析主链路**，所以 `enriched` 在出货路径上仍然恒为 0，
  // 这个分支实际不会触发。留着是为了将来接"概念溯源"时不用改渲染层。
  if (enriched > 0) return { text: '知乎语境增强', kind: 'enriched' };
  if (llm > 0) return { text: 'AI 分析', kind: 'llm' };
  return null;
}

export class Dashboard {
  #host: HTMLDivElement;
  #root: ShadowRoot;
  #settings: Settings;
  #cb: DashboardCallbacks;
  #lastView: PanelView | null = null;
  /** dock 态下用户有没有手动展开。切页面时重置 —— 展开是"这一页我想看看"，不是长期偏好。 */
  #dockOpen = false;
  #layout: PanelLayout = { mode: 'full', left: MARGIN, top: MIN_TOP, width: FULL_WIDTH };
  /** 上一次量到的输入。用来判断"值不值得重排"，避免每秒重渲染一次面板。 */
  #lastMeasure: LayoutInput | null = null;

  constructor(settings: Settings, cb: DashboardCallbacks) {
    this.#settings = settings;
    this.#cb = cb;
    this.#host = document.createElement('div');
    this.#host.id = 'zhiliu-panel-host';
    // top 必须让开知乎自己的顶部导航栏。实测 zhihu.com 导航栏占 y:0–62，
    // logo 在 x:20–84，「关注/推荐/热榜」在 x:100–274。
    // 原来的 top:12px + 292px 宽面板会完全盖住 logo 和前三个 tab，
    // 而且 z-index 极高会真实拦截点击——直接违反本文件开头写的
    // 「不遮挡知乎核心操作」这条约束。
    // 初始位置是保守值；真正的位置由 applyLayout() 用**量出来的 gutter** 决定。
    // 写死 left/top/width 正是 2026-09-09 真人 Field Test 抓到的问题：
    // 292px 的面板在实际页面上压住了正文，因为从来没人量过 gutter 有多宽。
    this.#host.style.cssText =
      `position:fixed;top:${MIN_TOP}px;left:${MARGIN}px;z-index:2147483000;visibility:hidden;`;
    this.#root = this.#host.attachShadow({ mode: 'open' });
    this.#root.innerHTML = `<style>${STYLE}</style><div class="panel"></div>`;
    document.documentElement.appendChild(this.#host);
  }

  destroy(): void { this.#host.remove(); }
  get settings(): Settings { return this.#settings; }
  get layout(): PanelLayout { return this.#layout; }

  /**
   * 诊断用：把这次布局决策的全部输入与输出摊平。
   * 真人跑 field test 时不需要再猜"为什么 hidden"。
   */
  explain(): Record<string, unknown> {
    const panel = this.#root.querySelector('.panel') as HTMLElement | null;
    let rendered: { left: number; right: number; width: number } | undefined;
    try {
      if (panel && typeof panel.getBoundingClientRect === 'function') {
        const r = this.#host.getBoundingClientRect();
        rendered = { left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1) };
      }
    } catch { /* 量不到就不给渲染值，其余照常输出 */ }
    const m = this.#lastMeasure ?? this.measureNow();
    return { ...explainLayout(m, this.#layout, rendered), visibility: this.#host.style.visibility };
  }

  /**
   * 量一次页面，把面板放进左侧 gutter。
   *
   * 在首次渲染前、以及每次 resize / SPA 跳转后调用。
   * `visibility` 在量出来之前一直是 hidden——宁可晚一帧出现，
   * 也不要先在错误的位置闪一下（那一帧就压在正文上）。
   */
  /** 换页时调用：dock 的展开是"这一页我想看看"，不是长期偏好。 */
  resetDock(): void { this.#dockOpen = false; }

  applyLayout(input?: LayoutInput): PanelLayout {
    const m = input ?? this.measureNow();
    this.#lastMeasure = m;
    const l = computeLayout(m);
    this.#layout = l;
    this.#host.style.top = `${l.top}px`;
    // dock 贴右侧时用 CSS `right` 定位。用 left 的话窗口一缩放就飘 ——
    // 而 dock 的全部意义就是"永远在同一个地方等着你"。
    if (l.mode === 'dock' && l.side === 'right') {
      this.#host.style.left = 'auto';
      this.#host.style.right = `${MARGIN}px`;
    } else {
      this.#host.style.right = 'auto';
      this.#host.style.left = `${l.left}px`;
    }
    // 没有视图就先别露面：早先在 #lastView 为 null 时就把 visibility 打开，
    // 会先闪一个空的深色盒子出来，再突然填上内容。
    this.#host.style.visibility = !this.#lastView ? 'hidden' : 'visible';
    const panel = this.#root.querySelector('.panel') as HTMLDivElement | null;
    // 宽度交给 CSS 变量，compact 态自己用 auto
    panel?.style.setProperty('--panel-w', `${l.width}px`);
    if (this.#lastView) {
      this.render(this.#lastView);
      this.#enforceNoOverlap();
    }
    return this.#layout;
  }

  /**
   * 运行时自检：**用真正渲染出来的宽度**再判一次"有没有进正文"。
   *
   * `computeLayout` 算出来的 width 只是我们**打算**给的宽度；
   * CSS 可以把它甩掉（`width:auto` 就会），字体、缩放、用户样式也会。
   * 红队实测：手动折叠时算出来 174px、渲染出来 197.12px，右边界 209 压在正文（198）上。
   * 所以那条"面板右边界 ≤ 正文左边界 - margin"的不变量，
   * 光靠纯函数测试是守不住的——必须在渲染之后拿真实矩形再验一次。
   *
   * 验不过就直接藏起来。宁可看不见，也不要压着别人的正文。
   */
  #enforceNoOverlap(): void {
    const panel = this.#root.querySelector('.panel') as HTMLElement | null;
    if (!panel || typeof panel.getBoundingClientRect !== 'function') return;
    let rendered: number;
    try { rendered = panel.getBoundingClientRect().width; } catch { return; }
    if (!Number.isFinite(rendered) || rendered <= 0) return;
    const actual = { ...this.#layout, width: Math.ceil(rendered) };
    const m = this.#lastMeasure;
    if (staysOutOfContent(actual, m?.contentLeft ?? null, m?.contentRight, m?.viewportWidth)) return;
    // **降到 dock，而不是整块藏起来。**
    // 藏起来会让用户以为扩展没启动 —— 那是这一轮专门要修的误解。
    // dock 只有 40px、贴视口边缘，仍然满足"不压正文"。
    if (this.#layout.mode !== 'dock') {
      console.warn(
        `[知流] 面板渲染宽度 ${Math.round(rendered)}px 超出分配的 ${this.#layout.width}px，` +
        `会压到正文（正文左边界 ${m?.contentLeft}）——已降为边缘 dock。`,
      );
      this.#layout = { ...this.#layout, mode: 'dock', side: 'right', width: DOCK_WIDTH };
      this.#host.style.left = 'auto';
      this.#host.style.right = `${MARGIN}px`;
      if (this.#lastView) this.render(this.#lastView);
      return;
    }
    // 已经是 dock 还压到正文 —— 这才是真的没地方站了。
    console.warn('[知流] 连边缘 dock 都会压到正文，已隐藏。');
    this.#host.style.visibility = 'hidden';
  }

  /** 量一次当前页面。抽出来是为了让"变了才重排"可以先量再比较。 */
  measureNow(): LayoutInput {
    try {
      // 把"我们正在记录的那篇正文"交给布局层——受保护的阅读列就是包着它的那一列。
      // 靠一串写死的 class 名去猜是行不通的：真人实测 .QuestionHeader-content
      // 在真实回答页上是 1450/1450 满宽 wrapper。
      const target = locateContentElement(document);
      return measure(document, window.innerWidth, (el) => el.getBoundingClientRect(), target);
    } catch {
      // 量不出来就维持现状，绝不因为一次异常把面板扔到默认位置去压正文
      return this.#lastMeasure ?? { contentLeft: null, headerBottom: 0 };
    }
  }

  /**
   * 只在版式真的变了的时候重排。
   *
   * 为什么不能只靠 `resize` 事件：
   * 1. `resize` 的回调用了 `requestAnimationFrame` 合并，而 **rAF 在后台标签页里不执行**——
   *    用户在别的标签页里拖窗口，切回来的那一瞬间面板还在旧位置；
   * 2. 更要命的是**知乎的版式会在没有 resize 的情况下变**：右侧栏异步加载完成、
   *    登录态横幅出现/消失、图片撑开布局，正文左边界都会移动，而 `resize` 一次都不会触发。
   *    实测就是这样漏掉的：视口从 1440 变到 1000 之后，量出来应该是 hidden，
   *    面板却仍然停在 174px 宽的位置上，右边界 186 压在正文（左边界 0）上。
   *
   * 所以真正的兜底是"每秒量一次，变了才重排"，成本是一次 getBoundingClientRect。
   */
  relayoutIfChanged(): boolean {
    const m = this.measureNow();
    if (!measurementChanged(this.#lastMeasure, m)) return false;
    this.applyLayout(m);
    return true;
  }

  render(view: PanelView): void {
    this.#lastView = view;
    const panel = this.#root.querySelector('.panel') as HTMLDivElement;
    // 兜底：即使上游状态判断出错，score 不是有限数就绝不渲染成分数。
    // 早先 service-worker 的门槛与核心库不一致，面板真的渲染过「信息集中度 null」。
    const raw = view.concentration.state === 'ready' ? view.concentration.score : null;
    const score = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    const preliminary = view.concentration.state === 'ready' && view.concentration.preliminary === true;

    panel.style.setProperty(
      '--tint',
      this.#settings.tintByConcentration && score !== null ? tint(score) : 'rgba(0,0,0,0)',
    );
    // gutter 放不下完整面板时**自动**收成胶囊，与用户手动折叠是两回事：
    // 手动折叠是偏好，自动收拢是"再宽就压到正文了"。两者都走 collapsed 渲染，
    // 但自动那次不写回 settings —— 用户把窗口拉宽以后应该自己展开回来。
    const compact = this.#layout.mode === 'compact';
    // dock：贴视口边缘的一条窄条。它是**兜底态**，不是一种偏好 ——
    // 所以和 compact 一样不写回 settings。点一下展开成完整面板。
    const docked = this.#layout.mode === 'dock' && !this.#dockOpen;
    panel.classList.toggle('collapsed', (this.#settings.collapsed || compact) && !docked);
    panel.classList.toggle('auto-compact', compact);
    panel.classList.toggle('dock', docked);
    panel.classList.toggle('dock-open', this.#layout.mode === 'dock' && this.#dockOpen);
    // dock 展开之后要恢复完整宽度 —— 不然 --panel-w 还是 40px，
    // 展开出来是一条 40px 宽的竖长条，比不展开更难看。
    if (this.#layout.mode === 'dock') {
      panel.style.setProperty('--panel-w', docked ? `${DOCK_WIDTH}px` : `${FULL_WIDTH}px`);
    }
    panel.innerHTML = docked
      ? this.#dock(view)
      : compact
      // 胶囊态用**专门的**极简标记，不是把折叠态塞进 104px 再 overflow:hidden 裁掉——
      // 那样集中度数字会被切掉一半，看起来像渲染坏了。
      ? this.#capsule(view, score)
      : this.#settings.collapsed
        ? this.#collapsed(view, score, preliminary)
        : this.#expanded(view, score, preliminary);
    this.#wire(panel, view);
    this.#host.style.visibility = 'visible';
  }

  /**
   * 兜底 dock 的标记。
   *
   * 只有竖排的「知流」和一个已记录篇数。它要回答的问题只有一个：
   * **"扩展还在吗？"** —— 在。点一下才展开完整面板。
   *
   * 采集状态不在这里说：dock 只有 40px，塞一行「当前页面不记录」会被裁掉，
   * 裁一半的字比不说更糟。展开之后那一行就在最上面。
   */
  #dock(view: PanelView): string {
    const n = view.sampleCount ?? 0;
    return `<button class="dock-tab" title="知流 · 点开查看最近信息" aria-label="展开知流面板">
        <span class="dock-name">知流</span>
        ${n > 0 ? `<span class="dock-n">${n}</span>` : ''}
      </button>`;
  }

  /** 「当前页面不记录」那一行。只在明确知道不采集时出现。 */
  #notCollecting(view: PanelView): string {
    if (view.collecting !== false) return '';
    return `<div class="not-collecting"><span class="dot"></span>` +
           `<span>当前页面不记录 · 仅展示最近信息</span></div>`;
  }

  #wire(panel: HTMLElement, view: PanelView): void {
    panel.querySelector('.dock-tab')?.addEventListener('click', () => {
      this.#dockOpen = true;
      if (this.#lastView) this.render(this.#lastView);
    });
    panel.querySelector('.dock-close')?.addEventListener('click', () => {
      this.#dockOpen = false;
      if (this.#lastView) this.render(this.#lastView);
    });
    panel.querySelector('.toggle')?.addEventListener('click', () => {
      this.#settings = { ...this.#settings, collapsed: !this.#settings.collapsed };
      this.#cb.onToggleCollapse(this.#settings.collapsed);
      this.render(view);
      // 折叠态走 `width:auto`，渲染宽度会变 —— 必须重新自检
      this.#enforceNoOverlap();
    });
    panel.querySelector('.tint-toggle')?.addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.#settings = { ...this.#settings, tintByConcentration: on };
      this.#cb.onToggleTint(on);
      this.render(view);
    });
    panel.querySelector('.demo-toggle')?.addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.#settings = { ...this.#settings, demoMode: on };
      this.#cb.onToggleDemo?.(on);
    });
    panel.querySelector('.err-dismiss')?.addEventListener('click', () => this.#cb.onDismissError?.());
  }

  #badge(view: PanelView): string {
    const b = sourceBadge(view.sourceBreakdown);
    if (!b) return '';
    const title = b.kind === 'demo'
      ? '这些概念来自本地预置样例或确定性 mock，不是真实模型分析'
      : b.kind === 'llm' ? '这些概念由语言模型分析得出' : '在模型分析基础上补充了知乎社区语境';
    return `<span class="src-badge ${b.kind}" title="${title}">${b.text}</span>`;
  }

  // ── 折叠态 ────────────────────────────────────────────────
  /**
   * 胶囊态：gutter 只放得下约 104px 时用。
   *
   * 只显示一件事，且必须**完整**显示。这里没有徽标、没有按钮——
   * 塞不下就不塞，而不是塞进去再裁掉。
   */
  #capsule(view: PanelView, score: number | null): string {
    const label =
      view.state === 'error' ? '<span class="err-dot">异常</span>'
      : view.state === 'analyzing' ? '<span class="muted">分析中</span>'
      : score === null ? '<span class="muted">积累中</span>'
      : `<b>${score}</b>`;
    // **演示标记在胶囊态必须仍然可见。**
    // 红队 R7-4：整个现场降级预案（真实分析挂了就切演示模式）都建立在
    // 「演示数据」徽标一定看得见之上；而胶囊态原本连徽标都不渲染，
    // 1150–1350px 的窗口宽度必然落进胶囊态 —— 评委会看到一个没有任何标记的实时面板。
    // 完整徽标在 104px 里放不下，所以用一个不占宽度的单字 chip，并保留 title 说明。
    const b = sourceBadge(view.sourceBreakdown);
    const mark = b && b.kind === 'demo'
      ? `<span class="src-badge demo" title="${escapeHtml(b.text)}：这些概念不是实时分析产生的">演</span>`
      : '';
    return `<div class="row head capsule" title="知流 · 信息集中度"><span class="brand">知流</span>${mark}<span class="score-inline">${label}</span></div>`;
  }

  #collapsed(view: PanelView, score: number | null, preliminary = false): string {
    const label =
      view.state === 'error' ? '<span class="err-dot">分析异常</span>'
      : view.state === 'analyzing' ? '<span class="muted">分析中…</span>'
      : score === null ? '<span class="muted">数据积累中</span>'
      : `信息集中度 <b>${score}</b>${preliminary ? '<span class="prelim">初步</span>' : ''}`;
    return `<div class="row head">
      <span class="brand">知流</span>
      <span class="score-inline">${label}</span>
      ${this.#badge(view)}
      <button class="toggle" title="展开" aria-label="展开">▸</button>
    </div>`;
  }

  // ── 展开态 ────────────────────────────────────────────────
  #expanded(view: PanelView, score: number | null, preliminary = false): string {
    return `
      <div class="row head">
        <span class="brand">知流 · 最近信息</span>
        ${this.#badge(view)}
        ${this.#layout.mode === 'dock'
          ? '<button class="dock-close" title="收回边缘" aria-label="收回边缘">×</button>'
          : '<button class="toggle" title="收起" aria-label="收起">▾</button>'}
      </div>
      ${view.error ? this.#errorBanner() : ''}
      ${this.#body(view, score, preliminary)}
      ${this.#notCollecting(view)}
      ${this.#footer(view)}
    `;
  }

  /**
   * 错误以横幅形式叠加，**不替换**主体内容。
   * 早先出错时整个面板被错误态占满，柱状图和集中度全部消失，
   * 而文案还写着「已记录的阅读不受影响」——一次网络抖动就当场白屏。
   */
  #errorBanner(): string {
    return `<div class="banner err">
        <span>分析暂时不可用，已记录的阅读不受影响</span>
        <button class="err-dismiss" aria-label="忽略">×</button>
      </div>`;
  }

  #body(view: PanelView, score: number | null, preliminary = false): string {
    switch (view.state) {
      case 'empty':
        return `<div class="notice">
            <div>还没有记录</div>
            <div class="sub">正常浏览知乎回答或文章，停留 8 秒以上就会自动记录。</div>
          </div>`;

      case 'analyzing':
        return `<div class="notice">
            <div class="pulse">正在分析当前内容…</div>
            <div class="sub">${view.analyzeEndpointConfigured
              ? '发送这一篇的标题与公开正文，不发送浏览历史。'
              : '当前未连接分析服务，使用本地演示数据。'}</div>
          </div>`;

      /*
       * 分母读 view.concentration.needed，**不写死**。
       * 这里曾经硬编码 5，而真实门槛是 concentration.ts 的 MIN_SAMPLES = 10 ——
       * needed 一路从 concentration.ts 传进这个 view 类型里，模板却把它扔了。
       * 后果落在 happy path 正中央：认真读 5 篇的人看到「5/5 篇」然后什么也不发生。
       * （注释写在模板字符串外面：里面出现反引号会直接把模板终止掉。）
       */
      case 'collecting':
        return `${this.#bars(view)}
          <div class="notice slim">
            <div>数据积累中 · 已记录 ${view.concentration.sampleCount}/${view.concentration.needed} 篇</div>
            <div class="sub">样本太少时不显示集中度，避免给出看起来精确的假数字。</div>
          </div>`;

      case 'error':
      case 'ready':
      default:
        // 免误读的解释必须常驻。放在 title 悬停里，路演时评委永远看不到，
        // 而"68 分"最容易被读成"越高越好"或"越高越危险"。
        if (score === null) {
          // 分数拿不到时退回积累态，绝不渲染 null
          return `${this.#bars(view)}
            <div class="notice slim"><div>数据积累中 · 已记录 ${view.sampleCount} 篇</div></div>`;
        }
        return `${this.#bars(view)}
          <div class="score">
            <span>信息集中度${preliminary ? '<span class="prelim">初步</span>' : ''}</span><b>${score}</b>
          </div>
          <div class="score-note">${preliminary
            ? `样本未满 20 篇，这是初步值，不要和满窗口的分数直接比较`
            : '不代表好坏，只描述最近读的内容是否集中在少数几个概念上'}</div>`;
    }
  }

  #bars(view: PanelView): string {
    if (view.concepts.length === 0) return '';
    // 一行说明，解决"条形+百分比+涨跌箭头"与股票持仓列表视觉同构的问题：
    // 没有这句，第一次看到的人会先怀疑这是某种排名或行情，而不是自己的阅读分布。
    const caption = `<div class="caption">最近 ${view.sampleCount} 篇里，各核心概念出现的占比</div>`;
    return caption + view.concepts.slice(0, 4).map((c) => {
      const pct = Math.round(c.share * 100);
      return `<div class="bar-row">
        <span class="label" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span>
        <span class="bar"><i style="width:${Math.max(2, pct)}%"></i></span>
        <span class="pct">${pct}%</span>
        <span class="arrow ${c.direction}">${ARROW[c.direction]}</span>
      </div>`;
    }).join('');
  }

  #footer(view: PanelView): string {
    const notes: string[] = [];
    if (view.analyzingCount > 0) notes.push(`${view.analyzingCount} 篇分析中`);
    if (view.pendingCount > 0) notes.push(`${view.pendingCount} 篇未产出概念`);
    // 混了不同模型 / 不同 prompt 的窗口必须说出来。这不是洁癖：
    // 换模型造成的分布跳变和兴趣变化在图上长得一模一样，不标就是误导。
    const mix = view.analysisMix ?? [];
    if (mix.length > 1) {
      notes.push(`这 ${mix.reduce((n, m) => n + m.count, 0)} 篇由 ${mix.length} 种分析来源混合产生（${mix.map((m) => m.key).join(' / ')}），跨时间对比需谨慎`);
    }
    return `
      ${notes.length ? `<div class="pending">${notes.join(' · ')}</div>` : ''}
      <div class="settings">
        <label><input type="checkbox" class="tint-toggle" ${this.#settings.tintByConcentration ? 'checked' : ''}/><span>按集中度调整色调</span></label>
        <label><input type="checkbox" class="demo-toggle" ${this.#settings.demoMode ? 'checked' : ''}/><span>演示模式</span></label>
      </div>`;
  }
}

/** 同一冷色系内的连续位移，不使用交通灯配色。 */
function tint(score: number): string {
  const t = Math.max(0, Math.min(100, score)) / 100;
  const hue = 214 - 26 * t;
  // 集中度越高 → 颜色越"深"而不是越"亮"。
  // 早先的实现把亮度往上推，实测在集中度 96 时把次要文字的对比度压到 2.96:1
  // （WCAG AA 要求 4.5:1）。往深处走既保住了可读性，语义上也更贴切：
  // "信息更集中"读作"颜色更沉"，而不是"更刺眼"。
  return `hsla(${hue}, ${22 + 24 * t}%, ${26 - 9 * t}%, ${0.20 + 0.24 * t})`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const STYLE = `
:host { all: initial; }
.panel {
  font: 12px/1.45 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #d8dee9;
  background-color: rgba(22,24,29,0.94);
  background-image: linear-gradient(var(--tint, transparent), var(--tint, transparent));
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 7px 10px 8px;
  width: var(--panel-w, 224px);
  /* max-width 必须无条件加，不能只加在自动收拢那一档。
     用户手动折叠时走 .panel.collapsed 的 width:auto，实测在真实 Chrome 里
     渲染成 197.12px、右边界 209，而正文左边界是 198 —— 算出来的 174px 被 CSS 整个甩掉。
     不变量只守住了纯函数，没守住渲染结果。 */
  max-width: var(--panel-w, 224px);
  box-sizing: border-box;
  overflow: hidden;
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 18px rgba(0,0,0,0.3);
  transition: background 400ms ease;
}
.panel.collapsed { width: auto; max-width: var(--panel-w, 224px); padding: 5px 8px; }
.panel.collapsed .row.head { min-width: 0; }
.panel.collapsed .brand,
.panel.collapsed .score-inline { overflow: hidden; text-overflow: ellipsis; }
/* 自动收拢：宽度被 gutter 卡住，必须不许溢出 —— 这是"不进正文"的最后一道 CSS 保险 */
.panel.auto-compact { max-width: var(--panel-w, 104px); }
.row.head.capsule { gap: 5px; justify-content: space-between; white-space: nowrap; }
.row.head { display: flex; align-items: center; gap: 8px; }
.brand { color: #9aa3b1; font-size: 11px; letter-spacing: .3px; white-space: nowrap; }
.score-inline { color: #c8cfdb; white-space: nowrap; }
.score-inline b { color: #eaf0f7; font-weight: 600; }
.muted { color: #8b93a1; }
.err-dot { color: #c98f6b; }
.src-badge {
  font-size: 10px; padding: 1px 5px; border-radius: 3px; white-space: nowrap;
}
.src-badge.demo { color: #c8a765; background: rgba(200,167,101,0.14); border: 1px solid rgba(200,167,101,0.32); }
.src-badge.llm { color: #8fb3d9; background: rgba(143,179,217,0.12); border: 1px solid rgba(143,179,217,0.28); }
.src-badge.enriched { color: #9ad0b8; background: rgba(154,208,184,0.12); border: 1px solid rgba(154,208,184,0.28); }
.toggle { margin-left: auto; background: none; border: none; color: #8b93a1; cursor: pointer; font-size: 11px; padding: 0 2px; line-height: 1; }
.toggle:hover { color: #c8cfdb; }
.caption { color: #8b939f; font-size: 10px; margin-top: 5px; }
.bar-row { display: flex; align-items: center; gap: 7px; margin-top: 5px; }
.label {
  /* 宽度可压缩：面板宽度由 gutter 决定，可能只有 168px。
     写死 62px 会把柱子挤没，标签反而是最能牺牲的部分（有 title 兜底）。 */
  flex: 0 1 62px; min-width: 38px;
  color: #c2c9d4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bar { flex: 1; height: 6px; background: rgba(255,255,255,0.07); border-radius: 3px; overflow: hidden; }
.bar { flex: 1 1 auto; min-width: 22px; }
.bar i { display: block; height: 100%; background: #5b8ac9; border-radius: 3px; transition: width 320ms ease; }
.pct { flex: 0 0 30px; text-align: right; color: #a8b0bd; font-variant-numeric: tabular-nums; }
.arrow { flex: 0 0 10px; text-align: center; font-size: 10px; }
.arrow.up { color: #7fa8dd; } .arrow.down { color: #8a8f99; } .arrow.flat { color: #5d636d; }
.score {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.07);
  color: #98a0ad;
}
.score b { color: #eaf0f7; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.score-note { margin-top: 2px; color: #8b939f; font-size: 10px; line-height: 1.35; }
.prelim {
  margin-left: 4px; padding: 0 3px; border-radius: 2px; font-size: 9px;
  color: #c8a765; background: rgba(200,167,101,0.16); border: 1px solid rgba(200,167,101,0.3);
}
.notice { margin-top: 7px; color: #aab2bf; }
.notice.slim { margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.07); }
.notice .sub { color: #8b939f; font-size: 11px; margin-top: 3px; line-height: 1.4; }
.notice.err { color: #d3a184; }
.notice.err .sub { color: #8b939f; }
.err-dismiss {
  margin-top: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
  color: #c8cfdb; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;
}
.pulse { animation: zl-pulse 1.4s ease-in-out infinite; }
@keyframes zl-pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
.pending { margin-top: 6px; color: #8b939f; font-size: 11px; }
.banner {
  display: flex; align-items: center; gap: 6px; margin-top: 6px;
  padding: 3px 6px; border-radius: 4px; font-size: 11px;
  background: rgba(201,143,107,0.14); border: 1px solid rgba(201,143,107,0.3); color: #d3a184;
}
.banner .err-dismiss {
  margin: 0 0 0 auto; padding: 0 4px; background: none; border: none;
  color: #d3a184; cursor: pointer; font-size: 13px; line-height: 1;
}
.settings {
  /* 面板宽度由 gutter 决定，1440 屏上只有 174px —— 两个选项并排会挤成两行半。
     换行而不是压缩：宁可占一行高度，也不要让文字断在中间。 */
  display: flex; flex-wrap: wrap; gap: 3px 12px; margin-top: 8px; padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.07); color: #9aa3b1; font-size: 11px;
}
.settings label {
  display: flex; align-items: center; gap: 4px; cursor: pointer;
  white-space: nowrap; /* 断行只能发生在两个选项之间，不能发生在一个选项内部 */
}
.settings input { margin: 0; }

/* ── 兜底 dock ─────────────────────────────────────────────
   放不下完整面板时贴在视口边缘的一条窄条。
   它取代了原来的"整块藏起来" —— 藏起来会让人以为扩展没启动。 */
/* dock 展开态是**用户主动打开的浮层**，不是面板默认铺开。
   给它一层明显的投影，让它读起来像"我点开的东西"而不是"它占了我的侧栏"；
   点 × 收回窄条。默认状态永远是那条 40px。 */
.panel.dock-open {
  box-shadow: 0 12px 40px -8px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
}
.panel.dock {
  --panel-w: 40px;
  width: 40px; min-width: 40px; padding: 0;
  background: rgba(31,35,40,0.92);
  border-radius: 8px 0 0 8px;   /* 贴右边缘，只圆左侧两角 */
  overflow: hidden;
}
.panel.dock .dock-tab {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  width: 100%; padding: 12px 0 14px; border: 0; background: none; cursor: pointer;
  color: #e6e9ec; font: inherit;
}
.panel.dock .dock-tab:hover { background: rgba(255,255,255,0.06); }
.panel.dock .dock-name {
  /* 竖排。40px 宽里横排放不下两个汉字，缩小字号会糊。 */
  writing-mode: vertical-rl; text-orientation: upright;
  font-size: 13px; letter-spacing: 2px; line-height: 1;
}
.panel.dock .dock-n {
  font-size: 10px; color: #9aa3b1; font-variant-numeric: tabular-nums;
}
.dock-close {
  border: 0; background: none; color: #9aa3b1; cursor: pointer;
  font-size: 12px; padding: 0 2px; line-height: 1;
}
.dock-close:hover { color: #e6e9ec; }

/* ── 当前页面不采集时的状态行 ──────────────────────────────
   它要说清楚的是"这一页不记录"，而不是"扩展坏了"。
   所以用中性的灰，不用警告色 —— 这不是错误，是设计。 */
.not-collecting {
  display: flex; align-items: center; gap: 6px;
  margin-top: 8px; padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.07);
  color: #8b94a3; font-size: 11px; line-height: 1.5;
}
.not-collecting .dot {
  width: 5px; height: 5px; border-radius: 50%; background: #6b7683; flex: none;
}
`;
