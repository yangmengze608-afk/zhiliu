import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeConcept, canonicalizeAll, normalizeSurface } from '../src/index.ts';

const fz = { enableFuzzy: true };

describe('canonicalize · 同义词合并（面板不碎裂的核心要求）', () => {
  test('稳定家族全部折叠到「稳定」', () => {
    for (const s of ['稳定', '工作稳定', '职业稳定性', '稳定就业', '体制稳定', '铁饭碗']) {
      assert.equal(canonicalizeConcept(s).canonical, '稳定', `${s} 未合并`);
    }
  });

  test('就业家族折叠到「就业」', () => {
    for (const s of ['就业', '找工作', '求职', '秋招']) {
      assert.equal(canonicalizeConcept(s).canonical, '就业', `${s} 未合并`);
    }
  });
});

describe('canonicalize · 口语与网络缩写', () => {
  test('社恐 → 社交焦虑；emo/破防 → 情绪调节；社死 → 负面评价恐惧', () => {
    assert.equal(canonicalizeConcept('社恐').canonical, '社交焦虑');
    assert.equal(canonicalizeConcept('emo').canonical, '情绪调节');
    assert.equal(canonicalizeConcept('破防').canonical, '情绪调节');
    assert.equal(canonicalizeConcept('社死').canonical, '负面评价恐惧');
    assert.equal(canonicalizeConcept('剁手').canonical, '消费观');
    assert.equal(canonicalizeConcept('摆烂').canonical, '拖延');
  });

  test('大小写与全角半角差异被吸收', () => {
    assert.equal(canonicalizeConcept('ＡＩ').canonical, 'AI');
    assert.equal(canonicalizeConcept('ai').canonical, 'AI');
    assert.equal(canonicalizeConcept('  铁饭碗  ').canonical, '稳定');
    assert.equal(normalizeSurface('人工　智能！'), '人工智能');
  });
});

describe('canonicalize · 多义词必须报 ambiguous，不许静默择一', () => {
  test('「上岸」同属考研与考公考编 → ambiguous', () => {
    const r = canonicalizeConcept('上岸');
    assert.equal(r.method, 'ambiguous');
    assert.equal(r.canonical, null, '多义别名被静默归到了某一个概念，这会系统性污染统计');
    assert.deepEqual(r.candidates, ['考公考编', '考研']);
  });

  test('ambiguous 会给出可读理由', () => {
    assert.match(canonicalizeConcept('上岸').note ?? '', /上岸/);
  });
});

describe('canonicalize · 近义但不应合并', () => {
  test('稳定币 / 风险投资 不得并入 稳定 / 风险', () => {
    assert.notEqual(canonicalizeConcept('稳定币', fz).canonical, '稳定');
    assert.notEqual(canonicalizeConcept('风险投资', fz).canonical, '风险');
  });

  test('语义相邻的独立概念各自保持独立', () => {
    // 这几个是刻意区分的相邻概念，合并会让面板失去分辨力
    assert.equal(canonicalizeConcept('社交焦虑').canonical, '社交焦虑');
    assert.equal(canonicalizeConcept('负面评价恐惧').canonical, '负面评价恐惧');
    assert.equal(canonicalizeConcept('AI').canonical, 'AI');
    assert.equal(canonicalizeConcept('自动化').canonical, '自动化');
    assert.equal(canonicalizeConcept('工作替代').canonical, '工作替代');
  });
});

describe('canonicalize · 上下位与表外词', () => {
  test('词表外的词返回 none，而不是硬塞进最近的概念', () => {
    for (const s of ['量子力学', '烘焙', '古典音乐']) {
      const r = canonicalizeConcept(s, fz);
      assert.equal(r.canonical, null, `${s} 被错误归一到 ${r.canonical}`);
      assert.equal(r.method, 'none');
    }
  });

  test('过长的派生表述不会因为共享字就被合并', () => {
    assert.equal(canonicalizeConcept('工作稳定性保障机制改革', fz).canonical, null);
  });
});

describe('canonicalize · LLM 归一层可插拔', () => {
  test('LLM 只能返回词表内的概念，越界结果被忽略', () => {
    const bad = canonicalizeConcept('职场倦怠', { llmNormalize: () => '这个词不在表里' });
    assert.equal(bad.canonical, null);

    const good = canonicalizeConcept('职场倦怠', { llmNormalize: () => '情绪调节' });
    assert.equal(good.canonical, '情绪调节');
    assert.equal(good.method, 'llm');
  });

  test('exact/alias 优先于 LLM —— 不为已知词浪费一次调用', () => {
    let called = 0;
    canonicalizeConcept('铁饭碗', { llmNormalize: () => { called++; return '收入'; } });
    assert.equal(called, 0, 'alias 能解决的词不应该走到 LLM');
  });
});

describe('canonicalizeAll · 批量与去重', () => {
  test('同一概念的多个表述合并成一条，取最高置信度', () => {
    const r = canonicalizeAll([
      { label: '工作稳定', confidence: 0.6 },
      { label: '铁饭碗', confidence: 0.9 },
      { label: '就业', confidence: 0.8 },
    ]);
    assert.equal(r.concepts.length, 2);
    const stable = r.concepts.find((c) => c.canonical === '稳定')!;
    assert.ok(stable.confidence > 0.8, `合并后应保留高置信度，实际 ${stable.confidence}`);
  });

  test('无法归一的标签进入 unresolved，不被静默丢弃', () => {
    const r = canonicalizeAll([{ label: '稳定', confidence: 0.9 }, { label: '星座运势', confidence: 0.5 }]);
    assert.equal(r.concepts.length, 1);
    assert.equal(r.unresolved.length, 1, '静默丢弃会掩盖概念表的覆盖缺口');
  });

  test('多义标签进入 unresolved 并保留候选', () => {
    const r = canonicalizeAll([{ label: '上岸', confidence: 0.9 }]);
    assert.equal(r.concepts.length, 0);
    assert.equal(r.unresolved[0].method, 'ambiguous');
    assert.deepEqual(r.unresolved[0].candidates, ['考公考编', '考研']);
  });

  test('空输入与空标签不崩溃', () => {
    assert.equal(canonicalizeAll([]).concepts.length, 0);
    assert.equal(canonicalizeConcept('   ').method, 'none');
  });
});
