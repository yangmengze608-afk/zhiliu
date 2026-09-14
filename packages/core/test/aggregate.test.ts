import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAggregates, statEvents, trendDirection, MIN_SAMPLES, TREND_SEGMENT } from '../src/index.ts';
import type { ReadEvent } from '../src/index.ts';

let seq = 0;
const ev = (concepts: string[], opts: Partial<ReadEvent> = {}): ReadEvent => ({
  id: `e${seq}`, contentType: 'answer', title: `t${seq}`, timestamp: 1000 + seq++,
  duration: 9000,
  concepts: concepts.map((c) => ({ canonical: c, confidence: 0.9 })),
  analysisStatus: 'llm', analysisVersion: 'v1', ...opts,
});
const many = (n: number, concepts: string[], opts: Partial<ReadEvent> = {}) =>
  Array.from({ length: n }, () => ev(concepts, opts));

describe('集中度 · 各类历史形态', () => {
  test('纯单主题历史 → 100', () => {
    const v = buildAggregates(many(10, ['稳定']));
    assert.equal(v.concentration.state, 'ready');
    if (v.concentration.state === 'ready') assert.equal(v.concentration.score, 100);
  });

  test('完全均匀历史 → 明显低于集中历史', () => {
    const uniform = ['稳定', '就业', '风险', 'AI', '房产'].flatMap((c) => many(2, [c]));
    const skewed = [...many(12, ['稳定']), ...many(2, ['就业'])];
    const u = buildAggregates(uniform).concentration;
    const s = buildAggregates(skewed).concentration;
    assert.equal(u.state, 'ready'); assert.equal(s.state, 'ready');
    if (u.state === 'ready' && s.state === 'ready') {
      assert.ok(s.score > u.score, `集中(${s.score}) 应高于均匀(${u.score})`);
    }
  });

  test('两主题集中 → 介于单一与均匀之间', () => {
    const one = buildAggregates(many(20, ['稳定'])).concentration;
    const two = buildAggregates([...many(10, ['稳定']), ...many(10, ['就业'])]).concentration;
    const five = buildAggregates(['稳定','就业','风险','AI','房产'].flatMap((c) => many(4, [c]))).concentration;
    if (one.state === 'ready' && two.state === 'ready' && five.state === 'ready') {
      assert.ok(one.score > two.score && two.score > five.score,
        `应单调：单一(${one.score}) > 两主题(${two.score}) > 五主题(${five.score})`);
    }
  });

  test('少于 10 篇显示「数据积累中」而不是一个假精确的数字', () => {
    for (const n of [1, 4, 9]) {
      const v = buildAggregates(many(n, ['稳定']));
      assert.equal(v.concentration.state, 'collecting', `${n} 篇不应出分`);
      if (v.concentration.state === 'collecting') assert.equal(v.concentration.needed, MIN_SAMPLES);
    }
    assert.equal(buildAggregates(many(10, ['稳定'])).concentration.state, 'ready');
  });

  test('concept 合并前后：碎裂的同义标签会低估集中度', () => {
    // 若未归一，稳定家族被拆成 4 个不同标签
    const fragmented = [
      ...many(5, ['工作稳定']), ...many(5, ['职业稳定性']),
      ...many(5, ['稳定就业']), ...many(5, ['体制稳定']),
    ];
    const merged = many(20, ['稳定']);
    const f = buildAggregates(fragmented).concentration;
    const m = buildAggregates(merged).concentration;
    if (f.state === 'ready' && m.state === 'ready') {
      assert.ok(m.score > f.score,
        `归一后集中度应更高：碎裂(${f.score}) vs 归一(${m.score})——这正是 canonicalization 的意义`);
    }
  });

  test('每篇文章总权重恒为 1：3 概念的文章不得获得 3 倍影响', () => {
    const v = buildAggregates([...many(10, ['稳定']), ...many(10, ['就业', '风险', 'AI'])]);
    const stable = v.concepts.find((c) => c.canonical === '稳定')!;
    assert.ok(Math.abs(stable.share - 0.5) < 1e-6, `稳定占比 ${stable.share}，应为 0.5`);
    const sum = v.concepts.reduce((s, c) => s + c.share, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6);
  });
});

