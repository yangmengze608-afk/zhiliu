/**
 * 面板定位：把知流放进知乎正文左侧原本空着的那条 gutter。
 *
 * ## 唯一的硬规则
 *
 * **面板的右边界不得进入正文主列。** 这条优先于"面板能显示多少信息"。
 * 2026-09-09 的真人 Field Test 里，面板（`left:12px` + 292px 宽）在实际页面上
 * 压住了正文——因为宽度是写死的，而 gutter 有多宽从来没被测量过。
 *
 * 所以这里不写死任何 left/top/width，而是**先量 gutter，再决定显示成什么样**：
 *
 *   gutter 够宽   → 完整面板
 *   gutter 不够   → 收成一个小胶囊（「知流 · 36」）
 *   gutter 极窄   → 不显示
 *
 * 最后一条是刻意的：在窄视口上（DevTools 打开、笔记本小屏、浏览器窗口拖窄），
 * 知乎的正文会一路顶到左边缘，此时**没有任何位置能放下面板而不压正文**。
 * 与其压上去，不如让开。这是"不遮挡 > 展示更多"这条原则的直接后果。
 *
 * 这个模块是**纯函数**：输入几个像素数，输出布局。因此不需要浏览器就能测，
 * 而"面板右边界 < 正文左边界"这条也就能写成一条真正的断言。
 */

/**
 * `dock` 是 2026-09-14 新增的**兜底态**，它取代了原来的 `hidden`。
 *
 * 起因是真人测试：在 `/question/<qid>`、`/search` 这类页面上面板整块消失，
 * 用户合理地以为"扩展没启动"。但那两件事本来就是分开的 ——
 *   **面板显不显示**（入口、已有历史）
 *   **这一页能不能采集**（计时、抽正文、调模型、写历史）
 * 把它们绑在一起，等于用"看不见"去表达"这页不记录"，而用户读到的是"坏了"。
 *
 * 所以放不下完整面板时不再整块藏起来，退成贴在视口边缘的一条窄 dock。
 * `NO OVERLAP > PANEL VISIBILITY` 没有松：dock 只有 40px，贴边放，
 * 并且优先放在**空白更宽**的那一侧。
 */
export type PanelMode = 'full' | 'compact' | 'dock';

export interface LayoutInput {
  /**
   * 正文主列的左边界（视口坐标，px）。
   *
   * **`null` = 没量出来**，不是"很宽"。这个区分是红队打出来的：
   * 旧实现在量不到时把它设成 `viewportWidth`，注释还写着"结果是 hidden，最保守"——
   * 实际算出来是 `available = 1440 - 24` → **完整面板**，回到 `left:12 / width:224`，
   * 正是真人看到压正文的那个位置。三种真实输入都会走进这条分支：
   * 探针类名被知乎改掉、`document_idle` 首屏 rect 还全是 0、
   * 正文列窄于 300px 被过滤器吞掉。
   *
   * 量不出来就**不显示**。这才是 fail closed。
   */
  contentLeft: number | null;
  /** 顶部导航的下边界（视口坐标，px） */
  headerBottom: number;
  /** 正文主列的右边界。只用于诊断，不参与布局决策。 */
  contentRight?: number | null;
  /** 实际量到正文列的那个探针。量不到时为 null —— 下次真人验证只需要看这一行。 */
  matchedProbe?: string | null;
  /** 量的时候的视口宽度。 */
  viewportWidth?: number;
  /** 全部候选探针的体检结果。只用于诊断。 */
  probeCandidates?: ProbeCandidate[];
}

export interface PanelLayout {
  mode: PanelMode;
  left: number;
  top: number;
  width: number;
  /**
   * dock 贴哪一边。只在 `mode === 'dock'` 时有意义。
   * 渲染时右侧用 CSS `right`，不要用 `left` —— 视口宽度会变，
   * 用 left 定位的右贴边在窗口缩放时会飘。
   */
  side?: 'left' | 'right';
}

/** 面板与视口左边、与正文左边各留这么多。 */
export const MARGIN = 12;
/** 完整面板的目标宽度。 */
export const FULL_WIDTH = 224;
/**
 * 低于这个宽度，完整面板的柱状图会挤得没法读，改用 compact。
 *
 * **168 是量出来的，不是拍的。** 在真实浏览器里按知乎的实际版式渲染
 * （正文列 690 + 内边距 48，右侧栏 296，居中）：
 *   1440 视口 → 正文左边界 198 → 可用 gutter **174**
 *   1600 视口 → 正文左边界 278 → 可用 gutter 254
 * 1440 是最常见的桌面宽度。阈值定在 196 会让**最常见的那块屏幕**直接掉进胶囊态，
 * 而 174px 其实完全放得下柱状图（实测四行标签+条+百分比+箭头都不折行）。
 * 定 168 留一点余量，同时仍然挡住真正放不下的窄屏。
 */
