/**
 * 发布门禁。**失败必须非零退出。**
 *
 *   npm run release-check
 *
 * 它检查的不是"代码对不对"（那是 279 个测试的事），而是
 * **"我们准备对外说的话，有没有超过手里的证据"**。
 *
 * ## 第一版被红队打穿了三次，这一版针对性重写
 *
 * 1. **kill switch**：`历史文档` 四个字出现在 production 文档**任何位置**
 *    （哪怕只是一句交叉引用），整个文件的禁令检查就全部跳过。
 *    实测往 README 追加一句「（详见历史文档 X）」+ 四条禁令 → 门禁 14/14 全绿。
 *    → 现在 **production 文档没有任何豁免出口**；历史文档靠"不在名单里"来豁免。
 * 2. **正则太窄**：21 个改写里 14 个能过（`支持知乎全部页面`、`已对接`、
 *    繁体 `頁面`、全角空格、英文……）。→ 先归一化再匹配，并补齐同义词。
 * 3. **14 项里 9 项是 grep 字符串**：把 `sourceBadge` 改成多数决、
 *    把白名单改成 `if (false && ...)`、把 live-e2e 换成硬编码假数据，
 *    门禁照样全绿。→ 关键项改成**真的 import 进来跑一遍**。
 *
 * 还是要说清楚它的边界：它挡的是**已知形状**的 overclaim。
 * 它读不懂自然语言，`docs/CLAIM_EVIDENCE.md` 仍然需要人读。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const has = (p: string) => existsSync(join(ROOT, p));

/**
 * 去掉 TS/JS 注释再检查。
 *
 * 必要性来自一次真实的误报：搜「代码里有没有 OAuth 实现」时，
 * 注释里写的 `redirect_uri`（在解释"我们为什么不做 OAuth"）会被当成实现。
 * 反过来也一样：注释里的禁止措辞不是对外文案。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const failures: Array<{ check: string; detail: string }> = [];
const passed: string[] = [];
async function check(name: string, fn: () => Promise<string | null> | string | null): Promise<void> {
  let detail: string | null;
  try { detail = await fn(); } catch (e) { detail = `检查本身抛错：${e instanceof Error ? e.message : String(e)}`; }
  if (detail === null) passed.push(name); else failures.push({ check: name, detail });
}

/**
 * 对外文案 = **除豁免名单以外的全部 `docs/*.md` 与根目录 `*.md`**。
 *
 * ## 为什么从"白名单"改成"豁免名单"
 *
 * 红队 R8-2：`docs/API_LIVE_20260913.md` 是今天新增的、被登记表指为
 * C-08/C-09 **唯一出处**的文档，却不在旧的白名单里。往它追加六条今天为假的
 * claim（含"已接入知乎登录""直答比 14B 更准"），门禁 **17 通过 0 失败**。
 *
 * 白名单的结构性问题是：**每加一份文档就多一个洞**，而且洞恰好开在
 * 最新、最可能出错的那份上。改成豁免名单之后，新文档默认受管。
 */
const EXEMPT_DOCS = new Set([
  // 历史审计记录：它们的工作就是引用当初说错的原话
  'docs/PRD.md',
  'docs/ARCHITECTURE.md',
  'docs/SEMANTIC_GROUNDING.md',
  'docs/DEMO_RELIABILITY.md',
]);
/** 前缀豁免：整类历史文档。 */
const EXEMPT_PREFIXES = ['docs/RED_TEAM', 'docs/CLAUDE_TASK_', 'docs/CLAUDE_HANDOFF', 'docs/AGENT_HANDOFF'];

function productionDocs(): string[] {
  const out: string[] = [];
  for (const dir of ['.', 'docs']) {
    let names: string[] = [];
    try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const rel = dir === '.' ? n : `${dir}/${n}`;
      if (EXEMPT_DOCS.has(rel)) continue;
      if (EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) continue;
      out.push(rel);
    }
  }
  return out.sort();
}
const PRODUCTION_DOCS = productionDocs();

/** 扩展里会被用户看见的字符串，也算对外文案。 */
const UI_SOURCES = ['extension/src/content/dashboard.ts'];

/**
 * 归一化：把改写手段消掉再匹配。
 * 去 markdown 强调、去全角/普通空格、繁转简（只处理会出现的几个字）。
 */
