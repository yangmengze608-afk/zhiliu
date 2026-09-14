/**
 * 页面识别的路由回归 —— 把 fail-closed contract 钉死。
 *
 * ## 起因，以及它**不是**什么
 *
 * 一次真人 production 验收（U-14）在这条地址栏 URL 上失败：
 *   https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388
 * 面板报 `unknown` / `unsupported` / 正文 0 字。
 *
 * 第一反应是"路由 regression"。**不是。**
 * 真人补打了 `location.href`，实际是：
 *   https://www.zhihu.com/question/2017971286807180358
 * —— 知乎把它变成了**纯问题页**。而 `/question/<qid>` 判 unknown
 * 正是我们写死的 contract：问题页上同时挂着很多个回答，
 * "你读了哪一篇"根本无法确定，抽出来的东西必然是错的。
 *
 * 所以这份测试的作用变了：它不是修 bug，是**把这条 contract 钉住**，
 * 免得下次有人看到"真人页面不工作"就顺手把 `/question/<qid>` 塞进 answer 分支。
 * 那一改，产品就开始往历史里写不知道是谁的正文。
 *
 * 用的 ID 是**新式雪花 ID（19 位）**。旧样例里的 ID 只有 3–9 位，
 * 万一哪天有人给 `\d+` 加了长度上限，这些用例会立刻红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectPage, stripTracking } from '../../extension/src/content/detect-page.ts';

/** 真人验收失败的那一条，逐字照抄，不许改写。 */
const FIELD_FAILURE_URL =
  'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388';

describe('U-14 那次真人验收，两条 URL 各自的正确行为', () => {
  test('地址栏看到的那条（带 /answer/）→ answer', () => {
    const r = detectPage(FIELD_FAILURE_URL);
    assert.equal(r.type, 'answer', `带 /answer/ 的 URL 被判成了 ${r.type}`);
    assert.equal(r.contentId, '2019114400523514388');
  });

  test('**实际 location.href**（被知乎改成纯问题页）→ unknown，这是对的', () => {
    const r = detectPage('https://www.zhihu.com/question/2017971286807180358');
    assert.equal(r.type, 'unknown',
      '问题页被认成了可分析页面 —— 那上面挂着很多个回答，抽出来必然张冠李戴');
    assert.equal(r.contentId, undefined);
  });
});

describe('回答页的各种真实形态', () => {
  const answerCases: Array<[string, string]> = [
    ['独立回答页', 'https://www.zhihu.com/answer/2019114400523514388'],
    ['问题下的回答', 'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388'],
    ['带结尾斜杠', 'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388/'],
    ['带普通 query', 'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388?foo=bar'],
    ['带 utm 追踪', 'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388?utm_campaign=shareopn&utm_medium=social&utm_psn=1234567890123456789'],
    ['带 source/hash_id', 'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388?source=feed&hash_id=abc123'],
    ['带 fragment', 'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388#comment'],
    ['斜杠 + query 一起', 'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388/?utm_id=0'],
    ['旧式短 ID 仍然要认', 'https://www.zhihu.com/question/123456/answer/7890123'],
  ];
  for (const [name, url] of answerCases) {
    test(`${name} → answer / 2019114400523514388 或对应 ID`, () => {
      const r = detectPage(url);
      assert.equal(r.type, 'answer', `${url}\n  被判成了 ${r.type}`);
      assert.match(r.contentId ?? '', /^\d+$/);
      // contentId 必须是**回答** ID，不能误取问题 ID
      if (url.includes('2019114400523514388')) assert.equal(r.contentId, '2019114400523514388');
    });
  }
});

describe('专栏文章', () => {
  for (const url of [
    'https://zhuanlan.zhihu.com/p/1234567890123456789',
    'https://zhuanlan.zhihu.com/p/1234567890123456789/',
    'https://zhuanlan.zhihu.com/p/1234567890123456789?utm_medium=social',
  ]) {
    test(`${url} → article`, () => {
      const r = detectPage(url);
      assert.equal(r.type, 'article');
      assert.equal(r.contentId, '1234567890123456789');
    });
  }
});

describe('必须 fail closed 的页面（这些认错了比认不出更糟）', () => {
  const unknownCases: Array<[string, string]> = [
    ['问题页本身（没点进具体回答）', 'https://www.zhihu.com/question/2017971286807180358'],
    ['问题页带斜杠', 'https://www.zhihu.com/question/2017971286807180358/'],
    ['回答的评论页', 'https://www.zhihu.com/question/2017971286807180358/answer/2019114400523514388/comment'],
    ['独立回答的评论页', 'https://www.zhihu.com/answer/2019114400523514388/comment'],
    ['专栏编辑器', 'https://zhuanlan.zhihu.com/p/1234567890123456789/edit'],
    ['首页', 'https://www.zhihu.com/'],
    ['热榜', 'https://www.zhihu.com/hot'],
    ['搜索页', 'https://www.zhihu.com/search?q=%E7%A8%B3%E5%AE%9A'],
    ['个人页', 'https://www.zhihu.com/people/someone'],
    ['专栏广场', 'https://www.zhihu.com/column-square'],
    ['回答 ID 不是数字', 'https://www.zhihu.com/question/123/answer/abc'],
  ];
  for (const [name, url] of unknownCases) {
    test(`${name} → unknown`, () => {
      assert.equal(detectPage(url).type, 'unknown', `${url}\n  不该被认成可分析页面`);
    });
  }
});

describe('stripTracking', () => {
  test('utm / source / hash_id 被剥掉，普通参数保留', () => {
    const out = stripTracking(
      'https://www.zhihu.com/answer/123?utm_campaign=x&source=feed&hash_id=y&keep=1',
    );
    assert.ok(!out.includes('utm_campaign'));
    assert.ok(!out.includes('source='));
    assert.ok(!out.includes('hash_id'));
    assert.ok(out.includes('keep=1'), '普通参数被误删了');
  });

  test('参数全被剥光时不留下一个孤零零的问号', () => {
    const out = stripTracking('https://www.zhihu.com/answer/123?utm_campaign=x');
    assert.equal(out, 'https://www.zhihu.com/answer/123');
  });

  test('畸形 URL 原样返回，不抛异常', () => {
    assert.equal(stripTracking('not a url'), 'not a url');
  });
});
