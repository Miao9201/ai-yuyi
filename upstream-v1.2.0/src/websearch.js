/**
 * 联网搜索
 *
 * 两条通道：
 *  1) anysearch（默认）—— 独立搜索 API，POST https://api.anysearch.com/v1/search，
 *     直接返回结果列表，不跑模型轮次，快且便宜。
 *  2) deepseek（备用）—— 复用 DeepSeek 原生 web 搜索：走 Anthropic 兼容 Messages 端点，
 *     带服务端 web_search 工具（协议参照 @deepseek-ai/dsh-web-search-deepseek）。
 *
 * 2026-10-20 把搜索引擎从 DeepSeek 换成 AnySearch：检索源变了，
 * 但「什么时候搜 / 搜几次 / 预算闸门 / 查询词构造 / 结果注入」这些框架一律不动。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_MAX_USES = 3;
const USER_AGENT = 'wx-bridge/1.0.0';

const ANYSEARCH_DEFAULT_BASE_URL = 'https://api.anysearch.com';
const ANYSEARCH_DEFAULT_MAX_RESULTS = 5;

/** 从 DSH 凭证文件读 key（与 chat.js 同源） */
function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(os.homedir(), '.dsh', 'credentials.yaml')
  ];
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)["']?\s*$/m);
      if (m && m[1]) return m[1];
    } catch { /* 试下一个 */ }
  }
  return '';
}

/**
 * 读 AnySearch key：环境变量 → 配置 → DSH 凭证 refs。
 * 放在凭证文件里而不是 data/config.json，分享这份程序时不会把 key 带出去。
 */
export function readAnySearchKey(configured = '') {
  if (configured) return String(configured).trim();
  if (process.env.ANYSEARCH_API_KEY) return process.env.ANYSEARCH_API_KEY;
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(os.homedir(), '.dsh', 'credentials.yaml')
  ];
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      const m = text.match(/^\s*ANYSEARCH_API_KEY\s*:\s*["']?([^"'\s#]+)["']?\s*$/m);
      if (m && m[1]) return m[1];
    } catch { /* 试下一个 */ }
  }
  return '';
}

/** 从 text 块的 citations 里收集 url → 摘录 */
function citationSnippets(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const cite of block.citations || []) {
      if (cite.url && cite.cited_text && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text);
      }
    }
  }
  return map;
}

/** 把 Anthropic Messages 响应解析成搜索结果 */
function mapResponse(json) {
  const blocks = json.content || [];
  const resultBlocks = blocks.filter((b) => b.type === 'web_search_tool_result');
  if (!resultBlocks.length) {
    return { ok: false, error: '没有返回搜索结果块（可能没触发联网搜索）', sources: [] };
  }

  const snippets = citationSnippets(blocks);
  const seen = new Set();
  const sources = [];

  for (const block of resultBlocks) {
    for (const item of block.content || []) {
      if (item.type !== 'web_search_result') continue;
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      sources.push({
        url: item.url,
        title: item.title || '',
        snippet: snippets.get(item.url) || '',
        publishedAt: item.page_age || ''
      });
    }
  }

  // 模型自己的总结（可能为空，不作为可信答案）
  const answerText = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n')
    .trim();

  return { ok: true, sources, answer: answerText };
}

/** 把 AnySearch 的 data.results 解析成统一结构 */
function mapAnySearch(json, { maxResults = ANYSEARCH_DEFAULT_MAX_RESULTS } = {}) {
  const data = json?.data || {};
  const list = Array.isArray(data.results) ? data.results : [];
  const seen = new Set();
  const sources = [];
  const excerpts = [];

  for (const item of list) {
    if (sources.length >= Math.max(1, maxResults)) break;
    const url = item.url || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = String(item.snippet || item.content || '').replace(/\s+/g, ' ').trim();
    sources.push({
      url,
      title: item.title || '',
      snippet: snippet.slice(0, 300),
      publishedAt: item.published_at || item.date || ''
    });
    if (snippet) excerpts.push(`- ${(item.title || url).slice(0, 60)}：${snippet.slice(0, 320)}`);
  }

  // 把前几条的正文摘出来当「搜索摘要」，替代 DeepSeek 通道里模型自己写的那段总结。
  // 只做原料搬运，措辞仍由机器人自己的模型来组织，所以不会出现"搜索引擎替我说话"。
  const answer = excerpts.slice(0, 3).join('\n');

  if (!sources.length) {
    return { ok: false, error: '没有搜到结果', sources: [] };
  }
  return { ok: true, sources, answer };
}

