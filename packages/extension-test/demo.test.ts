/**
 * 演示剧本的回归测试。
 *
 * 这个测试存在的原因：第一版剧本**没有达成它自己承诺的效果**——
 * 集中度从 56 掉到 52，而 Demo 的整个叙事就是"看着它涨上去"。
 * 失败是静默的：面板照常渲染，测试全绿，只有把每一步打出来才看得见。
 * 所以把剧本的承诺写成断言，别再让它悄悄退化。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { demoEvent, DEMO_TOTAL } from '../../extension/src/background/demo.ts';
import { buildAggregates } from '../../packages/core/src/aggregate.ts';
import type { ReadEvent } from '../../packages/core/src/model.ts';

function trace() {
  const events: ReadEvent[] = [];
  const steps: Array<{ score: number | null; view: ReturnType<typeof buildAggregates> }> = [];
  for (let i = 0; i < DEMO_TOTAL; i++) {
    events.push(demoEvent(i, 1_700_000_000_000 + i * 1000));
    const view = buildAggregates(events);
    steps.push({ score: view.concentration.state === 'ready' ? view.concentration.score : null, view });
  }
  return steps;
}

describe('演示剧本达成承诺的效果', () => {
  const steps = trace();
  const scored = steps.filter((s) => s.score !== null) as Array<{ score: number; view: any }>;
  const final = steps[steps.length - 1].view;

  test('集中度从第一次出分到结束是上升的', () => {
    assert.ok(scored.length >= 3, '出分步数太少，看不出趋势');
    assert.ok(
      scored[scored.length - 1].score > scored[0].score,
      `集中度没有上升：${scored[0].score} → ${scored[scored.length - 1].score}；` +
      'Demo 的整个叙事就是看着它涨上去',
    );
  });

  test('上升幅度足够肉眼可见（至少 10 分）', () => {
    const delta = scored[scored.length - 1].score - scored[0].score;
    assert.ok(delta >= 10, `只涨了 ${delta} 分，20 秒 Demo 里看不出来`);
  });

  test('主导概念最终占比超过 50%，是面板上最长的一根', () => {
    const top = final.concepts[0];
    assert.ok(top.share > 0.5, `最高概念只有 ${Math.round(top.share * 100)}%，压不住其他条`);
    assert.equal(top.canonical, '稳定');
  });

  test('推进过程中出现过 ↑（主导概念崛起时）', () => {
    assert.ok(steps.some((s) => s.view.concepts.some((c: any) => c.recentTrend === 'up')),
      '整个演示过程中没有出现过任何 ↑');
  });

  test('至少一个概念出现 ↓，让评委看到趋势是真的在动', () => {
    assert.ok(final.concepts.some((c: any) => c.recentTrend === 'down'), '没有任何 ↓ 箭头');
  });

  test('前 10 步不出分（样本不足时不给假精确数字）', () => {
    assert.equal(steps[8].score, null, '第 9 步就出分了，违反 MIN_SAMPLES=10');
    assert.notEqual(steps[9].score, null, '第 10 步应开始出分');
  });

  test('窗口内全部条目都被计为合成数据，面板才能打标签', () => {
    // 窗口固定 20，演示共 26 篇，因此窗口内应为 20 条且全是 demo
    assert.equal(final.sampleCount, final.syntheticCount,
      '窗口内出现了非演示数据，面板可能漏打标签');
  });

  test('剧本前段确实分散：首个分数明显低于结束时', () => {
    assert.ok(scored[0].score < 20, `起点集中度 ${scored[0].score} 偏高，看不出从分散到集中`);
  });
});
