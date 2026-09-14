// MV3 content_scripts 是经典脚本，无法直接用 ESM import。
// 这里做一次动态 import，把真正的入口以模块方式加载进来。
(async () => {
  try {
    const url = chrome.runtime.getURL('content/main.js');
    await import(url);
  } catch (e) {
    console.warn('[知流] 入口加载失败', e);
  }
})();
