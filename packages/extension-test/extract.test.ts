/**
 * 正文抽取测试。
 *
 * 这一轮把测试从"只测兜底函数"升级成"测完整的三层抽取"，
 * 因为本轮新增的硬约束是**第三层必须 fail loud**——
 * 而那正是没有测试就一定会悄悄退化回 `body.innerText` 的地方。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractContent, isAnalyzable, largestTextBlock } from '../../extension/src/content/extract-content.ts';
import { sanitize, truncateForModel, textWithoutNoise, MAX_MODEL_CHARS } from '../../extension/src/content/sanitize.ts';
import { El, makeDocument } from './dom-shim.ts';

const ANSWER_URL = 'https://www.zhihu.com/question/123/answer/456';

/** 真实回答页的骨架：根容器 + 正文 + 一堆应该被摘掉的东西。 */
function answerPage(bodyChars = 600): { doc: Document; body: string } {
  const bodyText = '我在大厂待了三年然后跳去了小公司。'.repeat(Math.ceil(bodyChars / 17)).slice(0, bodyChars);
  const rich = new El('div', 'RichText ztext').append(new El('p', '', bodyText));
  const root = new El('div', 'QuestionAnswer-content').append(
    new El('div', 'AuthorInfo').append(new El('span', '', '某某某，程序员')),
    rich,
    new El('div', 'RichContent-actions').append(new El('button', '', '赞同'), new El('button', '', '添加评论')),
    new El('div', 'Comments-container').append(new El('p', '', '楼主说得对'.repeat(50))),
  );
  const page = new El('body').append(
    new El('header', 'AppHeader').append(new El('a', '', '首页发现等你来答')),
    new El('h1', 'QuestionHeader-title', '大厂和小公司怎么选'),
    root,
    new El('div', 'Recommendations-Main').append(new El('p', '', '相关推荐内容'.repeat(60))),
    new El('footer', '').append(new El('p', '', '知乎 京ICP备')),
  );
  return { doc: makeDocument(page, '大厂和小公司怎么选 - 知乎'), body: bodyText };
}

describe('三层抽取 · 第一层：语义化 selector', () => {
  test('命中 RichText，confidence=high，且不含评论/推荐/按钮/作者简介', () => {
    const { doc, body } = answerPage();
    const c = extractContent(doc, ANSWER_URL);
    assert.equal(c.confidence, 'high');
    assert.equal(c.strategy, 'semantic');
    assert.ok(c.selectorMatched.includes('RichText'), c.selectorMatched);
    assert.equal(c.text, body);
    for (const bad of ['楼主说得对', '相关推荐内容', '赞同', '添加评论', '京ICP备', '首页发现等你来答', '某某某']) {
      assert.ok(!c.text.includes(bad), `正文里混进了「${bad}」`);
    }
  });

  test('标题来自 h1，而不是 document.title 的"- 知乎"后缀', () => {
    assert.equal(extractContent(answerPage().doc, ANSWER_URL).title, '大厂和小公司怎么选');
  });
});

