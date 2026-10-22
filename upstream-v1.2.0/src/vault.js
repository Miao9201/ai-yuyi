/**
 * Obsidian 知识库检索（RAG）
 *
 * 目标：让机器人回答时能引用你库里真实存在的内容，而不是凭空编。
 *
 * 为什么不用向量检索：
 *   DeepSeek 没有公开 embedding 接口，装本地 embedding 模型又要几百 MB 依赖。
 *   这个项目从第一天起就是零依赖，所以走 BM25 + 中文 bigram。
 *   代价是只匹配字面，不匹配语义（"难受" 搜不到 "情绪"），
 *   所以下面的分数阈值必须当真用——宁可检索不到，也不要塞不相关的片段。
 *
 * 语料规模（实测）：109 篇 / 799 KB / 约 645 个片段。
 * 建索引 < 1 秒，查询 < 10 ms，内存占用几百 KB。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'vault-index.json');

/** 这些目录不算语料：采集管道自己的产物、Obsidian 和 AI 工具的配置 */
const SKIP_DIRS = new Set([
  '.obsidian', '.claude', '.claudian', '.git', '.trash', '.attachments',
  'brain-collector', 'node_modules'
]);

const MAX_CHUNK = 900;     // 单片段上限
const TARGET_CHUNK = 700;  // 打包目标
const MIN_CHUNK = 40;      // 太短的片段没有信息量
const MAX_FILES = 5000;

// ── 分词 ────────────────────────────────────────────────────────────────

/**
 * 中文没有空格，用 bigram 当检索单位。
 * 同时保留 ASCII 单词（英文技术词在库里很多）。
 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];

  // 英文/数字词
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_+#.\-]{1,}/g)) {
    if (m[0].length >= 2) out.push(m[0]);
  }

  // 中文串 → bigram
  for (const m of s.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = m[0];
    if (run.length === 1) continue;
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    if (run.length <= 4) out.push(run); // 短词整词也收一份
  }

  return out;
}

// ── 切片 ────────────────────────────────────────────────────────────────

function stripFrontMatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(text.indexOf('\n', end + 1) + 1);
}

/** 正文按标题切段，超长的再按空行打包 */
function chunkBody(body, title, baseHeading = '') {
  const chunks = [];
  const lines = body.split(/\r?\n/);

  let heading = baseHeading;
  let buf = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;

    if (text.length <= MAX_CHUNK) {
      if (text.length >= MIN_CHUNK) chunks.push({ title, heading, text });
      return;
    }

    // 超长：按空行分段，贪心打包
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let pack = '';
    for (const p of paras) {
      if (pack && pack.length + p.length + 2 > TARGET_CHUNK) {
        if (pack.length >= MIN_CHUNK) chunks.push({ title, heading, text: pack });
        pack = p;
      } else {
        pack = pack ? pack + '\n\n' + p : p;
      }
    }
    if (pack.length >= MIN_CHUNK) chunks.push({ title, heading, text: pack });
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      heading = m[2].trim();
      continue;
    }
    buf.push(line);
  }
  flush();

  return chunks;
}

// ── 索引 ────────────────────────────────────────────────────────────────

function walk(dir, acc, depth = 0) {
  if (depth > 8 || acc.length >= MAX_FILES) return acc;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, acc, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      acc.push(full);
      if (acc.length >= MAX_FILES) return acc;
    }
  }
  return acc;
}

let index = null;          // { chunks:[{title,heading,text,path,tokens,tf,len}], df, avgLen, N, builtAt, files }
let building = null;

