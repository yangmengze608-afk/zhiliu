/**
 * 最小 DOM 实现，够用来测正文抽取，不引入 jsdom（本仓库零第三方依赖）。
 *
 * 支持的选择器语法刚好覆盖 `extract-content.ts` / `sanitize.ts` 里用到的：
 *   `div`、`.RichText`、`h1.Post-Title`、`.RichText.ztext`、
 *   `.Post-content .RichText`（后代）、`div, section, p`（并列）。
 * 不支持别的——写超出的选择器会安静地匹配不到，这是**刻意**的：
 * 与其让 shim 悄悄支持一个真实实现里没验证过的语法，不如让测试失败。
 */

export class El {
  tagName: string;
  classes: string[];
  children: El[] = [];
  parent: El | null = null;
  ownText: string;

  /** 除 class 之外的属性。真实 DOM 里回答容器会把 itemId 之类塞在属性里。 */
  attrs: Record<string, string> = {};

  constructor(tag: string, cls = '', text = '', attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    this.classes = cls.split(/\s+/).filter(Boolean);
    this.ownText = text;
    this.attrs = { ...attrs };
  }

  get parentElement(): El | null { return this.parent; }

  /** 与真实 DOM 的 Node.contains 一致：包含自身。 */
  contains(other: El | null): boolean {
    for (let cur: El | null = other; cur; cur = cur.parent) if (cur === this) return true;
    return false;
  }

  get attributes(): Array<{ name: string; value: string }> {
    return [
      ...(this.classes.length ? [{ name: 'class', value: this.classes.join(' ') }] : []),
      ...Object.entries(this.attrs).map(([name, value]) => ({ name, value })),
    ];
  }

  append(...kids: El[]): this {
    for (const k of kids) { k.parent = this; this.children.push(k); }
    return this;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  /** 真实 DOM 的 childNodes 里既有元素也有文本节点。这里只造元素节点，
   *  外加一个"整个 ownText 当作一个文本节点"的近似，够 blockText 用。 */
  get childNodes(): Array<{ nodeType: number; nodeValue?: string } | El> {
    const out: Array<{ nodeType: number; nodeValue?: string } | El> = [];
    if (this.ownText) out.push({ nodeType: 3, nodeValue: this.ownText });
    out.push(...this.children);
    return out;
  }

  readonly nodeType = 1;

  getAttribute(name: string): string | null {
    if (name === 'class') return this.classes.join(' ');
    return this.attrs[name] ?? null;
  }

  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  cloneNode(_deep: boolean): El {
    const c = new El(this.tagName, this.classes.join(' '), this.ownText, this.attrs);
    c.append(...this.children.map((k) => k.cloneNode(true)));
    return c;
  }

  /** 前序遍历，保证结果是文档序 */
  private walk(out: El[] = []): El[] {
    for (const c of this.children) { out.push(c); c.walk(out); }
    return out;
  }

  getElementsByTagName(_t: string): { length: number } {
    return { length: this.walk().length };
  }

  querySelectorAll(sel: string): El[] {
    const groups = sel.split(',').map((s) => s.trim()).filter(Boolean);
    const all = this.walk();
    const hit = new Set<El>();
    for (const g of groups) {
      const parts = g.split(/\s+/);
      for (const el of all) if (matchesChain(el, parts, this)) hit.add(el);
    }
    return all.filter((e) => hit.has(e)); // 保持文档序
  }

  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

/** 单个复合选择器：`div` / `.cls` / `h1.cls` / `.a.b` */
function matchesCompound(el: El, part: string): boolean {
  const m = part.match(/^([a-zA-Z0-9]*)((?:\.[\w-]+)*)$/);
  if (!m) return false;
  const [, tag, clsPart] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const c of clsPart.split('.').filter(Boolean)) {
    if (!el.classes.includes(c)) return false;
  }
  return true;
}

/** 后代链：最后一段匹配 el，前面的依次在祖先里按顺序出现 */
function matchesChain(el: El, parts: string[], root: El): boolean {
  if (!matchesCompound(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  let cur = el.parent;
  while (i >= 0 && cur && cur !== root.parent) {
    if (matchesCompound(cur, parts[i])) i--;
    cur = cur.parent;
  }
  return i < 0;
}

/** 造一个够用的 Document。`title` 是 `document.title`。 */
export function makeDocument(body: El, title = ''): Document {
  return {
    title,
    body: body as unknown as HTMLElement,
    querySelector: (s: string) => body.querySelector(s),
    querySelectorAll: (s: string) => body.querySelectorAll(s),
  } as unknown as Document;
}

/** 一段正文，`n` 段每段 `chars` 字。 */
export function paragraphs(n: number, chars: number, seed = '这是一篇真正的回答正文。'): El[] {
  return Array.from({ length: n }, (_, i) =>
    new El('p', '', (seed + i).repeat(Math.ceil(chars / seed.length)).slice(0, chars)));
}
