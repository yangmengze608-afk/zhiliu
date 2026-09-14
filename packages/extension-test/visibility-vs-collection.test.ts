/**
 * 「面板显不显示」与「这一页能不能采集」必须是两件独立的事。
 *
 * 2026-09-14 之前它们被绑在一起：不可采集的页面直接把面板藏掉。
 * 真人测试的反馈是 —— 在 `/question/<qid>`、`/search` 上面板消失，
 * **用户以为扩展没启动**。用"看不见"去表达"这页不记录"，读出来就是"坏了"。
 *
 * 拆开之后两条线各自的判据：
 *   可见性  ← 布局量测（有没有安全位置放）。放不下就退成贴边 dock，**不再整块消失**。
 *   采集    ← `detectPage` 的路由判定（这一页的内容能不能唯一归因）。
 *
 * 这份测试盯住的是：**采集范围一个字没放宽**。
 * 面板到处都在，但只有独立回答页和专栏文章会计时、抽正文、调模型、写历史。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectPage } from '../../extension/src/content/detect-page.ts';
import { computeLayout } from '../../extension/src/content/layout.ts';

/** 采集资格的唯一判据 —— 与 main.ts 的 `collecting` 同源。 */
const collectible = (href: string) => detectPage(href).type !== 'unknown';

/** 面板可见性的唯一判据：任何布局结果都不是"消失"。 */
const visible = (contentLeft: number | null) =>
  computeLayout({ contentLeft, headerBottom: 56 }).mode !== undefined;

const ANSWER = 'https://www.zhihu.com/question/2017971286807180358/answer/2048382266775287748';
const SOLO_ANSWER = 'https://www.zhihu.com/answer/2048382266775287748';
const ARTICLE = 'https://zhuanlan.zhihu.com/p/1234567890123456789';
const QUESTION = 'https://www.zhihu.com/question/2017971286807180358';
const SEARCH = 'https://www.zhihu.com/search?q=%E7%A8%B3%E5%AE%9A&type=content';
const FEED = 'https://www.zhihu.com/';
const HOT = 'https://www.zhihu.com/hot';
const PEOPLE = 'https://www.zhihu.com/people/someone';

describe('采集资格：范围没有放宽', () => {
  for (const [name, url] of [
    ['问题页里的回答', ANSWER],
    ['独立回答页', SOLO_ANSWER],
    ['专栏文章', ARTICLE],
  ] as const) {
    test(`${name} → 采集`, () => assert.equal(collectible(url), true, url));
  }

  for (const [name, url] of [
    ['纯问题页', QUESTION],
    ['搜索页', SEARCH],
    ['首页 feed', FEED],
    ['热榜', HOT],
    ['个人页', PEOPLE],
  ] as const) {
    test(`${name} → **不**采集（不计时、不抽正文、不调模型、不写历史）`, () => {
      assert.equal(collectible(url), false, `${url} 被纳入采集了 —— 本轮明确不扩大范围`);
    });
  }
});

describe('面板可见性：任何知乎页面上都不会整块消失', () => {
  const situations: Array<[string, number | null]> = [
    ['宽 gutter（回答页 @1450）', 209],
    ['窄 gutter（放得下胶囊）', 128],
    ['极窄 gutter（连胶囊都放不下）', 60],
    ['正文顶到左边缘', 0],
    ['**根本量不出阅读列**（搜索页 / feed / 问题页）', null],
  ];
  for (const [name, contentLeft] of situations) {
    test(`${name} → 仍然可见`, () => {
      const l = computeLayout({ contentLeft, headerBottom: 56 });
      assert.ok(visible(contentLeft));
      assert.ok(['full', 'compact', 'dock'].includes(l.mode), `意外的模式 ${l.mode}`);
      assert.ok(l.width > 0, '宽度为 0 等于看不见 —— 那就是这一轮要消灭的那个状态');
    });
  }

  test('量不出阅读列时退成 dock，而不是消失', () => {
    const l = computeLayout({ contentLeft: null, headerBottom: 56 });
    assert.equal(l.mode, 'dock');
    assert.equal(l.side, 'right');
  });
});

describe('两条线确实是独立的', () => {
  test('不可采集的页面照样有面板（这正是修的那件事）', () => {
    for (const url of [QUESTION, SEARCH, FEED, HOT]) {
      assert.equal(collectible(url), false, url);
      // 这些页面量不出阅读列 → dock
      const l = computeLayout({ contentLeft: null, headerBottom: 56 });
      assert.equal(l.mode, 'dock', `${url} 上面板消失了`);
    }
  });

  test('可采集的页面如果放不下，也只退到 dock，不因此停止采集', () => {
    assert.equal(collectible(ANSWER), true);
    // 同一篇回答，窗口很窄 → 面板退成 dock，但采集资格不受影响
    const l = computeLayout({ contentLeft: 30, headerBottom: 56 });
    assert.equal(l.mode, 'dock');
    assert.equal(collectible(ANSWER), true, '布局放不下不该影响采集');
  });
});

describe('非知乎域名', () => {
  test('detectPage 一律 unknown（且 manifest 本来就不注入）', () => {
    for (const url of [
      'https://example.com/question/1/answer/2',
      'https://zhihu.com.evil.com/answer/123',
      'https://www.zhihu.com.evil.com/answer/123',
    ]) {
      assert.equal(detectPage(url).type, 'unknown', url);
    }
  });
});