describe('三层抽取 · 第二层：结构兜底', () => {
  // 根容器现在按页面类型分开（真人 Field Test 之后的改动），
  // 所以兜底测试必须用**该类型真实存在的**根容器，不能随手拿 <article> 当回答页的根。
  test('根容器在、但正文 selector 全落空时退到最大文本块，confidence=medium', () => {
    const text = '知乎改了 class 名，但正文还在这里。'.repeat(40);
    const page = new El('body').append(
      new El('h1', 'QuestionHeader-title', '标题'),
      new El('div', 'QuestionAnswer-content').append(
        new El('div', 'brand-new-classname').append(new El('p', '', text)),
      ),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.equal(c.confidence, 'medium');
    assert.equal(c.strategy, 'structural');
    assert.ok(c.text.length > 200);
  });

  test('兜底只在根容器内搜索，不会跑到页面别处去捞', () => {
    // 侧栏文本更长、密度也高，但它在回答容器之外 —— 收缩根容器之后不该被看到
    const inside = '这是正文。'.repeat(50);
    const outside = '这是侧栏长文。'.repeat(200);
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content').append(new El('div', 'x').append(new El('p', '', inside))),
      new El('div', 'Sidebar').append(new El('p', '', outside)),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.ok(c.text.includes('这是正文'), '应抓到回答容器内的正文');
    assert.ok(!c.text.includes('侧栏'), '不得越过根容器抓到侧栏');
  });

  test('专栏文章页的根容器不会匹配回答页的容器，反之亦然', () => {
    const long = '正文内容。'.repeat(60);
    // 一个只有 Post-content 的页面，用回答页 URL 打开 → 找不到 answer 的根 → low
    const asAnswer = new El('body').append(
      new El('div', 'Post-content').append(new El('div', 'RichText ztext').append(new El('p', '', long))),
    );
    assert.equal(extractContent(makeDocument(asAnswer), ANSWER_URL).confidence, 'low');
    // 反过来同理
    const asArticle = new El('body').append(
      new El('div', 'QuestionAnswer-content').append(new El('div', 'RichText ztext').append(new El('p', '', long))),
    );
    assert.equal(extractContent(makeDocument(asArticle), 'https://zhuanlan.zhihu.com/p/1').confidence, 'low');
  });
});

describe('三层抽取 · 第三层：必须 fail loud', () => {
  /**
   * 这一组是红队打出来的。旧实现是 `firstElement(...) ?? doc.body`，
   * 于是"根容器全落空"变成"在整页里找最大文本块"。
   * 而旧的 fail-loud 测试之所以通过，**只是因为它的假页面全页文本不到 200 字**
   * ——`largestTextBlock` 的门槛就是 200，测试名字对得上，证明的却是别的事。
   * 所以下面每一条都刻意把噪声写到 200 字以上。
   */
  const noRoot = (extra: El) => makeDocument(
    new El('body').append(
      new El('div', 'Nav').append(...Array.from({ length: 30 }, () => new El('a', '', '话题'))),
      extra,
    ), '知乎');

  test('没有根容器 + 300 字页脚免责声明 → 仍然 low，页脚不得入库', () => {
    const footer = new El('div', 'SiteFooter').append(
      new El('p', '', '本内容由用户发布，不代表知乎立场。如有侵权请联系我们处理。'.repeat(12)));
    const c = extractContent(noRoot(footer), ANSWER_URL);
    assert.equal(c.confidence, 'low');
    assert.equal(c.text, '');
  });

  test('没有根容器 + 一条长评论 → 仍然 low', () => {
    const cm = new El('div', 'CommentList').append(
      new El('p', '', '楼主说得太对了我完全同意这个观点。'.repeat(15)));
    const c = extractContent(noRoot(cm), ANSWER_URL);
    assert.equal(c.confidence, 'low');
  });

  test('没有根容器 + 评论里带 .RichText → 仍然 low（旧实现在这里给 high）', () => {
    const cm = new El('div', 'CommentList').append(
      new El('div', 'RichText').append(new El('p', '', '楼主说得太对了我完全同意。'.repeat(15))));
    const c = extractContent(noRoot(cm), ANSWER_URL);
    assert.equal(c.confidence, 'low', '评论被当成了正文，而且拿到了 high');
    assert.equal(c.text, '');
  });

  test('确认不了正文时返回空文本 + low，而不是退回整页文字', () => {
    const page = new El('body').append(
      new El('header', 'AppHeader').append(new El('a', '', '首页 发现 等你来答')),
      new El('div', 'Nav').append(...Array.from({ length: 40 }, () => new El('a', '', '话题'))),
    );
    const c = extractContent(makeDocument(page, '知乎'), ANSWER_URL);
    assert.equal(c.confidence, 'low');
    assert.equal(c.strategy, 'none');
    assert.equal(c.text, '');
  });

  test('low 一律不可分析 —— 这是"绝不把整页当正文"的可执行版本', () => {
    const c = { type: 'answer', confidence: 'low', text: 'x'.repeat(9999) } as any;
    assert.equal(isAnalyzable(c), false);
  });

  test('unknown 页面即使抓到了长文本也不可分析', () => {
    const c = { type: 'unknown', confidence: 'high', text: 'x'.repeat(9999) } as any;
    assert.equal(isAnalyzable(c), false);
  });
});

describe('多回答问题页 · 根容器必须归属到 URL 里的那一篇', () => {
  const mine = '我的回答正文。'.repeat(40);
  const others = '别人的回答正文。'.repeat(200);

  /**
   * 注意：属性名 `data-item` 是**测试自己编的**。
   * 真实知乎把 itemId 放在哪个属性里我不知道，也不该假设——
   * `pickRoot` 的判据是"任一属性值里出现过这个 id"，不依赖具体属性名。
   */
  test('当前回答的容器带得上 id 线索时，选中它、不碰别人的回答', () => {
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content', '', { 'data-item': '{"itemId":456}' })
        .append(new El('div', 'RichText ztext').append(new El('p', '', mine))),
      new El('div', 'AnswerCard', '', { 'data-item': '{"itemId":789}' })
        .append(new El('div', 'RichText ztext').append(new El('p', '', others))),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL); // answer/456
    assert.equal(c.confidence, 'high');
    assert.ok(c.text.includes('我的回答'));
    assert.ok(!c.text.includes('别人的回答'), '抓到了其他回答');
  });

  test('多个候选根、但没有一个能归属到当前 id → fail closed（宁可漏记）', () => {
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content').append(new El('div', 'RichText ztext').append(new El('p', '', mine))),
      new El('div', 'AnswerCard').append(new El('div', 'RichText ztext').append(new El('p', '', others))),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.equal(c.confidence, 'low');
    assert.equal(c.text, '');
    assert.ok(c.selectorMatched.includes('候选根容器'), c.selectorMatched);
  });

  test('SPA 在同一问题页换回答：绝不用新 id 记下旧回答的正文', () => {
    // URL 已经是 answer/999，DOM 里 456 的容器还排在前面（querySelector 会先拿到它）
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content').append(
        new El('div', 'RichText ztext').append(new El('p', '', '这是 456 号回答的正文。'.repeat(20))),
      ),
      new El('div', 'QuestionAnswer-content').append(
        new El('div', 'RichText ztext').append(new El('p', '', '这是 999 号回答的正文。'.repeat(20))),
      ),
    );
    const c = extractContent(makeDocument(page), 'https://www.zhihu.com/question/1/answer/999');
    assert.ok(!c.text.startsWith('这是 456'), '用 999 的 id 记下了 456 的正文');
    assert.equal(isAnalyzable(c), false, '张冠李戴的内容不得进入分析');
  });

  test('只有一个候选根（真人 Field Test 验过的那种页面）行为不变', () => {
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content').append(new El('div', 'RichText ztext').append(new El('p', '', mine))),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.equal(c.confidence, 'high');
    assert.ok(c.text.includes('我的回答'));
  });
});

