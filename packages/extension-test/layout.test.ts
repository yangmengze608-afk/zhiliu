/**
 * 面板布局回归测试。
 *
 * 唯一要钉死的性质：**面板右边界 < 正文左边界 - margin**。
 * 2026-09-09 的真人 Field Test 里，面板压住了正文——因为 left/top/width 全是写死的，
 * 而 gutter 有多宽从来没被量过。所以这里**不断言任何具体的 left/top 数值**，
 * 只断言那条约束在各种视口下都成立。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLayout, measure, staysOutOfContent, measurementChanged,
  MARGIN, FULL_WIDTH, MIN_FULL_WIDTH, COMPACT_WIDTH, MIN_TOP, DOCK_WIDTH,
} from '../../extension/src/content/layout.ts';
import { El, makeDocument } from './dom-shim.ts';
import { CONTENT_PROBES } from '../../extension/src/content/layout.ts';
import type { RectLike } from '../../extension/src/content/layout.ts';

describe('不变量：面板永远不进入正文主列', () => {
  test('从 0 到 1600px 逐像素扫描 contentLeft，没有一个值会让面板压到正文', () => {
    const bad: number[] = [];
    for (let contentLeft = 0; contentLeft <= 1600; contentLeft++) {
      const l = computeLayout({ contentLeft, headerBottom: 56 });
      if (!staysOutOfContent(l, contentLeft)) bad.push(contentLeft);
    }
    assert.deepEqual(bad, [], `这些 contentLeft 下面板会压到正文：${bad.slice(0, 20).join(', ')}`);
  });

  test('1440 桌面：知乎的左侧 gutter 实测只有 198px —— 面板必须收进去而不是 224', () => {
    // 真实浏览器里按知乎版式量到的值：正文列 690+48 内边距，右侧栏 296，居中
    const contentLeft = 198;
    const l = computeLayout({ contentLeft, headerBottom: 52 });
    assert.equal(l.mode, 'full', '最常见的桌面宽度不该掉进胶囊态');
    assert.equal(l.width, 174);
    assert.ok(staysOutOfContent(l, contentLeft));
  });

  test('典型宽屏：完整面板，且右边界离正文还有余量', () => {
    const contentLeft = 500; // 1440 视口下知乎正文大致的左边界量级
    const l = computeLayout({ contentLeft, headerBottom: 56 });
    assert.equal(l.mode, 'full');
    assert.equal(l.width, FULL_WIDTH);
    assert.ok(l.left + l.width < contentLeft - MARGIN);
  });
});

describe('gutter 不够时自动收拢，而不是压上去', () => {
  test(`gutter 刚好放不下完整面板（${MIN_FULL_WIDTH}px）时收成胶囊`, () => {
    const contentLeft = MIN_FULL_WIDTH + MARGIN * 2 - 1;
    const l = computeLayout({ contentLeft, headerBottom: 56 });
    assert.equal(l.mode, 'compact');
    assert.ok(staysOutOfContent(l, contentLeft));
  });

  test(`gutter 刚好够完整面板时就展开（${MIN_FULL_WIDTH}px 边界）`, () => {
    const contentLeft = MIN_FULL_WIDTH + MARGIN * 2;
    assert.equal(computeLayout({ contentLeft, headerBottom: 56 }).mode, 'full');
  });

  test('gutter 连胶囊都放不下 → dock（贴边），绝不压正文', () => {
    const contentLeft = COMPACT_WIDTH + MARGIN * 2 - 1;
    const vw = 1440;
    const contentRight = 1100;
    const l = computeLayout({ contentLeft, headerBottom: 56, contentRight, viewportWidth: vw });
    assert.equal(l.mode, 'dock');
    // dock 有宽度（它是看得见的一条），但贴在视口边缘 ——
    // 这正是这一轮改的：兜底不再是"整块消失"，而是"退到边上待着"。
    assert.equal(l.width, DOCK_WIDTH);
    assert.equal(l.side, 'right', '右侧空白 340px 比左侧 127px 宽，应该贴右边');
    assert.ok(staysOutOfContent(l, contentLeft, contentRight, vw), 'dock 压到正文了');
  });

  test('dock 贴空白更宽的那一侧', () => {
    const wideLeft = computeLayout({
      contentLeft: 400, headerBottom: 56, contentRight: 1400, viewportWidth: 1440,
    });
    assert.equal(wideLeft.mode, 'full', '左边 400px 放得下完整面板，轮不到 dock');

    // 左边窄到放不下胶囊、右边也窄 —— 比谁更宽
    const l = computeLayout({ contentLeft: 100, headerBottom: 56, contentRight: 1400, viewportWidth: 1440 });
    assert.equal(l.mode, 'dock');
    assert.equal(l.side, 'left', '左侧 100px > 右侧 40px，应该贴左边');
  });

  test('量不出阅读列时 dock 默认贴右，且按安全处理', () => {
    const l = computeLayout({ contentLeft: null, headerBottom: 56 });
    assert.equal(l.mode, 'dock');
    assert.equal(l.side, 'right');
    // 搜索页 / feed 这类页面根本没有"正文列"这个概念，
    // 贴边的 40px 不构成遮挡 —— 这是 dock 存在的主场景。
    assert.ok(staysOutOfContent(l, null));
  });

  test('正文顶到左边缘（窄视口 / DevTools 打开）→ dock', () => {
    for (const contentLeft of [0, 8, 40, 80]) {
      assert.equal(computeLayout({ contentLeft, headerBottom: 56 }).mode, 'dock', `contentLeft=${contentLeft}`);
    }
  });

  test('完整面板的宽度会被 gutter 反向约束，不会硬撑到 224', () => {
    const contentLeft = MIN_FULL_WIDTH + MARGIN * 2 + 5;
    const l = computeLayout({ contentLeft, headerBottom: 56 });
    assert.equal(l.mode, 'full');
    assert.ok(l.width < FULL_WIDTH, `宽度没有被约束：${l.width}`);
    assert.ok(staysOutOfContent(l, contentLeft));
  });
});

describe('纵向：让开顶部导航', () => {
  test('top 至少是 MIN_TOP，且总在 header 下方', () => {
    for (const headerBottom of [0, 30, 56, 62, 120]) {
      const l = computeLayout({ contentLeft: 500, headerBottom });
      assert.ok(l.top >= MIN_TOP, `top=${l.top}`);
      assert.ok(l.top > headerBottom, `top=${l.top} 没有让开 header(${headerBottom})`);
    }
  });
});

/**
 * ── protectedContentLeft ────────────────────────────────────────────
 *
 * 2026-09-10 真人 Field Test：真实回答页上 `.QuestionHeader-content` 的实测矩形是
 * `left:0 / right:1450 / width:1450` —— **整个视口宽**。它是外层 wrapper，
 * 不是用户阅读的那一列。旧算法拿它算出 `contentLeft:0` / `gutter:0` → 面板永远消失，
 * 而肉眼看到左边明明有大片空白。
 *
 * 新定义：**包着"我们正在记录的这篇正文"的那一列，取其中最靠左的非满宽祖先。**
 */