function norm(text: string): string {
  return text
    .replace(/[*_`~]/g, '')
    .replace(/[\s　]/g, '')
    .replace(/頁/g, '页').replace(/麵/g, '面').replace(/準確/g, '准确')
    .replace(/實/g, '实').replace(/證/g, '证').replace(/據/g, '据')
    .replace(/接續|對接|對街/g, '对接');
}

/**
 * 否定式豁免。**刻意收窄**：第一版把 `避免` 也算进来，
 * 于是「为避免误解，这里说明：知流已接入知乎 Search API」能大摇大摆通过。
 */
const NEGATION = /不再宣称|禁止出现|绝不|不得说|不能说|不能用来|不能当|不等于|未能证明|测不出|从未|一次都没有|不讲|不要讲|不该说|不许|❌/;
const ATTRIBUTED_QUOTE = /官方赛道|赛道说明|官方手册|原话|引自/;

/** 由「事实断言」检查而不是措辞正则守护的禁令编号。它们仍是登记表里的真禁令。 */
const FACT_ASSERTION_IDS = new Set(['F-13']);

const FORBIDDEN: Array<{ id: string; re: RegExp; why: string }> = [
  { id: 'F-01', re: /支持(知乎)?(所有|全部|一切|任何)页面|(所有|全部)知乎页面(都)?(支持|可用)|覆盖知乎(的)?(每一种|所有|全部)页面|supportsallzhihupages/i,
    why: '证据只覆盖 answer 与 article' },
  // F-02 / F-03 在 2026-09-13 解除 —— 那天真的打通了，再禁就是反过来说假话。
  // 但**不能只删不补**：解除一条禁令的同时必须补上今天仍然为假的那些说法，
  // 否则门禁会随着能力上线而单调变松。下面四条就是补上的。
  // `[^不没未别勿]{0,10}` 而不是 `.{0,10}`：否则「搜索**不提升**准确率」
  // 会被自己的禁令抓住。红队 R8 的收紧把这条暴露了出来。
  { id: 'F-11', re: /(知乎)?(的)?搜索[^不没未别勿]{0,12}(提升|提高|改善|优化)[^不没未别勿]{0,8}(准确|判断|归类|分类|主题)|搜索(结果)?[^不没未别勿]{0,8}(已|已经)?[^不没未别勿]{0,6}(进入|接入|参与)[^不没未别勿]{0,6}(分析)?(主链路|概念判定|判定|分类)/i,
    why: '搜索没有进主链路，也测不出准确率增益' },
  // 放宽到「A 比 B 好」的一般形状 + 「换成官方之后变好了」的一般形状。
  { id: 'F-12', re: /(直答|官方(模型|直答|API))[^。；\n]{0,16}(比|优于|强于|好于)[^。；\n]{0,16}(本地|本机|14B|qwen|自建)|(本地|本机|14B|qwen)[^。；\n]{0,16}(不如|比不上)[^。；\n]{0,12}(直答|官方)|(直答|官方(模型|直答|API))[^。；\n]{0,16}(更|明显)(准|精确|靠谱|可靠|好)|(换|用)(成|了)?(知乎)?官方[^。；\n]{0,16}(之后|后)?[^。；\n]{0,10}(更|明显)(准|精确|靠谱|好)|(标签)?质量[^。；\n]{0,8}(明显)?更好/i,
    why: '分差 +0.103，判官重测漂移 0.172 比它更大 —— 测不出差别' },
  // **F-13 不用措辞正则**，改成下面那条「代码在不在」的事实断言。
  // 红队 R8-7：措辞正则挡不住「已支持知乎登录」「知乎登录功能已上线」
  // 「我们完成了知乎账号登录的接入」—— 15 个自然改写里 14 个能过。
  // 布尔能力型 claim（做了/没做）应该由代码判定，不该靠猜人怎么写。
  { id: 'F-14', re: /5000[^。；\n]{0,16}(够|随便|随意|不用担心|无需担心|足够)|(够|可以)(随便|随意)(调用|打|请求)|(基本)?不用担心额度/i,
    why: '日额度 5000 与瞬时限速是两回事：背靠背 12 次后连续 429' },
  { id: 'F-04', re: /知乎(的)?(Search)?API(能|可以|能够)?(提升|提高|改善)(主题)?(分类)?准确率/i,
    why: '盲测四层 McNemar p 0.125–1.000，测不出增益' },
  { id: 'F-05', re: /知流.{0,14}准确率.{0,14}(88\.9|0\.889)|(88\.9%|0\.889).{0,14}(产品|知流)准确率|产品准确率.{0,14}(88\.9|0\.889)/,
    why: '0.889 是 Claude 实验分类器，不是产品' },
  { id: 'F-06', re: /(比|较)(别人|竞品|其他产品|同类)(更)?准/,
    why: '没有与任何第三方做过对照' },
  { id: 'F-07', re: /打破信息茧房|走出信息茧房|诊断你的偏见|纠正知乎(的)?算法|判断你被困住/,
    why: '产品不做价值判断' },
];

// ── 1. 登记表 ─────────────────────────────────────────────
await check('CLAIM_EVIDENCE.md 存在且登记了 claim', () => {
  if (!has('docs/CLAIM_EVIDENCE.md')) return '缺少 docs/CLAIM_EVIDENCE.md';
  const t = read('docs/CLAIM_EVIDENCE.md');
  if (!/C-01/.test(t) || !/F-01/.test(t)) return '登记表里缺少 SUPPORTED 或 FORBIDDEN 分区';
  // 解除禁令必须留痕：F-02/F-03 是 2026-09-13 解除的，登记表里必须写清
  // 它们被哪条 L5 claim 取代，不能悄悄删掉一行了事。
  if (!/C-08/.test(t) || !/C-09/.test(t)) return '登记表里缺少 C-08 / C-09（官方 API 的 L5 claim）';
  if (!/F-02.*解除/.test(t) || !/F-03.*解除/.test(t)) return 'F-02 / F-03 被解除了，但登记表里没有写明由哪条 claim 取代';
  return null;
});

// ── 1.5 凭证不得进仓库 ────────────────────────────────────
/**
 * 2026-09-13 新增。这一轮第一次有了真实的 Access Secret，
 * 而在此之前门禁**完全没有**检查过凭证泄漏——它检查了十几条文案，
 * 却挡不住把 secret commit 进去这件后果最严重的事。
 *
 * 扫的是**形状**不是某一个具体的值：写死某个值意味着换一把 key 就失效。
 * 40 位十六进制会误伤 git SHA，所以只在会被提交的文本里扫，
 * 并排除掉紧挨着 commit / sha 字样的那些。
 */
await check('仓库里没有凭证形状的字符串', async () => {
  const { execSync } = await import('node:child_process');
  let files: string[] = [];
  try {
    // **索引 + 未跟踪**。红队 R8-8：只看 `git ls-files` 的话，
    // 「写文件 → 跑门禁（未跟踪，扫不到，绿）→ git add -A && commit」是一条完整通路。
    const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n');
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: ROOT, encoding: 'utf8' }).split('\n');
    files = [...tracked, ...untracked].filter(Boolean);
  } catch { return null; } // 不是 git 仓库就跳过，不误报
  const hits: string[] = [];
  const SECRETISH = /\b[0-9a-f]{40}\b/g;
  const objCache = new Map<string, boolean>();
  const isGitObject = (h: string): boolean => {
    const hit = objCache.get(h);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      execSync(`git cat-file -e ${h}^{object}`, { cwd: ROOT, stdio: 'ignore' });
      ok = true;
    } catch { ok = false; }
    objCache.set(h, ok);
    return ok;
  };
  // **黑名单而不是白名单。** 旧实现只扫 md|ts|js|json|mjs|html|css|txt|yml|yaml，
  // 于是 `scripts/demo-env.sh` 里的 `export ZHIHU_ACCESS_SECRET=<40位hex>` 完全免检 ——
  // 而「演示前临时写个 env 脚本」正是凌晨会发生的事。改成跳过已知二进制，其余全扫。
  const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mov|dmg|lock)$/i;
  for (const f of files) {
    if (SKIP_EXT.test(f)) continue;
    if (!has(f)) continue;
    const t = read(f);
    for (const line of t.split('\n')) {
      const m = line.match(SECRETISH);
      if (!m) continue;
      // **不再看关键词。** 旧实现只要同行出现 `commit` / `sha` / `冻结` / `校验和`
      // 就放过，于是 `# 冻结校验：<40位hex>` 和 `const X = "<40位hex>"; // commit`
      // 都能把真凭证带进仓库（红队 R8-8 两个 PoC 都跑通了）。
      // 改成**去问 git**：这个值必须真的是一个 git 对象。凭证不会是。
      if (m.every((h) => isGitObject(h))) continue;
      hits.push(`${f}: ${line.trim().slice(0, 80)}`);
    }
  }
  // 同时挡住"把 secret 写进环境变量默认值"这种写法
  for (const f of files) {
    if (!/\.(ts|js|mjs|json)$/.test(f) || !has(f)) continue;
    const t = read(f);
    // 值必须**看起来像凭证**才算命中：只由 [A-Za-z0-9_-] 组成且够长。
    // 帮助文案里的 `ZHIHU_ACCESS_SECRET='<你的 secret>'` 不是凭证，
    // 第一版正则把它也算进去了，那种误报会让人学会无视门禁。
    const m = t.match(/ZHIHU_ACCESS_SECRET\s*(\?\?|\|\||[:=])\s*['"][A-Za-z0-9_-]{16,}['"]/);
    if (m) hits.push(`${f}: 给 ZHIHU_ACCESS_SECRET 写了像凭证的默认值 —— ${m[0].slice(0, 50)}`);
  }
  return hits.length ? `疑似凭证进了仓库：\n    ${hits.join('\n    ')}` : null;
});

await check('扩展源码里不出现任何 Access Secret 相关读取', () => {
  // Access Secret 只允许存在于服务端进程环境。扩展是分发给用户的，
  // 里面一旦出现读取凭证的代码，就意味着凭证迟早要进包。
  const bad: string[] = [];
  for (const f of ['extension/src/content/dashboard.ts', 'extension/src/background/index.ts',
                   'extension/src/content/index.ts', 'extension/src/config.ts']) {
    if (!has(f)) continue;
    const t = read(f);
    if (/ZHIHU_ACCESS_SECRET|accessSecret|Bearer /.test(t)) bad.push(f);
  }
  return bad.length ? `扩展源码里出现了凭证相关代码：${bad.join(', ')}` : null;
});

// ── 2. 禁止措辞（**production 文档无豁免出口**）────────────
await check('production 文档与 UI 字符串里没有禁止措辞', () => {
  const hits: string[] = [];
  for (const f of [...PRODUCTION_DOCS, ...UI_SOURCES]) {
    if (!has(f)) continue;
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      // 登记表必须把禁止的说法写出来才能禁止它；其余文件一律没有豁免
      if (f === 'docs/CLAIM_EVIDENCE.md') return;
      const n = norm(line);
      for (const rule of FORBIDDEN) {
        const m = rule.re.exec(n);
        if (!m) continue;
        // **豁免必须同行，且否定词必须出现在被禁措辞之前。**
        //
        // 旧实现开的是 ±2 行的窗口，只要附近任何一行出现 `❌` / `绝不` / `官方手册`
        // 就整行免检。红队 R8-3 实测：在 README 里插一行 `❌`、空一行、
        // 再写三条禁止的 claim → 17 通过 0 失败；去掉那个 `❌` 就立刻被抓。
        // 而且这不是刻意攻击才会出现的形状 —— 红队量过，
        // production 文档里已有 131/1322 行（9.9%）天然落在窗口内，
        // PITCH 21%、DEMO_SCRIPT 26%，恰好是 claim 最密集的段落，
        // 因为我们习惯把「❌ 不能说 X」写在 claim 旁边。
        const before = n.slice(0, m.index);
        if (NEGATION.test(before)) continue;
        // **显式豁免**：只认同一行或上一行的 `<!-- gate:allow F-xx 原因 -->`。
        //
        // 为什么不再用"附近出现否定词"这种启发式：收紧成同行之后立刻冒出
        // 四条误报，全是"为了禁止某句话而引用它"的正常写法
        // （表格里引用官方赛道原话、`**不要**读成"所有知乎页面都支持"`）。
        // 启发式在这两个方向上都会错：漏掉真 overclaim，又误伤合法引用。
        // 显式标记把"这一行为什么允许"变成可审计的文本，而不是靠猜。
        const marker = new RegExp(`gate:allow\\s+${rule.id}\\b`);
        if (marker.test(line) || (i > 0 && marker.test(lines[i - 1]))) continue;
        hits.push(`${f}:${i + 1} [${rule.id}] ${rule.why} → ${line.trim().slice(0, 70)}`);
      }
    });
  }
  return hits.length ? hits.join('\n    ') : null;
});

