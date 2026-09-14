/**
 * 真实端到端：扩展 service worker → 真实 `/analyze` → 真实 Ollama → 本地历史 → 面板视图。
 *
 * 这个文件里**没有任何 mock**。跑不起来就整体 skip，
 * **绝不**退化成假数据然后声称"端到端通过"。
 *
 *   node server/dev-server.ts &
 *   node --test packages/extension-test/live-e2e.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../extension/src/shared/config.ts';
import { sourceBadge } from '../../extension/src/content/dashboard.ts';

/**
 * `ZHILIU_REQUIRE_LIVE=1` 时不许静默跳过。见 live-zhida.test.ts 的说明：
 * 一个会 skip 成 exit 0 的 live suite，没法用来兑现"真跑过"这句话。
 */
const REQUIRE_LIVE = process.env.ZHILIU_REQUIRE_LIVE === '1';

const ENDPOINT = process.env.ZHILIU_ANALYZE ?? 'http://127.0.0.1:8732/analyze';
const HEALTH = ENDPOINT.replace(/\/analyze$/, '/health');

let live: { provider: string; model: string } | null = null;
try {
  const r = await fetch(HEALTH, { signal: AbortSignal.timeout(2000) });
  const j = (await r.json()) as any;
  live = j?.llm ?? null;
} catch { live = null; }

const skip = live ? false : `分析服务不可用（${HEALTH}）—— 跳过，不伪造结果`;
if (REQUIRE_LIVE && skip) throw new Error(`ZHILIU_REQUIRE_LIVE=1 但 ${skip}`);

type Listener = (msg: any, s: unknown, send: (r: unknown) => void) => boolean | void;
const store: Record<string, unknown> = {};
let listener: Listener | null = null;
(globalThis as any).chrome = {
  storage: { local: {
    get: async (k: any) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
    set: async (i: Record<string, unknown>) => { Object.assign(store, i); },
  } },
  runtime: { onMessage: { addListener: (cb: Listener) => { listener = cb; } } },
};
(CONFIG as any).ANALYZE_ENDPOINT = ENDPOINT;
(CONFIG as any).ANALYZE_TIMEOUT_MS = 120_000; // 真模型，别把它掐了
if (!skip) await import('../../extension/src/background/service-worker.ts');
const send = (m: unknown): Promise<any> => new Promise((res) => listener!(m, null, res));

const ARTICLES = [
  { id: '9001', title: '付了首付之后，我们的关系差点没撑过去',
    text: '这套房子的首付是两家一起凑的，她家出得多一些。房贷占掉我们两个人收入的六成，意味着接下来五年任何一次冲动消费都要商量。买房这件事真正考验的不是你能不能凑出首付，是你们两个人有没有一套能把钱和感情分开谈的方法。' },
  { id: '9002', title: '我把入睡时间从一点半提到十一点半，用了三个月',
    text: '最有效的一件事不是早点上床，是把早上的起床时间钉死。第二件事是把手机充电器挪到客厅。这两件事都不需要意志力，它们只是把熬夜这个动作的成本抬高了一点点。靠意志力早睡的方案我试过四次，全败。' },
  { id: '9003', title: '今天真的服了',
    text: '早上出门发现自行车胎没气。走路去地铁站，卡消磁了，排队补办。到公司发现电梯在检修，爬了十一层。中午点的外卖送到了隔壁楼。下午空调滴水滴在我键盘上。晚上回家电梯又坏了。就这样，没了。真的服了，什么都不想说了。' },
];

describe('真实端到端（无 mock）', { skip }, () => {
  test('三篇连续上报：立刻返回、后台分析、结果各归各位', async () => {
    const t0 = Date.now();
    for (const a of ARTICLES) {
      await send({ type: 'READING_QUALIFIED', content: {
        url: `https://www.zhihu.com/answer/${a.id}`, contentId: a.id, type: 'answer',
        title: a.title, text: a.text, duration: 9000, confidence: 'high',
      } });
    }
    const submitMs = Date.now() - t0;
    // 三次真实推理每次数秒；如果上报总共只花了不到 1 秒，说明确实没有阻塞
    assert.ok(submitMs < 1000, `上报被模型阻塞了 ${submitMs}ms —— 异步改造失效`);

    const mid = await send({ type: 'GET_VIEW' });
    assert.ok(mid.analyzingCount > 0, '应有在途分析');

    const view = await send({ type: 'AWAIT_IDLE' });
    console.log(`  提交耗时 ${submitMs}ms；三篇真实分析总耗时 ${Date.now() - t0}ms`);
    assert.equal(view.analyzingCount, 0);

    const events = (store['zhiliu.events.v2'] as any[]);
    assert.equal(events.length, 3, '三篇都应入库');

    for (const e of events) {
      assert.notEqual(e.analysisVersion, 'pending', `${e.id} 没有被回填`);
      assert.equal(e.analysisStatus, 'llm', `${e.id} 不是 llm 来源：${e.analysisStatus}`);
      assert.equal(e.analysis.provider, live!.provider);
      assert.equal(e.analysis.model, live!.model);
      assert.ok(e.analysis.promptVersion && e.analysis.promptVersion !== 'n/a', 'promptVersion 没落库');
      console.log(`  ${e.id} ${e.title.slice(0, 12)}… → ${e.concepts.map((c: any) => c.canonical).join('、') || '(unknown)'}  [${e.analysis.provider}/${e.analysis.model}/${e.analysis.promptVersion}]`);
    }

    // 面板必须显示「AI 分析」而不是「演示数据」——没有一条 mock/demo
    const badge = sourceBadge(view.sourceBreakdown);
    assert.equal(badge?.kind, 'llm', `徽标是 ${badge?.text}，说明混进了 mock/demo`);
    assert.equal(view.sourceBreakdown.mock, 0);
    assert.equal(view.sourceBreakdown.demo, 0);

    // 出处一致 → 不该出现"多来源混合"提示
    assert.equal(view.analysisMix.length, 1, `出处不唯一：${JSON.stringify(view.analysisMix)}`);
  });

  test('纯流水账被判 unknown，不硬贴标签', async () => {
    const e = (store['zhiliu.events.v2'] as any[]).find((x) => x.id === 'a9003');
    assert.ok(e, '第三篇不在库里');
    assert.equal(e.concepts.length, 0, `模型给流水账贴了标签：${JSON.stringify(e.concepts)}`);
  });
});
