/**
 * 生成 / 更新公开快照（`../zhiliu-public`）。
 *
 * 为什么要有这个脚本：快照第一次是手工挑出来的，于是三轮之后它就落后了 ——
 * 面板停靠偏好、集中度配色都只在内部仓库里。手工同步下一次还会漏。
 *
 * 规则来自 docs/GITHUB_RELEASE_HANDOFF.md，这里把它变成可执行的：
 *   保留  产品源码 / 核心测试 / 部署源码 / 产品文档 / 资产 / 两个 zip
 *   排除  内部研究材料（红队、盲测、选型中间产物、Expert OS 日志、handoff）、
 *         调试页、live 测试（要凭证）、以及任何含个人本地路径的文件
 *
 * **排除是白名单之外一律不进**，不是"列几个黑名单"——
 * 新加的内部材料默认不会被带出去。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, '..', 'zhiliu-public');

/** 进快照的路径前缀（白名单）。 */
const KEEP = [
  'README.md', '.gitignore', 'package.json',
  'extension/', 'packages/core/', 'packages/extension-test/',
  'server/', 'deploy/', 'scripts/', 'assets/', 'fixtures/live/', 'release/',
  'docs/', 'bench/',
];

/** 白名单之内仍要剔掉的。每一条都写清楚为什么。 */
const DROP = [
  ['extension/dev/', '调试页，不进评委第一阅读路径'],
  ['deploy/.vercel/', '含 projectId / orgId 内部标识'],
  ['deploy/.env', '凭证'],
  // ── 内部研究材料：含个人本地路径（PII）或属过程日志 ──
  ['docs/RED_TEAM', '红队报告，内部研究材料'],
  ['docs/AGENT_HANDOFF', '协作 handoff'],
  ['docs/CLAUDE_HANDOFF', '协作 handoff'],
  ['docs/CLAUDE_TASK', '协作 handoff'],
  ['docs/GITHUB_RELEASE_HANDOFF', '协作 handoff'],
  ['docs/DEPLOY_CN_HANDOFF', '协作 handoff'],
  ['docs/STATS_REVIEW', '内部评审'],
  ['docs/UX_REVIEW', '内部评审'],
  ['docs/DEMO_RELIABILITY', '内部预案'],
  ['docs/COGNITION_DIAGNOSIS', '仍在进行中的 follow-up 诊断，引用的 bench 文件不公开'],
  ['docs/DEMO_MAIN_SCRIPT', '录制脚本，不是产品文档'],
  ['docs/ZHIHU_API_DAY1', '内部过程记录'],
  ['bench/', '默认整个排除，只放行下面 BENCH_ALLOW 里 CLAIM_EVIDENCE 真正引用的那几个'],
];

/** `bench/` 里唯一放行的几个 —— CLAIM_EVIDENCE.md 直接引用它们作为证据。 */
const BENCH_ALLOW = [
  'bench/api-probe-report.json',
  'bench/model-select/runs-qwen2_5_14b.json',
  'bench/model-select/score-report.json',
];

const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');

function included(f) {
  if (BENCH_ALLOW.includes(f)) return true;
  if (!KEEP.some((k) => (k.endsWith('/') ? f.startsWith(k) : f === k))) return false;
  return !DROP.some(([p]) => f.startsWith(p));
}

const files = tracked.filter(included);

/**
 * `extension/dist/` 在内部仓库是 gitignore 的，但快照里**必须有** ——
 * 评委按 README clone 下来是直接装 `extension/` 的，没有 dist 就装不上。
 */
function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else acc.push(p.slice(ROOT.length + 1));
  }
  return acc;
}
const dist = existsSync(join(ROOT, 'extension/dist')) ? walk(join(ROOT, 'extension/dist')) : [];
/**
 * `deploy/_lib/` 同理：它是 `npm run build:backend` 的产物，内部仓库 gitignore，
 * 但快照里**必须有** —— 少了它 `deploy/` 不自足，评委照 README 部署会失败。
 * 里面的 build.js 带着构建时的 commit，正好也是"线上跑的是哪一版"的凭据。
 */
