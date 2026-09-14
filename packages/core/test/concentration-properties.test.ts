/**
 * 信息集中度的**性质测试**。
 *
 * 这些不是"跑一遍看看对不对"，而是把指标必须满足的数学性质写死。
 * 上一版归一化熵正是在性质 D（样本量不变性）上失败的：
 * 行为不变的读者 n=5 中位 43、n=20 约 21，分数腰斩却与内容无关。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDistribution, concentration, WINDOW_SIZE, MIN_SAMPLES, FULL_SAMPLES,
} from '../src/index.ts';
import type { ReadingRecord } from '../src/index.ts';

let seq = 0;
const rec = (labels: string[]): ReadingRecord => ({
  id: `r${seq++}`, url: '', title: 't', readAt: seq,
  concepts: labels.map((l) => ({ label: l, confidence: 0.9 })),
  analysisStatus: 'grounded',
});
const many = (n: number, labels: string[]) => Array.from({ length: n }, () => rec(labels));
const score = (recs: ReadingRecord[], w = WINDOW_SIZE) => {
  const r = concentration(buildDistribution(recs, w));
  return r.state === 'ready' ? r.score : null;
};

describe('性质 A：单一概念 → 接近最大', () => {
  test('20 篇全是同一个概念 → 100', () => {
    assert.equal(score(many(20, ['稳定'])), 100);
  });
  test('19 篇同一概念 + 1 篇别的 → 仍然很高但不足 100', () => {
    const s = score([...many(19, ['稳定']), ...many(1, ['AI'])])!;
    assert.ok(s > 88 && s < 100, `实际 ${s}`);
  });
});

describe('性质 B / C：均匀分布随概念数单调下降', () => {
  const uniform = (k: number) =>
    Array.from({ length: k }, (_, i) => many(20 / k, [`c${i}`])).flat();

  test('4 个概念完全均匀 → 25，明显低于单一概念', () => {
    assert.equal(score(uniform(4)), 25);
  });
  test('10 个概念完全均匀 → 10，进一步降低', () => {
    assert.equal(score(uniform(10)), 10);
  });
  test('单一 > 2 > 4 > 5 > 10 严格单调', () => {
    const s = [1, 2, 4, 5, 10].map((k) => score(uniform(k))!);
    for (let i = 1; i < s.length; i++) {
      assert.ok(s[i] < s[i - 1], `k=${[1,2,4,5,10][i]} 的分数 ${s[i]} 不低于前一档 ${s[i-1]}`);
    }
  });
});

describe('性质 D：同分布复制样本，分数不因样本量改变', () => {
  test('把同一分布的样本量翻倍，分数严格不变', () => {
    const base = ['a', 'b', 'c', 'd'].flatMap((l) => many(5, [l]));
    const doubled = [...base, ...base];
    // 窗口都取 40，让两者的 n 真的不同（20 vs 40）
    assert.equal(score(base, 40), score(doubled, 40),
      '样本量本身改变了分数——这正是旧的归一化熵实现的致命缺陷');
  });

  test('三倍、五倍同样不变', () => {
    // base 必须 >= MIN_SAMPLES，否则它自己不出分，比较的是 null
    const base = ['a', 'b', 'c'].flatMap((l) => many(4, [l]));
    const s1 = score(base, 100);
    assert.equal(score([...base, ...base, ...base], 100), s1);
    assert.equal(score(Array.from({ length: 5 }, () => base).flat(), 100), s1);
  });
});

describe('性质 E：与文章顺序无关', () => {
  test('打乱顺序不改变分数', () => {
    const recs = [...many(8, ['稳定']), ...many(6, ['就业']), ...many(6, ['AI'])];
    const shuffled = [...recs].sort(() => (seq % 3) - 1);
    assert.equal(score(recs), score(shuffled));
  });
});

describe('性质 F：拆出更多次要概念不产生异常巨大偏移', () => {
  test('每篇从 1 个概念拆成 2 个，分数下降但不崩塌', () => {
    const one = score(many(20, ['稳定']))!;
    const two = score(many(20, ['稳定', '就业']))!;
    assert.equal(one, 100);
    // 两个概念各占一半 → Σp² = 0.5 → 50。是可解释的，不是断崖
    assert.equal(two, 50);
  });

  test('主概念稳定时，增加长尾次要概念的影响是渐进的', () => {
    const main = many(16, ['稳定']);
    const s1 = score([...main, ...many(4, ['就业'])])!;
    const s2 = score([...main, ...many(2, ['就业']), ...many(2, ['风险'])])!;
    const s3 = score([...main, rec(['就业']), rec(['风险']), rec(['AI']), rec(['房产'])])!;
    // 长尾越碎分数越低，但每一步的跌幅都是个位数
    assert.ok(s1 >= s2 && s2 >= s3, `不单调：${s1} ${s2} ${s3}`);
    assert.ok(s1 - s3 < 15, `长尾细分造成 ${s1 - s3} 分的跳变，过大`);
  });
});

describe('性质 G：固定窗口滑动时，变化只来自内容', () => {
  test('窗口内容不变、总历史变长，分数不变', () => {
    const recent20 = ['a', 'b', 'c', 'd'].flatMap((l) => many(5, [l]));
    const older = many(50, ['稳定']); // 早已滑出窗口
    assert.equal(score(recent20), score([...older, ...recent20]),
      '窗口外的历史影响了分数');
  });

  test('窗口滑动后分数随新内容改变', () => {
    const start = many(20, ['稳定']);
    const slid = [...start, ...many(20, ['a', 'b'])]; // 全部换成两概念文章
    assert.equal(score(start), 100);
    assert.equal(score(slid), 50);
  });
});

describe('出分门槛', () => {
  test('少于 10 篇不出分', () => {
    for (const n of [1, 5, 9]) {
      const r = concentration(buildDistribution(many(n, ['稳定'])));
      assert.equal(r.state, 'collecting', `${n} 篇不应出分`);
      if (r.state === 'collecting') assert.equal(r.needed, MIN_SAMPLES);
    }
  });

  test('10–19 篇出分但标记为初步', () => {
    for (const n of [10, 15, 19]) {
      const r = concentration(buildDistribution(many(n, ['稳定'])));
      assert.equal(r.state, 'ready');
      if (r.state === 'ready') assert.equal(r.preliminary, true, `${n} 篇应标记初步`);
    }
  });

  test('满 20 篇为正式分数', () => {
    const r = concentration(buildDistribution(many(FULL_SAMPLES, ['稳定'])));
    if (r.state === 'ready') assert.equal(r.preliminary, false);
  });
});

describe('可解释性：分数等于"随机抽两次抽到同一概念的概率"', () => {
  test('50/50 两概念 → 0.5² + 0.5² = 0.5 → 50', () => {
    assert.equal(score([...many(10, ['a']), ...many(10, ['b'])]), 50);
  });
  test('80/20 两概念 → 0.8² + 0.2² = 0.68 → 68', () => {
    assert.equal(score([...many(16, ['a']), ...many(4, ['b'])]), 68);
  });
});
