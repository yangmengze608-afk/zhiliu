/**
 * 打两个可分发的扩展包。
 *
 *   node scripts/package-release.mjs                                  # 只打演示包
 *   ZHILIU_ANALYZE_ENDPOINT=https://…/analyze node scripts/package-release.mjs   # 两个都打
 *
 * 为什么必须是两个而不是一个：
 *
 *   zhiliu-demo.zip        没有后端地址 → 走本地确定性数据 → 面板挂「演示数据」标记。
 *                          评委不配环境也能看到产品形态，但它**不是**实时分析。
 *   zhiliu-production.zip   烧进了公网 HTTPS 后端地址 → 真实链路 → 面板显示「AI 分析」。
 *
 * 两个包**绝不能混**。混了的后果是上一轮红队反复抓的那件事：
 * 后台是 mock，前端看起来像真实 AI 分析。所以这里在打包后逐个校验：
 * production 包里必须有 https 端点，demo 包里必须没有任何端点。
 */
import { execSync } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'extension', 'dist');
const OUT = join(ROOT, 'release');

const endpoint = process.env.ZHILIU_ANALYZE_ENDPOINT ?? '';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function build(env) {
  execSync('node extension/build.mjs', { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'pipe' });
}

/** 读 dist 里真正烧进去的端点。校验看的是产物，不是我们打算写什么。 */
function bakedEndpoint() {
  const m = readFileSync(join(DIST, 'shared', 'config.js'), 'utf8').match(/ANALYZE_ENDPOINT:\s*'([^']*)'/);
  return m ? m[1] : null;
}

function zip(name) {
  const out = join(OUT, name);
  // -r 递归，-q 安静；进 dist 再打包，保证 zip 里是 manifest.json 在根，
  // 而不是套一层 dist/ —— 套了的话「加载已解压的扩展程序」会选不中。
  execSync(`cd "${DIST}" && zip -qr "${out}" . -x '.*'`, { shell: '/bin/bash' });
  return out;
}

/** 打完必须解开看一眼：凭证、端点、manifest 三样都在产物里核对。 */
function verify(zipPath, { expectEndpoint }) {
  const listing = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8' });
  const problems = [];
  if (!/\bmanifest\.json\b/.test(listing)) problems.push('包里没有 manifest.json');
  if (!/background\/service-worker\.js/.test(listing)) problems.push('包里没有 service worker');

  const cfg = execSync(`unzip -p "${zipPath}" shared/config.js`, { encoding: 'utf8' });
  const baked = (cfg.match(/ANALYZE_ENDPOINT:\s*'([^']*)'/) ?? [])[1];
  if (expectEndpoint === null && baked) problems.push(`演示包里不该有端点，却烧进了 ${baked}`);
  if (expectEndpoint && baked !== expectEndpoint) problems.push(`端点不符：期望 ${expectEndpoint}，产物里是 ${baked || '(空)'}`);

  // 凭证扫描：40 位十六进制 / Bearer / Access Secret 字样，一个都不许出现。
  const all = execSync(`unzip -p "${zipPath}" '*.js' '*.json'`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (/\b[0-9a-f]{40}\b/.test(all)) problems.push('包里出现了 40 位十六进制串（疑似凭证）');
  if (/ZHIHU_ACCESS_SECRET|accessSecret|Bearer\s/.test(all)) problems.push('包里出现了凭证相关字样');

  const mf = JSON.parse(execSync(`unzip -p "${zipPath}" manifest.json`, { encoding: 'utf8' }));
  if (mf.manifest_version !== 3) problems.push('manifest_version 不是 3');
  if (expectEndpoint) {
    const origin = new URL(expectEndpoint).origin + '/*';
    if (!(mf.host_permissions ?? []).includes(origin)) problems.push(`manifest 缺少 host_permissions ${origin}`);
  } else if ((mf.host_permissions ?? []).length) {
    problems.push(`演示包不该有 host_permissions，却有 ${JSON.stringify(mf.host_permissions)}`);
  }
  return problems;
}

const made = [];

// ── 演示包 ─────────────────────────────────────
build({ ZHILIU_ANALYZE_ENDPOINT: '' });
if (bakedEndpoint()) { console.error('演示构建里出现了端点，中止'); process.exit(1); }
made.push(['zhiliu-demo.zip', zip('zhiliu-demo.zip'), { expectEndpoint: null }]);

// ── production 包 ──────────────────────────────
if (endpoint) {
  build({ ZHILIU_ANALYZE_ENDPOINT: endpoint });
  if (bakedEndpoint() !== endpoint) { console.error('端点注入失败，中止'); process.exit(1); }
  made.push(['zhiliu-production.zip', zip('zhiliu-production.zip'), { expectEndpoint: endpoint }]);
} else {
  console.log('未设置 ZHILIU_ANALYZE_ENDPOINT —— 只打了演示包。');
  console.log('production 包需要一个公网 HTTPS 后端地址，见 docs/DEPLOY_BACKEND.md。');
}

// 结束后把 dist 恢复成干净的演示构建，避免带着真实端点的 dist 留在工作区
build({ ZHILIU_ANALYZE_ENDPOINT: '' });

let bad = 0;
console.log('');
for (const [name, path, opts] of made) {
  const problems = verify(path, opts);
  const kb = (statSync(path).size / 1024).toFixed(0);
  if (problems.length) { bad++; console.log(`  ✘ ${name}  ${kb} KB`); for (const p of problems) console.log(`      ${p}`); }
  else console.log(`  ✔ ${name}  ${kb} KB  ${opts.expectEndpoint ? `→ ${opts.expectEndpoint}` : '演示数据（无端点）'}`);
}
console.log(`\n产物在 ${OUT}`);
process.exit(bad ? 1 : 0);
