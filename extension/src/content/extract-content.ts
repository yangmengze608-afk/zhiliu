/**
 * 正文抽取。所有 selector 只出现在这里，DOM 一变只改这个文件。
 *
 * ## 顺序（第 -1 层是 2026-09-09 真人 Field Test 打出来的）
 *
 * -1. **页面类型不在白名单 → 直接 unsupported，连 DOM 都不扫**
 *  0. **按页面类型找对应的根容器** —— 找不到就放弃，不在整页里找 → `low`
 *  1. **语义化 selector** —— 在根容器内命中正文容器 → `high`
 *  2. **结构兜底** —— 在根容器内找"文本量大且密度高"的块 → `medium`
 *  3. **确认不了就承认确认不了** —— 空正文 + `low`
 *
 * ### 第 -1 层的由来：真人在 /column-square 上抓到的 bug
 *
 * `detectPage` 正确判成 `unknown`，但抽取**照样往下跑**：
 * 旧的 `ROOT_SELECTORS` 里有 `main`，于是命中 `main.App-main`（整页），
 * 再在里面找到第一张推荐卡片的 `.RichText.ztext` —— 结果是
 * **`strategy: semantic` / `confidence: high`**，抓到 1818 字的推荐位、广告、
 * 搜索框和论文列表，诊断面板信心十足地把它显示成正文。
 *
 * 当时**唯一**挡住它的是 `isAnalyzable()` 里那个 `type !== 'unknown'`：
 * 因为它，`/analyze` 没被调用、ReadEvent 没被写入。
 * 但那是**下游的一个布尔判断**在替上游兜底——删掉那半行、或者哪天
 * `detectPage` 多认了一种页面，污染立刻就是真的。
 *
 * 现在的规则：**支持的页面类型只有 `answer` 和 `article`。其余一律 fail closed。**
 *
 *   KNOWN CONTENT PAGE → 尝试语义抽取
 *   UNKNOWN PAGE       → 直接放弃，不猜大容器
 *
 * 并且删掉了 `main`：它在任何页面上都能命中，等于把整页当根容器，
 * 是这次事故的直接原因。根容器现在**按页面类型分开**，
 * 回答页的根不可能匹配到文章页的容器，反之亦然。
 *
 * **任何情况下都不会把整页文本、`main.App-main` 或 `document.body` 当正文。**
 */
import { detectPage } from './detect-page.ts';
import { CONFIG } from '../shared/config.ts';
import { blockText, sanitize, stripNoise, textWithoutNoise, truncateForModel } from './sanitize.ts';

/** 抽取可信度。`low` 一律不进长期历史。 */
export type ExtractionConfidence = 'high' | 'medium' | 'low';

export interface ExtractedContent {
  url: string;
  contentId?: string;
  type: 'answer' | 'article' | 'unknown';
  title: string;
  text: string;
  confidence: ExtractionConfidence;
  /** 实际命中的 selector，诊断模式直接显示 */
  selectorMatched: string;
  /**
   * `semantic` 语义化 selector / `structural` 结构兜底 /
   * `none` 支持的页面但抓不到正文 / `unsupported` 页面类型不在白名单（根本没扫）
   */
  strategy: 'semantic' | 'structural' | 'none' | 'unsupported';
  truncated: boolean;
  /** 清理后、截断前的字数 */
  originalChars: number;
}

/** 按优先级排列的候选 selector；知乎 DOM 变动时在这里加，不要改调用方。 */
const TITLE_SELECTORS = [
  'h1.QuestionHeader-title',
  'h1.Post-Title',
  'article h1',
  '.ContentItem-title',
  'h1',
];

/**
 * 正式支持的页面类型。**改这个数组等于改产品的支持范围**，
 * 必须同步更新 `docs/REAL_PAGE_TEST.md`，并且要有真人验证证据。
 */
export const SUPPORTED_TYPES = ['answer', 'article'] as const;

