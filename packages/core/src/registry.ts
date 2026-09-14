/** Canonical concept 注册表：把同义表达合并成一个面板标签，避免统计碎裂。 */
import conceptsJson from './concepts.json' with { type: 'json' };

export interface ConceptEntry {
  canonical: string;
  /** 同义标签，用于把「工作稳定/职业稳定性/稳定就业」折叠成「稳定」 */
  aliases: string[];
  /** 朴素关键词系统会据以联想到该概念的表层线索词，只用于候选召回 */
  cues: string[];
  parent: string;
}

export const CONCEPTS: ConceptEntry[] = (conceptsJson as { concepts: ConceptEntry[] }).concepts;

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const c of CONCEPTS) {
  ALIAS_TO_CANONICAL.set(c.canonical, c.canonical);
  for (const a of c.aliases) ALIAS_TO_CANONICAL.set(a, c.canonical);
}

/**
 * 把任意标签折叠到 canonical。
 * 只做注册表内的显式合并；不做"词形相近就强行合并"，那会把
 * 「稳定」和「稳定币」这类无关概念错误地并到一起。
 */
export function canonicalize(label: string): string | null {
  const t = label.trim();
  if (!t) return null;
  return ALIAS_TO_CANONICAL.get(t) ?? null;
}

export function conceptOf(canonical: string): ConceptEntry | undefined {
  return CONCEPTS.find((c) => c.canonical === canonical);
}

/** 两个概念的共同上位概念，用于 ambiguous 时回退到更高层。 */
export function commonParent(a: string, b: string): string | null {
  const ca = conceptOf(a);
  const cb = conceptOf(b);
  if (ca && cb && ca.parent === cb.parent) return ca.parent;
  return null;
}

/** 该概念用于知乎搜索的查询词。目前等于 canonical，保留扩展位。 */
export function searchQueryFor(canonical: string): string {
  return canonical;
}

/** 概念自身及其别名的全部词面，用于抑制"自指词面命中"。 */
export function surfaceFormsOf(canonical: string): string[] {
  const c = conceptOf(canonical);
  return c ? [c.canonical, ...c.aliases] : [canonical];
}

/** 召回用线索词 = 本名 + 别名 + cues。Baseline A 与 System 召回层共用。 */
export function recallFormsOf(canonical: string): string[] {
  const c = conceptOf(canonical);
  return c ? [c.canonical, ...c.aliases, ...c.cues] : [canonical];
}
