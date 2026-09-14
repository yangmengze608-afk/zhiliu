/**
 * 送进模型之前的正文清理与截断。
 *
 * 两条原则：
 * 1. **宁可少送，不要送脏的。** 评论、推荐位、作者简介、按钮文案混进正文，
 *    模型会认真地去概括它们，而用户看到的是一个跟自己读的东西无关的标签。
 * 2. **截断必须留下结构。** 直接 `slice(0, N)` 会砍掉结论段；
 *    知乎回答的典型结构是"抛问题 → 展开 → 收结论"，只留开头等于只留问题。
 */

/** 送进模型的正文上限（字符）。超过就按下面的策略采样，而不是从头截断。 */
export const MAX_MODEL_CHARS = 1800;

/** 明显属于交互控件而非正文的短文案。整段等于这些词时删掉。 */
const UI_NOISE = [
  '赞同', '感谢', '喜欢', '收藏', '分享', '举报', '关注', '已关注', '编辑于', '发布于',
  '展开阅读全文', '收起', '继续浏览内容', '知乎', '打开', '登录', '写回答', '邀请回答',
  '添加评论', '查看全部', '条评论', '默认排序', '切换为时间排序', '广告',
];

/**
 * 抽取正文前应当从**副本**里摘掉的容器。
 *
 * 注意是"摘掉再取文本"，不是"取完文本再用正则删"——
 * 后者永远追不上文案变化，而且会误伤正文里恰好提到这些词的句子。
 */
export const STRIP_SELECTORS = [
  // 评论容器：知乎在不同页面/不同改版下用过好几个名字，全列上。
  // 红队实测：漏掉 `.CommentList` 时，一条带 `.RichText` 的长评论会被当成正文
  // 并拿到 **high** 置信度直接入库。这个清单需要人在真实页面上核一遍。
  '.Comments-container', '.CommentsV2', '.Comments', '.CommentList', '.Comment',
  '.CommentsV2-container', '.CommentTopbar', '.CommentEditor',
  '.RichContent-actions', '.ContentItem-actions', '.AnswerItem-extraInfo',
  '.Recommendations-Main', '.Card.TopstoryItem', '.RelatedReadings',
  '.AuthorInfo', '.AuthorInfo-detail', '.UserLink',
  '.Sticky', '.AppHeader', '.Header', 'header', 'footer', 'nav', 'aside',
  '.Post-topicsAndReviewer', '.Post-Sub', '.Reward', '.Pc-card', '.Pc-word',
  'script', 'style', 'noscript', 'button',
];

/**
 * 块级标签。取文本时要在它们之后补一个换行，`sanitize` 的按行清洗才有东西可清。
 */
const BLOCK_TAGS = new Set([
  'DIV', 'P', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'BR', 'HR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR', 'FIGURE', 'FIGCAPTION', 'PRE',
]);

/**
 * 带块级换行的取文本。
 *
 * **不能直接用 `textContent`。** DOM 的 `textContent` 是纯拼接、不产生任何换行：
 * `<p>标题</p><p>12 人赞同了该回答</p><p>正文</p>` 会变成
 * `"标题12 人赞同了该回答正文"` —— 于是 `sanitize()` 里所有按行做的清洗
 * （UI 文案行、「N 人赞同」统计行、与标题重复的首行）在真实链路上**一条都不会触发**。
 *
 * 这个 bug 之所以能藏住，是因为测试直接喂的是手写的 `'标题\n12 人赞同了该回答\n正文'`
 * 字符串——测的是 `sanitize` 自己，而不是"从 DOM 到 sanitize"这一段。
 */
export function blockText(el: Element): string {
  let out = '';
  for (const node of el.childNodes as unknown as Iterable<Node>) {
    if (node.nodeType === 3) { out += node.nodeValue ?? ''; continue; }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    out += blockText(child);
    if (BLOCK_TAGS.has(child.tagName)) out += '\n';
  }
  return out;
}

/**
 * 摘掉噪声容器，返回**克隆体**。原 DOM 不受影响。
 *
 * 单独导出是因为结构兜底必须**先摘噪声再打分**。
 * 原来的顺序反了：`largestTextBlock` 用未清洗的 `textContent` 打分，
 * 于是"短回答 + 长评论"这种页面上，评论区永远赢——
 * 清单里明明有 `.Comments-container`，却在打完分之后才生效，等于摆设。
 */
export function stripNoise(el: Element): Element {
  const clone = el.cloneNode(true) as Element;
  for (const sel of STRIP_SELECTORS) {
    for (const n of [...clone.querySelectorAll(sel)]) n.remove();
  }
  return clone;
}

/** 从一个元素的**克隆体**上摘掉噪声容器后取文本。原 DOM 不受影响。 */
export function textWithoutNoise(el: Element): string {
  return blockText(stripNoise(el));
}

/**
 * 归一化：合并空白、去掉纯控件行、去掉与标题完全重复的首行。
 */
export function sanitize(raw: string, title = ''): string {
  const lines = raw
    .split(/\n+/)
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .filter((l) => !(l.length <= 12 && UI_NOISE.some((w) => l === w || l === w + '·')))
    // 「12 人赞同了该回答」这类统计行
    .filter((l) => !/^\d+\s*(人赞同|条评论|人喜欢)/.test(l));

  const t = title.trim();
  while (lines.length > 0 && t && lines[0] === t) lines.shift();

  return lines.join(' ').replace(/\s{2,}/g, ' ').trim();
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/**
 * 结构化截断：开头 50% + 中段 20% + 结尾 30%。
 *
 * 权重是按知乎回答的实际结构定的：问题意识在开头，结论在结尾，
 * 中段大量是例子和展开，对"这篇在讨论什么"贡献最小。
 * 三段之间插入省略标记，让模型知道自己看到的不是连续文本。
 */
export function truncateForModel(text: string, limit = MAX_MODEL_CHARS): TruncationResult {
  const originalChars = text.length;
  if (originalChars <= limit) return { text, truncated: false, originalChars };

  const head = Math.floor(limit * 0.5);
  const mid = Math.floor(limit * 0.2);
  const tail = limit - head - mid;
  const midStart = Math.floor((originalChars - mid) / 2);

  return {
    text:
      text.slice(0, head) +
      ' …（中间略）… ' +
      text.slice(midStart, midStart + mid) +
      ' …（中间略）… ' +
      text.slice(originalChars - tail),
    truncated: true,
    originalChars,
  };
}
