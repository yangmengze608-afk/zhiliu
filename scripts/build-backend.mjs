/**
 * 把 server/ + packages/core/ 擦成纯 JS，放进 deploy/ 供 Vercel 直接跑。
 *
 * 和 extension/build.mjs 同一个做法（Node 内置 stripTypeScriptTypes，零依赖），
 * 原因也一样：这个项目没有需要打包器才能解决的问题。
 *
 * 为什么不让 Vercel 直接跑 .ts：类型擦除要 Node 22.18+，而 Vercel 的运行时版本
 * 不由我们控制。先擦成 .js 就跟运行时版本无关了 —— 部署环节最不该引入的就是
 * "在我机器上能跑"。
 */
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deploy', '_lib');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const rewrite = (code) => code
  .replace(/(from\s*['"])(?:\.\.\/)+packages\/core\/src\/([^'"]+?)\.ts(['"])/g, '$1./core/$2.js$3')
  .replace(/(from\s*['"])\.\/concepts\.json(['"])\s*with\s*\{[^}]*\}/g, '$1./concepts.data.js$2')
  .replace(/(from\s*['"])([^'"]+?)\.ts(['"])/g, '$1$2.js$3');

function emit(src, out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rewrite(stripTypeScriptTypes(readFileSync(src, 'utf8'), { mode: 'strip' })));
}

const CORE = join(ROOT, 'packages', 'core', 'src');
let n = 0;
for (const f of readdirSync(CORE)) {
  if (!f.endsWith('.ts')) continue;
  emit(join(CORE, f), join(OUT, 'core', f.replace(/\.ts$/, '.js')));
  n++;
}
writeFileSync(join(OUT, 'core', 'concepts.data.js'),
  `export default ${readFileSync(join(CORE, 'concepts.json'), 'utf8')};\n`);
n++;
emit(join(ROOT, 'server', 'analyze.ts'), join(OUT, 'analyze.js'));
n++;

/*
 * 把构建时的 commit 写进产物，让 /api/analyze 能如实报出"我是哪一版"。
 *
 * 红队 R9 的"未证实的怀疑"第一条：线上跑的到底是不是当前源码，**无法核对**——
 * `deploy/_lib/` 是 gitignore 的构建产物，而健康检查只回 provider/model。
 * 在一个把"可被外部核对"当原则的项目里，那是唯一一处只能信我们的说法。
 * 一行的事，补上。
 */
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) commit += '-dirty';
} catch { /* 不是 git 仓库就保持 unknown，不编一个出来 */ }
writeFileSync(join(OUT, 'build.js'),
  `export const BUILD = ${JSON.stringify({ commit, builtAt: new Date().toISOString() })};\n`);
n++;

console.log(`后端构建完成：${n} 个模块 → ${relative(ROOT, OUT)}`);
