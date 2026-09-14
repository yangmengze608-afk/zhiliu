/**
 * 真实知乎页面结构的回归测试。
 *
 * ## 这些 fixture 不是我编的
 *
 * 结构全部来自 **2026-09-09 的真人 Field Test**（见 `docs/REAL_PAGE_TEST.md`）：
 *
 *   回答页  `div.QuestionAnswer-content` → `.RichContent-inner` → `.RichText`
 *   文章页  `div.Post-content`           → `.Post-RichTextContainer` → `.RichText`
 *   列表页  `main.App-main`，里面一堆带 `.RichText` 的推荐卡片
 *
 * 前两条真人核对 PASS；第三条真人核对 **FAIL**——`/column-square` 被
 * `main.App-main` 命中，抽出 1818 字的推荐位/广告/搜索/论文列表，
 * 而且诊断显示 `strategy: semantic` / `confidence: high`。
 *
 * 所以这个文件的重点不是"能不能抓到"，而是**该放弃的时候有没有放弃**。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractContent, isAnalyzable, SUPPORTED_TYPES } from '../../extension/src/content/extract-content.ts';
import { detectPage } from '../../extension/src/content/detect-page.ts';
import { El, makeDocument } from './dom-shim.ts';

const ANSWER_URL = 'https://www.zhihu.com/question/667788/answer/112233';
const ARTICLE_URL = 'https://zhuanlan.zhihu.com/p/998877';
const SQUARE_URL = 'https://www.zhihu.com/column-square';

const body = (seed: string, times: number) => new El('p', '', seed.repeat(times));

/** 真人样本 1：/question/<qid>/answer/<aid> */
function realAnswerPage(): Document {
  return makeDocument(new El('body').append(
    new El('header', 'AppHeader').append(new El('a', '', '首页 发现 等你来答')),
    new El('div', 'QuestionHeader').append(
      new El('h1', 'QuestionHeader-title', '墨尔本大学是不是回国直接能当985用？'),
    ),
    new El('div', 'QuestionAnswer-content').append(
      new El('div', 'AuthorInfo').append(new El('span', '', '匿名用户')),
      new El('div', 'RichContent-inner').append(
        new El('div', 'RichText ztext').append(
          body('不能。首先我自己就墨大本科物理专业，回国之后的实际体感是这样的：', 8),
        ),
      ),
      new El('div', 'RichContent-actions').append(new El('button', '', '赞同'), new El('button', '', '添加评论')),
      new El('div', 'CommentList').append(new El('div', 'RichText').append(body('楼主说得对，我也是墨大的。', 20))),
    ),
    new El('div', 'Recommendations-Main').append(body('相关推荐内容', 60)),
  ), '墨尔本大学是不是回国直接能当985用？ - 知乎');
}

/** 真人样本 2：zhuanlan.zhihu.com/p/<id> */
function realArticlePage(): Document {
  return makeDocument(new El('body').append(
    new El('header', 'AppHeader').append(new El('a', '', '知乎')),
    new El('div', 'Post-content').append(
      new El('h1', 'Post-Title', 'ACP：一个可能被低估的 Agent 接口协议'),
      new El('div', 'Post-Header').append(new El('div', 'AuthorInfo').append(new El('span', '', '某作者'))),
      new El('div', 'Post-RichTextContainer').append(
        new El('div', 'RichText ztext').append(
          body('Claude Code 火了。OpenCode 火了。Gemini CLI、Codex CLI 也都在做同一件事：', 40),
        ),
      ),
      new El('div', 'Comments-container').append(body('评论区内容', 50)),
    ),
  ), 'ACP：一个可能被低估的 Agent 接口协议 - 知乎');
}

/** 真人样本 3：/column-square —— main.App-main 里全是带 RichText 的推荐卡 */
function realColumnSquare(): Document {
  const cards = Array.from({ length: 12 }, (_, i) =>
    new El('div', 'ColumnItem').append(
      new El('h2', '', `推荐专栏 ${i}`),
      new El('div', 'RichText ztext').append(body(`第 ${i} 张卡片的摘要，看起来很像正文。`, 10)),
    ));
  return makeDocument(new El('body').append(
    new El('header', 'AppHeader').append(new El('a', '', '首页 发现')),
    new El('main', 'App-main').append(
      new El('div', 'SearchBar').append(new El('input', '', '搜索')),
      ...cards,
      new El('div', 'Pc-card').append(body('广告位', 60)),
    ),
  ), '专栏广场 - 知乎');
}

