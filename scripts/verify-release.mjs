/**
 * 提交前的最后一道验证：**用发布包里解压出来的那份代码**，真的打一次公网后端。
 *
 *   node scripts/verify-release.mjs
 *
 * 它和 release-check 的分工很清楚：
 *   release-check   检查仓库和产物的**静态**属性（端点对不对、有没有凭证、封面规格）
 *   verify-release  检查「评委装上的那个包」**跑起来**是什么行为
 *
 * 为什么必须验产物而不是验源码：源码里 ANALYZE_ENDPOINT 永远是空字符串
 * （那是门禁强制的），所以源码怎么测都测不出 production 包的真实行为。
 * 端点是在打包那一刻注入的，只有解开 zip 才看得到真相。
 *
 * 这会消耗 1 次直答额度。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'release', 'zhiliu-production.zip');
if (!existsSync(ZIP)) {
  console.error('没有 release/zhiliu-production.zip。先跑：');
  console.error('  ZHILIU_ANALYZE_ENDPOINT=https://…/analyze node scripts/package-release.mjs');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'zhiliu-verify-'));
try {
  execSync(`unzip -q "${ZIP}" -d "${dir}"`);

  // service worker 里的代码假定有 chrome.storage；这里只是让 import 能过。
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };

  const { CONFIG } = await import(`${dir}/shared/config.js`);
  const { requestAnalysis } = await import(`${dir}/background/analysis.js`);

  const problems = [];
  if (!CONFIG.ANALYZE_ENDPOINT) problems.push('包里没有端点 —— 装上只会显示演示数据');
  if (CONFIG.ANALYZE_ENDPOINT && !/^https:\/\//.test(CONFIG.ANALYZE_ENDPOINT)) {
    problems.push(`端点不是 https：${CONFIG.ANALYZE_ENDPOINT}`);
  }
  console.log(`端点        ${CONFIG.ANALYZE_ENDPOINT || '(空)'}`);

  if (!problems.length) {
    const t0 = Date.now();
    const r = await requestAnalysis({
      contentId: 'verify-release',
      contentType: 'answer',
      title: '在同一个岗位待满十年是什么体验',
      text: '第十年那天没有任何仪式感。我照常打卡，照常开会。同事里没有人比我待得更久，'
          + '所以也没有人能跟我聊这件事。我开始怀疑我留下来的理由到底是喜欢，还是只是不敢动。'.repeat(3),
    });
    const elapsed = Date.now() - t0;
    console.log(`耗时        ${elapsed} ms`);
    console.log(`status      ${r.status}`);
    console.log(`provider    ${r.analysis?.provider ?? '(无)'}`);
    console.log(`concepts    ${(r.concepts ?? []).map((c) => c.canonical).join(' ') || '(无)'}`);

    if (r.status !== 'llm') problems.push(`status 是 ${r.status}，不是 llm —— 面板不会显示「AI 分析」`);
    if (r.analysis?.provider !== 'zhida') problems.push(`provider 是 ${r.analysis?.provider}，不是 zhida`);
    if (r.analysis?.provider === 'local-mock') problems.push('走了本地 mock —— 这是最不该发生的那种失败');

    // **耗时也要断言。**
    //
    // 第一版打印了耗时却不检查它。于是一个被改过的包 —— 让 analysis.js 永不联网、
    // 返回本地常量、自称 status:'llm' 且带伪造的 provenance{provider:'zhida'} ——
    // 可以在 **0 ms** 内通过这里的每一条检查（红队实测）。
    // 真实的直答往返实测 1.4–3.4 秒，不可能低于 200ms。
    // 一次网络往返都做不到的"成功"，只能是本地编出来的。
    if (elapsed < 200) {
      problems.push(`耗时 ${elapsed}ms —— 一次真实的上游往返不可能这么快，这个结果是本地编的`);
    }
    // （不断言 latencyMs：`AnalysisMeta` 目前只带 version/promptVersion/provider/model，
    //   服务端返回的 latencyMs 在扩展侧被丢掉了。断言一个不存在的字段只会永远失败。
    //   耗时这条已经覆盖了同一个攻击面。）
  }

  console.log('');
  if (problems.length) { for (const p of problems) console.log(`  ✘ ${p}`); process.exit(1); }
  console.log('  ✔ production 包走的是真实链路，装上之后面板会显示「AI 分析」');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