function buildFromDisk(vaultPath) {
  const started = Date.now();
  const files = walk(vaultPath, []);
  const chunks = [];
  let totalLen = 0;

  for (const file of files) {
    let raw = '';
    try {
      const st = statSync(file);
      if (st.size === 0 || st.size > 2 * 1024 * 1024) continue;
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const body = stripFrontMatter(raw);
    const title = path.basename(file, '.md');
    for (const c of chunkBody(body, title, '')) {
      const indexed = `${c.title} ${c.heading} ${c.text}`;
      const tokens = tokenize(indexed);
      if (!tokens.length) continue;
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

      // 小标题单独统计，打分时加权。
      // 不加权的话，"显卡"这种正好是某节标题的词，会输给正文里泛泛提到"型号"的片段：
      // 实测「我显卡什么型号」把 RTX 4070 那段排到第 5 位，前三位全是电池/硬盘/内存。
      //
      // 注意只统计【小标题】，不含文件名：文件名如 游戏.md 会让整篇所有片段
      // 都吃到"游戏"的加成，结果问"喜欢玩什么游戏"时返回的是游戏项目的说明文档，
      // 而不是「游戏行为画像」。文件名本身已经在正文词频里算过一遍了。
      const headTf = new Map();
      if (c.heading) {
        for (const t of tokenize(c.heading)) {
          headTf.set(t, (headTf.get(t) || 0) + 1);
        }
      }

      chunks.push({
        title: c.title,
        heading: c.heading,
        text: c.text,
        path: path.relative(vaultPath, file),
        tf,
        headTf,
        len: tokens.length
      });
      totalLen += tokens.length;
    }
  }

  // document frequency
  const df = new Map();
  for (const c of chunks) {
    for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }

  const idx = {
    chunks,
    df,
    avgLen: chunks.length ? totalLen / chunks.length : 1,
    N: chunks.length,
    files: files.length,
    builtAt: Date.now(),
    vaultPath,
    ms: Date.now() - started
  };

  // 只缓存统计元信息，不缓存索引本身（重建很快，省得缓存失效逻辑出错）
  try {
    mkdirSync(path.dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify({
      vaultPath, files: idx.files, chunks: idx.N,
      avgLen: Math.round(idx.avgLen), ms: idx.ms, builtAt: idx.builtAt
    }, null, 2), 'utf8');
  } catch { /* 缓存写不进去无所谓 */ }

  return idx;
}

/** 懒加载：第一次检索时才建索引 */
export function ensureIndex(vaultPath) {
  if (index && index.vaultPath === vaultPath) return index;
  if (building && building.vaultPath === vaultPath) return building.promise;

  building = { vaultPath, promise: (async () => {
    index = buildFromDisk(vaultPath);
    return index;
  })() };
  return building.promise;
}

/** 强制重建（库内容变了之后用） */
export function rebuildIndex(vaultPath) {
  index = null;
  building = null;
  return ensureIndex(vaultPath);
}

export function getStatus() {
  if (!index) return { ready: false };
  return {
    ready: true,
    vaultPath: index.vaultPath,
    files: index.files,
    chunks: index.N,
    avgLen: Math.round(index.avgLen),
    builtAt: index.builtAt,
    buildMs: index.ms,
    ageMinutes: Math.round((Date.now() - index.builtAt) / 60000)
  };
}

// ── 检索（BM25） ────────────────────────────────────────────────────────

const K1 = 1.2;
const B = 0.75;
const HEAD_WEIGHT = 1.8;   // 标题/小标题命中比正文命中更重要

/**
 * 把一句话拆成分句。
 *
 * 为什么需要：用户的实际问法是
 *   「我把你接入到我的obsidian知识库里面了，你说你现在都知道些关于我的什么信息」
 * 整句去检索时，前后两件事的词混在一起，bigram 互相稀释，
 * 结果只命中 1 条 0.47 的边缘片段。拆成两句后
 * 「你说你现在都知道些关于我的什么信息」就能正常命中画像类笔记。
 */
function splitClauses(query) {
  const parts = String(query || '')
    .split(/[，,。！？!?；;、\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  if (!parts.length) return [String(query || '').trim()].filter(Boolean);
  // 太长还是拆不动，就按固定长度再切一刀
  const out = [];
  for (const p of parts) {
    if (p.length <= 24) { out.push(p); continue; }
    for (let i = 0; i < p.length; i += 18) {
      const seg = p.slice(i, i + 18);
      if (seg.length >= 2) out.push(seg);
    }
  }
  return out.slice(0, 6);
}

/**
 * @param {string} query 用户这句话
 * @param {string} vaultPath 库根目录
 * @param {{topK?:number, minScore?:number}} opts
 * @returns {Promise<{ok:boolean, hits:Array, ms:number, error?:string}>}
 */
export async function searchVault(query, vaultPath, opts = {}) {
  const { topK = 3, minScore = 0.35 } = opts;
  const started = Date.now();

  if (!vaultPath || !existsSync(vaultPath)) {
    return { ok: false, hits: [], ms: 0, error: `库目录不存在：${vaultPath}` };
  }

  let idx;
  try {
    idx = await ensureIndex(vaultPath);
  } catch (e) {
    return { ok: false, hits: [], ms: Date.now() - started, error: '建索引失败：' + e.message };
  }

  // 单句 + 分句都搜一遍，按最高分合并。单句保证词组完整，分句保证不被长句稀释。
  const queries = [String(query || '').trim(), ...splitClauses(query)]
    .filter(Boolean)
    .filter((q, i, arr) => arr.indexOf(q) === i)
    .slice(0, 7);

  const best = new Map();   // chunkIndex → hit
  let scannedAny = 0;

  for (const q of queries) {
    const res = scoreQuery(q, idx, { topK, minScore });
    scannedAny += res.scanned;
    for (const h of res.hits) {
      const prev = best.get(h.path + '|' + h.heading + '|' + h.text.slice(0, 40));
      if (!prev || h.score > prev.score) best.set(h.path + '|' + h.heading + '|' + h.text.slice(0, 40), h);
    }
  }

  const hits = [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  return { ok: true, hits, ms: Date.now() - started, scanned: scannedAny };
}

/** 对单个查询串打分（内部用） */
function scoreQuery(query, idx, { topK, minScore }) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return { hits: [], scanned: 0 };

  const idfOf = (t) => {
    const n = idx.df.get(t) || 0;
    if (n === 0) return 0;
    return Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
  };
  let idfSum = 0;
  for (const t of qTokens) idfSum += idfOf(t);

  // 关键：库里一次都没出现的词 idf 会算成最大值，如果把它们算进分母，
  // 会把分数压到接近 0 —— "我显卡什么型号" 里 "我显/卡什/么型" 都不存在，
  // 结果连命中"显卡"的片段都被判为不相关。所以只用"库里真实存在"的词做分母。
  if (idfSum <= 0) return { hits: [], scanned: 0 };

  const scored = [];
  for (const c of idx.chunks) {
    let got = 0;
    let matched = 0;
    for (const t of qTokens) {
      const tfv = c.tf.get(t);
      if (!tfv) continue;
      matched++;
      const norm = tfv * (K1 + 1) / (tfv + K1 * (1 - B + B * c.len / idx.avgLen));
      got += idfOf(t) * norm;

      // 小标题命中额外加权
      const htf = c.headTf?.get(t) || 0;
      if (htf) {
        const hNorm = htf * (K1 + 1) / (htf + K1);
        got += HEAD_WEIGHT * idfOf(t) * hNorm;
      }
    }
    if (!matched) continue;

    // 归一化到 0~1：命中的稀有词占查询总稀有度的比例 × BM25 饱和度
    const score = got / idfSum;
    scored.push({ ...c, score, matched });
  }

  scored.sort((a, b) => b.score - a.score);
  const hits = scored
    .filter((c) => c.score >= minScore)
    .slice(0, topK)
    .map((c) => ({
      title: c.title,
      heading: c.heading,
      path: c.path,
      text: c.text,
      score: Number(c.score.toFixed(3)),
      matched: c.matched
    }));

  return { hits, scanned: scored.length };
}

/**
 * 把检索结果拼成可以塞进提示词的段落。
 * 明确告诉模型这是背景资料，不要照搬、不要说"根据资料"。
 */
export function formatHits(hits, { maxCharsPerHit = 420 } = {}) {  if (!hits || !hits.length) return '';
  const lines = ['【从你自己的笔记里翻到的东西】'];
  hits.forEach((h, i) => {
    const body = String(h.text || '').replace(/\s+/g, ' ').trim();
    const cut = body.length > maxCharsPerHit ? body.slice(0, maxCharsPerHit) + '…' : body;
    const label = h.heading && h.heading !== h.title ? `${h.title} · ${h.heading}` : h.title;
    lines.push(`${i + 1}. 「${label}」${cut}`);
  });
  lines.push('');
  lines.push('这些是你自己记下来的背景资料。说话时可以自然地用到，但：');
  lines.push('- 不要照搬原句，更不要列出来当成"资料摘录"；');
  lines.push('- 不要说"根据资料""我看到笔记里写着"这种话；');
  lines.push('- 跟当前话题无关就完全不提，不要硬塞。');
  return lines.join('\n');
}

// ── 画像摘要（回答"你都知道我什么"这类问题） ──────────────────────────

/**
 * 把画像笔记压成一份事实卡。
 *
 * 为什么需要：BM25 是字面匹配，而画像笔记的标题写的是「设备/技术栈/数字足迹」，
 * 用户问的却是「你知道些关于我的什么信息」——两边几乎没有共同的字面词。
 * 实测整句检索只命中 1 条 0.47 的边缘片段，所以她只能瞎编或跑去联网。
 *
 * 做法：这些笔记结构很规整（表格 + 列表），直接抽事实行、压成短句，
 * 不做任何推断，也不额外调模型（0 token 成本，只在需要时注入）。
 */
const PROFILE_CACHE = new Map();   // path → {mtimeMs, text}

function digestNote(file, maxChars) {
  let raw = '';
  let st;
  try {
    st = statSync(file);
    if (st.size === 0 || st.size > 400 * 1024) return '';
    const cached = PROFILE_CACHE.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.text;
    raw = readFileSync(file, 'utf8');
  } catch {
    return '';
  }

  const body = stripFrontMatter(raw);
  const all = body.split(/\r?\n/).map((s) => s.trim());
  const lines = [];
  let budget = maxChars;

  const isSeparator = (s) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(s);

  for (let li = 0; li < all.length; li++) {
    const line = all[li];
    if (!line) continue;
    // 跳过标题、引用块（隐私警告之类）、分隔线、代码块围栏
    if (line.startsWith('#') || line.startsWith('>') || line.startsWith('```')) continue;
    if (/^[-=|:\s]+$/.test(line)) continue;
    // 表头行：下一行是 |---|---| 分隔行时，这一行是列名，不是内容
    if (line.startsWith('|') && isSeparator(all[li + 1] || '')) continue;

    let fact = '';
    if (line.startsWith('|')) {
      // | 项 | 值 | → 项：值
      const cells = line.split('|').map((s) => s.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      fact = `${cells[0]}：${cells.slice(1).join(' / ')}`;
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      fact = line.slice(2).trim();
    } else if (/^[^\s|].*[：:].+/.test(line) && line.length <= 120) {
      fact = line;
    } else {
      continue;
    }

    fact = fact.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').replace(/\s+/g, ' ').trim();
    if (fact.length < 4) continue;
    if (fact.length > 180) fact = fact.slice(0, 180) + '…';
    if (budget - fact.length - 1 < 0) break;
    budget -= fact.length + 1;
    lines.push(fact);
  }

  const text = lines.join('\n');
  PROFILE_CACHE.set(file, { mtimeMs: st.mtimeMs, text });
  return text;
}

/**
 * 取出画像事实卡（多篇笔记拼一起，总长受 maxChars 限制）。
 * @param {string} vaultPath
 * @param {string[]} relPaths 相对库根的笔记路径
 * @param {number} maxChars
 */
export function getProfileDigest(vaultPath, relPaths = [], maxChars = 1100) {
  if (!vaultPath || !relPaths.length) return '';

  // 按篇平分预算。
  // 不分的话第一篇（用户画像，表格最长）会把预算吃光，
  // 后面的「兴趣图谱」「第二大脑总入口」一个字都进不去。
  const per = Math.max(180, Math.floor(maxChars / relPaths.length));
  const parts = [];
  for (const rel of relPaths) {
    const file = path.join(vaultPath, rel);
    if (!existsSync(file)) continue;
    const text = digestNote(file, per);
    if (!text) continue;
    parts.push(text);
  }
  return parts.join('\n');
}

/**
 * 最近在弄的笔记（给「聊什么」一个抓手）。
 *
 * 为什么不用 mtime 直接排：
 *   采集管道每次跑都会重写 00-第二大脑 下的全部笔记，mtime 永远是"刚刚"，
 *   排出来全是自动生成的画像/日志，等于没有信息。所以要排除这些生成目录。
 *   对话档案、MOC、索引同理——它们是索引文件，不是"他最近在弄的事"。
 */
const GENERATED_DIRS = new Set(['00-第二大脑', 'session-log', 'brain-collector']);
const NOT_A_TOPIC = /^(MOC|INDEX|README)$/i;
const ARCHIVE_SEGMENTS = ['对话档案'];

export function getRecentTopics(vaultPath, { days = 30, maxItems = 5 } = {}) {
  if (!vaultPath) return [];
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  for (const file of walk(vaultPath, [])) {
    const rel = path.relative(vaultPath, file);
    const segs = rel.split(path.sep);
    if (GENERATED_DIRS.has(segs[0])) continue;
    if (ARCHIVE_SEGMENTS.some((s) => segs.includes(s))) continue;
    const title = path.basename(file, '.md');
    if (NOT_A_TOPIC.test(title)) continue;
    try {
      const st = statSync(file);
      if (st.mtimeMs < cutoff) continue;
      out.push({ rel, title, mtimeMs: st.mtimeMs });
    } catch {
      /* 权限/竞态，跳过 */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, maxItems);
}

/** 把「最近在弄的事」包成提示词段落 */
export function formatRecentTopics(items, { maxChars = 240 } = {}) {
  if (!items || !items.length) return '';
  const lines = [];
  let used = 0;
  for (const it of items) {
    const ago = Math.max(0, Math.floor((Date.now() - it.mtimeMs) / 86400000));
    const when = ago === 0 ? '今天' : ago === 1 ? '昨天' : `${ago} 天前`;
    const line = `- ${it.title}（${when}）`;
    if (used + line.length > maxChars) break;
    used += line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return '';
  return [
    '【他最近在弄的东西（笔记标题，只是线索，不一定还热着）】',
    ...lines,
    '',
    '想知道细节就问他，或者顺口提一嘴；别装作你什么都知道，也别硬扯。'
  ].join('\n');
}

/** 把画像事实卡包成提示词段落 */
export function formatProfile(digest) {
  if (!digest) return '';
  return [
    '【你记住的关于他的资料（来自你自己的笔记，都是真的）】',
    digest,
    '',
    '这些是你本来就记得的事。他问起你就自然地说出来，',
    '可以挑几条具体的说（型号、数字、名字），这样才像真的记得；',
    '不要说"根据资料""我的笔记里"，也不要一口气全念完。'
  ].join('\n');
}