export const MIN_FULL_WIDTH = 168;
/** 胶囊态宽度。 */
export const COMPACT_WIDTH = 104;
/** 顶部下限：即使页面没有 header，也不贴着视口顶边。 */
export const MIN_TOP = 72;

/**
 * 兜底 dock 的宽度。
 *
 * 40px：够放竖排的「知流」两个字加一个计数，又窄到几乎不可能压住正文
 * （知乎的阅读列是居中的，两侧本来就有留白）。
 */
export const DOCK_WIDTH = 40;

/**
 * 量出来的 gutter → 布局。
 *
 * `available` 是"视口左边缘留出 MARGIN 之后，到正文左边缘再留出 MARGIN 之前"
 * 这一段的宽度。面板放进去就一定不会碰到正文。
 */
export function computeLayout(m: LayoutInput): PanelLayout {
  const top = Math.max(MIN_TOP, Math.round(m.headerBottom) + MARGIN);

  // 量到了阅读列，且左侧空白够宽 —— 正常展示。
  if (m.contentLeft !== null) {
    const available = Math.max(0, Math.floor(m.contentLeft) - MARGIN * 2);
    if (available >= MIN_FULL_WIDTH) {
      return { mode: 'full', left: MARGIN, top, width: Math.min(FULL_WIDTH, available) };
    }
    if (available >= COMPACT_WIDTH) {
      return { mode: 'compact', left: MARGIN, top, width: COMPACT_WIDTH };
    }
  }

  // 到这里有两种情况，处理方式一样：
  //   · `contentLeft === null` —— 根本没量出阅读列（搜索页、feed、问题页…）
  //   · 量出来了但左边放不下完整面板
  // **不再整块藏起来。** 藏起来等于用"看不见"表达"这页不记录"，
  // 而用户读到的是"扩展坏了"。退成贴边的窄 dock，入口和历史始终在。
  return { mode: 'dock', side: dockSide(m), left: MARGIN, top, width: DOCK_WIDTH };
}

/**
 * dock 贴哪一侧：哪边空白宽就贴哪边，量不出来时默认右侧。
 *
 * 默认右侧是因为知乎左上角有站点导航与侧栏入口，右侧通常是纯留白；
 * 而且用户的注意力在阅读列上，右边缘更不容易被误点。
 */
function dockSide(m: LayoutInput): 'left' | 'right' {
  const vw = m.viewportWidth;
  if (typeof vw !== 'number' || m.contentRight == null || m.contentLeft === null) return 'right';
  const rightFree = vw - m.contentRight;
  const leftFree = m.contentLeft;
  return leftFree > rightFree ? 'left' : 'right';
}

/**
 * 兜底用的正文列候选类名。
 *
 * **这些只是候选，不是判据。** 2026-09-10 的真人 Field Test 证明了为什么：
 * 在真实回答页上 `.QuestionHeader-content` 的实测矩形是
 * `left:0 / right:1450 / width:1450`——**整个视口宽**。
 * 它是外层 wrapper，不是用户阅读的那一列；用它算出 `contentLeft: 0`、
 * `availableLeftGutter: 0`，面板于是永远 hidden，而肉眼看到左边明明有大片空白。
 *
 * 所以现在真正的判据是**测量**（见 `findProtectedColumn`），
 * 这个列表只是在"没能从正文元素往上找到列"时多给几个候选。
 */
export const CONTENT_PROBES = [
  '.QuestionAnswer-content',
  '.Post-content',
  '.QuestionHeader-content',
  '.Post-Header',
  '.Question-main',
  '.Post-Main',
];
// 这里**不放** `.App-main`：它是整页容器，左边界约等于 0，量到它等于永远认为没有 gutter。

/** 顶部导航的候选探针。 */
export const HEADER_PROBES = ['.AppHeader', 'header', '.Sticky--holder'];

/**
 * 宽度达到视口的这个比例，就判定为 page-level wrapper，**不得**当作正文列。
 *
 * 0.9 不是拍的：真人实测 `.QuestionHeader-content` 是 1450/1450 = 1.00，
 * 而知乎的正文列在 1450 视口下肉眼可见地只占中间一段。
 * 任何接近满宽的东西都不是"用户阅读的那一列"。
 */
export const FULL_WIDTH_RATIO = 0.9;

/** 窄于此的元素不当作阅读列（段落、内联卡片、侧栏小组件）。 */
export const MIN_COLUMN_WIDTH = 280;

/** 页面内容区的左原点。正常页面就是视口左边。 */
export const PAGE_LEFT = 0;

export interface RectLike { left: number; top: number; bottom: number; width: number }