const backendLib = existsSync(join(ROOT, 'deploy/_lib')) ? walk(join(ROOT, 'deploy/_lib')) : [];
const deployPublicZips = ['deploy/public/zhiliu-production.zip', 'deploy/public/zhiliu-demo.zip']
  .filter((f) => existsSync(join(ROOT, f)));

const all = [...new Set([...files, ...dist, ...backendLib, ...deployPublicZips])].sort();

// 清掉旧内容（保留 .git 和 LICENSE —— LICENSE 只存在于快照里）
for (const e of readdirSync(OUT)) {
  if (e === '.git' || e === 'LICENSE') continue;
  rmSync(join(OUT, e), { recursive: true, force: true });
}
for (const f of all) {
  mkdirSync(dirname(join(OUT, f)), { recursive: true });
  copyFileSync(join(ROOT, f), join(OUT, f));
}

// ── 出门前的两道扫描。不通过就直接失败，绝不"先推了再说"。 ──
const problems = [];
const PII = [
  /\/Users\/[a-z0-9_.-]+\//i,
  /[\w.+-]+@(?:gmail|qq|163|outlook|hotmail)\.com/i,
  /**
   * 手机号。左右都要卡死：
   * 知乎的回答 id / 专栏 id 是十几位数字，`2009924017616859262` 里面必然
   * 藏着一串长得像手机号的子串；`/p/18698154193` 也是。
   * 只用 `\b` 收尾会把它们全报成手机号 —— 第一版就是这样，两条全是误报。
   */
  /(?<![\d\/])1[3-9]\d{9}(?![\d])/,
];
const SECRET = [/ZHIHU_ACCESS_SECRET\s*[:=]\s*['"][A-Za-z0-9_-]{16,}/];
for (const f of all) {
  if (/\.(zip|png|jpg|jpeg|ico|woff2?)$/i.test(f)) continue;
  const t = readFileSync(join(OUT, f), 'utf8');
  for (const re of PII) if (re.test(t)) problems.push(`${f} 含个人信息/本地路径：${t.match(re)[0]}`);
  for (const re of SECRET) if (re.test(t)) problems.push(`${f} 疑似含凭证`);
}
if (problems.length) {
  console.error('快照未通过出门扫描：');
  for (const p of problems) console.error('  ✘ ' + p);
  process.exit(1);
}
/**
 * 快照的 .gitignore 要和内部仓库**不一样**。
 *
 * 内部仓库忽略 `extension/dist/`、`deploy/_lib/`、`deploy/public/*.zip` ——
 * 它们都是构建产物。但快照里这三样是**发布内容**：
 * 评委 clone 下来直接装 `extension/`、照 README 部署 `deploy/`、从下载页拿 zip。
 *
 * 第一版快照是用 `git add -f` 硬塞进去的，于是 .gitignore 里的规则留着 ——
 * 这一轮新增的 `content/concentration-visual.js` / `oklch.js` 就被静默忽略了，
 * 差点推上去一个 dashboard.js 引用不到模块的坏 dist。
 * 所以这里把那三条规则从快照的 .gitignore 里摘掉，让 `git add -A` 本来就是对的。
 */
const gi = join(OUT, '.gitignore');
const kept = readFileSync(gi, 'utf8').split('\n')
  .filter((l) => !/^(extension\/dist\/|deploy\/_lib\/|deploy\/public\/\*\.zip)\s*$/.test(l));
writeFileSync(gi, kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() +
  '\n\n# 注意：extension/dist/、deploy/_lib/、deploy/public/*.zip 在内部仓库是构建产物、被忽略，\n' +
  '# 但在这个公开快照里它们是**发布内容**，必须进版本库。由 scripts/make-public-snapshot.mjs 维护。\n');

console.log(`快照 ${all.length} 个文件 → ${OUT}`);
console.log('PII / 凭证扫描：通过');
