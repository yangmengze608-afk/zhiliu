/**
 * 有效阅读检测。
 *
 * 只有"页面可见 + 正文存在 + 累计停留达阈值 + 未在去重窗口内"四条同时满足，
 * 才算一次有效阅读。
 *
 * 这一层要顶住的真实场景（都有对应测试）：
 * - 快速点开又退出        → 不足阈值，不记
 * - 切到别的 tab 挂机     → 不可见不计时，不记
 * - 切走再切回            → 时间接着累计，不清零
 * - SPA 内部跳转          → 重置计时，按新内容重新计
 * - 浏览器前进 / 后退      → 同上，靠 URL 变化触发重置
 * - 同一篇重复打开        → 去重窗口内只记一次
 * - 多个知乎标签页        → 各自独立计时，靠去重避免重复入库
 * - 页面关闭             → 达标则在关闭前落盘
 */
import { CONFIG } from '../shared/config.ts';

export interface SessionHooks {
  isVisible: () => boolean;
  now: () => number;
  onQualified: () => void;
}

export class ReadingSession {
  #visibleMs = 0;
  #fired = false;
  #hooks: SessionHooks;
  #thresholdMs: number;
  /** 当前会话绑定的内容 key，用于识别 SPA 跳转 */
  #key = '';

  constructor(hooks: SessionHooks, thresholdSeconds = CONFIG.MIN_VISIBLE_SECONDS) {
    this.#hooks = hooks;
    this.#thresholdMs = thresholdSeconds * 1000;
  }

  get visibleMs(): number { return this.#visibleMs; }
  get fired(): boolean { return this.#fired; }
  get key(): string { return this.#key; }
  /** 达到阈值但尚未触发时，页面关闭前应当补记 */
  get qualifiesNow(): boolean { return !this.#fired && this.#visibleMs >= this.#thresholdMs; }

  /** 绑定到一段内容。key 变化即视为换了内容，计时重置。 */
  bind(key: string): void {
    if (key === this.#key) return;
    this.#key = key;
    this.#visibleMs = 0;
    this.#fired = false;
  }

  tick(deltaMs: number): void {
    if (this.#fired || !this.#key) return;
    if (!this.#hooks.isVisible()) return;
    this.#visibleMs += deltaMs;
    if (this.#visibleMs >= this.#thresholdMs) {
      this.#fired = true;
      this.#hooks.onQualified();
    }
  }

  /** 页面即将关闭：达标就补触发一次，避免最后一篇丢失。 */
  flush(): void {
    if (this.qualifiesNow) {
      this.#fired = true;
      this.#hooks.onQualified();
    }
  }

  reset(): void {
    this.#visibleMs = 0;
    this.#fired = false;
  }
}

/** 去重：同一内容在窗口内只记一次。 */
export function shouldRecord(
  key: string,
  history: Array<{ id: string; timestamp: number }>,
  now: number,
  windowMs = CONFIG.DEDUPE_WINDOW_MS,
): boolean {
  return !history.some((h) => h.id === key && now - h.timestamp < windowMs);
}
