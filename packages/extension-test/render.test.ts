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
    /** 记下写进去的 CSS 变量 —— 集中度的颜色编码就是走这条路进面板的，
        setProperty 是空实现的话，"接线了没有"这件事根本测不到。 */
    _props: {} as Record<string, string>,
    style: {
      cssText: '',
      setProperty(k: string, v: string) { el._props[k] = v; },
      getPropertyValue(k: string) { return el._props[k] ?? ''; },
    },
    /** 记下最后一次 toggle 的结果，测试要断言 dock / dock-open 这些类。 */
    _classes: new Set<string>(),
    classList: {
      toggle(name: string, on?: boolean) {
        if (on === true) el._classes.add(name);
        else if (on === false) el._classes.delete(name);
        else el._classes.has(name) ? el._classes.delete(name) : el._classes.add(name);
      },
    },
    addEventListener() {},
    appendChild() {},
    remove() {},
    attachShadow() { const r = makeEl(); el._shadow = r; lastHost = el; return r; },
    querySelector(sel: string) {
      if (sel === '.panel') { el._panel ??= makeEl(); return el._panel; }
      // 事件绑定目标：返回一个能**记住 handler** 的壳，
      // 这样 dock 的「点开 → 收回」闭环可以在测试里真的走一遍，
      // 而不是写一句 assert.ok(true) 假装测过。
      if (sel === '.dock-tab' || sel === '.dock-close') {
        el._handlers ??= {};
        const key = sel;
        return {
          addEventListener(_type: string, fn: () => void) { el._handlers[key] = fn; },
        };
      }
      return null; // 其余绑定目标不存在时 Dashboard 用了可选链
    },
    setAttribute() {},
  };
  return el;
}

/** 最近一次被 attachShadow 的宿主。Dashboard 的 #host 是私有字段，只能从这里拿。 */
let lastHost: any = null;

/** 触发 dock 上的某个按钮。找不到 handler 说明那个按钮压根没渲染出来。 */
function clickIn(sel: '.dock-tab' | '.dock-close'): void {
  // #wire 收到的是 .panel，所以 handler 挂在 shadow root 的 _panel 上
  const fn = lastHost?._shadow?._panel?._handlers?.[sel];
  assert.ok(typeof fn === 'function', `${sel} 没有被渲染/绑定`);
  fn();
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
const { concentrationVisual } = await import('../../extension/src/content/concentration-visual.ts');
const { hexToOklch } = await import('../../extension/src/content/oklch.ts');
/** dashboard.ts 的 STYLE 是模块私有的，只能读源码断言。 */
const DASHBOARD_SRC = readFileSync(
  new URL('../../extension/src/content/dashboard.ts', import.meta.url), 'utf8');

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
  el.attachShadow = () => { const r = makeCapturingEl(); el._shadow = r; lastHost = el; return r; };
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

/**
 * 不可采集的页面上，面板要明确说「这一页不记录」，而不是靠消失来表达。
 */
describe('当前页面不记录 · 状态行', () => {
  test('collecting=false → 出现状态行', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render({ ...base, collecting: false } as never);
    assert.match(lastHtml, /当前页面不记录/, `没渲染出状态行：\n${lastHtml.slice(0, 400)}`);
    assert.match(lastHtml, /仅展示最近信息/);
  });

  test('collecting=true → 不出现（不要在正常页面上制造噪音）', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render({ ...base, collecting: true } as never);
    assert.doesNotMatch(lastHtml, /当前页面不记录/);
  });

  test('没给 collecting → 按"在采集"渲染，不确定时不主动报警', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render({ ...base } as never);
    assert.doesNotMatch(lastHtml, /当前页面不记录/);
  });

  test('状态行不冒充错误：不带 error 样式，也不吞掉已有历史', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render({ ...base, collecting: false } as never);
    // 历史照常渲染
    assert.match(lastHtml, /稳定/, '不可采集时把已有历史也吞掉了');
    assert.doesNotMatch(lastHtml, /分析暂时不可用/);
  });
});

/**
 * dock 的交互闭环：窄条 → 点开 → 收回窄条。
 *
 * 关键是**收回**这一步。dock 展开之后是 224px，会盖住知乎的右侧栏 ——
 * 那是用户主动点开的浮层，可以接受；但如果收不回去，它就变成了
 * "面板默认铺开压着侧栏"，正是这一轮明确不要的东西。
 */