/**
 * 豁免标记本身也要受管：它可以让一行免检，所以它必须
 * ① 指向一个登记表里真实存在的 F 编号，② 写出理由。
 * 否则 `gate:allow F-99` 就成了新的 kill switch。
 */
/**
 * F-13 的事实断言版。
 *
 * 「我们接了知乎登录」是一个**布尔能力**：做了或没做，代码里看得见。
 * 所以不去猜人会怎么写这句话，而是先确认代码里到底有没有 OAuth，
 * 再要求所有提到它的行必须同时带上否定/降级限定。
 *
 * 这比措辞正则可靠得多：红队实测措辞版挡不住「已支持知乎登录」
 * 「知乎登录功能已上线」这类只差一个字的改写。
 */
await check('OAuth：代码里没有，文档里就不许当成已有能力说', () => {
  // 不扫 scripts/：门禁自己的正则字面量里就写着 `redirect_uri`，
  // 会把检查器本身当成 OAuth 实现。要判定的是**产品代码**。
  const CODE = ['extension/src', 'packages/core/src', 'server'];
  const implemented: string[] = [];
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(join(ROOT, dir), { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)); }
    catch { return; }
    for (const n of names) {
      const rel = `${dir}/${n.replace(/\/$/, '')}`;
      if (n.endsWith('/')) { walk(rel); continue; }
      if (!/\.(ts|js|mjs)$/.test(n) || !has(rel)) continue;
      const body = stripComments(read(rel));
      if (/client_secret|redirect_uri|\/oauth\/|authorize\?|X-OAuth-Token/i.test(body)) implemented.push(rel);
    }
  };
  CODE.forEach(walk);
  if (implemented.length) {
    // 真做了，这条检查就该换成"检查它是否被正确描述"，而不是继续假装没做
    return `代码里出现了 OAuth 实现（${implemented.join(', ')}）——` +
      '这条检查假设 OAuth 未实现。请更新 CLAIM_EVIDENCE 的 U-08 与本检查。';
  }
  // 「知乎登录**态**」「真实知乎登录」指的是浏览器里登着知乎账号，
  // 和「接入知乎登录」（OAuth）是两回事。第一版正则把前者也抓了 ——
  // 而且它抓的还是另一个 agent 写的协作文档，属于纯误报。
  // 误报比漏报更能让人学会无视门禁，所以这里先把这几种写法排除掉。
  // 除了「登录态」，还要排除**在讨论这条门禁本身**的行
  // （比如列举门禁名字时写的「OAuth 事实断言」）。
  const NOT_OAUTH = /登录态|登录状态|已?登录的?(浏览器|账号|Chrome)|真实知乎登录|保持登录|OAuth\s*(事实断言|检查|门禁|断言)|回调地址.{0,6}(留空|可空|不填)/;
  const OAUTH = /知乎登录|OAuth|知乎账号登录|一键登录/i;
  const SAFE = /没做|未做|不许|不能|禁止|L0|P1|一行代码都没写|未实现|不接|没有做|不做|将来|以后|后续|❌|~~/;
  const bad: string[] = [];
  for (const f of [...PRODUCTION_DOCS, ...UI_SOURCES]) {
    if (!has(f)) continue;
    read(f).split('\n').forEach((line, i) => {
      if (!OAUTH.test(line)) return;
      if (NOT_OAUTH.test(line)) return;
      if (SAFE.test(line)) return;
      if (/gate:allow\s+F-13\b/.test(line)) return;
      bad.push(`${f}:${i + 1} 提到了 OAuth / 知乎登录，但同行没有任何"没做"的限定 → ${line.trim().slice(0, 64)}`);
    });
  }
  return bad.length ? bad.join('\n    ') : null;
});