describe('趋势 · 最近 10 篇 vs 前 10 篇（出现率）', () => {
  test('后段新出现的概念标记上升，消失的标记下降', () => {
    const v = buildAggregates([...many(10, ['就业']), ...many(10, ['稳定'])]);
    assert.equal(v.concepts.find((c) => c.canonical === '稳定')!.recentTrend, 'up');
    assert.equal(v.concepts.find((c) => c.canonical === '就业')!.recentTrend, 'down');
  });

  test('前后一致的概念标记持平', () => {
    const v = buildAggregates(many(20, ['稳定']));
    assert.equal(v.concepts[0].recentTrend, 'flat');
  });

  test('反例回归：出现在最近所有文章里的概念，不得因权重被稀释而显示 ↓', () => {
    // 前 10 篇只有「稳定」，后 10 篇每篇都有「稳定」外加两个别的概念。
    // 旧的权重占比算法会把「稳定」从 100% 稀释到 33% 从而显示 ↓；
    // 出现率算法看到的是 10/10 vs 10/10，正确显示 flat。
    const v = buildAggregates([...many(10, ['稳定']), ...many(10, ['稳定', '就业', '风险'])]);
    assert.equal(v.concepts.find((c) => c.canonical === '稳定')!.recentTrend, 'flat');
  });

  test('前段没有数据时不谈趋势——刚开始记录不算上升', () => {
    const v = buildAggregates(many(TREND_SEGMENT, ['稳定']));
    assert.equal(v.concepts[0].recentTrend, 'flat');
    assert.equal(v.concepts[0].trendDelta, 0);
  });

  test('小幅波动不触发箭头（差 3 篇仍是 flat，阈值为 4 篇）', () => {
    const v = buildAggregates([
      ...many(7, ['就业']), ...many(3, ['稳定']),   // prior: 稳定 3/10
      ...many(4, ['就业']), ...many(6, ['稳定']),   // recent: 稳定 6/10 → 差 3 篇
    ]);
    assert.equal(v.concepts.find((c) => c.canonical === '稳定')!.recentTrend, 'flat');
  });

  test('差 4 篇触发箭头（阈值边界）', () => {
    const v = buildAggregates([
      ...many(8, ['就业']), ...many(2, ['稳定']),   // prior: 稳定 2/10
      ...many(4, ['就业']), ...many(6, ['稳定']),   // recent: 稳定 6/10 → 差 4 篇
    ]);
    assert.equal(v.concepts.find((c) => c.canonical === '稳定')!.recentTrend, 'up');
  });

  test('浮点一致性：同样大小的差值必须给出对称结果', () => {
    // 旧实现里 1.0-0.8 得到 -0.19999999999999996 判 flat，
    // 而 0.4-0.2 得到 0.2 判 up —— 同一个差值两种结果
    assert.equal(trendDirection(10, 10, 6, 2), 'up');
    assert.equal(trendDirection(10, 10, 2, 6), 'down');
    assert.equal(trendDirection(5, 5, 5, 4), trendDirection(5, 5, 1, 0));
  });
});

describe('统计口径', () => {
  test('歧义 / 未分析出概念的记录不进主统计，但计为待分析', () => {
    const events = [
      ...many(10, ['稳定']),
      ev(['就业'], { ambiguous: true }),
      ev([]),
      ev(['风险'], { analysisStatus: 'failed' }),
    ];
    const v = buildAggregates(events);
    assert.equal(v.sampleCount, 10);
    assert.equal(v.pendingCount, 3);
    assert.ok(!v.concepts.some((c) => c.canonical === '风险'));
    assert.equal(statEvents(events).length, 10);
  });

  test('mock / demo 记录被单独计数，供面板显式标注', () => {
    const v = buildAggregates([...many(3, ['稳定']), ...many(2, ['就业'], { analysisStatus: 'demo' })]);
    assert.equal(v.syntheticCount, 2);
  });

  test('窗口只取最近 N 篇', () => {
    const v = buildAggregates([...many(30, ['房产']), ...many(20, ['AI'])], 20);
    assert.equal(v.sampleCount, 20);
    assert.ok(!v.concepts.some((c) => c.canonical === '房产'));
  });

  test('空历史不崩溃', () => {
    const v = buildAggregates([]);
    assert.equal(v.concepts.length, 0);
    assert.equal(v.concentration.state, 'collecting');
  });
});
