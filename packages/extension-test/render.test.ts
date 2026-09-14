/**
 * 面板**真实渲染**测试。
 *
 * 存在的理由：红队第四轮指出，此前 153 个测试里**没有一个渲染过面板**。
 * 于是「信息集中度 null」这种一眼可见的问题能一路活到线上——
 * service-worker 的门槛与核心库不一致，score 是 null，
 * 直接被插进 `<b>${score}</b>`，而所有测试照样全绿。
 *
 * 这里用最小 DOM 垫片真的跑一遍 Dashboard.render()，
 * 断言输出的 HTML 里不出现 null / undefined / NaN。
 */
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// —— 最小 DOM 垫片：只实现 Dashboard 真正用到的那几个方法 ——
function makeEl(): any {
  const el: any = {
    innerHTML: '',
    style: { cssText: '', setProperty() {} },
    classList: { toggle() {} },
    addEventListener() {},
    appendChild() {},
    remove() {},
    attachShadow() { const r = makeEl(); el._shadow = r; return r; },
    querySelector(sel: string) {
      if (sel === '.panel') { el._panel ??= makeEl(); return el._panel; }
      return null; // 事件绑定目标不存在时 Dashboard 用了可选链
    },
    setAttribute() {},
  };
  return el;
}
(globalThis as any).document = {
  createElement: () => makeEl(),
  documentElement: { appendChild: () => {} },
  addEventListener() {},
  visibilityState: 'visible',
};

const { Dashboard } = await import('../../extension/src/content/dashboard.ts');
import type { PanelView } from '../../extension/src/content/dashboard.ts';
const { sourceBadge } = await import('../../extension/src/content/dashboard.ts');

const settings = { collapsed: false, tintByConcentration: false, demoMode: false };
const cb = { onToggleCollapse() {}, onToggleTint() {}, onToggleDemo() {}, onDismissError() {} };

const base: PanelView = {
  state: 'ready',
  concepts: [{ label: '稳定', share: 0.4, direction: 'up' }],
  concentration: { state: 'ready', score: 55, preliminary: false, sampleCount: 20, conceptCount: 4 },
  sampleCount: 20, syntheticCount: 0, pendingCount: 0, analyzingCount: 0,
  sourceBreakdown: { llm: 20, mock: 0, demo: 0, enriched: 0, other: 0 },
  demoMode: false, error: null, zhihuSearchEnabled: false, analyzeEndpointConfigured: true,
};

// 垫片记录最后一次写入的 innerHTML
let lastHtml = '';
const origMake = makeEl;
function makeCapturingEl(): any {
  const el = origMake();
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html ?? ''; },
    set(v: string) { el._html = v; if (v.includes('panel') === false) lastHtml = v; },
    configurable: true,
  });
  const q = el.querySelector.bind(el);
  el.querySelector = (sel: string) => {
    if (sel === '.panel') { el._panel ??= makeCapturingEl(); return el._panel; }
    return q(sel);
  };
  el.attachShadow = () => { const r = makeCapturingEl(); el._shadow = r; return r; };
  return el;
}
(globalThis as any).document.createElement = () => makeCapturingEl();