await check('gate:allow 标记必须指向真实的禁令并写明理由', () => {
  const registry = read('docs/CLAIM_EVIDENCE.md');
  const bad: string[] = [];
  for (const f of [...PRODUCTION_DOCS, ...UI_SOURCES]) {
    if (!has(f)) continue;
    read(f).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/gate:allow\s+(\S+)([^>]*)/g)) {
        const id = m[1];
        // F-13 不在 FORBIDDEN 里（它是上面那条"代码里有没有 OAuth"的事实断言），
        // 但它仍然是一个真实的禁令编号，所以 gate:allow F-13 必须被接受。
        const known = FORBIDDEN.some((r) => r.id === id) || FACT_ASSERTION_IDS.has(id);
        if (!known) bad.push(`${f}:${i + 1} 豁免了不存在的禁令 ${id}`);
        else if (!new RegExp(`\\*\\*${id}\\*\\*`).test(registry)) bad.push(`${f}:${i + 1} ${id} 不在登记表里`);
        if (m[2].replace(/-->|\s/g, '').length < 4) bad.push(`${f}:${i + 1} ${id} 的豁免没写理由`);
      }
    });
  }
  return bad.length ? bad.join('\n    ') : null;
});

await check('0.889 / 88.9 出现处必须带「实验」限定', () => {
  const bad: string[] = [];
  for (const f of PRODUCTION_DOCS) {
    if (!has(f)) continue;
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (!/0\.889|88\.9/.test(line)) return;
      if (f === 'docs/CLAIM_EVIDENCE.md') return; // 登记表必须写出被禁的数字才能禁它
      const near = lines.slice(Math.max(0, i - 3), i + 4).join(' ');
      if (/实验|experimental|Claude/.test(near)) return;
      bad.push(`${f}:${i + 1} → ${line.trim().slice(0, 70)}`);
    });
  }
  return bad.length ? bad.join('\n    ') : null;
});

// ── 3. meta：L4 / L5 必须有原始输出 ───────────────────────
/**
 * 红队 R7-1：`Answer layout` 被从 L2 直接翻成 L4，而同一份文档里还留着
 * "布局没有通过验证"。这条检查本可以在当轮就抓到它。
 */
/**
 * 2026-09-13 扩到 L5。红队 R8-4：**L5 是唯一没有门禁的证据等级**——
 * 旧实现只匹配 `**L4**`，而今天新增的 C-04/C-08/C-09/C-10 全是 L5。
 * 实测往登记表追加一条无证据、无出处的 `C-99 … **L5** … SUPPORTED`，
 * 门禁 17 通过 0 失败。这正是 R7「L4 证据缺出处」的同一形状，只是升了一级：
 * **给某一级建了门禁，然后引入新的一级时忘了扩。**
 */