/** AnySearch 通道 */
async function anysearchSearch(query, opts = {}) {
  const {
    baseUrl = ANYSEARCH_DEFAULT_BASE_URL,
    maxResults = ANYSEARCH_DEFAULT_MAX_RESULTS,
    timeoutMs = 30_000,
    apiKey: configuredKey = ''
  } = opts;

  const started = Date.now();
  const key = readAnySearchKey(configuredKey);
  if (!key) {
    return { ok: false, sources: [], ms: 0, error: '未配置 AnySearch API Key' };
  }

  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/v1/search`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT
      },
      body: JSON.stringify({ query: String(query).trim(), max_results: Math.max(1, Math.min(10, maxResults)) }),
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        detail = j.message || j.error?.message || detail;
      } catch { /* 保持默认 */ }
      return { ok: false, sources: [], ms: Date.now() - started, error: detail };
    }

    const json = await res.json();
    if (json && typeof json.code === 'number' && json.code !== 0) {
      return {
        ok: false, sources: [], ms: Date.now() - started,
        error: json.message || `AnySearch 返回 code=${json.code}`
      };
    }
    const mapped = mapAnySearch(json, { maxResults });
    return { ...mapped, ms: Date.now() - started };
  } catch (e) {
    const aborted = e.name === 'AbortError';
    return {
      ok: false, sources: [], ms: Date.now() - started,
      error: aborted ? `搜索超时（${Math.round(timeoutMs / 1000)} 秒）` : (e.message || String(e))
    };
  } finally {
    clearTimeout(timer);
  }
}

/** DeepSeek 原生搜索通道（备用） */
async function deepseekSearch(query, opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    maxUses = DEFAULT_MAX_USES,
    timeoutMs = 90_000
  } = opts;

  const started = Date.now();
  const apiKey = readKey();

  if (!apiKey) {
    return { ok: false, sources: [], ms: 0, error: '未找到 API Key' };
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/messages`;
  const body = {
    model,
    max_tokens: DEFAULT_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${String(query).trim()}` }]
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'authorization': `Bearer ${apiKey}`,
        'anthropic-version': DEFAULT_API_VERSION,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': USER_AGENT
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        detail = (typeof j.error === 'string' ? j.error : j.error?.message) || j.message || detail;
      } catch { /* 保持默认 */ }
      return { ok: false, sources: [], ms: Date.now() - started, error: detail };
    }

    const json = await res.json();
    const mapped = mapResponse(json);
    return { ...mapped, ms: Date.now() - started };
  } catch (e) {
    const aborted = e.name === 'AbortError';
    return {
      ok: false, sources: [], ms: Date.now() - started,
      error: aborted ? `搜索超时（${Math.round(timeoutMs / 1000)} 秒）` : (e.message || String(e))
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行一次联网搜索。
 *
 * @param {string} query 搜索词
 * @param {{provider?:'anysearch'|'deepseek', apiKey?:string, baseUrl?:string, model?:string,
 *          maxUses?:number, maxResults?:number, timeoutMs?:number,
 *          fallbackProvider?:'anysearch'|'deepseek'|'', fallbackTimeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, sources:Array, answer?:string, error?:string, ms:number, provider:string}>}
 */
export async function webSearch(query, opts = {}) {
  const {
    provider = 'anysearch',
    fallbackProvider = 'deepseek',
    timeoutMs = 30_000,
    fallbackTimeoutMs = 90_000
  } = opts;

  if (!query || !String(query).trim()) {
    return { ok: false, sources: [], ms: 0, error: '搜索词为空', provider };
  }

  const run = (name) => (name === 'deepseek'
    ? deepseekSearch(query, { ...opts, timeoutMs })
    : anysearchSearch(query, { ...opts, timeoutMs }));

  const started = Date.now();
  const first = await run(provider);
  if (first.ok) return { ...first, provider };

  const canFallback = !!fallbackProvider && fallbackProvider !== provider;
  if (!canFallback) return { ...first, provider };

  const second = await run(fallbackProvider);
  const totalMs = Date.now() - started;
  if (second.ok) {
    return { ...second, ms: totalMs, provider: fallbackProvider, fallbackFrom: provider, firstError: first.error };
  }
  return {
    ok: false, sources: [], ms: totalMs, provider,
    error: `${provider}: ${first.error}；${fallbackProvider}: ${second.error}`
  };
}

/**
 * 把搜索结果格式化成适合聊天发送的文本。
 * @param {Array} sources
 * @param {number} limit 最多几条
 */
export function formatSources(sources, limit = 4) {
  if (!Array.isArray(sources) || !sources.length) return '';
  const lines = [];
  sources.slice(0, limit).forEach((s, i) => {
    const title = (s.title || s.url || '').slice(0, 60);
    lines.push(`${i + 1}. ${title}`);
    if (s.snippet) lines.push(`   ${s.snippet.slice(0, 100).replace(/\s+/g, ' ')}`);
    lines.push(`   ${s.url}`);
  });
  return lines.join('\n');
}

/**
 * 把用户的聊天气话变成真正能搜的查询词。
 *
 * 踩过的坑（2026-10-18）：用户回了一句「你搜一下嘛」，代码直接拿这句话当 query，
 * 搜回来一堆不相关网页，她只好说"没搜到"。反例：「天气是什么样的」这种指代句
 * 也必须补上场景话题（今天是哪、哪里），否则搜出来的是别处天气。
 *
 * @param {string} text 用户原话
 * @param {string} sceneTopic 当前场景话题（可空）
 */
export function buildSearchQuery(text, sceneTopic = '') {
  const raw = String(text || '').trim();
  const cue = /^(你|帮我|请|麻烦|能不能|可不可以|可以)?(搜一下|搜搜|搜索|搜|查一下|查查|查|百度一下|百度|谷歌|上网查)(一下|下|嘛|吧|呀|啊|呢)*[，,。.!！~～、\s]*/;
  let q = raw
    .replace(/^(你|帮我|请|麻烦|能不能|可不可以|可以)+/g, '')
    .replace(cue, '')
    .replace(/[呢呀啊吧嘛哦啦哈~～。！？!?]+$/g, '')
    .trim();

  const compact = q.replace(/\s+/g, '');
  const topic = String(sceneTopic || '').replace(/[呢呀啊吧嘛哦啦]+$/g, '').trim();

  // 「天气是什么样的」「今天几号」这类没有主语的指代句，单搜会搜到别处 —— 补场景话题
  const HEADLESS = /^(那么|那|这个|那个)?(今天|明天|昨天|现在|那边|那儿|这儿|这里)?的?(天气|气温|温度|几点|时间|价格|多少钱|多少度|新闻|情况|行情)(是什么样|是什么样的|怎么样|如何|多少|咋样|呢|嘛|呀|啊|吧|的)*$/;
  const headless = HEADLESS.test(compact);
  const topicHasWord = /天气|气温|温度|几点|价格|多少钱|多少度|新闻|情况|行情/.test(topic);

  if (topic && (headless || compact.length < 6)) {
    // 话题里已经带了同一个词（场景是"今天的天气"、这句是"天气怎么样"）就别重复拼接
    q = headless && topicHasWord ? topic : `${topic} ${compact}`.trim();
  }

  return q || raw;
}

/**
 * 判断这句话是不是明显需要联网（用于决定要不要自动搜）。
 *
 * 踩过的坑：原来的时效性正则里有 `/现在.*(多少|几|什么)/`，
 * 于是「你**现在**都知道些关于我的**什么**信息」被判成需要联网，
 * 她去搜了一堆"Obsidian 怎么打标签"的教程，完全答非所问。
 * 现在改成必须"时间词 + 询问词"紧挨着出现，而不是跨越整句话。
 */
export function needsSearch(text) {
  const t = String(text || '').trim();

  // ① 明确要求搜 —— 优先，用户说了就搜
  if (/搜一下|搜搜|查一下|帮我查|查询|搜索|百度|谷歌|上网查/.test(t)) return true;

  // ② 问的是「我自己的事」——这是知识库该管的，不要跑去联网
  if (/关于我|我的(资料|信息|画像|习惯|爱好|电脑|配置|笔记|知识库)|你知道我|了解我|记得我|我是谁/.test(t)) {
    return false;
  }

  // ③ 时效性：时间词必须紧挨着询问词
  if (/现在几点|现在多少度|现在多少钱|现在什么天气|现在的?(价格|汇率|股价)/.test(t)) return true;
  // 时间词 + 话题：允许中间夹地名/定语（2026-10-18 修：「今天某市某区的天气是什么样的呢」这类原来匹配不到）
  if (/(今天|今日|昨天|明天|今儿|这两天)[^。！？!?]{0,14}(天气|气温|温度|几号|星期几|多少度|新闻|发生|下雨|下雪|降温|冷不冷|热不热)/.test(t)) return true;
  // 话题 + 询问语气
  if (/(天气|气温|温度)[^。！？!?]{0,8}(什么样|怎么样|如何|多少|咋样|好不好|冷不冷|热不热)/.test(t)) return true;
  if (/最新.{0,6}(消息|进展|版本|新闻|动态|价格|政策)/.test(t)) return true;
  if (/最近.{0,8}(进展|消息|新闻|动态|发布|出了|上线)/.test(t)) return true;
  if (/刚刚(发生|出|公布|上线)/.test(t)) return true;
  if (/(天气|气温|股价|汇率|油价|金价)(怎么样|如何|多少)/.test(t)) return true;
  if (/今年.*(最新|发布|出了)/.test(t)) return true;

  return false;
}
