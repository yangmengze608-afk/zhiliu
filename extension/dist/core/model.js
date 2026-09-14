/**
 * 本地数据模型。
 *
 * 隐私前提：这两个结构**只存在于浏览器本地**。服务端从不接收 ReadEvent，
 * 也从不接收 ConceptAggregate —— 它只看得到当前这一篇的 title + text。
 */

/**
 * 分析来源。这不是装饰性字段——面板必须据此显示不同标签，
 * 让「后台是 mock 但前端看起来像真实 AI 分析」在结构上不可能发生。
 */
                                                                                                    

/**
 * 一条分析结果的**出处**。
 *
 * 为什么必须逐条存而不是存一个全局值：模型会换。今天 3B 打的标签和
 * 明天 14B 打的标签混在同一个 20 篇窗口里，如果不记来源，
 * 半年后没有任何办法解释"为什么那一周的分布突然变了"。
 *
 * 注意这里**只能选 A 方案（保留历史 + 标版本）**，不能选 B 方案（重算最近窗口）：
 * 出于隐私，本地历史里**不保存正文**，只保存标题和概念。
 * 没有正文就无法重算——这是隐私设计的代价，必须写下来而不是假装可以重算。
 */
                               
               
                  
                                
                        
                    
                 
 

/** 一次有效阅读。 */
                            
                                              
             
                  
                     
                                                
                
                  
                    
                  
                   
                                                             
                                   
                                   
                                             
                          
                                                        
                          
                                   
                      
 

/** 某个 canonical concept 在当前窗口内的聚合视图。 */
                                   
                    
                               
                      
                   
                       
               
                
                                      
                                  
                     
                    
                           
                    
                          
                   
 

export const ANALYSIS_VERSION = 'llm-only-v1';

/**
 * URL → 稳定本地 id。不上传，仅用于本地去重。
 *
 * **必须带命名空间前缀。** 知乎的回答 id 和专栏文章 id 是两套独立编号，
 * 会撞：`www.zhihu.com/answer/1234567890` 和 `zhuanlan.zhihu.com/p/1234567890`
 * 都给出 contentId `1234567890`，旧实现直接返回它，于是后读的那一篇
 * 被去重逻辑当成"刚才读过的同一篇"**静默丢弃**——用户读了，面板不记，也不报错。
 */
export function localId(contentId                    , url        )         {
  if (contentId) return `${url.startsWith('https://zhuanlan.') ? 'p' : 'a'}${contentId}`;
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `u${(h >>> 0).toString(36)}`;
}
