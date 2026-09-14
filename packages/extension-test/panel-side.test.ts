/**
 * 面板停靠侧偏好。
 *
 * v1.1.0 只有"按左右可用空间自己选边"一种行为。技术上讲得通，产品上不成立 ——
 * 真人反馈是面板**一会儿在左、一会儿在右，像在页面里跳**。
 * 空间记忆是面板类产品最基本的东西：用户得知道往哪儿看。
 *
 * 现在的规则：**先认偏好，再谈空间**。
 *   left（默认）  左侧放得下 → 左侧完整面板；放不下 → 左边缘 dock；**不跳到右边**
 *   right         同理镜像
 *   auto          才继续比较左右可用空间
 *
 * 唯一能凌驾于偏好之上的是**不遮挡**：偏好那一侧连 40px 贴边都塞不下时，
 * 先试对面边缘，两边都不行才隐藏。那是极端版式（正文铺满视口）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, staysOutOfContent, DOCK_WIDTH } from '../../extension/src/content/layout.ts';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/config.ts';

/** 回答页 / 专栏：量得到阅读列，两侧都有留白。 */
const CONTENT_PAGE = { contentLeft: 209, headerBottom: 52, contentRight: 1241, viewportWidth: 1450 };
/** 问题页 / 搜索页：量不出阅读列。 */
const LIST_PAGE = { contentLeft: null, headerBottom: 52, viewportWidth: 1450 };

describe('默认就是 left，用户不用做任何操作', () => {
  test('DEFAULT_SETTINGS.panelSide === "left"', () => {
    assert.equal(DEFAULT_SETTINGS.panelSide, 'left');
  });

  test('不传 prefer 时按 left 处理（老调用点不会悄悄变成自动选边）', () => {
    assert.equal(computeLayout(CONTENT_PAGE).side, 'left');
    assert.equal(computeLayout(LIST_PAGE).side, 'left');
  });
});

describe('LEFT（默认）', () => {
  test('回答页 / 专栏 → 左侧完整面板', () => {
    const l = computeLayout(CONTENT_PAGE, 'left');
    assert.equal(l.mode, 'full');
    assert.equal(l.side, 'left');
    assert.ok(staysOutOfContent(l, CONTENT_PAGE.contentLeft, CONTENT_PAGE.contentRight, 1450));
  });

  test('问题页 / 搜索页 → 左边缘 dock', () => {
    const l = computeLayout(LIST_PAGE, 'left');
    assert.equal(l.mode, 'dock');
    assert.equal(l.side, 'left');
    assert.equal(l.width, DOCK_WIDTH);
  });

  test('右侧空白明显更宽也**不跳过去**', () => {
    // 左 100px（放不下完整面板）、右 440px（放得下）
    const m = { contentLeft: 100, headerBottom: 52, contentRight: 1000, viewportWidth: 1440 };
    const l = computeLayout(m, 'left');
    assert.equal(l.side, 'left', '偏好 left 却跳到了右边 —— 这就是"面板在跳"的来源');
    assert.notEqual(l.mode, 'full'); // 左边确实放不下完整面板
  });
});

describe('RIGHT', () => {
  test('回答页 / 专栏 → 右侧完整面板', () => {
    const l = computeLayout(CONTENT_PAGE, 'right');
    assert.equal(l.mode, 'full');
    assert.equal(l.side, 'right');
    assert.ok(staysOutOfContent(l, CONTENT_PAGE.contentLeft, CONTENT_PAGE.contentRight, 1450));
  });

  test('问题页 / 搜索页 → 右边缘 dock', () => {
    const l = computeLayout(LIST_PAGE, 'right');
    assert.equal(l.mode, 'dock');
    assert.equal(l.side, 'right');
  });

  test('左侧空白明显更宽也**不跳过去**', () => {
    // 左 600px、右 216px —— 两侧都放得下完整面板，左边宽得多。
    // （右边必须真的放得下：不遮挡凌驾于偏好之上，右边塞不下时换边是对的行为，
    //   那种几何测不出"偏好有没有被尊重"。）
    const m = { contentLeft: 600, headerBottom: 52, contentRight: 1200, viewportWidth: 1440 };
    const l = computeLayout(m, 'right');
    assert.equal(l.side, 'right', '偏好 right 却跳到了左边');
    assert.equal(l.mode, 'full');
    assert.ok(staysOutOfContent(l, 600, 1200, 1440));
  });
});

describe('AUTO', () => {
  test('才恢复"比较左右可用空间"的逻辑', () => {
    const leftWider = { contentLeft: 500, headerBottom: 52, contentRight: 1400, viewportWidth: 1440 };
    const rightWider = { contentLeft: 100, headerBottom: 52, contentRight: 900, viewportWidth: 1440 };
    assert.equal(computeLayout(leftWider, 'auto').side, 'left');
    assert.equal(computeLayout(rightWider, 'auto').side, 'right');
  });

  test('两侧都量不出来时选左，和新默认保持一致', () => {
    assert.equal(computeLayout({ contentLeft: null, headerBottom: 52 }, 'auto').side, 'left');
  });
});

