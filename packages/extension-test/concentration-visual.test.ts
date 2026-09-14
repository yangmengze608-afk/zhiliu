/**
 * 集中度视觉编码：靛青 #1661AB → 鹅血石红 #AB372F。
 *
 * **这个模块还没有接进出货路径**，但它已经在源码树里，就得有测试守着。
 *
 * 守的是四条产品性约束，不是审美偏好：
 *   ① 两端必须精确落在那两个中国传统色上 —— 它们是产品身份，不是随手挑的蓝红
 *   ② 色相只能走**经紫**那一侧；穿绿/黄会既难看又把语义带偏
 *   ③ 颜色连续（硬切会暗示"越过了一条我们自己划的线"）
 *   ④ 背景是最大面积的色块，必须压住 —— 整块高饱和红会被读成报错
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  concentrationVisual, rampAt, rampOklch, scaleHtml, LEVEL_EDGES, EFFECTIVE_EDGES,
  ANCHOR_HEXES, RAMP_LOW, RAMP_HIGH,
} from '../../extension/src/content/concentration-visual.ts';
import { hexToOklch, oklchToHex } from '../../extension/src/content/oklch.ts';

const alphaOf = (c: string): number => Number((c.match(/,\s*([\d.]+)\s*\)$/) ?? [])[1] ?? 1);

describe('① 两端就是那两个传统色', () => {
  test('0 = 靛青 #1661AB，100 = 鹅血石红 #AB372F', () => {
    assert.equal(rampAt(0).toLowerCase(), '#1661ab');
    assert.equal(rampAt(100).toLowerCase(), '#ab372f');
    assert.equal(RAMP_LOW.toUpperCase(), '#1661AB');
    assert.equal(RAMP_HIGH.toUpperCase(), '#AB372F');
  });

  test('端点不因浮点往返而漂移', () => {
    // 越界分数也要夹回端点本身
    assert.equal(rampAt(-10).toLowerCase(), '#1661ab');
    assert.equal(rampAt(150).toLowerCase(), '#ab372f');
  });
});

describe('② 色相走经紫那一侧，全程不碰绿/黄', () => {
  test('逐分检查：OKLCH 色相不进入绿黄区（90°–180°）', () => {
    for (let s = 0; s <= 100; s++) {
      const h = rampOklch(s).h;
      assert.ok(h < 90 || h > 180, `score ${s} 的色相 ${h.toFixed(1)}° 落进绿黄区`);
    }
  });

  test('路径依次经过 蓝 → 蓝紫 → 紫 → 紫红 → 红', () => {
    // 色相从 253° 单调升到 388°(=28°)。展开成不回绕的角度来判单调。
    const start = rampOklch(0).h;
    let unwrapped = start, prev = start;
    const seq: number[] = [start];
    for (let s = 1; s <= 100; s++) {
      const h = rampOklch(s).h;
      let d = h - prev;
      if (d < -180) d += 360;
      if (d > 180) d -= 360;
      unwrapped += d; prev = h; seq.push(unwrapped);
    }
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] >= seq[i - 1] - 1e-9, `色相在 score ${i} 回头了`);
    }
    assert.ok(seq[seq.length - 1] - seq[0] > 120, '色相总跨度太小，看不出过渡');
    assert.ok(seq[seq.length - 1] - seq[0] < 180, '色相跨度过大，可能绕反了方向');
  });

  test('中段不浑浊：彩度始终不低于两端的八成', () => {
    const floor = Math.min(rampOklch(0).c, rampOklch(100).c) * 0.8;
    for (let s = 0; s <= 100; s += 2) {
      assert.ok(rampOklch(s).c >= floor, `score ${s} 彩度 ${rampOklch(s).c.toFixed(3)} 掉到了 ${floor.toFixed(3)} 以下`);
    }
  });

  test('全程不超出 sRGB 色域（超了会被降彩度，反而更脏）', () => {
    for (let s = 0; s <= 100; s += 2) {
      const want = rampOklch(s);
      const got = hexToOklch(oklchToHex(want));
      assert.ok(want.c - got.c < 0.008,
        `score ${s} 被色域裁掉了 ${(want.c - got.c).toFixed(3)} 的彩度`);
    }
  });
});

describe('③ 颜色连续，文字才分档', () => {
  test('相邻分数的色相变化都很小', () => {
    let prev = rampOklch(0).h;
    for (let s = 1; s <= 100; s++) {
      const h = rampOklch(s).h;
      const d = Math.min(Math.abs(h - prev), 360 - Math.abs(h - prev));
      // 上限 3°：中段是刻意加速的（见 ANCHORS），但仍要小到看不出台阶
      assert.ok(d <= 3, `score ${s - 1}→${s} 色相跳了 ${d.toFixed(2)}°`);
      prev = h;
    }
  });

  test('档位边界上颜色不跳，但文案要换', () => {
    for (const e of LEVEL_EDGES) {
      const a = rampOklch(e).h, b = rampOklch(e + 1).h;
      assert.ok(Math.abs(b - a) <= 3, `档位边界 ${e} 上色相跳了`);
      assert.notEqual(concentrationVisual(e).level, concentrationVisual(e + 1).level);
    }
  });
});

describe('④ 强度分配：背景最弱', () => {
  test('背景 alpha 封顶 0.18', () => {
    for (let s = 0; s <= 100; s += 5) {
      const a = alphaOf(concentrationVisual(s).tint);
      assert.ok(a <= 0.18, `score ${s} 的背景 alpha ${a} 超了`);
    }
  });

  test('背景比分数和竖轨都暗 —— 大面积的那个必须沉下去', () => {
    for (const s of [10, 40, 70, 95]) {
      const v = concentrationVisual(s);
      const tintHex = v.tint.match(/rgba\((\d+), (\d+), (\d+)/)!;
      const tintL = hexToOklch('#' + [1, 2, 3].map((i) => Number(tintHex[i]).toString(16).padStart(2, '0')).join('')).l;
      assert.ok(tintL < hexToOklch(v.scoreColor).l, `score ${s}：背景比分数还亮`);
      assert.ok(tintL < hexToOklch(v.railColor).l, `score ${s}：背景比竖轨还亮`);
    }
  });

  test('分数颜色在深色面板上够亮（可读）', () => {
    for (let s = 0; s <= 100; s += 10) {
      const l = hexToOklch(concentrationVisual(s).scoreColor).l;
      assert.ok(l > 0.62, `score ${s} 的分数颜色明度只有 ${l.toFixed(2)}，深色面板上读不清`);
    }
  });

  test('竖轨宽度单调增长 —— 不依赖颜色的冗余通道', () => {
    const w = [0, 25, 50, 75, 100].map((s) => concentrationVisual(s).railWidth);
    for (let i = 1; i < w.length; i++) assert.ok(w[i] >= w[i - 1], `竖轨宽度不单调：${w.join(',')}`);
    assert.equal(w[0], 2);
    assert.equal(w[w.length - 1], 5);
  });
});

describe('文字只描述分布形状', () => {
  test('不出现任何价值判断词', () => {
    const banned = /茧房|偏食|健康|危险|警告|良好|优秀|问题|风险|严重|正常|异常|安全/;
    for (let s = 0; s <= 100; s += 5) {
      assert.doesNotMatch(concentrationVisual(s).label, banned);
    }
  });

  test('有效概念数就是 1/Simpson', () => {
    assert.equal(concentrationVisual(50).effectiveConcepts, 2);
    assert.equal(concentrationVisual(25).effectiveConcepts, 4);
    assert.ok(Number.isNaN(concentrationVisual(0).effectiveConcepts));
  });

  test('四档文案互不相同，且档位是按有效概念数切的', () => {
    const labels = [10, 30, 50, 80].map((s) => concentrationVisual(s).label);
    assert.equal(new Set(labels).size, 4, `四档文案出现重复：${labels.join(' / ')}`);
    // 边界就是 1/Simpson 的 4.0 / 2.5 / 1.5 个
    for (const e of EFFECTIVE_EDGES) {
      const inside = concentrationVisual(100 / e);
      const outside = concentrationVisual(100 / (e - 0.05));
      assert.equal(inside.effectiveConcepts, Math.round(e * 10) / 10);
      assert.notEqual(inside.level, outside.level, `有效概念数 ${e} 这条边界没换档`);
    }
  });

  test('55 和 80 不再共用同一句话 —— 这是第 20 轮真人反馈的那一条', () => {
    assert.notEqual(concentrationVisual(55).label, concentrationVisual(80).label);
    assert.notEqual(concentrationVisual(55).level, concentrationVisual(80).level);
  });
});

describe('连续量尺', () => {
  test('标记位置跟着分数走，轨道画的就是这条色谱', () => {
    assert.match(scaleHtml(concentrationVisual(64)), /left:64\.0%/);
    const html = scaleHtml(concentrationVisual(50));
    assert.match(html, /linear-gradient\(90deg/);
    assert.ok(html.includes('#1661ab') && html.includes('#ab372f'), '轨道两端不是那两个传统色');
  });
});

describe('⑤ 非匀速：两端慢、中段快', () => {
  test('五个锚点，头尾就是那两个传统色', () => {
    assert.equal(ANCHOR_HEXES.length, 5);
    assert.equal(ANCHOR_HEXES[0].toLowerCase(), '#1661ab');
    assert.equal(ANCHOR_HEXES[4].toLowerCase(), '#ab372f');
    assert.equal(new Set(ANCHOR_HEXES).size, 5, '锚点有重复，等于少了一个锚点');
  });

  /** 展开成不回绕的色相，方便直接比较"走了多远"。 */
  const unwrap = (s: number): number => {
    const h = rampOklch(s).h;
    return h < rampOklch(0).h - 1e-9 ? h + 360 : h;
  };
  const travelled = (s: number): number => unwrap(s) - rampOklch(0).h;

  test('低分区仍然是靛青/蓝 —— 25 分不许已经明显紫化', () => {
    assert.ok(travelled(25) < 15, `25 分已经走了 ${travelled(25).toFixed(1)}°，太早离开蓝`);
    assert.ok(rampOklch(25).h < 270, `25 分色相 ${rampOklch(25).h.toFixed(1)}° 已经是紫了`);
  });

  test('36 分开始进入紫区，但还没走完一半', () => {
    const t = travelled(36);
    assert.ok(t > 20 && t < 50, `36 分走了 ${t.toFixed(1)}°，不在"刚进紫"的范围里`);
  });

  test('80 分已经在红系，不再是品红', () => {
    const h = rampOklch(80).h;
    // 鹅血石红 27.8°、纯红约 29°。落在 5–25° 才算红家族；0° 附近是品红/玫红
    assert.ok(h > 5 && h < 25, `80 分色相 ${h.toFixed(1)}°，不在红系区间`);
    const toHigh = Math.abs(h - rampOklch(100).h);
    assert.ok(toHigh < 25, `80 分离鹅血石红还有 ${toHigh.toFixed(1)}°，太远`);
  });

  test('确实是非匀速 —— 中段速度至少是低分区的两倍', () => {
    const slow = travelled(25) / 25;              // 0–25 每分走多少度
    const fast = (travelled(65) - travelled(35)) / 30; // 35–65 每分走多少度
    assert.ok(fast > slow * 2, `中段 ${fast.toFixed(2)}°/分 没比低分区 ${slow.toFixed(2)}°/分 快一倍以上`);
    // 反过来钉死：匀速插值会让这两个数几乎相等，这条测试就会红
  });

  test('高分区减速 —— 65 之后是"逐步靠近"，不是又冲过去', () => {
    const fast = (travelled(65) - travelled(35)) / 30;
    const tail = (travelled(100) - travelled(80)) / 20;
    assert.ok(tail < fast, `尾段 ${tail.toFixed(2)}°/分 没比中段 ${fast.toFixed(2)}°/分 慢`);
  });
});