/** 一个候选探针的完整体检结果。诊断里原样输出，真人一眼能看出为什么选/不选。 */
export interface ProbeCandidate {
  selector: string;
  left: number;
  right: number;
  width: number;
  /** 是否包着我们**正在记录的那篇正文** */
  containsTargetContent: boolean;
  /** null = 通过体检 */
  rejectedReason: string | null;
  selected: boolean;
}

/**
 * 找出 **protectedContentLeft**：Dashboard 绝不能越过的主阅读列左边界。
 *
 * ## 定义（这是本轮的核心改动）
 *
 * 旧定义是"页面上最大的内容容器从哪里开始"——那会选中 page wrapper。
 * 新定义是：
 *
 *   **包着"我们正在记录的这篇正文"的那一列，其中最外层的、仍然不是满宽 wrapper 的那个。**
 *
 * 做法是从**抽取到的正文元素**向上走祖先链，逐个量矩形：
 * 越往上越宽，直到某一层变成满宽 wrapper 就停。
 * 取幸存者里**最靠左**的那个——最保守的边界。
 *
 * ## 为什么不取更靠右的元素
 *
 * 因为那是作弊。正文元素自己（`.RichText`）的 left 包含了卡片内边距，
 * 拿它当边界能凭空多出几十像素 gutter，但"再往右"其实早就进了用户的阅读区。
 * 规则写死：**取幸存候选里 left 最小的**，不是最大的。
 *
 * ## 找不到就 hidden
 *
 * 如果所有候选都是满宽 wrapper（或者根本没抽到正文），返回 null，
 * 布局层据此隐藏面板。`NO OVERLAP > PANEL VISIBILITY`。
 */
