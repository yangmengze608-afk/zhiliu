/**
 * 零依赖构建：用 Node 内置的类型擦除把 TypeScript 源转成浏览器可加载的 ESM。
 * 不引入 webpack / vite / esbuild —— 本项目没有需要打包器才能解决的问题。
 */
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const ROOT = import.meta.dirname;
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const CORE_SRC = join(ROOT, '..', 'packages', 'core', 'src');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * import 说明符改写：
 * 1. 源码里对 core 包的真实相对路径 → 扩展包内的 core/ 副本
 *    （源码必须引用真实路径，否则无法被 node --test 直接跑）
 * 2. 剩下的 .ts 后缀 → .js，否则浏览器会去请求一个不存在的文件
 */
function rewriteSpecifiers(code) {
  return code
    // core 包的真实相对路径 → 扩展包内的 core/ 副本
    .replace(/(from\s*['"])(?:\.\.\/)+packages\/core\/src\/([^'"]+?)\.ts(['"])/g, '$1../core/$2.js$3')
    // JSON 模块导入在浏览器里依赖 import attributes 支持，风险太大：
    // 构建时把 concepts.json 转成普通 JS 模块，彻底绕开这个不确定性
    .replace(/(from\s*['"])\.\/concepts\.json(['"])\s*with\s*\{[^}]*\}/g, '$1./concepts.data.js$2')
    .replace(/(from\s*['"])([^'"]+?)\.ts(['"])/g, '$1$2.js$3');
}

function emit(srcFile, outFile) {
  const code = readFileSync(srcFile, 'utf8');
  const js = srcFile.endsWith('.ts') ? stripTypeScriptTypes(code, { mode: 'strip' }) : code;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, rewriteSpecifiers(js));
}

let count = 0;
for (const f of walk(SRC)) {
  if (!/\.(ts|js)$/.test(f)) continue;
  const rel = relative(SRC, f).replace(/\.ts$/, '.js');
  emit(f, join(DIST, rel));
  count++;
}

// 扩展需要：数据模型、概念归一、抽取契约、聚合与集中度。
// grounding / corpus / zhihu-client 属于服务端职责，不进扩展包。
for (const f of ['model', 'canonicalize', 'extract', 'concentration', 'aggregate', 'registry']) {
  emit(join(CORE_SRC, `${f}.ts`), join(DIST, 'core', `${f}.js`));
  count++;
}

// concepts.json → 普通 JS 模块
const conceptsJson = readFileSync(join(CORE_SRC, 'concepts.json'), 'utf8');
writeFileSync(join(DIST, 'core', 'concepts.data.js'), `export default ${conceptsJson};\n`);
count++;

cpSync(join(ROOT, 'manifest.json'), join(DIST, 'manifest.json'));

/**
 * production 构建：把分析端点烧进 dist。
 *
 *   ZHILIU_ANALYZE_ENDPOINT=https://xxx/analyze node extension/build.mjs
 *
 * 为什么用环境变量而不是改源码：`CONFIG.ANALYZE_ENDPOINT` 在仓库里**必须**保持
 * 空字符串。空 = 走本地演示数据 + 面板打「演示数据」标记，这是发布门禁强制的
 * （F-08：出货扩展默认不是实时 AI）。把真实地址 commit 进去，等于让
 * 任何 clone 这个仓库的人默认连到我们的后端，也会让门禁失去意义。
 *
 * 所以地址只在打 production 包的那一刻注入，且**只注入到 dist**，不回写 src。
 * 同时校验它必须是 https —— Chrome 扩展从 https 页面发 http 请求会被直接拦掉，
 * 那种失败在面板上只表现为"分析失败"，很难查。
 */
const ENDPOINT = process.env.ZHILIU_ANALYZE_ENDPOINT ?? '';
if (ENDPOINT) {
  if (!/^https:\/\//.test(ENDPOINT)) {
    console.error(`拒绝构建：ZHILIU_ANALYZE_ENDPOINT 必须是 https，收到 ${ENDPOINT}`);
    process.exit(1);
  }
  const cfgPath = join(DIST, 'shared', 'config.js');
  const cfg = readFileSync(cfgPath, 'utf8');
  const patched = cfg.replace(/ANALYZE_ENDPOINT:\s*''/, `ANALYZE_ENDPOINT: '${ENDPOINT}'`);
  if (patched === cfg) {
    console.error('拒绝构建：没能在 dist/shared/config.js 里找到 ANALYZE_ENDPOINT: \'\' —— 注入失败');
    process.exit(1);
  }
  writeFileSync(cfgPath, patched);
  // 同时把端点写进 manifest 的 host_permissions，否则 MV3 会拦掉这个跨域请求。
  const mfPath = join(DIST, 'manifest.json');
  const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  const origin = new URL(ENDPOINT).origin + '/*';
  mf.host_permissions = [...new Set([...(mf.host_permissions ?? []), origin])];
  writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');
  console.log(`已注入分析端点：${ENDPOINT}`);
  console.log(`已加入 host_permissions：${origin}`);
} else {
  console.log('未注入分析端点（演示构建）：面板将显示「演示数据」标记。');
  console.log('  打 production 包：ZHILIU_ANALYZE_ENDPOINT=https://… node extension/build.mjs');
}

console.log(`构建完成：${count} 个模块 → ${DIST}`);
console.log('在 chrome://extensions 开启开发者模式，"加载已解压的扩展程序"，选择 extension/dist');