describe('dock 交互闭环', () => {
  const dockLayout = { contentLeft: null, headerBottom: 52, viewportWidth: 1440 };

  test('默认是窄条；点开变完整；关闭回到窄条', () => {
    const d = new Dashboard({ ...settings }, cb);
    d.applyLayout(dockLayout as never);

    lastHtml = '';
    d.render({ ...base, collecting: false } as never);
    assert.match(lastHtml, /dock-tab/, '默认不是窄条');
    assert.doesNotMatch(lastHtml, /最近 20 篇/, '窄条里不该塞完整内容');

    // 点开
    clickIn('.dock-tab');
    assert.match(lastHtml, /最近 20 篇/, '点开之后没有渲染完整内容');
    assert.match(lastHtml, /dock-close/, '展开态没有收回按钮 —— 那就收不回去了');
    assert.match(lastHtml, /当前页面不记录/, '展开之后应该看得到采集状态');

    // 收回
    clickIn('.dock-close');
    assert.match(lastHtml, /dock-tab/, '没有回到窄条');
    assert.doesNotMatch(lastHtml, /最近 20 篇/);
  });

  test('窄条里只有品牌和计数，没有被裁一半的状态行', () => {
    const d = new Dashboard({ ...settings }, cb);
    d.applyLayout(dockLayout as never);
    lastHtml = '';
    d.render({ ...base, collecting: false, sampleCount: 20 } as never);
    assert.match(lastHtml, /知流/);
    assert.match(lastHtml, /dock-n[^>]*>20</, '计数没渲染出来');
    // 40px 宽塞「当前页面不记录 · 仅展示最近信息」只会被裁掉，裁一半比不说更糟
    assert.doesNotMatch(lastHtml, /当前页面不记录/);
  });

  test('有安全 gutter 时不该退成 dock —— 完整面板优先', () => {
    const d = new Dashboard({ ...settings }, cb);
    const l = d.applyLayout({ contentLeft: 209, headerBottom: 52, viewportWidth: 1450 } as never);
    assert.equal(l.mode, 'full', '有 209px gutter 还退成 dock');
  });
});

/**
 * 位置选择器：轻量、默认不用碰，但点了要真的生效并落盘。
 */
describe('位置选择器', () => {
  test('三个选项都渲染，当前项标成选中', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings, panelSide: 'left' } as never, cb);
    d.render({ ...base } as never);
    assert.match(lastHtml, /data-side="left"/);
    assert.match(lastHtml, /data-side="right"/);
    assert.match(lastHtml, /data-side="auto"/);
    assert.match(lastHtml, /class="side-btn on" data-side="left"/, '当前项没有高亮');
  });

  test('偏好是 right 时高亮 right', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings, panelSide: 'right' } as never, cb);
    d.render({ ...base } as never);
    assert.match(lastHtml, /class="side-btn on" data-side="right"/);
    assert.doesNotMatch(lastHtml, /class="side-btn on" data-side="left"/);
  });

  test('窄条态里不塞位置选择器（40px 放不下）', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings } as never, cb);
    d.applyLayout({ contentLeft: null, headerBottom: 52, viewportWidth: 1440 } as never);
    d.render({ ...base } as never);
    assert.doesNotMatch(lastHtml, /side-btn/, '窄条里塞了位置选择器，会被裁掉');
  });
});

/**
 * 位置 fallback **绝不能回写偏好**。
 *
 * 上一条测试验的是 `computeLayout` 这个纯函数。这条验的是面板本身 ——
 * 真正会落盘的是 `onSetSide`，所以要钉死：**只有用户点击**才触发它，
 * 布局被迫换边不触发。
 */