describe('评论在根容器内部时也必须被剥离', () => {
  test('.CommentList 在回答容器里，评论文字不得进入正文', () => {
    const body = '我的回答正文内容。'.repeat(40);
    const page = new El('body').append(
      new El('div', 'QuestionAnswer-content').append(
        new El('div', 'RichText ztext').append(new El('p', '', body)),
        new El('div', 'CommentList').append(new El('p', '', '楼主说得对'.repeat(60))),
      ),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.equal(c.confidence, 'high');
    assert.ok(!c.text.includes('楼主说得对'), '评论混进了正文');
  });
});

describe('从 DOM 到 sanitize 的整段（不是只测 sanitize 自己）', () => {
  /**
   * 旧测试直接喂 `'标题\n12 人赞同了该回答\n正文'` 这种手写字符串，
   * 于是没人发现 `textContent` 根本不产生换行——按行做的清洗在真实链路上
   * **一条都不会触发**。这条测试从真实的 DOM 结构走一遍。
   */
  test('「N 人赞同了该回答」这类统计行在真实 DOM 结构下也会被清掉', () => {
    const long = '这是正文的实际内容需要足够长才能通过门槛。'.repeat(12);
    const page = new El('body').append(
      new El('h1', 'QuestionHeader-title', '大厂和小公司怎么选'),
      new El('div', 'QuestionAnswer-content').append(
        new El('div', 'RichText ztext').append(
          new El('p', '', '大厂和小公司怎么选'),   // 与标题重复的首行
          new El('p', '', '128 人赞同了该回答'),   // 统计行
          new El('p', '', '编辑于'),               // UI 文案行
          new El('p', '', long),
        ),
      ),
    );
    const c = extractContent(makeDocument(page), ANSWER_URL);
    assert.ok(!c.text.includes('人赞同了该回答'), `统计行没被清掉：${c.text.slice(0, 40)}`);
    assert.ok(!c.text.startsWith('大厂和小公司怎么选'), '与标题重复的首行没被去掉');
    assert.ok(!c.text.includes('编辑于'), 'UI 文案行没被清掉');
    assert.ok(c.text.startsWith('这是正文'), c.text.slice(0, 30));
  });
});

describe('清理与截断', () => {
  test('摘掉噪声容器用的是克隆体，原 DOM 不被修改', () => {
    const root = new El('div', 'r').append(
      new El('p', '', '正文'),
      new El('div', 'Comments-container').append(new El('p', '', '评论')),
    );
    // blockText 会在块级元素后补换行，所以比较时先去掉换行
            assert.equal(textWithoutNoise(root).replace(/\n/g, ''), '正文');
    assert.ok(root.textContent.includes('评论'), '原 DOM 被改坏了');
  });

  test('去掉与标题重复的首行和统计行', () => {
    assert.equal(sanitize('标题\n12 人赞同了该回答\n真正的正文', '标题'), '真正的正文');
  });

  test('超长正文按 头/中/尾 采样，结尾一定保留', () => {
    const head = 'A'.repeat(MAX_MODEL_CHARS);
    const tailMark = '这是全文最后的结论段。';
    const r = truncateForModel(head + tailMark);
    assert.equal(r.truncated, true);
    assert.ok(r.text.endsWith(tailMark), '结论段被截掉了 —— 那正是"这篇在讲什么"的关键');
    assert.ok(r.text.startsWith('AAA'));
    assert.equal(r.originalChars, head.length + tailMark.length);
  });

  test('未超长时不标 truncated', () => {
    const r = truncateForModel('短文');
    assert.equal(r.truncated, false);
    assert.equal(r.text, '短文');
  });
});

describe('largestTextBlock 兜底细节', () => {
  test('选中高密度正文而不是低密度大容器', () => {
    const body = '这是一篇真正的回答正文。'.repeat(30);
    const rich = new El('div', 'RichText').append(new El('p', '', body));
    const main = new El('div', 'Main').append(rich, ...Array.from({ length: 400 }, () => new El('span', '', '推荐 ')));
    assert.ok(largestTextBlock(main).startsWith('这是一篇真正的回答正文'));
  });

  test('短文本与空容器返回空串而不抛错', () => {
    assert.equal(largestTextBlock(new El('div', '').append(new El('p', '', '登录后体验更好'))), '');
    assert.equal(largestTextBlock(new El('div', '')), '');
  });

  test('纯导航容器（文本长但密度极低）不会被误当成正文', () => {
    const nav = new El('div', 'Nav').append(...Array.from({ length: 500 }, () => new El('a', '', '话题 ')));
    assert.equal(largestTextBlock(nav), '');
  });

  test('段落级 p 也能被选中', () => {
    const p = new El('p', '', '一段足够长的独立段落。'.repeat(30));
    assert.ok(largestTextBlock(new El('div', '').append(p)).length > 200);
  });
});