/**
 * 正文搜索的**根**，按页面类型分开。
 *
 * 分开而不是合并成一个列表，是为了让"回答页的根匹配到文章页容器"这件事
 * 在结构上不可能发生。列表里的类名全部来自 2026-09-09 的真人 Field Test：
 *
 *   回答页  div.QuestionAnswer-content → .RichContent-inner → .RichText
 *   文章页  div.Post-content           → .Post-RichTextContainer → .RichText
 *
 * **注意这里没有 `main`。** 它在任何知乎页面上都能命中，等于把整页当根容器，
 * 正是 /column-square 事故的直接原因。
 */
const ROOT_SELECTORS: Record<'answer' | 'article', string[]> = {
  // 真人验证过的只有 `.QuestionAnswer-content`。`.AnswerCard` 是未验证的保守候补。
  // **`.AnswerItem` 已删除**：它是信息流**卡片**的类名，合法的 answer URL 配上
  // 一屏信息流 DOM 就会抓到第一张卡片，还是 semantic / high。
  answer: ['.QuestionAnswer-content', '.AnswerCard'],
  // 真人验证：div.Post-content。后两个未验证。
  article: ['.Post-content', '.Post-Main', 'article'],
};

const BODY_SELECTORS = [
  '.Post-RichTextContainer .RichText',   // 真人验证：文章页
  '.RichContent-inner .RichText',        // 真人验证：回答页
  '.RichText.ztext',
  '.RichText',
];

/**
 * `href` 显式传入而不是每次读 `location`：一来测试可以构造任意页面形态，
 * 二来 SPA 里"当前 URL"和"当前 DOM"可能有一瞬不同步，调用方能自己决定用哪个。
 */
export function extractContent(doc: Document = document, href?: string): ExtractedContent {
  const id = href === undefined ? detectPage() : detectPage(href);
  const title = firstText(doc, TITLE_SELECTORS) || doc.title.replace(/\s*-\s*知乎\s*$/, '');
  const base: Omit<ExtractedContent, 'text' | 'confidence' | 'selectorMatched' | 'strategy' | 'truncated' | 'originalChars'> = {
    url: id.url, contentId: id.contentId, type: id.type, title,
  };
  const giveUp = (why: string, strategy: 'unsupported' | 'none'): ExtractedContent => ({
    ...base, text: '', truncated: false, originalChars: 0,
    confidence: 'low', strategy, selectorMatched: why,
  });

  // ── 第 -1 层：页面类型不在白名单 → fail closed，**连 DOM 都不扫**。
  // 不是"扫完再判断要不要用"，是根本不扫：只要还去扫，诊断面板就会显示出
  // 一段看起来很像正文的东西，而那正是 /column-square 那次事故的样子。
  if (!(SUPPORTED_TYPES as readonly string[]).includes(id.type)) {
    return giveUp(`不支持的页面类型：${id.type}（只支持 ${SUPPORTED_TYPES.join(' / ')}）`, 'unsupported');
  }
  const kind = id.type as 'answer' | 'article';
  const roots = ROOT_SELECTORS[kind];

  // ── 第 0 层：没有根容器就不猜。**绝不 `?? doc.body`，也绝不退到 `main`。**
  //    多个候选根时先按包含关系分组：嵌套的算同一条 chain，只有互不包含
  //    才是"多个内容实体"，那时才需要 contentId 归属，归属不了才放弃。
  const picked = pickRoots(doc, roots, id.contentId, id.relatedIds);
  if (picked.chain.length === 0) return giveUp(`${kind} 页${picked.why}`, 'none');

  // ── 第一层：语义化 selector。
  //    沿 root chain **从最具体往外**试：最内层通常就是正文容器，
  //    但如果它恰好不含正文（比如 `.Post-Main` 只包了侧边操作栏），
  //    再往外一层仍然是**同一篇文章**，可以安全地退。
  for (const cand of picked.chain) {
    for (const sel of BODY_SELECTORS) {
      const el = cand.el.querySelector(sel);
      if (!el) continue;
      const text = sanitize(textWithoutNoise(el), title);
      if (text.length < CONFIG.MIN_TEXT_CHARS) continue;
      const cut = truncateForModel(text);
      return { ...base, text: cut.text, truncated: cut.truncated, originalChars: cut.originalChars,
               confidence: 'high', strategy: 'semantic',
               selectorMatched: `${describe(cand.el)} ${sel}` };
    }
  }

  // ── 第二层：结构兜底，**只在最具体的那个根之内**。
  //    不沿 chain 往外退：越往外混进导航/推荐的风险越大，
  //    而兜底本来就是"selector 全落空"的降级路径，不该同时放宽两个维度。
  const inner = picked.chain[0];
  const block = largestTextBlock(inner.el, title);
  if (block && block.length >= CONFIG.MIN_TEXT_CHARS) {
    const cut = truncateForModel(block);
    return { ...base, text: cut.text, truncated: cut.truncated, originalChars: cut.originalChars,
             confidence: 'medium', strategy: 'structural',
             selectorMatched: `${describe(inner.el)} → 最大文本块` };
  }

  // ── 第三层：承认失败。空正文 + low，调用方不会上报。
  return { ...base, text: '', truncated: false, originalChars: 0,
           confidence: 'low', strategy: 'none',
           selectorMatched: `${picked.why} → 未找到正文` };
}