describe('真人样本 1 · 回答页（Field Test: PASS）', () => {
  const c = extractContent(realAnswerPage(), ANSWER_URL);

  test('高置信度语义抽取，命中真实 selector 链', () => {
    assert.equal(c.type, 'answer');
    assert.equal(c.strategy, 'semantic');
    assert.equal(c.confidence, 'high');
    assert.ok(c.selectorMatched.includes('QuestionAnswer-content'), c.selectorMatched);
    assert.ok(c.selectorMatched.includes('RichContent-inner'), c.selectorMatched);
  });

  test('标题与正文起点与真人核对一致', () => {
    assert.equal(c.title, '墨尔本大学是不是回国直接能当985用？');
    assert.ok(c.text.startsWith('不能。首先我自己就墨大本科物理专业'), c.text.slice(0, 40));
  });

  test('不含评论 / 推荐 / 作者信息 / 导航', () => {
    for (const bad of ['楼主说得对', '相关推荐内容', '匿名用户', '首页 发现', '赞同', '添加评论']) {
      assert.ok(!c.text.includes(bad), `正文混进了「${bad}」`);
    }
  });

  test('可分析', () => assert.equal(isAnalyzable(c), true));
});

describe('真人样本 2 · 专栏文章页（Field Test: PASS）', () => {
  const c = extractContent(realArticlePage(), ARTICLE_URL);

  test('高置信度语义抽取，命中真实 selector 链', () => {
    assert.equal(c.type, 'article');
    assert.equal(c.strategy, 'semantic');
    assert.equal(c.confidence, 'high');
    assert.ok(c.selectorMatched.includes('Post-content'), c.selectorMatched);
    assert.ok(c.selectorMatched.includes('Post-RichTextContainer'), c.selectorMatched);
  });

  test('标题正确、正文起点正确、评论未混入', () => {
    assert.equal(c.title, 'ACP：一个可能被低估的 Agent 接口协议');
    assert.ok(c.text.startsWith('Claude Code 火了。'), c.text.slice(0, 40));
    assert.ok(!c.text.includes('评论区内容'));
  });

  test('长文触发结构化截断，并如实标记', () => {
    assert.equal(c.truncated, true);
    assert.ok(c.originalChars > c.text.length);
  });

  test('可分析', () => assert.equal(isAnalyzable(c), true));
});

describe('真人样本 3 · /column-square（Field Test: FAIL → 已修）', () => {
  const c = extractContent(realColumnSquare(), SQUARE_URL);

  test('即使整页布满 RichText，也必须 unsupported / low', () => {
    assert.equal(c.type, 'unknown');
    assert.equal(c.strategy, 'unsupported', '列表页仍在走抽取流程');
    assert.equal(c.confidence, 'low');
  });

  test('一个字都不抽 —— 不是"抽了但不用"', () => {
    assert.equal(c.text, '', `抽到了 ${c.text.length} 字：${c.text.slice(0, 40)}`);
    assert.equal(c.originalChars, 0);
  });

  test('绝不再命中 main.App-main', () => {
    assert.ok(!c.selectorMatched.includes('App-main'), c.selectorMatched);
    assert.ok(!c.selectorMatched.includes('main'), c.selectorMatched);
  });

  test('不可分析 → 不会发 /analyze、不会写 history', () => {
    assert.equal(isAnalyzable(c), false);
  });
});

describe('fail closed 是按页面类型白名单，不是按"抓没抓到"', () => {
  const OTHERS = [
    ['首页 feed', 'https://www.zhihu.com/'],
    ['热榜', 'https://www.zhihu.com/hot'],
    ['搜索页', 'https://www.zhihu.com/search?q=x'],
    ['个人主页', 'https://www.zhihu.com/people/someone'],
    ['问题页（不带 /answer/）', 'https://www.zhihu.com/question/667788'],
    ['专栏广场', SQUARE_URL],
  ] as const;

  for (const [name, url] of OTHERS) {
    test(`${name} → unsupported，且一个字都不抽`, () => {
      const c = extractContent(realColumnSquare(), url);
      assert.equal(c.strategy, 'unsupported', name);
      assert.equal(c.text, '', name);
      assert.equal(isAnalyzable(c), false, name);
    });
  }

  test('支持的类型只有 answer / article —— 改这个数组等于改产品支持范围', () => {
    assert.deepEqual([...SUPPORTED_TYPES], ['answer', 'article']);
  });
});