describe('位置 fallback 不写回用户偏好', () => {
  test('偏好侧塞不下而换到对面时，onSetSide 一次都不被调用', () => {
    const calls: string[] = [];
    const d = new Dashboard(
      { ...settings, panelSide: 'left' },
      { ...cb, onSetSide: (side: string) => calls.push(side) },
    );
    d.render(base);
    // 正文顶到左边缘：左侧连 40px 贴边都放不下 → 会退到右边缘
    d.applyLayout({ contentLeft: 0, headerBottom: 52, contentRight: 900, viewportWidth: 1440 });
    // 再回到一张正常页面
    d.applyLayout({ contentLeft: 209, headerBottom: 52, contentRight: 1241, viewportWidth: 1450 });
    assert.deepEqual(calls, [], `布局 fallback 把偏好写回去了：${calls.join(',')}`);
  });

  test('被迫换边之后，回到正常页面时选择器仍然高亮「左」', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings, panelSide: 'left' }, cb);
    // 先经历一张会触发 fallback 的页面（正文顶到左边缘 → 退右边缘 dock）
    d.applyLayout({ contentLeft: 0, headerBottom: 52, contentRight: 900, viewportWidth: 1440 });
    // 再回到正常页面：这时才会渲染出带侧别选择器的完整面板
    d.applyLayout({ contentLeft: 209, headerBottom: 52, contentRight: 1241, viewportWidth: 1450 });
    d.render(base);
    assert.ok(lastHtml.includes('side-btn'), '没渲染出侧别选择器，这条测试没验到东西');
    assert.match(lastHtml, /class="side-btn on" data-side="left"/,
      `被迫换边之后选择器不再高亮「左」：\n${lastHtml.slice(0, 800)}`);
    assert.doesNotMatch(lastHtml, /class="side-btn on" data-side="right"/,
      'fallback 把「右」变成了用户偏好');
  });
});

/**
 * 集中度视觉编码**已接进出货面板**。
 *
 * 之前几轮它一直只是 `concentration-visual.ts` 里的提案，测试守的是那个模块自己。
 * 这一组守的是另一件事：**面板真的用上了它**。
 * 模块测得再全，`dashboard.ts` 忘了引用，用户看到的还是旧的那层看不见的 hsla。
 */