/**
 * 定位**我们真正抽取的那个正文元素**（不取文本，只返回元素）。
 *
 * 布局层要用它：`Dashboard 绝不能侵入的主阅读列` 应该被定义成
 * "包着我们正在记录的这篇正文的那一列"，而不是靠一串写死的 class 名去猜。
 * 这样布局和抽取盯的是同一篇内容，不会各说各话。
 *
 * 走的是和 `extractContent` 完全相同的门：页面类型白名单 → root chain → 正文 selector。
 * 不支持的页面返回 null（调用方据此 fail safe）。
 */
export function locateContentElement(doc: Document = document, href?: string): Element | null {
  const id = href === undefined ? detectPage() : detectPage(href);
  if (!(SUPPORTED_TYPES as readonly string[]).includes(id.type)) return null;
  const kind = id.type as 'answer' | 'article';
  const picked = pickRoots(doc, ROOT_SELECTORS[kind], id.contentId, id.relatedIds);
  for (const cand of picked.chain) {
    for (const sel of BODY_SELECTORS) {
      const el = cand.el.querySelector(sel);
      if (el && (el.textContent ?? '').trim().length >= CONFIG.MIN_TEXT_CHARS) return el;
    }
  }
  return null;
}

/**
 * 兜底抽取：在给定根容器内找出文本量最大且文本密度足够高的元素。
 *
 * 密度过滤（文本长度 / 子元素数）用来排除掉"包含正文的大容器"——
 * 比如整个 `<main>`，它文本最长，但混进了侧栏、推荐位和评论。
 * 注意这里传进来的 root 已经被 ROOT_SELECTORS 收缩过一次了。
 */
