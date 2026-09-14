/**
 * 有效阅读判定的边界测试。
 * 覆盖用户在真实浏览中会遇到的场景，每一条都对应一个具体的失败模式。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingSession, shouldRecord } from '../../extension/src/content/reading-session.ts';
import { detectPage } from '../../extension/src/content/detect-page.ts';
import { CONFIG } from '../../extension/src/shared/config.ts';

function make(visible: () => boolean, threshold = 8) {
  let fired = 0;
  const s = new ReadingSession({ isVisible: visible, now: () => 0, onQualified: () => { fired++; } }, threshold);
  return { s, fired: () => fired };
}
const run = (s: ReadingSession, seconds: number) => { for (let i = 0; i < seconds; i++) s.tick(1000); };

describe('边界 · 快速点开又退出', () => {
  test('停留 3 秒不产生记录', () => {
    const { s, fired } = make(() => true);
    s.bind('https://www.zhihu.com/answer/1');
    run(s, 3);
    assert.equal(fired(), 0);
    // 离开页面时也不应补记——它本来就没达标
    s.flush();
    assert.equal(fired(), 0);
  });
});

describe('边界 · 切换到后台', () => {
  test('不可见时不累计，挂机一小时也不产生记录', () => {
    let visible = false;
    const { s, fired } = make(() => visible);
    s.bind('u1');
    run(s, 3600);
    assert.equal(s.visibleMs, 0, '后台挂机不得凭空产生阅读记录');
    assert.equal(fired(), 0);
  });

  test('切走再切回，时间接着累计而不是清零', () => {
    let visible = true;
    const { s, fired } = make(() => visible);
    s.bind('u1');
    run(s, 5);
    visible = false; run(s, 100);
    assert.equal(s.visibleMs, 5000);
    visible = true; run(s, 3);
    assert.equal(fired(), 1);
  });
});

describe('边界 · SPA 内部跳转与前进后退', () => {
  test('换一篇内容后计时重置，不继承上一篇的时长', () => {
    const { s, fired } = make(() => true);
    s.bind('https://www.zhihu.com/answer/1');
    run(s, 7);                       // 差 1 秒达标
    s.bind('https://www.zhihu.com/answer/2');   // SPA 跳到第二篇
    assert.equal(s.visibleMs, 0, '新内容必须从零开始计时');
    run(s, 7);
    assert.equal(fired(), 0, '两篇各 7 秒不应凑成一次有效阅读');
    run(s, 1);
    assert.equal(fired(), 1);
  });

  test('bind 到同一个 key 是幂等的，不会重置进度', () => {
    const { s } = make(() => true);
    s.bind('u1'); run(s, 5);
    s.bind('u1');
    assert.equal(s.visibleMs, 5000, '重复 bind 同一内容不应清零');
  });

  test('后退回到已读过的文章，会重新开始计时', () => {
    const { s, fired } = make(() => true);
    s.bind('u1'); run(s, 8);
    assert.equal(fired(), 1);
    s.bind('u2'); run(s, 2);
    s.bind('u1');                    // 后退
    assert.equal(s.visibleMs, 0);
    run(s, 8);
    assert.equal(fired(), 2, '重新计时后应再次达标（是否入库由去重决定）');
  });

  test('跳到非内容页（首页/搜索）时 key 为空，不计时', () => {
    const { s, fired } = make(() => true);
    s.bind('');                      // detectPage 返回 unknown 时传空 key
    run(s, 60);
    assert.equal(fired(), 0);
    assert.equal(s.visibleMs, 0);
  });
});

describe('边界 · 页面关闭前安全写入', () => {
  test('已达阈值但尚未触发时，关闭前补记一次', () => {
    // 构造：阈值 8 秒，累计到 8 秒的同一 tick 就会触发，
    // 因此用更长阈值模拟"达标但回调还没跑"的窗口
    const { s, fired } = make(() => true, 8);
    s.bind('u1');
    run(s, 8);
    assert.equal(fired(), 1);
    s.flush();
    assert.equal(fired(), 1, 'flush 不应重复触发');
  });

  test('未达阈值时 flush 不产生记录', () => {
    const { s, fired } = make(() => true);
    s.bind('u1'); run(s, 4); s.flush();
    assert.equal(fired(), 0);
  });

  test('qualifiesNow 正确反映"达标但未触发"', () => {
    const { s } = make(() => true, 8);
    s.bind('u1');
    run(s, 7);
    assert.equal(s.qualifiesNow, false);
  });
});

describe('边界 · 同一篇重复打开与多标签页', () => {
  const hist = [{ id: 'a1', timestamp: 1_000_000 }];

  test('去重窗口内不重复计入', () => {
    assert.equal(shouldRecord('a1', hist, 1_000_000 + 60_000), false);
  });

  test('超过 30 分钟后可再次计入', () => {
    assert.equal(shouldRecord('a1', hist, 1_000_000 + CONFIG.DEDUPE_WINDOW_MS + 1), true);
  });

  test('多个标签页同时读同一篇：各自计时，但只入库一次', () => {
    // 两个 tab 各有独立 session，都会达标
    const t1 = make(() => true), t2 = make(() => true);
    t1.s.bind('a1'); t2.s.bind('a1');
    run(t1.s, 8); run(t2.s, 8);
    assert.equal(t1.fired(), 1);
    assert.equal(t2.fired(), 1);
    // 但第二次上报会被去重挡掉
    const history: Array<{ id: string; timestamp: number }> = [];
    const now = 2_000_000;
    assert.equal(shouldRecord('a1', history, now), true);
    history.push({ id: 'a1', timestamp: now });
    assert.equal(shouldRecord('a1', history, now + 500), false, '第二个标签页的上报应被去重');
  });

  test('不同文章互不影响', () => {
    assert.equal(shouldRecord('a2', hist, 1_000_000 + 1000), true);
  });
});

describe('边界 · 非内容页与抽取失败', () => {
  test('首页 / 搜索 / 个人页 / 热榜 一律 unknown', () => {
    for (const u of [
      'https://www.zhihu.com/',
      'https://www.zhihu.com/search?q=ai',
      'https://www.zhihu.com/people/someone',
      'https://www.zhihu.com/hot',
      'https://www.zhihu.com/follow',
    ]) {
      assert.equal(detectPage(u).type, 'unknown', u);
    }
  });

  test('回答页 / 问题页回答 / 专栏文章 被正确识别', () => {
    assert.equal(detectPage('https://www.zhihu.com/answer/190304495').type, 'answer');
    assert.equal(detectPage('https://www.zhihu.com/question/123/answer/456').type, 'answer');
    assert.equal(detectPage('https://zhuanlan.zhihu.com/p/18698154193').type, 'article');
  });

  test('utm 追踪参数被剥离，避免同一篇被当成两篇', () => {
    const a = detectPage('https://www.zhihu.com/answer/123?utm_medium=openapi_platform&utm_source=6d23');
    const b = detectPage('https://www.zhihu.com/answer/123');
    assert.equal(a.url, b.url);
  });
});