describe('⑥ 概念条随集中度降饱和', () => {
  test('概念条彩度始终低于色谱本身', () => {
    for (let s = 0; s <= 100; s += 5) {
      const ramp = rampOklch(s).c;
      const bar = hexToOklch(concentrationVisual(s).barColor).c;
      assert.ok(bar < ramp, `score ${s}：概念条彩度 ${bar.toFixed(3)} 没有低于色谱 ${ramp.toFixed(3)}`);
    }
  });

  test('降幅随集中度单调增大，高分区明显更收', () => {
    const drop = (s: number): number => 1 - hexToOklch(concentrationVisual(s).barColor).c / rampOklch(s).c;
    const ds = [0, 25, 50, 75, 100].map(drop);
    for (let i = 1; i < ds.length; i++) {
      assert.ok(ds[i] > ds[i - 1], `降幅不单调：${ds.map((d) => (d * 100).toFixed(0) + '%').join(',')}`);
    }
    assert.ok(drop(80) > drop(25) * 2, '高分区的降饱和不够明显');
  });

  test('但也不能收成脏灰 —— 概念条彩度有下限', () => {
    for (let s = 0; s <= 100; s += 5) {
      const bar = hexToOklch(concentrationVisual(s).barColor).c;
      assert.ok(bar > 0.09, `score ${s}：概念条彩度 ${bar.toFixed(3)} 已经接近灰`);
    }
  });

  test('强度排序不变：分数 ≥ 竖轨 > 概念条 > 背景', () => {
    for (const s of [10, 40, 70, 95]) {
      const v = concentrationVisual(s);
      const cScore = hexToOklch(v.scoreColor).c;
      const cBar = hexToOklch(v.barColor).c;
      assert.ok(hexToOklch(v.scoreColor).l > hexToOklch(v.barColor).l, `score ${s}：概念条比分数还亮`);
      assert.ok(cScore > cBar, `score ${s}：概念条比分数还艳`);
    }
  });
});