export function largestTextBlock(root: Element, title = ''): string {
  // **先摘噪声再打分。** 顺序反了的话，清单里的 .Comments-container 等于摆设：
  // 打分用的是未清洗的 textContent，"短回答 + 长评论"这种页面上评论永远赢，
  // 然后才在赢家身上做清洗——赢的已经是评论了。
  const clean = stripNoise(root);
  let best: Element | null = null;
  let bestScore = 0;
  // 把 clean 自己也算成候选：querySelectorAll 不会匹配根元素本身，
  // 而"正文直接挂在根容器上、没有额外包一层 div"完全可能。
  const candidates: Element[] = [clean, ...clean.querySelectorAll('div, section, article, p')];
  for (const el of candidates) {
    const text = (el.textContent ?? '').trim();
    if (text.length < 200) continue;
    const childElements = el.getElementsByTagName('*').length;
    const density = text.length / Math.max(1, childElements);
    if (density < 12) continue; // 容器型节点，跳过
    const score = text.length * Math.min(density / 40, 1);
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best ? sanitize(blockText(best), title) : '';
}

/**
 * 抽取是否达到可分析标准。
 *
 * 这里的三条现在是**纵深防御**，不再是唯一防线：真正的 fail closed 已经
 * 提前到 `extractContent` 的第 -1 层。保留它们是因为
 * /column-square 那次事故里，挡住污染的恰好就是这里的 `type !== 'unknown'`——
 * 一个下游布尔值替上游兜了底。上游修好了，这道网也不拆。
 */
export function isAnalyzable(c: ExtractedContent): boolean {
  return (SUPPORTED_TYPES as readonly string[]).includes(c.type)
    && c.strategy !== 'unsupported'
    && c.confidence !== 'low'
    && c.text.length >= CONFIG.MIN_TEXT_CHARS;
}

function firstText(doc: Document, selectors: string[]): string {
  for (const s of selectors) {
    const t = doc.querySelector(s)?.textContent?.trim();
    if (t) return t;
  }
  return '';
}

function firstElement(doc: Document, selectors: string[]): Element | null {
  for (const s of selectors) {
    const el = doc.querySelector(s);
    if (el) return el;
  }
  return null;
}

/**
 * 选出"属于当前 URL 这篇内容"的根容器**链**。
 *
 * ## 为什么不能直接 querySelector
 *
 * 页面类型来自 **URL**，根容器来自 **querySelector**（永远返回文档序第一个），
 * 两者之间原本没有任何一致性校验。红队复现的场景很现实：
 * 在同一个问题页里从回答 456 切到回答 999（SPA，不刷新），
 * URL 变成 `answer/999`、DOM 里 456 的容器还在最前面 →
 * **用 999 的 id 记下了 456 的正文**，而且 `semantic / high / analyzable=true`。
 *
 * ## 为什么"有两个候选就放弃"是错的
 *
 * 2026-09-10 的真人复验打出了一个 false negative：**正常的专栏文章页**
 * 也会出现两个候选，因为 `<article>` 包着 `.Post-content`（或 `.Post-content`
 * 里还有 `.Post-Main`）。它们是**同一篇文章的祖先/后代**，不是两篇互相冲突的内容。
 * 旧逻辑一律 fail closed，于是此前真人验证 PASS 的同一类页面变成了 0 字。
 *
 * 现在的规则分两步：
 *
 * 1. **按包含关系分组。** 互为祖先/后代的候选属于**同一条 root chain**
 *    （同一篇内容的不同层），组内按"越深越具体"排序，深的优先。
 *    DOM 是树，所以两个都包含同一节点的候选必然互相可比 —— 贪心分组就够了。
 * 2. **只有分出多个互不包含的组时，才是真的有多个内容实体。**
 *    这时才用 contentId 归属；归属不了才 fail closed。
 *
 * 归属判据是"候选或其祖先的**任一属性值**里出现过这个 id"，
 * **不假设任何具体属性名**——我没有真实知乎的属性清单，编一个就是瞎猜。
 */
export interface RootCandidate {
  el: Element;
  sel: string;
  /** 到 document 根的祖先数。越大越具体。 */
  depth: number;
}

export interface RootPick {
  /** 候选链，**最具体的在前**。空数组表示放弃。 */
  chain: RootCandidate[];
  why: string;
}

export function pickRoots(
  doc: Document,
  selectors: string[],
  contentId: string | undefined,
  /** 本次 URL 自带的、属于别的实体的 id（目前只有问题 id）。见 foreignIdNear。 */
  relatedIds: readonly string[] = [],
): RootPick {
  const seen = new Set<Element>();
  const candidates: RootCandidate[] = [];
  for (const sel of selectors) {
    for (const el of doc.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      candidates.push({ el, sel, depth: depthOf(el) });
    }
  }
  if (candidates.length === 0) {
    return { chain: [], why: `未命中任何根容器（${selectors.join(' / ')}）` };
  }

  const groups = groupByContainment(candidates);
  const order = (g: RootCandidate[]) => [...g].sort((a, b) => b.depth - a.depth);

  if (groups.length === 1) {
    const chain = order(groups[0]);
    // **只有一组也要核对归属。**
    // 红队 PoC：SPA 在同一问题页换回答，URL 已经是 `answer/999`，
    // 但 DOM 里只剩 456 的容器还没换 —— 只有一个候选，旧逻辑直接采信，
    // 于是用 999 的 id 记下了 456 的正文，而且 semantic / high / analyzable。
    // 判据仍然只在"容器确实带得上 id 线索"时才生效：
    // 页面上完全不出现这个 id 时不做判断（很多页面的 id 不在属性里），
    // 但**只要出现了、却指向别的 id**，就说明我们看的不是这一篇。
    if (contentId && !mentionsId(chain[0].el, contentId)) {
      const foreign = foreignIdNear(chain[0].el, contentId, relatedIds);
      if (foreign) {
        return {
          chain: [],
          why: `唯一的根容器带的是 id ${foreign}，不是 ${contentId}——` +
               'SPA 换内容时 DOM 可能还没更新，拒绝把别人的正文记成这一篇',
        };
      }
    }
    return {
      chain,
      why: chain.length === 1
        ? chain[0].sel
        : `${chain.map((c) => c.sel).join(' ⊂ ')}（同一条 root chain，取最具体的 ${chain[0].sel}）`,
    };
  }

  // 到这里才是真的有多个互不包含的内容实体
  if (contentId) {
    const matched = groups.filter((g) => g.some((c) => mentionsId(c.el, contentId)));
    if (matched.length === 1) {
      const chain = order(matched[0]);
      return { chain, why: `${chain[0].sel}[属性含 ${contentId}]` };
    }
    if (matched.length > 1) {
      return { chain: [], why: `有 ${matched.length} 个互不包含的根容器都声称是 ${contentId}，无法确认` };
    }
  }
  return {
    chain: [],
    why: `有 ${groups.length} 个互不包含的候选根容器（${groups.map((g) => order(g)[0].sel).join(' / ')}），` +
         `没有一个能归属到 ${contentId ?? '(URL 未提供 id)'}——拒绝猜，否则可能把别的内容记成这一篇`,
  };
}

/**
 * 诊断用：把每个候选根摊开，供真人 field test 直接读。
 * 回答"到底有几个候选、它们什么关系、哪个被选中、为什么"。
 */
export function describeCandidates(
  doc: Document,
  kind: 'answer' | 'article',
  contentId: string | undefined,
  relatedIds: readonly string[] = [],
): Array<Record<string, unknown>> {
  const picked = pickRoots(doc, ROOT_SELECTORS[kind], contentId, relatedIds);
  const chosen = new Set(picked.chain.map((c) => c.el));
  const all: RootCandidate[] = [];
  const seen = new Set<Element>();
  for (const sel of ROOT_SELECTORS[kind]) {
    for (const el of doc.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      all.push({ el, sel, depth: depthOf(el) });
    }
  }
  return all.map((c) => {
    const others = all.filter((o) => o !== c);
    const bodyHit = BODY_SELECTORS.find((b) => c.el.querySelector(b));
    return {
      selector: c.sel,
      tag: describe(c.el),
      depth: c.depth,
      isAncestorOf: others.filter((o) => nodeContains(c.el, o.el)).map((o) => o.sel),
      isDescendantOf: others.filter((o) => nodeContains(o.el, c.el)).map((o) => o.sel),
      contentIdEvidence: contentId ? (mentionsId(c.el, contentId) ? `属性含 ${contentId}` : '无') : '(URL 未提供 id)',
      bodySelector: bodyHit ?? '(该根内未命中任何正文 selector)',
      bodyTextLength: bodyHit ? (c.el.querySelector(bodyHit)?.textContent ?? '').trim().length : 0,
      chosen: chosen.has(c.el),
      chosenRank: picked.chain.findIndex((x) => x.el === c.el),
    };
  });
}

function depthOf(el: Element): number {
  let d = 0;
  for (let cur = el.parentElement; cur; cur = cur.parentElement) d++;
  return d;
}

/**
 * 按包含关系分组。互为祖先/后代的归为一组。
 *
 * DOM 是树：如果两个候选都包含同一个第三候选，它们必然在同一条根路径上、
 * 因而互相可比。所以贪心（找到第一个有关系的组就加进去）不会漏合并。
 */
function groupByContainment(cands: RootCandidate[]): RootCandidate[][] {
  const groups: RootCandidate[][] = [];
  for (const c of cands) {
    const hit = groups.find((g) => g.some((o) => nodeContains(o.el, c.el) || nodeContains(c.el, o.el)));
    if (hit) hit.push(c); else groups.push([c]);
  }
  return groups;
}

/** `Node.contains` 语义（包含自身）。测试用的 DOM shim 实现了同一语义。 */
function nodeContains(a: Element, b: Element): boolean {
  if (a === b) return true;
  const fn = (a as unknown as { contains?: (n: Element) => boolean }).contains;
  if (typeof fn === 'function') return fn.call(a, b);
  for (let cur: Element | null = b.parentElement; cur; cur = cur.parentElement) if (cur === a) return true;
  return false;
}

/**
 * 这个根容器（或其祖先）的属性里到底带不带**某个**内容 id。
 *
 * 用来区分两种情况：
 *  - 属性里根本没有 id 形状的东西 → 没法核对，只能采信（很多页面形态如此）；
 *  - 属性里**有别人的** id → 说明我们看的不是这一篇，必须拒绝。
 *
 * **不假设任何具体属性名**（没有真实知乎的属性清单）。只看属性值里有没有
 * 连续 6 位以上的数字——知乎的 answer/article id 都是这个形状。
 *
 * ## 必须排除掉"本次 URL 自带的 id"（U-14 真人 blocker）
 *
 * `/question/<qid>/answer/<aid>` 这种页面，祖先上几乎一定挂着**问题 id**。
 * 那是同一条 URL 自带的、完全预期之内的东西 —— 它不说明"我们看的是别的回答"。
 * 第一版没排除它，于是：找到一个 id（问题 id）、它又不等于 answerId
 * → 判定张冠李戴 → **整页抽不出任何东西**。真人验收就卡在这里。
 *
 * 排除它**不降低**校验强度：真正来自另一个回答的 id 仍然会被抓住，
 * 因为那个 id 既不是 target 也不在 benign 里。
 *
 * 返回找到的第一个"外来 id"，让诊断能直接打出来是谁 ——
 * 上一轮的教训是：只说"不匹配"而不说"不匹配什么"，会让人查两轮。
 */
function foreignIdNear(el: Element, target: string, benign: readonly string[]): string | null {
  const known = new Set<string>([target, ...benign]);
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const attrs = cur.attributes;
    if (!attrs) continue;
    for (const a of Array.from(attrs) as Array<{ name?: string; value?: string }>) {
      if (a?.name === 'class') continue; // class 里的数字不是内容 id
      if (typeof a?.value !== 'string') continue;
      for (const m of a.value.match(/\d{6,}/g) ?? []) {
        if (!known.has(m)) return m;
      }
    }
  }
  return null;
}

/**
 * 元素**自身、祖先或子孙**的任一属性值里是否出现过这个 id。不依赖具体属性名。
 *
 * 子孙也要看：知乎常把 answerId 挂在根容器里面的某个子节点上
 * （`ContentItem-meta` 之类），只往上找会漏掉 —— 漏掉的后果不是少抽一篇，
 * 是整页判成张冠李戴然后全面停摆。
 */
function mentionsId(el: Element, id: string): boolean {
  const hit = (e: Element): boolean => {
    const attrs = e.attributes;
    if (!attrs) return false;
    for (const a of Array.from(attrs) as Array<{ value?: string }>) {
      if (typeof a?.value === 'string' && a.value.includes(id)) return true;
    }
    return false;
  };
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (hit(cur)) return true;
  }
  // 子孙：用 querySelectorAll('*') 一把捞，DOM 里根容器的子树不大
  for (const d of Array.from(el.querySelectorAll?.('*') ?? [])) {
    if (hit(d as Element)) return true;
  }
  return false;
}

function describe(el: Element | null): string {
  if (!el) return '';
  const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0];
  return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
}
