/**
 * Concept Canonicalization —— 让「工作稳定 / 职业稳定性 / 稳定就业 / 体制稳定」
 * 在面板上合并成同一根柱子。
 *
 * 目标不是建知识图谱，只是**保证聚合不碎裂**。因此刻意保持四级、可解释、可测：
 *
 *   1. exact      与 canonical 完全相同
 *   2. alias      在别名表里
 *   3. llm        交给 LLM 归一（可插拔，默认不启用）
 *   4. fuzzy      字符重合度兜底，阈值很高
 *
 * 两条硬约束，都是为了避免"合并过头"：
 *
 * - **一个别名映射到多个 canonical 时返回 ambiguous，不许静默挑一个。**
 *   「上岸」同时是「考公考编」和「考研」的别名，把它硬归到其中一个
 *   会系统性污染统计。
 * - **fuzzy 只在长度相近且重合度极高时才触发**，并且有显式的禁止合并对。
 *   「稳定」和「稳定币」共享两个字，但不是一回事。
 */
import { CONCEPTS } from './registry.ts';

export type CanonMethod = 'exact' | 'alias' | 'llm' | 'fuzzy' | 'none' | 'ambiguous';

export interface CanonResult {
  canonical: string | null;
  method: CanonMethod;
  confidence: number;
  /** ambiguous 时列出所有可能的归属，交给调用方决定 */
  candidates?: string[];
  note?: string;
}

/** 明确禁止合并的词对：字面很像但语义无关。 */
const NEVER_MERGE: Array<[string, string]> = [
  ['稳定', '稳定币'],
  ['风险', '风险投资'],
  ['认知', '认知症'],
  ['留学', '留学中介费'],
  ['健身', '健身房转让'],
];

const CANONICAL_SET = new Set(CONCEPTS.map((c) => c.canonical));

/** 别名 → 可能的 canonical 集合。一个别名可以指向多个概念。 */
const ALIAS_INDEX = new Map<string, Set<string>>();
for (const c of CONCEPTS) {
  for (const a of c.aliases) {
    const key = normalizeSurface(a);
    if (!ALIAS_INDEX.has(key)) ALIAS_INDEX.set(key, new Set());
    ALIAS_INDEX.get(key)!.add(c.canonical);
  }
}

/**
 * 表层归一：全角转半角、去标点空白、ASCII 转小写。
 * 这一步不改变语义，只吸收书写差异。
 */
export function normalizeSurface(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[·・.,，。、!！?？:：;；"'"'（）()\[\]【】]/g, '')
    .toLowerCase();
}

export interface CanonOptions {
  /** 可插拔的 LLM 归一化。返回 canonical 或 null。默认不启用。 */
  llmNormalize?: (label: string, vocabulary: string[]) => string | null;
  /** fuzzy 触发所需的最小字符重合度 */
  fuzzyThreshold?: number;
  enableFuzzy?: boolean;
}

const DEFAULT_FUZZY_THRESHOLD = 0.8;

/**
 * 把任意标签折叠到 canonical concept。
 *
 * 返回 `method` 是刻意的：调用方（和面板 debug 视图）需要知道这次合并
 * 是靠别名表还是靠模糊匹配得到的——后者可信度低得多。
 */
export function canonicalizeConcept(label: string, options: CanonOptions = {}): CanonResult {
  const raw = label.trim();
  if (!raw) return { canonical: null, method: 'none', confidence: 0, note: '空标签' };

  const key = normalizeSurface(raw);

  // 1. exact
  for (const c of CANONICAL_SET) {
    if (normalizeSurface(c) === key) return { canonical: c, method: 'exact', confidence: 1 };
  }

  // 2. alias（一对多时不许静默挑一个）
  const hit = ALIAS_INDEX.get(key);
  if (hit && hit.size === 1) {
    return { canonical: [...hit][0], method: 'alias', confidence: 0.95 };
  }
  if (hit && hit.size > 1) {
    return {
      canonical: null,
      method: 'ambiguous',
      confidence: 0,
      candidates: [...hit].sort(),
      note: `「${raw}」同时是 ${[...hit].sort().join('、')} 的别名，不做静默归并`,
    };
  }

  // 3. LLM 归一（可选）
  if (options.llmNormalize) {
    const out = options.llmNormalize(raw, [...CANONICAL_SET]);
    if (out && CANONICAL_SET.has(out)) {
      return { canonical: out, method: 'llm', confidence: 0.8 };
    }
  }

  // 4. fuzzy 兜底
  if (options.enableFuzzy) {
    const threshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
    let best: { canonical: string; score: number } | null = null;
    for (const c of CONCEPTS) {
      for (const form of [c.canonical, ...c.aliases]) {
        if (isForbidden(raw, form)) continue;
        const score = charOverlap(key, normalizeSurface(form));
        if (score >= threshold && (!best || score > best.score)) {
          best = { canonical: c.canonical, score };
        }
      }
    }
    if (best) {
      return {
        canonical: best.canonical,
        method: 'fuzzy',
        confidence: Math.min(0.7, best.score * 0.7),
        note: `字符重合度 ${best.score.toFixed(2)}，可信度低于别名匹配`,
      };
    }
  }

  return { canonical: null, method: 'none', confidence: 0, note: `「${raw}」不在概念表内` };
}

function isForbidden(a: string, b: string): boolean {
  const na = normalizeSurface(a), nb = normalizeSurface(b);
  return NEVER_MERGE.some(([x, y]) => {
    const nx = normalizeSurface(x), ny = normalizeSurface(y);
    return (na === nx && nb === ny) || (na === ny && nb === nx);
  });
}

/**
 * 字符集合的 Dice 系数，并要求长度相近。
 *
 * 长度门槛很重要：「稳定」和「工作稳定性保障机制」重合度可以很高，
 * 但后者显然是另一回事。
 */
function charOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const la = [...a].length, lb = [...b].length;
  if (Math.min(la, lb) / Math.max(la, lb) < 0.5) return 0;
  const sa = new Set([...a]), sb = new Set([...b]);
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}

/**
 * 批量归一化一组概念，并合并重复项（取最高 confidence）。
 * 未能归一的标签不会被丢掉，而是作为 `unresolved` 返回，
 * 让调用方决定是记录还是忽略——静默丢弃会掩盖概念表的覆盖缺口。
 */
export function canonicalizeAll(
  labels: Array<{ label: string; confidence: number }>,
  options: CanonOptions = {},
): { concepts: Array<{ canonical: string; confidence: number; method: CanonMethod }>; unresolved: CanonResult[] } {
  const merged = new Map<string, { canonical: string; confidence: number; method: CanonMethod }>();
  const unresolved: CanonResult[] = [];

  for (const item of labels) {
    const r = canonicalizeConcept(item.label, options);
    if (!r.canonical) {
      unresolved.push({ ...r, note: r.note ?? `无法归一：${item.label}` });
      continue;
    }
    const prev = merged.get(r.canonical);
    const conf = item.confidence * r.confidence;
    if (!prev || conf > prev.confidence) {
      merged.set(r.canonical, { canonical: r.canonical, confidence: conf, method: r.method });
    }
  }

  return {
    concepts: [...merged.values()].sort((a, b) => b.confidence - a.confidence),
    unresolved,
  };
}