describe('面板渲染绝不输出 null / undefined / NaN', () => {
  const cases: Array<[string, PanelView]> = [
    ['ready', base],
    ['ready 初步', { ...base, concentration: { state: 'ready', score: 40, preliminary: true, sampleCount: 13, conceptCount: 3 }, sampleCount: 13 }],
    ['collecting', { ...base, state: 'collecting', concentration: { state: 'collecting', sampleCount: 6, needed: 10 }, sampleCount: 6 }],
    ['empty', { ...base, state: 'empty', concepts: [], sampleCount: 0, sourceBreakdown: { llm: 0, mock: 0, demo: 0, enriched: 0, other: 0 } }],
    ['analyzing', { ...base, state: 'analyzing', concepts: [], analyzingCount: 1, sampleCount: 0 }],
    ['error 横幅', { ...base, error: 'network_error' }],
    ['demo 混合', { ...base, sourceBreakdown: { llm: 10, mock: 5, demo: 5, enriched: 0, other: 0 } }],
    // 关键回归：上游状态判断出错，score 是 null 却仍标成 ready
    ['ready 但 score 为 null（上游门槛不一致）', {
      ...base, state: 'ready',
      concentration: { state: 'ready', score: null as unknown as number, preliminary: false, sampleCount: 7, conceptCount: 2 },
      sampleCount: 7,
    }],
    ['ready 但 score 为 NaN', {
      ...base, state: 'ready',
      concentration: { state: 'ready', score: NaN, preliminary: false, sampleCount: 12, conceptCount: 2 },
    }],
  ];

  for (const [name, view] of cases) {
    test(`${name} 状态下不出现 null/undefined/NaN`, () => {
      lastHtml = '';
      const d = new Dashboard({ ...settings }, cb);
      d.render(view);
      assert.ok(lastHtml.length > 0, '没有渲染出任何内容');
      for (const bad of ['null', 'undefined', 'NaN']) {
        assert.ok(!lastHtml.includes(bad), `渲染结果里出现了「${bad}」：\n${lastHtml.slice(0, 300)}`);
      }
    });
  }

  test('折叠态同样不出现 null', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings, collapsed: true }, cb);
    d.render({ ...base, concentration: { state: 'ready', score: null as unknown as number, preliminary: false, sampleCount: 7, conceptCount: 1 } });
    assert.ok(!lastHtml.includes('null'), lastHtml);
  });

  test('初步分数会在界面上被标出来', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render({ ...base, concentration: { state: 'ready', score: 40, preliminary: true, sampleCount: 13, conceptCount: 3 } });
    assert.ok(lastHtml.includes('初步'), '10–19 篇的初步分数在界面上与正式分数无法区分');
  });

  test('混入 mock/demo 时徽标必须是「演示数据」', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render({ ...base, sourceBreakdown: { llm: 19, mock: 1, demo: 0, enriched: 0, other: 0 } });
    assert.ok(lastHtml.includes('演示数据'), '有 mock 却没打演示标记');
  });
});

describe('胶囊态必须保留演示数据标记（红队 R7-4）', () => {
  /**
   * 整个现场降级预案（真实分析挂了就切演示模式）都建立在
   * 「演示数据」标记一定看得见之上。而胶囊态原本连徽标都不渲染，
   * 1150–1350px 的窗口宽度必然落进胶囊态 —— 评委会看到一个没有任何标记的面板。
   */
  test('#capsule 的实现里必须引用 sourceBadge', () => {
    const src = readFileSync(
      new URL('../../extension/src/content/dashboard.ts', import.meta.url), 'utf8');
    const m = src.match(/#capsule\([^)]*\):\s*string\s*\{([\s\S]*?)\n  \}/);
    assert.ok(m, '找不到 #capsule 的方法定义');
    assert.match(m![1], /sourceBadge/, '胶囊态没有读 sourceBadge，mock 数据会显示成实时分析');
  });

  test('sourceBadge 对 19 llm + 1 mock 仍判 demo（不按多数决）', () => {
    const zero = { llm: 0, mock: 0, demo: 0, enriched: 0, other: 0 };
    assert.equal(sourceBadge({ ...zero, llm: 19, mock: 1 })?.kind, 'demo');
    assert.equal(sourceBadge({ ...zero, llm: 99, demo: 1 })?.kind, 'demo');
    assert.equal(sourceBadge({ ...zero, llm: 20 })?.kind, 'llm');
  });
});

/**
 * sourceBadge 的 fail-closed 行为。
 *
 * 这条测试的来历：给作品链接做截图时，脚本只传了 `{mock:20, llm:0}`，
 * `b.mock + b.demo` 变成 NaN，判断全部落空，**面板显示 20 条演示数据却没有任何标记**。
 * 这个项目从第四轮起反复在防的就是这一件事，而它差点被贴到封面上。
 */
describe('sourceBadge 缺字段时必须 fail closed', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['只有 mock 和 llm', { mock: 20, llm: 0 }],
    ['缺 demo', { mock: 3, llm: 5, enriched: 0, other: 0 }],
    ['缺 mock', { demo: 0, llm: 5, enriched: 0, other: 0 }],
    ['字段是字符串', { mock: '20', demo: 0, llm: 0, enriched: 0, other: 0 }],
    ['全空对象', {}],
  ];
  for (const [name, b] of cases) {
    test(`${name} → 仍然标「演示数据」，不会静默无标记`, () => {
      const badge = sourceBadge(b as never);
      assert.ok(badge, `${name}：返回了 null —— 面板会一个标记都不显示`);
      assert.equal(badge.kind, 'demo');
    });
  }

  test('字段齐全且全是真实分析时才显示「AI 分析」', () => {
    const badge = sourceBadge({ llm: 12, mock: 0, demo: 0, enriched: 0, other: 0 });
    assert.equal(badge?.kind, 'llm');
  });
});