describe('protectedContentLeft · 满宽 wrapper 必须被拒', () => {
  /** 造一个"满宽 wrapper 包着窄阅读列包着正文"的页面。 */
  function page(opts: {
    viewport: number; columnLeft: number; columnWidth: number;
    wrapperClass: string; columnClass: string; bodyClass?: string;
  }) {
    const rects = new Map<El, RectLike>();
    const bodyEl = new El('div', opts.bodyClass ?? 'RichText ztext');
    // 正文本身还有内边距，比列更靠右 —— 绝不能拿它当边界（那是作弊）
    rects.set(bodyEl, { left: opts.columnLeft + 24, top: 100, bottom: 900, width: opts.columnWidth - 48 });
    const column = new El('div', opts.columnClass).append(bodyEl);
    rects.set(column, { left: opts.columnLeft, top: 90, bottom: 910, width: opts.columnWidth });
    const wrapper = new El('div', opts.wrapperClass).append(column);
    rects.set(wrapper, { left: 0, top: 0, bottom: 1000, width: opts.viewport });
    const header = new El('header', 'AppHeader');
    rects.set(header, { left: 0, top: 0, bottom: 52, width: opts.viewport });
    const doc = makeDocument(new El('body').append(header, wrapper));
    return {
      doc, bodyEl: bodyEl as unknown as Element,
      rectOf: (el: Element) => rects.get(el as unknown as El) ?? { left: 0, top: 0, bottom: 0, width: 0 },
    };
  }

  test('回答页：满宽 QuestionHeader-content 被拒，选中更窄的回答列', () => {
    const { doc, bodyEl, rectOf } = page({
      viewport: 1450, columnLeft: 386, columnWidth: 694,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content',
    });
    const m = measure(doc, 1450, rectOf, bodyEl);
    assert.equal(m.contentLeft, 386, `选错了列：${m.matchedProbe}`);
    assert.ok(!String(m.matchedProbe).includes('QuestionHeader'), m.matchedProbe as string);
    const rejected = m.probeCandidates!.find((c) => c.selector.includes('QuestionHeader'));
    assert.ok(rejected?.rejectedReason?.includes('wrapper'), JSON.stringify(rejected));
  });

  test('文章页：满宽 Post-content 被拒，选中更窄的阅读列', () => {
    const { doc, bodyEl, rectOf } = page({
      viewport: 1450, columnLeft: 340, columnWidth: 690,
      wrapperClass: 'Post-content', columnClass: 'Post-Main',
    });
    const m = measure(doc, 1450, rectOf, bodyEl);
    assert.equal(m.contentLeft, 340);
    const rejected = m.probeCandidates!.find((c) => c.selector.includes('Post-content'));
    assert.ok(rejected?.rejectedReason?.includes('wrapper'), JSON.stringify(rejected));
  });

  test('**不得**拿正文自身的内边距制造虚假 gutter', () => {
    const { doc, bodyEl, rectOf } = page({
      viewport: 1450, columnLeft: 386, columnWidth: 694,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content',
    });
    const m = measure(doc, 1450, rectOf, bodyEl);
    // 正文元素 left = 386+24 = 410；取它会凭空多出 24px gutter
    assert.notEqual(m.contentLeft, 410, '拿了正文内边距当边界 —— 这是作弊');
    assert.equal(m.contentLeft, 386);
  });

  test('只剩满宽 wrapper、找不到可信阅读列 → null → dock', () => {
    const rects = new Map<El, RectLike>();
    const bodyEl = new El('div', 'RichText ztext');
    rects.set(bodyEl, { left: 0, top: 100, bottom: 900, width: 1450 });
    const wrapper = new El('div', 'QuestionAnswer-content').append(bodyEl);
    rects.set(wrapper, { left: 0, top: 0, bottom: 1000, width: 1450 });
    const doc = makeDocument(new El('body').append(wrapper));
    const rectOf = (el: Element) => rects.get(el as unknown as El) ?? { left: 0, top: 0, bottom: 0, width: 0 };
    const m = measure(doc, 1450, rectOf, bodyEl as unknown as Element);
    assert.equal(m.contentLeft, null);
    assert.equal(computeLayout(m).mode, 'dock');
  });

  test('抽不到正文（target=null）→ 没有可信阅读列 → dock', () => {
    const { doc, rectOf } = page({
      viewport: 1450, columnLeft: 386, columnWidth: 694,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content',
    });
    const m = measure(doc, 1450, rectOf, null);
    assert.equal(m.contentLeft, null, '没有目标正文却选出了一列');
    assert.equal(computeLayout(m).mode, 'dock');
  });

  test('窄于 MIN_COLUMN_WIDTH 的元素不当作阅读列', () => {
    const { doc, bodyEl, rectOf } = page({
      viewport: 1450, columnLeft: 900, columnWidth: 200,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content',
    });
    const m = measure(doc, 1450, rectOf, bodyEl);
    assert.equal(m.contentLeft, null);
  });

  test('候选清单里每一条都带 left/right/width/containsTargetContent/rejectedReason', () => {
    const { doc, bodyEl, rectOf } = page({
      viewport: 1450, columnLeft: 386, columnWidth: 694,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content',
    });
    const m = measure(doc, 1450, rectOf, bodyEl);
    assert.ok(m.probeCandidates!.length >= 3);
    for (const c of m.probeCandidates!) {
      for (const k of ['selector', 'left', 'right', 'width', 'containsTargetContent', 'rejectedReason']) {
        assert.ok(k in c, `候选缺字段 ${k}: ${JSON.stringify(c)}`);
      }
    }
    assert.equal(m.probeCandidates!.filter((c) => c.selected).length, 1);
  });

  test('选中的列变了（resize 后版式变化）→ 判据说要重排', () => {
    const wide = page({ viewport: 1450, columnLeft: 386, columnWidth: 694,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content' });
    const narrow = page({ viewport: 1000, columnLeft: 20, columnWidth: 690,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content' });
    const a = measure(wide.doc, 1450, wide.rectOf, wide.bodyEl);
    const b = measure(narrow.doc, 1000, narrow.rectOf, narrow.bodyEl);
    assert.equal(a.contentLeft, 386);
    assert.equal(b.contentLeft, 20);
    assert.equal(measurementChanged(a, b), true);
    assert.equal(computeLayout(a).mode, 'full');
    assert.equal(computeLayout(b).mode, 'dock', 'gutter 只有 20px 还敢把完整面板铺开');
  });

  test('渲染出来的面板不得越过 protectedContentLeft', () => {
    const { doc, bodyEl, rectOf } = page({
      viewport: 1450, columnLeft: 386, columnWidth: 694,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content',
    });
    const m = measure(doc, 1450, rectOf, bodyEl);
    const l = computeLayout(m);
    assert.ok(staysOutOfContent(l, m.contentLeft));
    // 模拟 CSS 把宽度撑大（真实发生过：width:auto 的折叠态）
    const bloated = { ...l, width: 400 };
    assert.equal(staysOutOfContent(bloated, m.contentLeft), false, '运行时自检必须能抓住撑宽');
  });

  test('顶部导航仍然量得到', () => {
    const { doc, bodyEl, rectOf } = page({
      viewport: 1450, columnLeft: 386, columnWidth: 694,
      wrapperClass: 'QuestionHeader-content', columnClass: 'QuestionAnswer-content',
    });
    assert.equal(measure(doc, 1450, rectOf, bodyEl).headerBottom, 52);
  });
});

describe('没有 resize 事件、版式也可能变 —— 轮询重量的判据', () => {
  /**
   * 真实浏览器里抓到的：视口从 1440 变到 1000 之后，面板仍停在 174px 宽、
   * 右边界 186，而正文左边界已经是 0 —— 直接压在正文上。
   * 原因有两层：`resize` 回调用了 rAF 而 **rAF 在后台标签页不执行**；
   * 更根本的是知乎的版式会在**完全没有 resize** 的情况下移动
   * （右侧栏异步加载完、登录横幅出现/消失、图片撑开布局）。
   * 所以兜底必须是"每秒量一次、变了才重排"。
   */
  test('第一次总是要排', () => {
    assert.equal(measurementChanged(null, { contentLeft: 400, headerBottom: 52 }), true);
  });

  test('没变就不排（否则每秒重渲染一次面板）', () => {
    const m = { contentLeft: 400, headerBottom: 52 };
    assert.equal(measurementChanged(m, { ...m }), false);
    assert.equal(measurementChanged(m, { contentLeft: 400.4, headerBottom: 52.2 }), false);
  });

  test('正文左边界移动 ≥1px 就要排', () => {
    const m = { contentLeft: 400, headerBottom: 52 };
    assert.equal(measurementChanged(m, { contentLeft: 399, headerBottom: 52 }), true);
    assert.equal(measurementChanged(m, { contentLeft: 0, headerBottom: 52 }), true);
  });

  test('顶部导航高度变了也要排（登录横幅出现/消失）', () => {
    const m = { contentLeft: 400, headerBottom: 52 };
    assert.equal(measurementChanged(m, { contentLeft: 400, headerBottom: 100 }), true);
  });

  test('回归：1440 → 1000 的那次真实失效，判据必须说"要排"', () => {
    const at1440 = { contentLeft: 198, headerBottom: 52 };
    const at1000 = { contentLeft: 0, headerBottom: 52 };
    assert.equal(measurementChanged(at1440, at1000), true);
    // 而且重排后必须退成 dock，不能是那个压在正文上的 174px
    const l = computeLayout(at1000);
    assert.equal(l.mode, 'dock');
    assert.ok(staysOutOfContent(l, 0));
  });
});

describe('resize 后重新量，不会留在旧位置', () => {
  test('宽 → 窄：full 变 dock；窄 → 宽：变回 full', () => {
    const wide = computeLayout({ contentLeft: 500, headerBottom: 56 });
    const narrow = computeLayout({ contentLeft: 60, headerBottom: 56 });
    const back = computeLayout({ contentLeft: 500, headerBottom: 56 });
    assert.equal(wide.mode, 'full');
    assert.equal(narrow.mode, 'dock');
    assert.deepEqual(back, wide, '回到宽视口后布局没有还原');
  });
});
