/**
 * 中文分词：不引入任何第三方依赖。
 *
 * 采用字符 bigram，而不是词典分词。理由：
 * 1. 零依赖，扩展与 serverless 都能跑；
 * 2. 本项目要比较的是"两段中文在用词分布上有多像"，bigram 对该任务足够；
 * 3. 不会因为分词器词表里没有"社恐""上岸"这类社区新词而丢信息。
 * ASCII 串（AI、GPT、Python）按整词保留，避免被切碎。
 */

/** 高频虚词与通用口语词，携带的主题信息接近 0，先行剔除以降噪。 */
const STOP_CHARS = new Set(
  '的了是我你他她它在有和就不人都一个也很这那些什么怎么为什么如何可以因为所以但是而且还有自己没有知道觉得时候一些这样那样其实真的现在已经可能应该就是然后而是于与之及对从被把让给再更最又才只还向到过着地得们且或若则以于乎者也'.split(''),
);

const ASCII_TOKEN = /[A-Za-z][A-Za-z0-9+#.]{1,19}/g;
const CJK = /[一-鿿]/;

function isCjk(ch        )          {
  return CJK.test(ch);
}

/**
 * 把一段文本转成 term 列表。
 * CJK 部分产出 unigram + bigram，ASCII 部分产出小写整词。
 */
export function tokenize(text        )           {
  if (!text) return [];
  const terms           = [];

  for (const m of text.matchAll(ASCII_TOKEN)) {
    const w = m[0].toLowerCase();
    if (w.length >= 2) terms.push(w);
  }

  // 只保留 CJK，其余字符当作分隔，避免跨句拼出假 bigram
  const segments = text.split(/[^一-鿿]+/).filter(Boolean);
  for (const seg of segments) {
    const chars = [...seg];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (!isCjk(c)) continue;
      if (!STOP_CHARS.has(c)) terms.push(c);
      if (i + 1 < chars.length && isCjk(chars[i + 1])) {
        const bg = c + chars[i + 1];
        // 两个字都是虚词的 bigram 无信息量
        if (!(STOP_CHARS.has(c) && STOP_CHARS.has(chars[i + 1]))) terms.push(bg);
      }
    }
  }
  return terms;
}

/**
 * 单字权重。中文单字是歧义很大的语素（「会/心/说/想」几乎出现在任何文本里），
 * 而 bigram 近似于词。给单字降权可以同时提升判别质量和解释可读性——
 * 面板要能说出"判别依据是 紧张、回避、冒汗"，而不是"会、心、说"。
 */
export const UNIGRAM_WEIGHT = 0.35;

/** 统计加权词频。 */
export function termFrequency(text        )                      {
  const tf = new Map                ();
  for (const t of tokenize(text)) {
    const w = [...t].length === 1 ? UNIGRAM_WEIGHT : 1;
    tf.set(t, (tf.get(t) ?? 0) + w);
  }
  return tf;
}

/** L2 归一化，使不同长度的文本可比。 */
export function l2Normalize(vec                     )                      {
  let sum = 0;
  for (const v of vec.values()) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return new Map(vec);
  const out = new Map                ();
  for (const [k, v] of vec) out.set(k, v / norm);
  return out;
}

/** 稀疏向量点积。遍历较短的一侧。 */
export function dot(a                     , b                     )         {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w !== undefined) s += v * w;
  }
  return s;
}