describe('嵌套根容器 · 2026-09-10 真人复验抓到的 false negative', () => {
  /**
   * 上一轮加的 `pickRoot` 规则是"多于一个候选就 fail closed"。
   * 真人在**同一类此前验证 PASS 的专栏文章页**上跑，拿到
   * `confidence: low` / `textLength: 0` / 「article 页有 2 个根容器都满足」。
   *
   * 原因：正常的文章页本来就会有两个候选——`<article>` 包着 `.Post-content`
   * （或 `.Post-content` 里还有 `.Post-Main`）。它们是**同一篇文章的不同层**，
   * 不是两篇互相冲突的内容。旧规则把"嵌套"误当成"冲突"。
   */
  const richBody = () => new El('div', 'Post-RichTextContainer').append(
    new El('div', 'RichText ztext').append(body('Claude Code 火了。OpenCode 火了。', 30)));

  test('<article> ⊃ .Post-content → high，取最具体的 .Post-content', () => {
    const page = new El('body').append(
      new El('article', 'Post').append(
        new El('div', 'Post-content').append(new El('h1', 'Post-Title', '标题'), richBody()),
      ),
    );
    const c = extractContent(makeDocument(page), ARTICLE_URL);
    assert.equal(c.confidence, 'high');
    assert.equal(c.strategy, 'semantic');
    assert.ok(c.text.length > 200, `只抓到 ${c.text.length} 字`);
    assert.ok(c.selectorMatched.startsWith('div.Post-content'), c.selectorMatched);
  });

  test('.Post-content ⊃ .Post-Main → high，取更深的 .Post-Main', () => {
    const page = new El('body').append(
      new El('div', 'Post-content').append(new El('div', 'Post-Main').append(richBody())),
    );
    const c = extractContent(makeDocument(page), ARTICLE_URL);
    assert.equal(c.confidence, 'high');
    assert.ok(c.selectorMatched.startsWith('div.Post-Main'), c.selectorMatched);
  });

  test('三层嵌套也只算一条 chain', () => {
    const page = new El('body').append(
      new El('article', '').append(
        new El('div', 'Post-content').append(new El('div', 'Post-Main').append(richBody())),
      ),
    );
    const c = extractContent(makeDocument(page), ARTICLE_URL);
    assert.equal(c.confidence, 'high');
  });

  test('最具体的根不含正文时，沿 chain 往外退一层（仍是同一篇）', () => {
    // .Post-Main 只包了操作栏，正文挂在外层 .Post-content 上
    const page = new El('body').append(
      new El('div', 'Post-content').append(
        new El('div', 'Post-Main').append(new El('span', '', '赞同 收藏')),
        richBody(),
      ),
    );
    const c = extractContent(makeDocument(page), ARTICLE_URL);
    assert.equal(c.confidence, 'high');
    assert.ok(c.selectorMatched.startsWith('div.Post-content'), c.selectorMatched);
  });

  test('两个**互不包含**的 .Post-content（真的两篇）→ 仍然 fail closed', () => {
    const page = new El('body').append(
      new El('div', 'Post-content').append(richBody()),
      new El('div', 'Post-content').append(richBody()),
    );
    const c = extractContent(makeDocument(page), ARTICLE_URL);
    assert.equal(c.confidence, 'low');
    assert.equal(c.text, '');
    assert.ok(c.selectorMatched.includes('互不包含'), c.selectorMatched);
  });

  test('两篇互不包含、但其中一篇属性带得上 contentId → 选中它', () => {
    const mine = new El('div', 'Post-content', '', { 'data-item': '{"id":998877}' }).append(
      new El('div', 'Post-RichTextContainer').append(
        new El('div', 'RichText ztext').append(body('这是 998877 的正文。', 30))));
    const other = new El('div', 'Post-content', '', { 'data-item': '{"id":111}' }).append(
      new El('div', 'Post-RichTextContainer').append(
        new El('div', 'RichText ztext').append(body('这是别人的正文。', 30))));
    const c = extractContent(makeDocument(new El('body').append(other, mine)), ARTICLE_URL);
    assert.equal(c.confidence, 'high');
    assert.ok(c.text.startsWith('这是 998877'), c.text.slice(0, 20));
  });

  test('回答页的嵌套同理：.AnswerCard ⊃ .QuestionAnswer-content 不算冲突', () => {
    const page = new El('body').append(
      new El('div', 'AnswerCard').append(
        new El('div', 'QuestionAnswer-content').append(
          new El('div', 'RichContent-inner').append(
            new El('div', 'RichText ztext').append(body('不能。首先我自己就墨大本科物理专业。', 20)))),
      ),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.equal(c.confidence, 'high');
    assert.ok(c.selectorMatched.startsWith('div.QuestionAnswer-content'), c.selectorMatched);
  });

  test('嵌套修复**没有**放松 column-square：列表页仍然 unsupported / 0 字', () => {
    const c = extractContent(realColumnSquare(), SQUARE_URL);
    assert.equal(c.strategy, 'unsupported');
    assert.equal(c.text, '');
    assert.equal(isAnalyzable(c), false);
  });

  test('嵌套修复**没有**放松推荐位：列表 DOM 配合法 article URL 也抓不到', () => {
    // main.App-main 不在 article 的根容器列表里，推荐卡的 RichText 无从进入
    const c = extractContent(realColumnSquare(), ARTICLE_URL);
    assert.equal(c.confidence, 'low');
    assert.equal(c.text, '');
  });
});

describe('单个候选根也要核对归属（红队 R7）', () => {
  /**
   * SPA 在同一问题页换回答：URL 已经是 answer/999，DOM 里只剩 456 的容器还没换。
   * 只有一个候选，旧逻辑直接采信 → 用 999 的 id 记下了 456 的正文，
   * 而且 semantic / high / analyzable=true。用户永远发现不了。
   */
  test('唯一根容器带的 id 不是当前 URL 的 id → fail closed', () => {
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content', '', { 'data-item': '{"itemId":456789}' }).append(
        new El('div', 'RichContent-inner').append(
          new El('div', 'RichText ztext').append(body('这是 456789 号回答的正文。', 20)))),
    );
    const c = extractContent(makeDocument(page), 'https://www.zhihu.com/question/1/answer/999888');
    assert.equal(c.confidence, 'low');
    assert.equal(c.text, '');
    assert.equal(isAnalyzable(c), false);
  });

  test('唯一根容器带的 id 就是当前 id → 正常抽取', () => {
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content', '', { 'data-item': '{"itemId":999888}' }).append(
        new El('div', 'RichContent-inner').append(
          new El('div', 'RichText ztext').append(body('这是 999888 号回答的正文。', 20)))),
    );
    const c = extractContent(makeDocument(page), 'https://www.zhihu.com/question/1/answer/999888');
    assert.equal(c.confidence, 'high');
  });

  test('页面根本不把 id 放在属性里 → 无从核对，正常采信（不能因此全面停摆）', () => {
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content').append(
        new El('div', 'RichContent-inner').append(
          new El('div', 'RichText ztext').append(body('正文内容。', 40)))),
    );
    const c = extractContent(makeDocument(page), 'https://www.zhihu.com/question/1/answer/999888');
    assert.equal(c.confidence, 'high');
  });

  test('class 里的数字不算 id 线索（否则会误伤）', () => {
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content css-123456789').append(
        new El('div', 'RichContent-inner').append(
          new El('div', 'RichText ztext').append(body('正文内容。', 40)))),
    );
    assert.equal(extractContent(makeDocument(page), 'https://www.zhihu.com/question/1/answer/999888').confidence, 'high');
  });
});

