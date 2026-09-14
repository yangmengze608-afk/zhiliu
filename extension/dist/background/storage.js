/**
 * 本地历史存储。
 *
 * 隐私边界：ReadEvent 只存在这里，**从不上传**。服务端只看得到当前这一篇的
 * title + text，看不到 id 列表、时间序列、概念历史或集中度。
 */
import { CONFIG, STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/config.js';
                                                    
                                                                                   

                       
                                                                        
                                                     
 

function area()              {
  return (globalThis                                                              ).chrome.storage.local;
}

/**
 * 读取本地历史，并在**入口处**规整每一条。
 *
 * 只检查"整体是不是数组"是不够的：单条记录缺 concepts 字段（schema 迁移、
 * 有人在 DevTools 里手改、storage 写入中断）会让下游 `e.concepts.length`
 * 直接抛 TypeError，而且这条坏记录会一直待在 storage 里，
 * 每次读都崩一次。在入口一次性堵住，比指望每个消费者都记得判空可靠。
 */
export async function loadEvents()                       {
  const raw = await area().get(STORAGE_KEYS.EVENTS);
  const list = raw[STORAGE_KEYS.EVENTS];
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map(normalizeEvent);
}

function isObject(x         )                               {
  return typeof x === 'object' && x !== null;
}

export function normalizeEvent(raw                         )            {
  const concepts = Array.isArray(raw.concepts)
    ? (raw.concepts             ).filter(isObject).map((c) => ({
        canonical: typeof c.canonical === 'string' ? c.canonical : '',
        confidence: typeof c.confidence === 'number' ? c.confidence : 0,
      })).filter((c) => c.canonical)
    : [];
  return {
    id: typeof raw.id === 'string' ? raw.id : `broken-${Math.random().toString(36).slice(2)}`,
    contentId: typeof raw.contentId === 'string' ? raw.contentId : undefined,
    contentType: raw.contentType === 'article' || raw.contentType === 'answer' ? raw.contentType : 'unknown',
    title: typeof raw.title === 'string' ? raw.title : '',
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : 0,
    duration: typeof raw.duration === 'number' ? raw.duration : 0,
    concepts,
    analysisStatus: typeof raw.analysisStatus === 'string' ? (raw.analysisStatus                               ) : 'failed',
    analysisVersion: typeof raw.analysisVersion === 'string' ? raw.analysisVersion : 'unknown',
    // 这个字段必须在这里显式保留。
    // 归一化是**白名单**式的，漏一个字段不会报错，只会让它在下一次
    // 「读全量 → 改 → 写回」里被静默抹掉——真实端到端测试就是这么抓到它的：
    // 面板显示 status:'llm'，但每条记录的模型出处都没了，
    // 于是"这 20 篇是哪个模型打的标签"这个问题永远回答不了。
    analysis: normalizeMeta(raw.analysis),
    ambiguous: raw.ambiguous === true,
  };
}

function normalizeMeta(raw         )                           {
  if (!isObject(raw)) return undefined;
  if (typeof raw.version !== 'string' || typeof raw.promptVersion !== 'string') return undefined;
  return {
    version: raw.version,
    promptVersion: raw.promptVersion,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
  };
}

export async function appendEvent(e           )                       {
  const events = await loadEvents();
  events.push(e);
  const trimmed = trim(events);
  await area().set({ [STORAGE_KEYS.EVENTS]: trimmed });
  return trimmed;
}

export async function replaceEvents(events             )                {
  await area().set({ [STORAGE_KEYS.EVENTS]: trim(events) });
}

export function trim(events             , max = CONFIG.MAX_RECORDS)              {
  return events.slice(-max);
}

export async function loadSettings()                    {
  const raw = await area().get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...((raw[STORAGE_KEYS.SETTINGS]                     ) ?? {}) };
}

export async function saveSettings(s          )                {
  await area().set({ [STORAGE_KEYS.SETTINGS]: s });
}
