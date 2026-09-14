/**
 * 内容提取诊断（仅开发用）。
 *
 * ## 为什么需要它
 *
 * 知乎的 DOM selector **从来没有在真实知乎页面上验证过**。
 * 自动化访问会触发安全验证，而绕过安全验证是明令禁止的；
 * 因此这一层验证只能由**一个已经正常登录的真人**在自己的浏览器里完成。
 *
 * 这个模块的唯一目的，就是让那次人工验证只需要三十秒：
 * 打开任意知乎回答/文章页 → 敲 `__zhiliu()` → 立刻看到 extractor 到底抓到了什么。
 *
 * 它**不改变任何行为**，不发网络请求，不写 storage，只读当前页面。
 * 打包进出货版本也是安全的（只是多一个全局函数），但默认不在 UI 上暴露入口。
 */
import { detectPage } from './detect-page.js';
import { describeCandidates } from './extract-content.js';
                                                             

                                   
     
                        
    
                                                                    
                                                  
                                     
                                            
     
                               
                                         
                                     
     
                                                           
                                              
                                
     
                                   
                    
                 
                           
                               
 

                                   
              
                     
                              
                                
                   
                               
                          
                      
                
                     
                        
                     
                                           
                  
                      
                          
                         
                                                            
                       
                                          
                          
                                      
                        
                         
 

export function buildReport(src                  )                                          {
  const c = src.extraction;
  const id = detectPage();
  return {
    url: id.url,
    urlPattern:
      id.type === 'article' ? 'zhuanlan.zhihu.com/p/<id>'
      : id.type === 'answer' ? 'www.zhihu.com/[question/<qid>/]answer/<id>'
      : '（不匹配任何已知的可分析页面）',
    detectedContentType: c.type,
    contentId: c.contentId,
    strategy: c.strategy,
    extractionConfidence: c.confidence,
    selectorMatched: c.selectorMatched,
    titleLength: c.title.length,
    title: c.title,
    textLength: c.text.length,
    originalChars: c.originalChars,
    truncated: c.truncated,
    preview: c.text.slice(0, 200),
    readTimerMs: src.visibleMs,
    readThresholdMs: src.thresholdSeconds * 1000,
    readQualified: src.fired,
    panelLayout: src.layout ?? '(面板未初始化)',
    rootCandidates: c.type === 'answer' || c.type === 'article'
      ? describeCandidates(document, c.type, c.contentId)
      : `(${c.type} 页不做根容器搜索)`,
    lastRecorded: src.recorded
      ? { title: src.recorded.title, strategy: src.recorded.strategy,
          confidence: src.recorded.confidence, textLength: src.recorded.text.length,
          selectorMatched: src.recorded.selectorMatched }
      : '(本页尚无入库记录)',
  };
}

                                                  

/**
 * 挂上 `window.__zhiliu()`。
 *
 * 返回一个 Promise，resolve 出完整报告；同时往 console 打一份**人类可读**的版本，
 * 因为真人做 field test 的时候不想读 JSON。
 */
export function installDiagnostics(src                        )       {
  globalThis.__zhiliu = async ()                            => {
    const s = src();
    const base = buildReport(s);
    let analysisState          = null;
    try { analysisState = await s.view(); } catch (e) { analysisState = `(取不到面板状态: ${String(e)})`; }
    const report = { ...base, analysisState };

    console.log(
      `%c知流 · 内容提取诊断`, 'font-weight:bold',
      '\n  URL 形态      ', base.urlPattern,
      '\n  contentType   ', base.detectedContentType, base.contentId ? `(id=${base.contentId})` : '',
      '\n  抽取策略      ', base.strategy, `→ 可信度 ${base.extractionConfidence}`,
      '\n  命中 selector ', base.selectorMatched,
      '\n  标题          ', `${base.titleLength} 字：${base.title}`,
      '\n  正文          ', `${base.textLength} 字`, base.truncated ? `（原文 ${base.originalChars} 字，已结构化截断）` : '（未截断）',
      '\n  阅读计时      ', `${Math.round(base.readTimerMs / 1000)}s / ${base.readThresholdMs / 1000}s`, base.readQualified ? '已达标' : '未达标',
      '\n  面板布局      \n', base.panelLayout,
      '\n  根容器候选    \n', base.rootCandidates,
      '\n  正文前 200 字 \n', base.preview,
    );
    if (base.strategy === 'unsupported') {
      console.info('知流 · 这个页面类型不在支持范围内（只支持回答页与专栏文章页）。不抽取、不分析、不入库 —— 这是预期行为，不是故障。');
    } else if (base.extractionConfidence === 'low') {
      console.warn('知流 · 抽取可信度 low —— 这一篇不会被记录，也不会送去分析。请把上面的 selector 信息反馈给开发。');
    }
    return report;
  };
}
