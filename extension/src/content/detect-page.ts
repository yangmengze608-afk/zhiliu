/** 页面类型识别。selector 全部集中在这一层，UI 不得直接触碰 DOM 结构。 */

export type PageType = 'answer' | 'article' | 'unknown';

export interface PageIdentity {
  type: PageType;
  contentId?: string;
  url: string;
}

/**
 * 知乎的可分析页面目前有三种形态：
 *  - 回答独立页  https://www.zhihu.com/answer/<id>
 *  - 问题页展开的回答 https://www.zhihu.com/question/<qid>/answer/<id>
 *  - 专栏文章   https://zhuanlan.zhihu.com/p/<id>
 * 其余（首页 feed、搜索页、个人页）一律 unknown，不计入统计。
 */
export function detectPage(href: string = location.href): PageIdentity {
  const url = stripTracking(href);

  // 结尾必须锚死。只写前缀会把 `/p/123/edit`（真实可达的专栏编辑器页）、
  // `/answer/123/comment` 之类都认成正文页 —— 那些页面的 DOM 完全不同，
  // 抽出来的东西也完全不是正文。允许的尾巴只有一个可选的 `/` 和查询串。
  const zhuanlan = url.match(/^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)\/?(?:\?|$)/);
  if (zhuanlan) return { type: 'article', contentId: zhuanlan[1], url };

  const answer = url.match(/^https:\/\/www\.zhihu\.com\/(?:question\/\d+\/)?answer\/(\d+)\/?(?:\?|$)/);
  if (answer) return { type: 'answer', contentId: answer[1], url };

  return { type: 'unknown', url };
}

/** 去掉 utm 等追踪参数，保证同一内容的 URL 稳定，去重才有意义。 */
export function stripTracking(href: string): string {
  try {
    const u = new URL(href);
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || k === 'source' || k === 'hash_id') u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString().replace(/\?$/, '');
  } catch {
    return href;
  }
}
