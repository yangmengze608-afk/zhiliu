/** 演示模式驱动：把预置样例按剧本逐条写入本地历史，让面板实时变化。 */
import { DEMO_ARTICLES, DEMO_STEP_MS } from '../shared/demo-data.js';
                                                                     

                            
                   
               
                
 

/** 把第 i 篇演示内容变成一条 ReadEvent。 */
export function demoEvent(i        , now = Date.now())            {
  const a = DEMO_ARTICLES[i];
  return {
    id: a.contentId,
    contentId: a.contentId,
    contentType: a.contentType,
    title: a.title,
    timestamp: now,
    duration: 9000,
    concepts: a.concepts,
    // 关键：永远标记为 demo，面板据此打「演示数据」标签
    analysisStatus: 'demo',
    analysisVersion: 'demo-v1',
  };
}

export const DEMO_TOTAL = DEMO_ARTICLES.length;
export { DEMO_STEP_MS };