export function findProtectedColumn(
  doc: Document,
  viewportWidth: number,
  rectOf: (el: Element) => RectLike,
  target: Element | null,
): { protectedContentLeft: number | null; selected: ProbeCandidate | null; candidates: ProbeCandidate[] } {
  const seen = new Set<Element>();
  const raw: Array<{ el: Element; label: string }> = [];

  // ① 主路径：从正文元素往上走。这是唯一能保证"确实是这篇内容那一列"的来源。
  if (target) {
    let depth = 0;
    for (let cur: Element | null = target; cur; cur = cur.parentElement) {
      if (!seen.has(cur)) { seen.add(cur); raw.push({ el: cur, label: `祖先#${depth} ${describeEl(cur)}` }); }
      depth++;
      if (depth > 30) break; // 防御性上限，正常页面用不到
    }
  }
  // ② 兜底：类名候选。只有在①一个都没通过体检时才可能派上用场。
  for (const sel of CONTENT_PROBES) {
    for (const el of doc.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      raw.push({ el, label: sel });
    }
  }

  const candidates: ProbeCandidate[] = raw.map(({ el, label }) => {
    let r: RectLike;
    try { r = rectOf(el); } catch {
      return { selector: label, left: NaN, right: NaN, width: NaN, containsTargetContent: false,
               rejectedReason: '取矩形抛异常', selected: false };
    }
    const contains = target ? elContains(el, target) : false;
    let reason: string | null = null;
    if (!Number.isFinite(r.width) || !Number.isFinite(r.left) || r.width <= 0) reason = '未布局（宽度 0）';
    else if (r.width >= viewportWidth * FULL_WIDTH_RATIO) {
      reason = `page-level wrapper（宽 ${Math.round(r.width)} ≥ 视口 ${viewportWidth} 的 ${FULL_WIDTH_RATIO}）`;
    } else if (r.width < MIN_COLUMN_WIDTH) reason = `太窄（${Math.round(r.width)} < ${MIN_COLUMN_WIDTH}），不是阅读列`;
    else if (!contains) reason = '不包含正在记录的正文';
    return {
      selector: label,
      left: round1(r.left), right: round1(r.left + r.width), width: round1(r.width),
      containsTargetContent: contains, rejectedReason: reason, selected: false,
    };
  });

  const ok = candidates.filter((c) => c.rejectedReason === null);
  if (ok.length === 0) return { protectedContentLeft: null, selected: null, candidates };

  // 最保守：left 最小；同 left 时取更宽的（更外层的那一列）
  ok.sort((a, b) => (a.left - b.left) || (b.width - a.width));
  const chosen = ok[0];
  chosen.selected = true;
  return { protectedContentLeft: chosen.left, selected: chosen, candidates };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function describeEl(el: Element): string {
  const cls = (el.getAttribute?.('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
}

function elContains(a: Element, b: Element): boolean {
  if (a === b) return true;
  const fn = (a as unknown as { contains?: (n: Element) => boolean }).contains;
  if (typeof fn === 'function') return fn.call(a, b);
  for (let cur: Element | null = b.parentElement; cur; cur = cur.parentElement) if (cur === a) return true;
  return false;
}

/**
 * 量当前页面。
 *
 * `target` 是抽取层定位到的正文元素；没有它就没有可信的"主阅读列"，
 * 布局层会拿到 `contentLeft: null` 并隐藏面板。
 */
export function measure(
  doc: Document,
  viewportWidth: number,
  rectOf: (el: Element) => RectLike,
  target: Element | null = null,
): LayoutInput {
  const found = findProtectedColumn(doc, viewportWidth, rectOf, target);

  let headerBottom = 0;
  for (const sel of HEADER_PROBES) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    let r: RectLike;
    try { r = rectOf(el); } catch { continue; }
    if (r.bottom > 0 && r.bottom < 200) { headerBottom = r.bottom; break; }
  }

  return {
    contentLeft: found.protectedContentLeft,
    contentRight: found.selected ? found.selected.right : null,
    matchedProbe: found.selected ? found.selected.selector : null,
    headerBottom,
    viewportWidth,
    probeCandidates: found.candidates,
  };
}

/** 诊断用：把一次布局决策摊平成真人能直接读的数字。 */
export function explainLayout(m: LayoutInput, l: PanelLayout, rendered?: { left: number; right: number; width: number }) {
  // availableLeftGutter = protectedContentLeft - pageLeft - margin（面板与正文之间）
  //                        再减一个 margin（面板与视口左边之间）
  const gutter = m.contentLeft === null
    ? null
    : Math.max(0, Math.floor(m.contentLeft) - PAGE_LEFT - MARGIN * 2);
  return {
    viewportWidth: m.viewportWidth ?? null,
    protectedContentLeft: m.contentLeft,
    selectedProtectedProbe: m.matchedProbe ?? null,
    protectedContentRight: m.contentRight ?? null,
    pageLeft: PAGE_LEFT,
    layoutProbeCandidates: m.probeCandidates ?? [],
    availableLeftGutter: gutter,
    computedMode: l.mode,
    computedWidth: l.width,
    computedLeft: l.left,
    computedTop: l.top,
    renderedLeft: rendered?.left ?? null,
    renderedRight: rendered?.right ?? null,
    renderedWidth: rendered?.width ?? null,
    // 用**渲染出来的**右边界判，不是用算出来的。
    // dock 贴在视口边缘、不在阅读列左侧，所以左边界那条判据对它不适用 ——
    // 它单独用"渲染矩形和阅读列有没有相交"来判。
    overlaps: !rendered ? null
      : l.mode === 'dock'
        ? (m.contentLeft !== null && m.contentRight != null
            ? rendered.right > m.contentLeft && rendered.left < m.contentRight
            : null)
        : (m.contentLeft !== null ? rendered.right > m.contentLeft : null),
  };
}

/**
 * 版式是否变了（值不值得重排）。
 *
 * 拆成纯函数是为了能被测：真正的失效模式是"没有 resize 事件、版式却变了"
 * （右侧栏异步加载完、登录横幅出现、图片撑开布局），
 * 那种情况只能靠轮询重量，而轮询必须便宜——所以要先比较再决定重排。
 */
export function measurementChanged(prev: LayoutInput | null, next: LayoutInput): boolean {
  if (!prev) return true;
  if ((prev.contentLeft === null) !== (next.contentLeft === null)) return true;
  if (prev.contentLeft !== null && next.contentLeft !== null
      && Math.abs(prev.contentLeft - next.contentLeft) >= 1) return true;
  return Math.abs(prev.headerBottom - next.headerBottom) >= 1;
}

/**
 * 断言用：面板是否确实待在正文左侧。测试和运行时自检共用同一个判据。
 */
export function staysOutOfContent(
  layout: PanelLayout,
  contentLeft: number | null,
  /** 阅读列右边界与视口宽度。只有判 dock 需要，缺了就对 dock 不下结论。 */
  contentRight?: number | null,
  viewportWidth?: number,
): boolean {
  // dock 贴视口边缘，判据不是"在阅读列左边"，而是"和阅读列不相交"。
  if (layout.mode === 'dock') {
    if (contentLeft === null || contentRight == null || typeof viewportWidth !== 'number') {
      // 量不到阅读列 —— 这恰恰是 dock 存在的场景（搜索页、feed）。
      // 那里没有"正文列"这个概念，贴边的 40px 不构成遮挡，按安全处理。
      return true;
    }
    const left = layout.side === 'right' ? viewportWidth - MARGIN - layout.width : MARGIN;
    return left + layout.width <= Math.floor(contentLeft) || left >= Math.ceil(contentRight);
  }
  // 不知道正文在哪 → 任何**占位的**面板都不能算安全
  if (contentLeft === null) return false;
  return layout.left + layout.width <= Math.floor(contentLeft) - MARGIN;
}