await check('标 L4 / L5 的 claim 必须写明证据出处，且出处文件真的存在', () => {
  const t = read('docs/CLAIM_EVIDENCE.md');
  const bad: string[] = [];
  for (const block of t.split(/\n### /).slice(1)) {
    if (!/\*\*L[45]\*\*|（L[45]）|\(L[45]\)/.test(block)) continue;
    const id = block.split('\n')[0].trim();
    if (!/证据细节|证据出处|Evidence detail/.test(block)) bad.push(`${id} 标了 L4/L5 但没有证据细节`);
    // 出处若指向一个仓库路径，该路径**必须存在**。
    // 红队 R8-4：`api-probe.ts` 自称"本脚本的输出是唯一能支撑真实调用过的证据"，
    // 而它声明的输出文件 `bench/api-probe-report.json` 从未存在过。
    for (const m of block.matchAll(/`((?:docs|bench|fixtures|packages|server|extension|scripts)\/[\w./-]+)`/g)) {
      if (!has(m[1])) bad.push(`${id} 的证据指向 ${m[1]}，但这个文件不存在`);
    }
  }
  const rp = read('docs/REAL_PAGE_TEST.md');
  if (/L4/.test(rp) && !/证据出处/.test(rp)) bad.push('REAL_PAGE_TEST 有 L4 但没写证据出处');
  return bad.length ? bad.join('\n    ') : null;
});

await check('Field Test 文档内部不自相矛盾', () => {
  const t = read('docs/REAL_PAGE_TEST.md');
  const claimsPass = /Answer\s+layout:\s+MANUAL VERIFIED PASS/.test(t);
  const saysUnverified = /\*\*布局没有通过验证。?\*\*/.test(t);
  if (claimsPass && saysUnverified) {
    return '同一文档既写 Answer layout = MANUAL VERIFIED PASS，又写「布局没有通过验证」';
  }
  return null;
});

// ── 4. Feature flag ──────────────────────────────────────
/**
 * 2026-09-13 之后这条**仍然必须是 false**，而且理由变了，所以值得写下来：
 * 以前是"还没接入"，现在是"**扩展永远不该自己调官方 API**"——
 * 调用要带 Access Secret，而扩展是分发给用户的。官方能力只在服务端用。
 * 如果哪天有人因为"我们已经接入了"就把这两个 flag 打开，那才是真正的泄漏路径。
 */
await check('扩展侧两个知乎 API flag 仍然默认 false（凭证不进扩展）', () => {
  const t = read('extension/src/shared/config.ts');
  if (!/ZHIHU_SEARCH_ENABLED:\s*false/.test(t)) return 'ZHIHU_SEARCH_ENABLED 不是 false';
  if (!/ZHIHU_AI_ENABLED:\s*false/.test(t)) return 'ZHIHU_AI_ENABLED 不是 false';
  return null;
});

// ── 5. 行为断言（**真的跑一遍，不是 grep**）────────────────
await check('行为：窗口里只要有一条 mock/demo 就标演示数据（不按多数决）', async () => {
  const { sourceBadge } = await import('../extension/src/content/dashboard.ts');
  const zero = { llm: 0, mock: 0, demo: 0, enriched: 0, other: 0 };
  const mostlyReal = sourceBadge({ ...zero, llm: 19, mock: 1 });
  if (mostlyReal?.kind !== 'demo') return `19 llm + 1 mock 得到 ${JSON.stringify(mostlyReal)}，应为 demo`;
  const oneDemo = sourceBadge({ ...zero, llm: 99, demo: 1 });
  if (oneDemo?.kind !== 'demo') return `99 llm + 1 demo 得到 ${JSON.stringify(oneDemo)}，应为 demo`;
  const allReal = sourceBadge({ ...zero, llm: 20 });
  if (allReal?.kind !== 'llm') return `全 llm 却没显示 AI 分析：${JSON.stringify(allReal)}`;
  return null;
});

await check('胶囊态（gutter 不足）也必须显示演示数据标记', () => {
  const src = read('extension/src/content/dashboard.ts');
  // 必须定位**方法定义**，不能用 indexOf('#capsule(') —— 那会抓到 render() 里的调用点。
  // 第一版就是这么写的，于是切出 70 个字符的无关片段，检查恒为假。
  const m = src.match(/#capsule\([^)]*\):\s*string\s*\{([\s\S]*?)\n  \}/);
  if (!m) return '找不到 #capsule 的方法定义';
  if (!/sourceBadge|演/.test(m[1])) {
    return '胶囊态没有任何 mock/demo 标记 —— RUNBOOK 的降级预案建立在这个标记一定可见之上';
  }
  return null;
});

await check('行为：未配置端点时走 mock，且 mock 带 local-mock provenance', async () => {
  const { CONFIG } = await import('../extension/src/shared/config.ts');
  if (CONFIG.ANALYZE_ENDPOINT !== '') return `出货默认 ANALYZE_ENDPOINT 应为空，实际 ${CONFIG.ANALYZE_ENDPOINT}`;
  const { requestAnalysis } = await import('../extension/src/background/analysis.ts');
  const r = await requestAnalysis({ title: 't', text: '正文'.repeat(60) });
  if (r.status !== 'mock') return `端点为空时 status=${r.status}，应为 mock`;
  if (r.analysis?.provider !== 'local-mock') return `mock 的 provider=${r.analysis?.provider}，应为 local-mock`;
  return null;
});

await check('行为：常量 JSON 冒充模型会被降级为 ungrounded', async () => {
  const { validateExtraction } = await import('../packages/core/src/extract.ts');
  const r = validateExtraction({ concepts: [{ canonical: '就业', confidence: 0.9 }] });
  if (r.status === 'llm') return 'validateExtraction 默认把结果盖章成 llm —— 上一轮的假完成又回来了';
  return null;
});

await check('行为：不支持的页面一个字都不抽，且不可分析', async () => {
  const { extractContent, isAnalyzable, SUPPORTED_TYPES } =
    await import('../extension/src/content/extract-content.ts');
  const { El, makeDocument } = await import('../packages/extension-test/dom-shim.ts');
  if (SUPPORTED_TYPES.join(',') !== 'answer,article') return `SUPPORTED_TYPES=${SUPPORTED_TYPES}`;
  const rich = new El('div', 'RichText ztext').append(new El('p', '', '推荐卡摘要。'.repeat(30)));
  const doc = makeDocument(new El('body').append(new El('main', 'App-main').append(rich)));
  for (const url of [
    'https://www.zhihu.com/column-square',
    'https://www.zhihu.com/',
    'https://www.zhihu.com/question/123',
    'https://zhuanlan.zhihu.com/p/123/edit',
  ]) {
    const c = extractContent(doc as unknown as Document, url);
    if (c.text !== '') return `${url} 抽到了 ${c.text.length} 字`;
    if (isAnalyzable(c)) return `${url} 被判为可分析`;
  }
  return null;
});

await check('行为：service worker 拒绝不支持的页面类型（纵深防御，真的跑一遍）', async () => {
  // 红队 PoC：把白名单改成 `if (false && ...)`，第一版门禁照样全绿。
  // grep 挡不住这种改法，所以这里真的把 service worker 装起来发一条消息。
  const store: Record<string, unknown> = {};
  let listener: ((m: any, s: unknown, send: (r: unknown) => void) => void) | null = null;
  (globalThis as any).chrome = {
    storage: { local: {
      get: async (k: any) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
      set: async (i: Record<string, unknown>) => { Object.assign(store, i); },
    } },
    runtime: { onMessage: { addListener: (cb: any) => { listener = cb; } } },
  };
  let fetched = 0;
  (globalThis as any).fetch = async () => { fetched++; throw new Error('不该被调用'); };

  await import('../extension/src/background/service-worker.ts');
  if (!listener) return 'service worker 没有注册消息监听';
  const send = (msg: unknown) => new Promise((res) => listener!(msg, null, res));

  await send({ type: 'READING_QUALIFIED', content: {
    url: 'https://www.zhihu.com/column-square', contentId: 'x', type: 'unknown',
    title: '专栏广场', text: '正文'.repeat(80), duration: 9000,
    confidence: 'high', // 刻意伪造成高可信度，只留页面类型这一道门
  } });
  await send({ type: 'AWAIT_IDLE' });

  const events = (store['zhiliu.events.v2'] as unknown[]) ?? [];
  if (events.length > 0) return `unknown 页面写进了 history（${events.length} 条）—— 白名单失效`;
  if (fetched > 0) return `unknown 页面触发了 ${fetched} 次分析请求 —— 白名单失效`;
  return null;
});

/**
 * 量不到阅读列时**绝不铺开面板**。
 *
 * 这条的原始版本要求 `hidden`。2026-09-14 契约改了：兜底从"整块消失"
 * 换成"贴边 40px dock" —— 因为真人反馈"面板不见了"被读成"扩展坏了"。
 *
 * **但 fail-open 的那条底线一个字没松**：量不到阅读列时依然不许出现
 * full / compact 这种会占据版面的形态，且必须通过 `staysOutOfContent`。
 * 最早的 bug 正是量不到时假装"很宽"，算出 224px 压在正文上。
 */
await check('行为：量不到阅读列时只退到贴边 dock，绝不铺开面板', async () => {
  const { computeLayout, staysOutOfContent, DOCK_WIDTH } =
    await import('../extension/src/content/layout.ts');
  const l = computeLayout({ contentLeft: null, headerBottom: 52 });
  if (l.mode !== 'dock') return `contentLeft=null 时 mode=${l.mode}，应为 dock（不许是 full/compact）`;
  if (l.width !== DOCK_WIDTH) return `dock 宽度是 ${l.width}，应为 ${DOCK_WIDTH}`;
  if (!staysOutOfContent(l, null)) return 'dock 没通过 staysOutOfContent';
  // 有阅读列但放不下完整面板时，退 dock —— 给全测量（真实的 measure() 一定会给）
  const narrow = computeLayout({ contentLeft: 30, headerBottom: 52, contentRight: 1000, viewportWidth: 1440 });
  if (narrow.mode !== 'dock') return `gutter 只有 30px 时 mode=${narrow.mode}，应为 dock`;
  if (!staysOutOfContent(narrow, 30, 1000, 1440)) return 'dock 压到正文了';

  // **唯一允许真的隐藏的情形**：正文铺满视口，两侧都没有 40px 空隙。
  // 不遮挡是绝对的，停靠偏好不能凌驾于它 —— 但这条路必须窄到只剩这种极端版式。
  const nowhere = computeLayout({ contentLeft: 0, headerBottom: 52, contentRight: 1440, viewportWidth: 1440 });
  if (nowhere.mode !== 'hidden') return `两侧都没空隙时 mode=${nowhere.mode}，应为 hidden`;
  return null;
});

/**
 * 停靠偏好必须被尊重 —— 面板不许自己在页面之间跳边。
 *
 * 真人反馈：v1.1.0 按左右可用空间自动选边，结果是"一会儿在左一会儿在右"。
 * 空间记忆是面板类产品最基本的东西。默认 left，只有 auto 才比较空间。
 */
await check('行为：面板停靠侧跟着用户偏好，不自动跳边', async () => {
  const { computeLayout } = await import('../extension/src/content/layout.ts');
  const { DEFAULT_SETTINGS } = await import('../extension/src/shared/config.ts');
  if (DEFAULT_SETTINGS.panelSide !== 'left') {
    return `默认停靠侧是 ${DEFAULT_SETTINGS.panelSide}，应为 left`;
  }
  // 右侧空白明显更宽，偏好 left 时也不许跳过去
  const m = { contentLeft: 100, headerBottom: 52, contentRight: 1000, viewportWidth: 1440 };
  if (computeLayout(m, 'left').side !== 'left') return '偏好 left 却跳到了右边';
  if (computeLayout(m, 'right').side !== 'right') return '偏好 right 却跳到了左边';
  // 只有 auto 才按空间选
  if (computeLayout(m, 'auto').side !== 'right') return 'auto 没有选空白更宽的一侧';
  // 不传偏好时按 left（老调用点不会悄悄变成自动选边）
  if (computeLayout(m).side !== 'left') return '不传偏好时没有按 left 处理';
  return null;
});

/**
 * 「面板可见」与「这一页采集」必须保持分离。
 *
 * 真人反馈：不可采集的页面把面板整块藏掉，用户以为扩展没启动。
 * 拆开之后要守住的是**另一个方向**的风险：面板到处都在，
 * 别顺手把采集范围也放宽了。
 */
await check('行为：面板到处都在，但采集范围没放宽', async () => {
  const { detectPage } = await import('../extension/src/content/detect-page.ts');
  const collectible = (u: string) => detectPage(u).type !== 'unknown';
  const mustNot = [
    'https://www.zhihu.com/question/2017971286807180358',
    'https://www.zhihu.com/search?q=x',
    'https://www.zhihu.com/',
    'https://www.zhihu.com/hot',
  ];
  for (const u of mustNot) {
    if (collectible(u)) return `${u} 被纳入采集了 —— 采集范围不该随可见性一起放宽`;
  }
  const mustYes = [
    'https://www.zhihu.com/question/2017971286807180358/answer/2048382266775287748',
    'https://zhuanlan.zhihu.com/p/1234567890123456789',
  ];
  for (const u of mustYes) {
    if (!collectible(u)) return `${u} 应该采集却没有`;
  }
  return null;
});

/**
 * 钉住「不会自动降级到演示数据」这条语义。
 *
 * 红队 R8-12：RUNBOOK 写着"扩展拿不到 /analyze 时会走本地确定性数据、
 * 面板上会有「演」标记"——**代码不是这样**。只有端点为空才走 mock；
 * 端点配好之后请求失败走的是 failed，没有任何演示标记。
 * 台上照着那段 runbook 等着自动兜住，会等到一片"分析失败"。
 *
 * 所以这里真的跑一遍：配上端点 + 让 fetch 抛错 ⇒ 必须是 failed，绝不是 mock。
 */
await check('行为：配了端点但请求失败时是 failed，**不会**自动变成演示数据', async () => {
  const mod = await import('../extension/src/background/analysis.ts');
  const cfg = await import('../extension/src/shared/config.ts');
  const original = globalThis.fetch;
  const originalEndpoint = cfg.CONFIG.ANALYZE_ENDPOINT;
  try {
    // CONFIG 是 as const，但运行时仍是普通对象；这里临时改掉再还原。
    (cfg.CONFIG as unknown as Record<string, string>).ANALYZE_ENDPOINT = 'http://127.0.0.1:9/analyze';
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const out = await mod.requestAnalysis({ contentId: 'x', contentType: 'answer', title: 't', text: 'y'.repeat(200) });
    if (out.analysis?.provider === 'local-mock') return '请求失败时退回了 mock —— 那就是静默降级';
    if (out.status !== 'failed') return `请求失败时 status 应为 failed，实际是 ${String(out.status)}`;
  } finally {
    globalThis.fetch = original;
    (cfg.CONFIG as unknown as Record<string, string>).ANALYZE_ENDPOINT = originalEndpoint;
  }
  return null;
});

/**
 * 轮询窗口必须覆盖住请求超时。
 * 红队 R8-13：FOLLOW_UP_MAX_TICKS(20) × FOLLOW_UP_MS(1500) = 30 秒，
 * 而 ANALYZE_TIMEOUT_MS 是 60 秒 —— 超过 30 秒回来的分析，
 * 结果入库但当次面板不再刷新，一直挂在"正在分析"。
 */
await check('面板轮询窗口覆盖得住分析超时', async () => {
  const { CONFIG } = await import('../extension/src/shared/config.ts');
  const window = CONFIG.FOLLOW_UP_MS * CONFIG.FOLLOW_UP_MAX_TICKS;
  return window >= CONFIG.ANALYZE_TIMEOUT_MS
    ? null
    : `轮询只覆盖 ${window}ms，而超时是 ${CONFIG.ANALYZE_TIMEOUT_MS}ms —— 慢请求回来时面板不会刷新`;
});

await check('服务端未注入模型时 fail loud（503）', () => {
  const t = read('server/analyze.ts');
  return /llm_not_configured/.test(t) && /status: 503/.test(t)
    ? null : '/analyze 未在缺模型时返回 503';
});

// ── 6. 文档与代码的数字一致 ───────────────────────────────
/**
 * 额度数字必须与代码常量一致，而且不许再把它归给"官方手册"。
 *
 * 红队 R8-5：README 写着「官方手册明确知乎搜索 **1,000 次/日**」——
 * 三重错：官方文档写的是 100，实测是 5000，1,000 两边都不是；
 * 而且因为那行含「官方手册」，旧门禁的 ATTRIBUTED_QUOTE 让它**永久免检**。
 * R7 逐字报过这一点，R8 才修。
 */
await check('额度数字与代码一致，且不归给「官方手册」', async () => {
  const { DAILY_SEARCH_QUOTA } = await import('../packages/core/src/zhihu-client.ts');
  const bad: string[] = [];
  for (const f of PRODUCTION_DOCS) {
    if (!has(f)) continue;
    read(f).split('\n').forEach((line, i) => {
      if (!/(知乎)?搜索[^。\n]{0,20}(次\/日|\/ ?日|次每天)/.test(line)) return;
      const nums = [...line.matchAll(/([\d,]{3,})\s*次?\s*\/?\s*日/g)].map((m) => Number(m[1].replace(/,/g, '')));
      const claimed = nums.find((n) => n !== 100); // 100 是官方文档的默认值，允许作为对照出现
      if (claimed !== undefined && claimed !== DAILY_SEARCH_QUOTA && !/作废|猜的|已实测|保守取值/.test(line)) {
        bad.push(`${f}:${i + 1} 写的额度是 ${claimed}，代码常量是 ${DAILY_SEARCH_QUOTA} → ${line.trim().slice(0, 60)}`);
      }
      if (/官方(手册|文档)明确[^。\n]{0,16}(次\/日|\/日)/.test(line)) {
        bad.push(`${f}:${i + 1} 把额度归给"官方手册明确"——实际数字只能以 quota 查询为准`);
      }
    });
  }
  return bad.length ? bad.join('\n    ') : null;
});

/**
 * 线下措辞。
 *
 * 这个项目是**线上提交 + 远程评审**：评委不接触作者本机。
 * 任何"到场后配置""会场网络""现场启动服务"的说法都描述了一个不存在的场景，
 * 而且会让人以为有一条不需要提前跑通的兜底路径。
 */
await check('production 文档里没有线下场景措辞', () => {
  // 词表按**词根**写，不按短语写。第一版列的是「现场配置 / 现场启动 / 路演现场」，
  // 于是「到了现场先把服务跑起来」「在比赛现场架好机器」全过 —— 红队实测。
  const OFFSITE = /会场|现场|路演|到场|线下(电脑|机器|环境)?|评委面前/;
  const bad: string[] = [];
  for (const f of PRODUCTION_DOCS) {
    if (!has(f)) continue;
    read(f).split('\n').forEach((line, i) => {
      if (!OFFSITE.test(line)) return;
      // 允许"这些步骤不存在"这种否定式说明
      // 豁免词里原本有裸的「不是」—— 中文里最常见的两个字之一，
      // 一句话尾巴加上「这不是什么难事」就能让整行免检（红队实测）。
      // 收窄成明确指向"这个场景不成立"的写法。
      // 「线上线下行为不一致」「现场抽取」这类是词形撞车，不是线下场景 ——
      // 收紧词表之后它们全被误报了。误报比漏报更能让人学会无视门禁。
      const FALSE_HIT = /线上线下|非线下|不是任何线下|现场(抽取|重抽|诊断)|当场/;
      if (FALSE_HIT.test(line)) return;
      if (/不存在|没有任何|并不是|而不是|不是线下|改成|已删除|那些前提|不适用/.test(line)) return;
      bad.push(`${f}:${i + 1} → ${line.trim().slice(0, 64)}`);
    });
  }
  return bad.length ? `线上提交的项目不该有线下措辞：\n    ${bad.join('\n    ')}` : null;
});

/**
 * 提交物的硬规格。表单会当场拒绝不合规的图，而那时候才发现就太晚了。
 */
await check('封面与 ICON 符合表单规格', async () => {
  const { statSync } = await import('node:fs');
  const bad: string[] = [];
  /** 读 PNG 的 IHDR 拿宽高，不引入图像库。 */
  const png = (rel: string) => {
    const buf = readFileSync(join(ROOT, rel));
    if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
    // 必须验到 IEND。只读 IHDR 的话，一个被截断的文件（导出/拷贝中断）
    // 照样能报出正确的宽高 —— 红队用 `head -c 33` 造过：门禁说合规，
    // 系统的 sips 说这根本不是图。
    if (!buf.subarray(-12).toString('ascii').includes('IEND')) return { w: 0, h: 0, bytes: buf.length, broken: true };
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length, broken: false };
  };
  const cover = has('assets/cover-1920x1080.png') ? png('assets/cover-1920x1080.png') : null;
  if (!cover) bad.push('缺少 assets/cover-1920x1080.png');
  else if (cover.broken) bad.push('封面 PNG 不完整（缺 IEND）—— 表单会拒收');
  else {
    if (Math.abs(cover.w / cover.h - 16 / 9) > 0.01) bad.push(`封面不是 16:9（${cover.w}×${cover.h}）`);
    if (cover.bytes > 5 * 1024 * 1024) bad.push(`封面超过 5MB（${(cover.bytes / 1048576).toFixed(2)}MB）`);
  }
  const icon = has('assets/icon-512.png') ? png('assets/icon-512.png') : null;
  if (!icon) bad.push('缺少 assets/icon-512.png');
  else if (icon.broken) bad.push('ICON PNG 不完整（缺 IEND）');
  else {
    if (icon.w !== icon.h) bad.push(`ICON 不是正方形（${icon.w}×${icon.h}）`);
    if (icon.bytes > 5 * 1024 * 1024) bad.push(`ICON 超过 5MB`);
  }
  /*
   * 封面上必须带"这不是 zhihu.com 抓图"的声明。
   *
   * 红队 R3：三处用到这张截图的地方（README / 作品链接页 / 封面），
   * 只有封面没写 —— 而封面是表单必填项、评委第一眼看到的东西，
   * 图里还带着知乎 logo 和一个「1.2 万人赞同」。
   * 更糟的是 COVER_BRIEF 当时写着"封面和作品链接上都写明了这一点"，
   * 也就是文档说了谎。这里盯住封面的**源码**，PNG 本身没法 grep。
   */
  if (has('assets/src/cover.html')) {
    const cover = read('assets/src/cover.html');
    if (!/非\s*zhihu\.com\s*抓图|不是\s*zhihu\.com\s*的?抓图|本地还原/.test(cover)) {
      bad.push('assets/src/cover.html 里没有"背景页是本地还原、非 zhihu.com 抓图"的声明');
    }
  }
  void statSync;
  return bad.length ? bad.join('\n    ') : null;
});

/**
 * 出货包不能混。
 *
 * 这是这个项目从第四轮起反复在防的那件事的**发布物版本**：
 * production 包必须真的连着后端，demo 包必须一个端点都没有。
 * 混了的后果是评委装上以为在看实时分析，其实是本地常量。
 */
await check('两个发布包各自是它声称的那个东西', async () => {
  if (!has('release/zhiliu-demo.zip')) return null; // 还没打包，不算失败
  const { execSync } = await import('node:child_process');
  const bad: string[] = [];
  const cfgOf = (zip: string) => {
    const t = execSync(`unzip -p "${join(ROOT, zip)}" shared/config.js`, { encoding: 'utf8' });
    return (t.match(/ANALYZE_ENDPOINT:\s*'([^']*)'/) ?? [])[1] ?? '';
  };
  if (cfgOf('release/zhiliu-demo.zip')) bad.push('演示包里烧进了分析端点 —— 它会看起来像实时分析');
  if (has('release/zhiliu-production.zip')) {
    const ep = cfgOf('release/zhiliu-production.zip');
    if (!ep) bad.push('production 包里没有端点 —— 装上只会显示演示数据');
    else if (!/^https:\/\//.test(ep)) bad.push(`production 包的端点不是 https：${ep}`);
  }
  return bad.length ? bad.join('\n    ') : null;
});

/**
 * 「任意知乎回答页」这类说法必须点名到独立回答页。
 *
 * 来历是一次真人验收：地址栏看着是 `/question/<qid>/answer/<aid>`，
 * 而 `location.href` 实际是 `/question/<qid>` —— 知乎把它改写成了纯问题页。
 * 面板按 contract 判 unknown（**这是对的**：那一页挂着很多个回答，
 * 无法确定用户读的是哪一篇），但安装说明写的是「打开任意知乎回答页」，
 * 于是看起来像产品坏了。
 *
 * 问题不在代码，在文案：它把"问题页"也包进了承诺里。
 */
await check('安装说明不把「任意回答页」当成支持范围', () => {
  const TOO_BROAD = /(打开|访问|进入)\s*(任意|任何|随便一个|一个)?\s*知乎(回答页|文章页)|任意知乎(回答|文章)/;
  // 说清楚是"独立回答页"或明确排除了问题页，就不算过宽
  const SPECIFIC = /独立回答页|\/answer\/|answer\/&lt;|问题页.{0,20}(不|别|无法|不会)|已验证过的回答页/;
  const bad: string[] = [];
  for (const f of [...PRODUCTION_DOCS, ...UI_SOURCES, 'assets/src/landing.html']) {
    if (!has(f)) continue;
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (!TOO_BROAD.test(line)) return;
      // 允许同一行或紧邻两行里把范围说清楚
      const ctx = lines.slice(Math.max(0, i - 1), i + 4).join('\n');
      if (SPECIFIC.test(ctx)) return;
      bad.push(`${f}:${i + 1} → ${line.trim().slice(0, 60)}`);
    });
  }
  return bad.length
    ? `这些地方把"任意知乎回答页"当成了支持范围，但问题页 /question/<qid> 是不支持的：\n    ${bad.join('\n    ')}`
    : null;
});

