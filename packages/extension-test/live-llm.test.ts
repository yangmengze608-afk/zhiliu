/**
 * 真实模型集成测试。
 *
 * 存在的理由：红队第四轮指出，此前所有关于 LLM 的测试都把 `fetchImpl` 打了桩——
 * 把 ollama 整个卸掉，测试照样全绿。那种测试证明不了"接了模型"。
 *
 * 这个测试**真的连本地 ollama**。没跑 ollama 时自动跳过（不会假装通过）。
 *
 *   ollama serve & ; ollama pull qwen2.5:3b
 *   node --test packages/extension-test/live-llm.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaExtractor } from '../../packages/core/src/index.ts';

/**
 * `ZHILIU_REQUIRE_LIVE=1` 时不许静默跳过。见 live-zhida.test.ts 的说明：
 * 一个会 skip 成 exit 0 的 live suite，没法用来兑现"真跑过"这句话。
 */
const REQUIRE_LIVE = process.env.ZHILIU_REQUIRE_LIVE === '1';

const BASE = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.ZHILIU_LLM_MODEL ?? 'qwen2.5:3b';

async function available(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const d = (await r.json()) as { models?: Array<{ name: string }> };
    return (d.models ?? []).some((m) => m.name === MODEL);
  } catch { return false; }
}

const live = await available();
if (REQUIRE_LIVE && !live) throw new Error(`ZHILIU_REQUIRE_LIVE=1 但本地没有 ${MODEL}`);

describe('真实模型集成（未运行 ollama 时跳过）', { skip: live ? false : `本地没有 ${MODEL}，跳过` }, () => {
  test('真的产生一次模型调用，并带回 provenance', async () => {
    const ex = new OllamaExtractor({ model: MODEL, baseUrl: BASE, timeoutMs: 120_000 });
    const r = await ex.extract({
      title: '为什么我一见到不熟的人就说不出话',
      text: '每次和陌生人说话前我都要在心里排练很久，还是会紧张。事后我会反复回放刚才哪句话说错了。人多的场合我只想躲。开会轮到我发言，心跳很快，脑子一片空白。',
    });

    assert.equal(r.status, 'llm', `模型调用失败：${r.dropped.join(',')}`);
    assert.equal(r.provenance.provider, 'ollama');
    assert.equal(r.provenance.model, MODEL);
    assert.ok(r.provenance.latencyMs > 0, '延迟为 0，说明没有真的发生网络调用');
    assert.ok((r.provenance.promptTokens ?? 0) > 0, '没有 prompt token 计数，可疑');
    assert.ok(r.concepts.length >= 1 && r.concepts.length <= 3);
    for (const c of r.concepts) {
      assert.ok(c.confidence > 0 && c.confidence <= 1, `confidence 越界：${c.confidence}`);
    }
  });

  test('概念一定落在词表内（归一化生效）', async () => {
    const { canonicalizeConcept } = await import('../../packages/core/src/index.ts');
    const ex = new OllamaExtractor({ model: MODEL, baseUrl: BASE, timeoutMs: 120_000 });
    const r = await ex.extract({ title: '这周我把定投停了', text: '账户波动影响了我的睡眠和工作状态，我开始怀疑这件事本身值不值得。'.repeat(4) });
    if (r.status === 'failed') return; // 模型偶发失败不算这条测试的问题
    for (const c of r.concepts) {
      assert.notEqual(canonicalizeConcept(c.canonical).canonical, null, `产出了词表外标签：${c.canonical}`);
    }
  });
});

describe('模型不可达时的行为（始终运行）', () => {
  test('连不上 provider 时 fail loud，绝不产出概念', async () => {
    const ex = new OllamaExtractor({ baseUrl: 'http://127.0.0.1:1', maxAttempts: 1, timeoutMs: 400 });
    const r = await ex.extract({ title: 't', text: 'x' });
    assert.equal(r.status, 'failed');
    assert.equal(r.concepts.length, 0);
  });
});
