/**
 * 概念抽取调度（客户端一侧）。
 *
 * ## 当前真实状态
 *
 * 真正的模型调用在**服务端**（`packages/core/src/llm.ts` 的 `OllamaExtractor`，
 * 由 `server/dev-server.ts` 注入）。扩展这一侧只负责发请求和**核验来源**。
 *
 * 默认构建的 `ANALYZE_ENDPOINT` 为空 → 走本文件下方的确定性 mock，
 * 标记 `status:'mock'`，面板打「演示数据」。**这是出货默认值**，
 * 不要把它读成"已经接了 AI"。接法见 README「三步接上模型」。
 *
 * mock 必须确定性——刷新页面结果跳来跳去会让 Demo 立刻失去可信度。
 */
import { CONFIG } from '../shared/config.js';
import { validateExtraction } from '../core/extract.js';
                                                                              
import { ANALYSIS_VERSION } from '../core/model.js';
                                                                                          

/** 未接模型时使用的出处标记。写进历史，将来一眼能认出这段数据不是模型产的。 */
const MOCK_META               = {
  version: ANALYSIS_VERSION, promptVersion: 'n/a', provider: 'local-mock', model: 'deterministic-hash',
};

/** 失败记录也要带出处，否则历史里会出现"不知道是谁失败了"的空洞。 */
function failed(why        , meta               = { version: ANALYSIS_VERSION, promptVersion: 'n/a' })                  {
  return { concepts: [], ambiguous: false, status: 'failed', analysisVersion: ANALYSIS_VERSION, dropped: [why], analysis: meta };
}

                                 
                     
                                     
                
               
 

/** 只允许出现在网络请求里的字段。 */
const WIRE_FIELDS = ['contentId', 'contentType', 'title', 'text']         ;

export function toWirePayload(req                )                          {
  const out                          = {};
  for (const k of WIRE_FIELDS) {
    const v = (req                           )[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const MOCK_SETS                                                          = [
  [{ canonical: '社交焦虑', confidence: 0.86 }, { canonical: '负面评价恐惧', confidence: 0.72 }],
  [{ canonical: '就业', confidence: 0.84 }, { canonical: '稳定', confidence: 0.77 }, { canonical: '风险', confidence: 0.61 }],
  [{ canonical: 'AI', confidence: 0.88 }, { canonical: '工作替代', confidence: 0.7 }],
  [{ canonical: '考研', confidence: 0.83 }, { canonical: '学习方法', confidence: 0.66 }],
  [{ canonical: '房产', confidence: 0.81 }, { canonical: '风险', confidence: 0.64 }],
  [{ canonical: '亲密关系', confidence: 0.79 }],
];

                                                  
                                
                                                                                                 
                                                          
                         
  

export async function requestAnalysis(req                )                           {
  // **只有端点为空时才走 mock。**
  //
  // 这一点容易被误读成"拿不到 /analyze 就自动降级到演示数据"。不是的：
  // 端点配好之后，超时 / 网络失败走下面的 `failed(...)` 分支，
  // `analysisStatus` 变成 `'failed'`，**不是 mock、没有「演」标记**。
  // 要进演示模式必须用户手动勾选。RUNBOOK 曾经把这件事写反了。
  if (!CONFIG.ANALYZE_ENDPOINT) return mockAnalysis(req);

  // 超时保护：fetch 本身没有超时上限。后端"接受连接但从不返回"时
  // （赛前接了个没跑起来的服务、进程卡死、端口转发配错）会让 handleQualified
  // 永远卡在 await 上，analyzing 计数器不清零，面板永远停在"分析中"。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.ANALYZE_TIMEOUT_MS);
  try {
    const resp = await fetch(CONFIG.ANALYZE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toWirePayload(req)),
      signal: ctrl.signal,
    });
    if (!resp.ok) return failed(`HTTP ${resp.status}`);
    const body = (await resp.json())     
                      
                        
                                                                                 
     ;

    // 关键：**不能**无条件标成 llm。
    // resp.ok 只证明"有人回了 200"——一个返回常量 JSON 的静态服务器
    // 也能让扩展打出「AI 分析」。上一轮的「无条件盖章」就是这样换了个位置又活了一次。
    // 现在要求服务端自报 status，且 llm 必须附带 provenance（provider + model），
    // 否则一律降级为 ungrounded：宁可显示"未标注来源"，也不冒充 AI 分析。
    const declared = body.status;
    const hasProvenance = Boolean(body.provenance?.provider && body.provenance?.model);
    const source                   =
      declared === 'llm' && hasProvenance ? 'llm'
      : declared === 'zhihu_enriched' && hasProvenance ? 'zhihu_enriched'
      : declared === 'mock' ? 'mock'
      : 'ungrounded';

    const validated = validateExtraction(body, source);
    return {
      ...validated,
      provenance: body.provenance,
      analysis: {
        version: ANALYSIS_VERSION,
        promptVersion: body.provenance?.promptVersion ?? '未声明',
        provider: body.provenance?.provider,
        model: body.provenance?.model,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return failed('analyze_timeout');
    // 不反复重试；交给上层显示为"待分析"，绝不编造概念
    return failed(err instanceof Error ? err.name : 'network_error');
  } finally {
    clearTimeout(timer);
  }
}

/** 用内容 id / 标题的哈希做确定性选择，同一篇永远得到同一组概念。 */
export function mockAnalysis(req                )                  {
  const h = hash(req.contentId || req.title);
  return {
    concepts: MOCK_SETS[h % MOCK_SETS.length],
    ambiguous: false,
    status: 'mock',
    analysisVersion: ANALYSIS_VERSION,
    dropped: [],
    analysis: MOCK_META,
  };
}

function hash(s        )         {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