/**
 * 「还要读几篇」的分母必须跟着真实门槛走。
 *
 * 这条测试的来历：模板里硬编码了 `/5`，而 `concentration.ts` 的 MIN_SAMPLES 是 **10**，
 * 而且 `needed` 早就一路传进 view 类型里了 —— 模板把它扔了。
 * 后果落在 happy path 正中央：评委装上、认真读 5 篇、面板写着「5/5 篇」，
 * 然后什么也不发生，要读到第 10 篇才出分。
 */
describe('数据积累中的分母跟着 MIN_SAMPLES 走', () => {
  test('面板显示的分母 == concentration 报的 needed，且不是写死的 5', async () => {
    const { MIN_SAMPLES } = await import('../core/src/concentration.ts');
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render({
      ...base,
      // state 必须一起改成 collecting —— 真实链路里它由 service-worker 按
      // MIN_SAMPLES 判定（见 service-worker.ts:84），两者不会不一致。
      state: 'collecting',
      concentration: { state: 'collecting', sampleCount: 5, needed: MIN_SAMPLES },
      concepts: [], sampleCount: 5,
    } as never);
    const seen = (lastHtml.match(/已记录[^<]*/) ?? ['(没找到"已记录"这段)'])[0];
    assert.match(lastHtml, new RegExp(`5\\s*/\\s*${MIN_SAMPLES}\\s*篇`),
      `面板写的分母不是 ${MIN_SAMPLES}。实际渲染出来的是：${seen}`);
    assert.doesNotMatch(lastHtml, /已记录\s*\d+\s*\/\s*5\s*篇/,
      '分母还是写死的 5 —— 读满 5 篇的人会以为该出分了，其实还要再读 5 篇');
  });

  test('门槛真的是 10：读满 5 篇时仍然是 collecting，10 篇才 ready', async () => {
    const { buildAggregates } = await import('../core/src/aggregate.ts');
    const ev = (i: number) => ({
      id: `a${i}`, contentType: 'answer', title: `t${i}`, timestamp: i, duration: 9000,
      concepts: [{ canonical: '稳定', confidence: 0.9 }],
      analysisStatus: 'llm', analysisVersion: 'x',
    });
    const at5 = buildAggregates(Array.from({ length: 5 }, (_, i) => ev(i)) as never).concentration as never as { state: string; needed: number };
    const at10 = buildAggregates(Array.from({ length: 10 }, (_, i) => ev(i)) as never).concentration as never as { state: string };
    assert.equal(at5.state, 'collecting');
    assert.equal(at5.needed, 10, 'needed 不是 10 —— 面板文案会跟着错');
    assert.equal(at10.state, 'ready');
  });
});
