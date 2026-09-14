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
import { detectPage } from './detect-page.ts';
import { describeCandidates } from './extract-content.ts';
import type { ExtractedContent } from './extract-content.ts';

export interface DiagnosticSource {
  /**
   * **每次都重新抽取**，不要复用缓存。
   *
   * 早先这里是 `lastExtraction ?? extractContent()`，于是 `__zhiliu()` 可能显示
   * 上一次**成功**时的结果（`semantic / high`），而当前 DOM 已经变了
   * （知乎会懒加载补上外层容器）。真人拿到的就是一份自相矛盾的报告：
   * 策略写着 semantic、字数却是 0。诊断的唯一职责是说实话，不该有缓存。
   */
  extraction: ExtractedContent;
  /** 最近一次**真正入库**的抽取结果，与上面那份现场抽取分开显示。 */
  recorded?: ExtractedContent | null;
  /**
   * 布局解释。**必须是摊平的数字**，不是一个 `{mode:'hidden',width:0}` 就完了——
   * 2026-09-10 那次真人验证拿到的就是后者，除了"藏起来了"什么也说明不了，
   * 既不知道正文左边界量到多少，也不知道是哪个探针命中的。
   */
  layout?: Record<string, unknown>;
  visibleMs: number;
  fired: boolean;
  thresholdSeconds: number;
  view: () => Promise<unknown>;
}

export interface DiagnosticReport {
  url: string;
  urlPattern: string;
  detectedContentType: string;
  contentId: string | undefined;
  strategy: string;
  extractionConfidence: string;
  selectorMatched: string;
  titleLength: number;
  title: string;
  textLength: number;
  originalChars: number;
  truncated: boolean;
  /** 正文前 200 字。用来一眼看出有没有混进导航 / 评论 / 推荐位 */
  preview: string;
  readTimerMs: number;
  readThresholdMs: number;
  readQualified: boolean;
  /** 面板布局全量数字：视口 / 正文左右边界 / gutter / 算出来的 / 渲染出来的 / 是否重叠 */
  panelLayout: unknown;
  /** 所有根容器候选及其关系。真人验证时直接看这一段就知道为什么选/不选 */
  rootCandidates: unknown;
  /** 最近一次真正入库的抽取（可能来自上一篇），与现场抽取分开看 */
  lastRecorded: unknown;
  analysisState: unknown;
}

export function buildReport(src: DiagnosticSource): Omit<DiagnosticReport, 'analysisState'> {
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

declare const globalThis: Record<string, unknown>;

/**
 * 挂上 `window.__zhiliu()`。
 *
 * 返回一个 Promise，resolve 出完整报告；同时往 console 打一份**人类可读**的版本，
 * 因为真人做 field test 的时候不想读 JSON。
 */
export function installDiagnostics(src: () => DiagnosticSource): void {
  globalThis.__zhiliu = async (): Promise<DiagnosticReport> => {
    const s = src();
    const base = buildReport(s);
    let analysisState: unknown = null;
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
