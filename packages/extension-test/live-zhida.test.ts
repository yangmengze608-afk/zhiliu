/**
 * **真实**调用知乎官方开放平台。没有 ZHIHU_ACCESS_SECRET 就整份跳过。
 *
 *   ZHIHU_ACCESS_SECRET=... node --test packages/extension-test/live-zhida.test.ts
 *
 * 它和 providers.test.ts 的分工很清楚：那边用假 fetch 测结构约束，
 * 这边**真的打到 developer.zhihu.com**，回答"协议假设今天还成立吗"。
 * 每条 case 都消耗真实额度，所以刻意只留最少的几条。
 *
 * 为什么必须存在：整个项目里"已接入官方 API"这句话的证据就是它。
 * 没有它，providers.ts 里那张 VERIFIED 表就退回成读文档读来的假设。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ZhidaExtractor, probeZhida, ZHIDA_MODELS } from '../core/src/providers.ts';
import { LiveSearchTransport, ZhihuSearchClient } from '../core/src/zhihu-client.ts';

const secret = process.env.ZHIHU_ACCESS_SECRET;

/**
 * `ZHILIU_REQUIRE_LIVE=1` 时**不许跳过**。
 *
 * 红队 R8-14：不带凭证敲 `npm run test:live`，三个 suite 全部被 skip，
 * 汇总行是 `tests 1 / pass 1 / fail 0 / skipped 0`，**退出码 0**。
 * 于是「live 测试过了」这句话没法区分"6 条真跑过"和"0 条跑了"——
 * 而这个文件自述是「已接入官方 API」这句话的唯一证据。
 *
 * 发布前应该跑 `ZHILIU_REQUIRE_LIVE=1 npm run test:live`：
 * 少跑一条就是 fail，而不是静悄悄地绿。
 */
const REQUIRE_LIVE = process.env.ZHILIU_REQUIRE_LIVE === '1';
if (REQUIRE_LIVE && !secret) {
  throw new Error('ZHILIU_REQUIRE_LIVE=1 但没有 ZHIHU_ACCESS_SECRET —— 拒绝把"跳过"报成"通过"');
}

describe('LIVE · 知乎开放平台', { skip: secret ? false : '没有 ZHIHU_ACCESS_SECRET，跳过真实调用' }, () => {
  test('直答 probe：响应确实是 OpenAI 形状', async () => {
    const r = await probeZhida(secret!);
    assert.equal(r.httpStatus, 200, `直答返回 ${r.httpStatus}：${r.rawPreview.slice(0, 200)}`);
    assert.equal(r.shapeMatchesOpenAI, true, '响应体不是 choices[0].message.content 形状');
  });

  test('无效凭证是诚实的 401，不是 200 里塞 error —— 所以 resp.ok 可以信', async () => {
    const r = await probeZhida('deadbeef'.repeat(5));
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 401);
    assert.match(r.rawPreview, /invalid_api_key|authentication/i);
  });

  test('瞎编的模型名被服务端拒绝 —— 证明那三个模型名不是我们自己编的', async () => {
    const r = await probeZhida(secret!, 'zhida-model-that-does-not-exist');
    assert.equal(r.httpStatus, 400);
    assert.match(r.rawPreview, /model/i);
  });

  test('真实抽取一篇：返回真概念，provenance 是 zhida', async () => {
    const ex = new ZhidaExtractor({ accessSecret: secret!, model: ZHIDA_MODELS[0], timeoutMs: 60_000 });
    const r = await ex.extract({
      title: '我把每天的通勤时间全用来听播客，三个月后',
      text: '一开始只是打发时间。后来发现自己会主动找某一类节目——全是讲一件事怎么运作的。'
        + '我原本以为自己在放松，其实是在补一块很具体的知识缺口。这件事我自己是最后才意识到的。'.repeat(3),
    });
    assert.equal(r.status, 'llm', `真实调用失败：${r.dropped.join(',')}`);
    assert.ok(r.concepts.length >= 1 && r.concepts.length <= 3);
    assert.equal(r.provenance.provider, 'zhida');
    assert.equal(r.provenance.model, ZHIDA_MODELS[0]);
  });

  test('知乎搜索真实返回，且字段就是 types.ts 声明的那些', async () => {
    const client = new ZhihuSearchClient(new LiveSearchTransport(secret!));
    const items = await client.neighborhoodItems('拖延', 3);
    assert.ok(items.length > 0, '搜索返回空');
    const it = items[0];
    for (const k of ['Title', 'ContentType', 'ContentID', 'ContentText', 'Url', 'AuthorName', 'AuthorityLevel', 'RankingScore'] as const) {
      assert.ok(k in it, `真实响应里缺少已声明的字段 ${k}`);
    }
    assert.equal(typeof it.RankingScore, 'number');
    assert.equal(typeof it.AuthorityLevel, 'string', 'AuthorityLevel 实测是字符串不是数字');
  });
});