describe('集中度颜色已接进面板', () => {
  const panelOf = (d: any): any => (lastHost as any)._shadow._panel;
  // 这一组默认开着背景色调（`settings` 全局默认是关的）；
  // 关闭的情形有下面单独一条测试。
  const on = { ...settings, tintByConcentration: true };
  const withScore = (score: number): PanelView => ({
    ...base,
    concentration: { state: 'ready', score, preliminary: false, sampleCount: 20, conceptCount: 4 },
  });

  test('四个通道都写进了 CSS 变量，而且互不相同', () => {
    const d = new Dashboard({ ...on }, cb);
    d.render(withScore(80));
    const p = panelOf(d)._props;
    for (const k of ['--conc-score', '--conc-rail', '--conc-rail-w', '--conc-bar', '--tint']) {
      assert.ok(p[k], `面板没有写 ${k} —— 颜色编码没接上`);
    }
    assert.notEqual(p['--conc-score'], p['--conc-bar'], '分数和概念条用了同一个颜色，强度分级没生效');
  });

  test('颜色就是 concentration-visual 算出来的那一套，不是面板自己又调了一遍', () => {
    for (const s of [12, 36, 80]) {
      const d = new Dashboard({ ...on }, cb);
      d.render(withScore(s));
      const p = panelOf(d)._props;
      const v = concentrationVisual(s);
      assert.equal(p['--conc-score'], v.scoreColor, `score ${s} 的分数颜色和模块对不上`);
      assert.equal(p['--conc-rail'], v.railColor);
      assert.equal(p['--conc-bar'], v.barColor);
      assert.equal(p['--conc-rail-w'], `${v.railWidth}px`);
      assert.equal(p['--tint'], v.tint);
    }
  });

  test('低分偏蓝、高分偏红 —— 端点要能在面板上还原出那两个传统色', () => {
    const d0 = new Dashboard({ ...settings }, cb); d0.render(withScore(0));
    const p0 = panelOf(d0)._props;
    const d100 = new Dashboard({ ...settings }, cb); d100.render(withScore(100));
    const p100 = panelOf(d100)._props;
    // 面板上的分数颜色是在色谱基础上提亮的，所以比色相：蓝区 vs 红区
    const h0 = hexToOklch(p0['--conc-score']).h;
    const h100 = hexToOklch(p100['--conc-score']).h;
    assert.ok(h0 > 200 && h0 < 300, `0 分的分数颜色色相 ${h0.toFixed(1)}° 不在蓝区`);
    assert.ok(h100 < 60 || h100 > 340, `100 分的分数颜色色相 ${h100.toFixed(1)}° 不在红区`);
  });

  test('关掉「按集中度调整色调」只关背景，分数/竖轨/概念条仍然带编码', () => {
    const d = new Dashboard({ ...settings, tintByConcentration: false }, cb);
    d.render(withScore(80));
    const p = panelOf(d)._props;
    assert.equal(p['--tint'], 'rgba(0,0,0,0)', '开关关掉了背景之外的东西');
    assert.equal(p['--conc-score'], concentrationVisual(80).scoreColor,
      '关掉背景色调把整个集中度编码也一起关掉了 —— 那个开关不是这个意思');
    assert.notEqual(p['--conc-rail'], 'transparent');
  });

  test('没有分数时不上色，也不渲染量尺（绝不拿默认色冒充一个分数）', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render({ ...base, state: 'collecting', concepts: [], sampleCount: 6,
      concentration: { state: 'collecting', sampleCount: 6, needed: 10 } });
    const p = panelOf(d)._props;
    assert.equal(p['--tint'], 'rgba(0,0,0,0)');
    assert.equal(p['--conc-rail'], 'transparent');
    assert.equal(p['--conc-rail-w'], '0px');
    assert.ok(!lastHtml.includes('conc-scale'), '还没有分数却画了量尺');
  });

  test('四档文案和有效概念数都渲染在面板里', () => {
    for (const [score, want] of [[25, '分散在多个概念上'], [36, '主要分布在几个概念上'],
                                 [55, '明显集中在少数概念上'], [80, '高度集中在一个主要概念上']] as const) {
      lastHtml = '';
      const d = new Dashboard({ ...settings }, cb);
      d.render(withScore(score));
      assert.ok(lastHtml.includes(want), `score ${score} 没渲染出「${want}」`);
      assert.ok(lastHtml.includes('个有效概念'), `score ${score} 没渲染有效概念数`);
      // 免误读的那句话必须常驻，不能被新文案挤掉
      assert.ok(lastHtml.includes('不代表好坏'), `score ${score} 把「不代表好坏」挤没了`);
    }
  });

  test('连续量尺渲染出来了，标记位置就是分数', () => {
    lastHtml = '';
    const d = new Dashboard({ ...settings }, cb);
    d.render(withScore(64));
    assert.ok(lastHtml.includes('conc-scale'), '没渲染连续量尺');
    assert.ok(lastHtml.includes('left:64.0%'), '量尺标记没跟着分数走');
    assert.ok(lastHtml.includes('#1661ab') && lastHtml.includes('#ab372f'),
      '量尺轨道两端不是靛青和鹅血石红');
  });

  test('竖轨用 box-shadow，不用 border-left —— border 会把面板撑宽', () => {
    // 面板宽度有"不压正文"的不变量守着，竖轨不能在渲染时偷偷再加 5px
    assert.ok(DASHBOARD_SRC.includes('inset var(--conc-rail-w'), '竖轨没走 box-shadow');
    assert.ok(!/border-left:\s*var\(--conc-rail/.test(DASHBOARD_SRC), '竖轨用了 border-left，会改变盒宽');
  });

  /**
   * 真实踩过的坑：竖轨原本是 `.panel` 里单独一行 box-shadow，
   * 而同一条规则后面还有一行投影 `box-shadow: 0 4px 18px …` ——
   * 后者把前者**整条覆盖**，竖轨在真实渲染里根本不存在。
   * 而"源码里有 inset var(--conc-rail-w)"那条断言照样是绿的。
   */
  test('.panel 里只能有一条 box-shadow，且竖轨和投影都在里面', () => {
    const rule = DASHBOARD_SRC.match(/\n\.panel \{([\s\S]*?)\n\}/);
    assert.ok(rule, '找不到 .panel 规则');
    const decls = rule![1].split('\n').filter((l) => /^\s*box-shadow\s*:/.test(l));
    assert.equal(decls.length, 1,
      `.panel 里有 ${decls.length} 条 box-shadow —— 后面那条会把竖轨覆盖掉`);
    const whole = rule![1].slice(rule![1].indexOf('box-shadow'));
    assert.ok(whole.includes('inset var(--conc-rail-w'), '这条 box-shadow 里没有竖轨');
    assert.ok(/0 4px 18px/.test(whole), '这条 box-shadow 里没有投影 —— 面板失去立体感');
  });

  test('旧的 hsla tint 已经从面板里删干净', () => {
    assert.ok(!/hsla\(\$\{hue/.test(DASHBOARD_SRC), '旧的 hsla 色调还在');
    const d = new Dashboard({ ...on }, cb);
    d.render(withScore(80));
    assert.ok(panelOf(d)._props['--tint'].startsWith('rgba('),
      '背景 tint 不是 concentration-visual 产出的 rgba');
  });
});