await check('README 的趋势定义与代码一致', () => {
  const code = read('packages/core/src/aggregate.ts');
  const seg = code.match(/TREND_SEGMENT = (\d+)/)?.[1];
  const thr = code.match(/TREND_THRESHOLD = ([\d.]+)/)?.[1];
  if (!seg || !thr) return '读不到 TREND_SEGMENT / TREND_THRESHOLD';
  const pp = Math.round(Number(thr) * 100);
  const doc = read('README.md');
  const bad: string[] = [];
  if (new RegExp(`最近 ${seg} 篇`).test(doc) === false && /最近 \d+ 篇\*{0,2} vs/.test(doc)) {
    bad.push(`README 的趋势段长不是 ${seg}`);
  }
  if (!new RegExp(`±\\s*${pp}`).test(doc) && /±\s*\d+\s*个百分点/.test(doc)) {
    bad.push(`README 的趋势阈值不是 ±${pp} 个百分点`);
  }
  return bad.length ? bad.join('；') : null;
});

// ── 输出 ─────────────────────────────────────────────────
console.log('\n知流 · 发布门禁\n');
for (const p of passed) console.log(`  ✔ ${p}`);
for (const f of failures) console.log(`  ✘ ${f.check}\n    ${f.detail}`);
console.log(`\n${passed.length} 通过 / ${failures.length} 失败\n`);
if (failures.length > 0) {
  console.error('发布门禁未通过。上面每一条都指向一个"说得比证据多"的地方。');
  process.exit(1);
}
