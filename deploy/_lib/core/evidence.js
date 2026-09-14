/**
 * Evidence Bundle —— 知乎 API 在新链路里的角色。
 *
 * ## 与上一版的根本区别
 *
 * 上一版把知乎语料做成了**判别器**：算原文与各候选邻域的分布相似度，谁高选谁。
 * 评测证明那样不行——分布相似度赢不了语言理解，在 LLM 之上重排是「修对 1 条、改坏 12 条」。
 *
 * 这一版知乎 API **不再做任何判断**。它只负责一件事：
 * 把「这个概念在知乎社区里实际是怎么被讨论的」整理成可读的证据，
 * 交给 LLM 去做最终裁决。
 *
 * 也就是说，我们不再问"哪个邻域的余弦相似度更高"，
 * 而是让 LLM 看着真实的社区语料回答"原文的问题意识更接近哪一类讨论"。
 *
 * ## 消融维度
 *
 * `EvidenceLevel` 存在的唯一目的是回答："到底是哪一层证据在起作用？"
 * 如果 `full` 不比 `titles` 好，就说明摘要和评论是噪声，应该砍掉——
 * 这个结论必须由数据给出，不能靠猜。
 */
                                                           
                                                  

                           
                                    
          
             
            
                  
               
                                      
           

                               
                
                   
                      
                        
                          
                       
                        
                       
 

                                    
                
                
                                       
                    
                        
                                 
                   
 

/** 摘要截断长度。给 LLM 的证据要够用，但不能让单个候选淹没其他候选。 */
const SUMMARY_CHARS = 220;

/**
 * 为每个候选概念取回知乎证据。
 *
 * 注意 `level==='none'` 时**不会发起任何请求**——LLM-only 对照组必须
 * 真的没有碰过知乎 API，否则消融不干净。
 */
export async function buildEvidenceBundles(
  candidates          ,
  client                   ,
  level               ,
  topK = 5,
)                               {
  if (level === 'none') return [];

  const out                      = [];
  for (const label of candidates) {
    try {
      const items = await client.neighborhoodItems(label, topK);
      out.push({
        label,
        query: label,
        itemCount: items.length,
        items: items.slice(0, topK).map((it) => project(it, level)),
      });
    } catch {
      // 单个候选取证失败不应让整篇分析失败，但必须如实标记，
      // 否则 LLM 会把"没有证据"误读成"知乎上没人这么讨论"。
      out.push({ label, query: label, itemCount: 0, items: [], failed: true });
    }
  }
  return out;
}

function project(it                 , level               )               {
  const base               = { title: it.Title };
  if (level === 'titles') return base;

  base.summary = clip(it.ContentText ?? '', SUMMARY_CHARS);
  if (level === 'summaries') return base;

  // full：把官方明确返回的、对"社区如何讨论这个概念"有信息量的字段都给出去。
  // 刻意不给 AuthorName/AuthorAvatar/ContentID —— 它们对语义判断无用，
  // 只会占用上下文并引入无关的作者身份信息。
  base.comments = (it.CommentInfoList ?? []).map((c) => clip(c.Content ?? '', 80)).filter(Boolean).slice(0, 2);
  base.rankingScore = it.RankingScore;
  base.authorityLevel = it.AuthorityLevel;
  base.voteUpCount = it.VoteUpCount;
  base.commentCount = it.CommentCount;
  base.contentType = it.ContentType;
  return base;
}

function clip(s        , n        )         {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 把证据渲染成交给 LLM 裁决者的文本。
 *
 * 刻意用 Markdown 而不是原始 JSON：裁决者要读的是"社区在怎么谈这件事"，
 * 结构化字段堆在一起反而会诱导它去做加权求和——那正是上一版失败的做法。
 */
export function renderEvidence(bundles                     , level               )         {
  if (level === 'none' || bundles.length === 0) return '（本组不提供知乎证据）';

  const parts           = [];
  for (const b of bundles) {
    parts.push(`### 候选：${b.label}`);
    if (b.failed) {
      parts.push('> 取证失败（上游错误）。不要把它理解为"知乎上没有这类讨论"。');
      continue;
    }
    if (b.itemCount === 0) {
      parts.push('> 知乎检索未返回结果。');
      continue;
    }
    b.items.forEach((it, i) => {
      const meta           = [];
      if (it.rankingScore !== undefined) meta.push(`相关度 ${it.rankingScore.toFixed(2)}`);
      if (it.authorityLevel) meta.push(`权威等级 ${it.authorityLevel}`);
      if (it.voteUpCount !== undefined) meta.push(`赞同 ${it.voteUpCount}`);
      parts.push(`${i + 1}. **${it.title}**${meta.length ? `  〔${meta.join(' · ')}〕` : ''}`);
      if (it.summary) parts.push(`   ${it.summary}`);
      if (it.comments?.length) parts.push(...it.comments.map((c) => `   > 评论：${c}`));
    });
  }
  return parts.join('\n');
}