describe('URL 尾巴不得被当成正文页（红队 R6-8）', () => {
  const cases: Array<[string, string]> = [
    ['https://zhuanlan.zhihu.com/p/123/edit', 'unknown'],       // 真实可达的专栏编辑器
    ['https://www.zhihu.com/answer/123/comment', 'unknown'],
    ['https://zhuanlan.zhihu.com/p/123', 'article'],
    ['https://zhuanlan.zhihu.com/p/123/', 'article'],
    ['https://www.zhihu.com/question/1/answer/2', 'answer'],
    ['https://www.zhihu.com/answer/123?x=1', 'answer'],
  ];
  for (const [url, want] of cases) {
    test(`${url} → ${want}`, () => assert.equal(detectPage(url).type, want));
  }
});

describe('信息流卡片类名不得作为回答页的根容器（红队 R6-5）', () => {
  test('合法 answer URL + 一屏信息流 DOM → 抓不到东西，而不是抓第一张卡', () => {
    const feed = new El('body').append(
      new El('div', 'List').append(
        ...Array.from({ length: 8 }, (_, i) =>
          new El('div', 'AnswerItem').append(
            new El('div', 'RichText ztext').append(body(`第 ${i} 张信息流卡片的摘要。`, 12)),
          )),
      ),
    );
    const c = extractContent(makeDocument(feed), ANSWER_URL);
    assert.equal(c.confidence, 'low');
    assert.equal(c.text, '');
  });
});

describe('结构兜底路径上噪声必须先摘再打分（红队 R6-4）', () => {
  test('短回答 + 长评论 → 抓回答，或者放弃，但绝不抓评论', () => {
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content').append(
        new El('div', 'brand-new-name').append(body('这是一段不算长的真实回答正文。', 12)),
        new El('div', 'Comments-container').append(body('评论内容非常长非常长非常长。', 60)),
      ),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.ok(!c.text.includes('评论内容'), `抓到了评论：${c.text.slice(0, 30)}`);
  });
});

describe('评论区 RichText 不得被当成回答正文', () => {
  test('回答容器缺失、只剩评论时 → low，而不是拿评论顶上', () => {
    const page = new El('body').append(
      new El('header', 'AppHeader'),
      // 没有 QuestionAnswer-content / AnswerCard / AnswerItem
      new El('div', 'CommentList').append(
        new El('div', 'RichText ztext').append(body('楼主说得太对了我完全同意这个观点。', 20)),
      ),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.equal(c.confidence, 'low');
    assert.equal(c.text, '');
    assert.equal(isAnalyzable(c), false);
  });
});