describe('SPA 来回切页：偏好不漂移', () => {
  test('answer → search → article → question，side 始终跟着偏好走', () => {
    const pages = [
      ['answer', CONTENT_PAGE],
      ['search', LIST_PAGE],
      ['article', { contentLeft: 260, headerBottom: 52, contentRight: 1180, viewportWidth: 1440 }],
      ['question', LIST_PAGE],
    ] as const;
    for (const prefer of ['left', 'right'] as const) {
      const sides = pages.map(([, m]) => computeLayout(m, prefer).side);
      assert.deepEqual(sides, [prefer, prefer, prefer, prefer],
        `偏好 ${prefer} 时侧别漂了：${sides.join(' → ')}`);
    }
  });

  test('同一偏好下，模式可以变（full ↔ dock），但侧别不变', () => {
    const modes = [CONTENT_PAGE, LIST_PAGE].map((m) => computeLayout(m, 'left'));
    assert.equal(modes[0].mode, 'full');
    assert.equal(modes[1].mode, 'dock');
    assert.deepEqual(modes.map((l) => l.side), ['left', 'left']);
  });
});

describe('不遮挡仍然凌驾于偏好之上', () => {
  test('偏好侧连贴边都塞不下 → 换对面边缘', () => {
    const l = computeLayout({ contentLeft: 0, headerBottom: 52, contentRight: 900, viewportWidth: 1440 }, 'left');
    assert.equal(l.side, 'right');
    assert.ok(staysOutOfContent(l, 0, 900, 1440));
  });

  test('两边都塞不下 → 隐藏（唯一会真消失的情形）', () => {
    const l = computeLayout({ contentLeft: 0, headerBottom: 52, contentRight: 1440, viewportWidth: 1440 }, 'left');
    assert.equal(l.mode, 'hidden');
  });

  /**
   * **fallback 只是当前这一页的布局结果，不是新的偏好。**
   *
   * 这是最容易写错的一处：某一页被迫退到右边缘，顺手把 'right' 存回设置，
   * 于是用户选的 LEFT 被一次极端版式永久改掉了 —— 而用户从头到尾没点过任何东西。
   */
  test('被迫换到对面之后，下一张正常页面自动回到 LEFT', () => {
    const squeezed = computeLayout({ contentLeft: 0, headerBottom: 52, contentRight: 900, viewportWidth: 1440 }, 'left');
    assert.equal(squeezed.side, 'right', '前置条件不成立：这一页并没有触发 fallback');
    // 偏好仍然是 'left' —— computeLayout 是纯函数，不回写任何状态
    const next = computeLayout(CONTENT_PAGE, 'left');
    assert.equal(next.side, 'left', 'fallback 把偏好带到了下一页');
    assert.equal(next.mode, 'full');
  });

  test('同一个偏好反复调用，结果只取决于这一页的版式', () => {
    const pages = [CONTENT_PAGE, { contentLeft: 0, headerBottom: 52, contentRight: 900, viewportWidth: 1440 }, CONTENT_PAGE, LIST_PAGE];
    const sides = pages.map((m) => computeLayout(m, 'left').side);
    assert.deepEqual(sides, ['left', 'right', 'left', 'left'],
      '出现了"一旦跳过去就回不来"的粘滞行为');
  });
});

/**
 * 偏好必须跨页面、跨 SPA 跳转、跨浏览器重启保持。
 *
 * 它走的是和其它设置同一条路（`chrome.storage.local`），所以这里验的是
 * **那条路真的把新字段带上了** —— 新增字段最常见的失败是
 * loadSettings 的默认合并漏了它，老用户永远拿不到。
 */
describe('偏好的持久化', () => {
  test('loadSettings 给老用户补上默认值（存档里没有 panelSide）', async () => {
    const store: Record<string, unknown> = {
      // 模拟 v1.1.0 之前存下的设置：没有 panelSide
      'zhiliu.settings': { tintByConcentration: true, collapsed: false, demoMode: false },
    };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
      } },
    };
    const { loadSettings, saveSettings } = await import('../../extension/src/background/storage.ts');
    const s = await loadSettings();
    assert.equal(s.panelSide, 'left', '老存档没有 panelSide 时没有补上默认值');
    assert.equal(s.tintByConcentration, true, '补默认值时把已有设置覆盖了');

    // 改成 right 并落盘，再读回来
    await saveSettings({ ...s, panelSide: 'right' });
    const again = await loadSettings();
    assert.equal(again.panelSide, 'right', '落盘之后读不回来 —— 重启就丢了');
  });
});
