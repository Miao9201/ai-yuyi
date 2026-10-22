/**
 * imagegen.js —— 生图（Agnes Image 2.5 Flash）
 *
 * 为什么单独一个模块：
 *   识图（vision.js）是"把图看懂"，生图是"把想法画出来"，两件事的失败模式
 *   和钱花在哪儿完全不同，混在一起以后不好改。这里只管：
 *     ① 从他说的话里判断"他是不是让我画东西"
 *     ② 把话变成一段适合出图的提示词（去掉客套、补风格）
 *     ③ 调接口、把结果落到本地、失败分类成一句人话
 *
 * 接口事实（2026-10-20 核对文档 + 实测）：
 *   POST {base}/v1/images/generations
 *   Authorization: Bearer <key>，Content-Type: application/json
 *   必填：model、prompt、size（1K/2K/3K/4K，或 1024x768 这类精确值）
 *   可选：ratio（1:1、3:4、4:3、16:9、9:16、2:3、3:2、21:9，默认 1:1）
 *   URL 输出：extra_body.response_format = 'url'（不能在顶层写 response_format）
 *   Base64 输出：文生图 return_base64: true
 *   ⚠ 域名坑：文档写 api.agnes-ai.cn，但实测这把 Key 在那个域名下
 *     /v1/images/generations 一律 401「无效的令牌」，换 apihub.agnes-ai.cn 才通。
 *     所以 baseUrl 做成配置项，默认 apihub。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_BASE = 'https://apihub.agnes-ai.cn';
const MAX_PROMPT = 400;

/* ────────────────────────── 意图识别 ────────────────────────── */

// "帮我画一张…" / "画个猫" / "生成一张壁纸" 这类
const DRAW_VERB = '(?:画|绘制|生成|作|做|来|搞|整)';
const DRAW_UNIT = '(?:一|1|两|2)?\\s*(?:张|幅|个|只|副|款|份)?';
const DRAW_NOUN = '(?:图|图片|画|照片|相片|壁纸|头像|海报|插画|插画图|表情|表情包|贴纸|图案|场景|画面)';
const RE_DRAW_FULL = new RegExp(`(?:${DRAW_VERB})\\s*${DRAW_UNIT}\\s*${DRAW_NOUN}`, 'i');
const RE_DRAW_SHORT = /(帮我|给我|替我|能不能|可不可以|可以|能否)\s*(画|绘制|生成|做)\s*(一下|一张|一幅|个|只|张)|画个|画张|画一幅|画一只|画一下|生成一张|生成一幅|来张图|来一张图/i;
// 这些词里的"画"不是画图（计划、策划、漫画、画面…）
const NOT_DRAW = /(计划|策划|规划|谋划|企划|漫画|动画|画面|笔画|刻|划)/;
// "你会画图吗""能不能画画" 是在问能力，不是让你真画 —— 真画会得到一张"会画图吗"
const ASK_ABILITY = /(会|能|可以|擅长|懂)\s*(不会|不能)?\s*(画|画画|画图|作图|绘制)/;

/** 他这句话是不是"让你画东西" */
export function looksLikeDrawRequest(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 200) return false;
  if (NOT_DRAW.test(s) && !RE_DRAW_FULL.test(s)) return false;
  // 只是问"你会不会画" → 不画，让她自己回答
  if (ASK_ABILITY.test(s) && /[?？吗嘛么呢]\s*$/.test(s) && s.length < 20) return false;
  return RE_DRAW_FULL.test(s) || RE_DRAW_SHORT.test(s);
}

/**
 * 从"帮我画一张日落的海边，要暖一点"里剥出"日落的海边，要暖一点"。
 * 剥不干净没关系，多留几个字对出图影响不大；留空了才算失败。
 */
export function extractDrawSubject(text) {
  let s = String(text || '').trim();

  // 去掉引号包裹（"画一张'猫'" 这种）
  s = s.replace(/^[\s"'“”‘’「」《》]+|[\s"'“”‘’「」《》]+$/g, '');

  // 开头的客套与请求词
  s = s.replace(/^(?:那个|嗯+|诶+|哎+)[，,、\s]*/g, '');
  s = s.replace(/^(?:你|能不能|可不可以|可以|能否|麻烦你?|请你?|帮我|给我|替我|帮|帮个忙)+/g, '');
  s = s.replace(/^(?:画|绘制|生成|作|做|来|搞|整)\s*(?:一?下)?\s*(?:一|1|两|2)?\s*(?:张|幅|个|只|副|款|份)?\s*(?:图|图片|画|照片|相片|画面)?/g, '');
  s = s.replace(/^(?:吧|呢|呗)[，,、\s]*/g, '');
  s = s.replace(/^(?:of|about)\s+/i, '');
  s = s.replace(/^[，,、:：\s]+/, '');

  // 结尾的商量语气
  s = s.replace(/[，,、\s]*(?:好不好|行不行|可以吗|好吗|行吗|可以么|呗|吧|呗~)\s*$/g, '');
  s = s.replace(/[，,、\s]*(?:吗|么|嘛|呢)\s*$/g, '');
  s = s.replace(/[。.!！?？…~～]+$/g, '');

  return s.trim().slice(0, MAX_PROMPT);
}

/** 把主体补成一段适合出图的提示词 */
export function buildPrompt(subject, cfg = {}) {
  const style = String(cfg.imageGenStyle || '').trim();
  const noText = cfg.imageGenNoText !== false;
  const parts = [String(subject || '').trim()];
  if (style) parts.push(style);
  if (noText) parts.push('画面里不要出现任何文字、logo 或水印');
  return parts.filter(Boolean).join('，').slice(0, MAX_PROMPT + 200);
}

/* ────────────────────────── 模型回复里的画图标记 ────────────────────────── */

// 支持 [draw: 描述] / 【画：描述】
const RE_MARKER = /(?:\[\[?|【)\s*(?:draw|画|画图)\s*[:：]\s*([^\]】\n]{1,300})\s*(?:\]\]?|】)/i;

/** 从模型回复里摘掉画图标记，返回 {text, prompt} */
export function extractDrawMarker(text) {
  const raw = String(text || '');
  const m = raw.match(RE_MARKER);
  if (!m) return { text: raw, prompt: '' };
  return {
    text: raw.replace(RE_MARKER, '').replace(/\n{3,}/g, '\n\n').trim(),
    prompt: m[1].trim()
  };
}

/* ────────────────────────── 频率闸门 ────────────────────────── */

const BUDGET_PATH = path.join(ROOT, 'data', 'imagegen-budget.json');

function hourKey(d = new Date()) {
  return d.toISOString().slice(0, 13);
}

function loadBudget() {
  try {
    const j = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'));
    return {
      hourKey: j.hourKey || '',
      hourCount: Number(j.hourCount || 0),
      dayKey: j.dayKey || '',
      dayCount: Number(j.dayCount || 0)
    };
  } catch {
    return { hourKey: '', hourCount: 0, dayKey: '', dayCount: 0 };
  }
}

function saveBudget(b) {
  try {
    fs.mkdirSync(path.dirname(BUDGET_PATH), { recursive: true });
    fs.writeFileSync(BUDGET_PATH, JSON.stringify(b), 'utf8');
  } catch {
    /* 预算文件写不进去也不能影响出图 */
  }
}

/**
 * 出图预算：防止她一句话画十张把额度烧光。
 * 返回 {allowed, reason, hourCount, dayCount}
 */
export function checkDrawBudget(cfg = {}) {
  const perHour = Math.max(1, Number(cfg.imageGenMaxPerHour ?? 5));
  const perDay = Math.max(1, Number(cfg.imageGenMaxPerDay ?? 20));
  const b = loadBudget();
  const now = new Date();
  const hk = hourKey(now);
  const dk = now.toISOString().slice(0, 10);
  if (b.hourKey !== hk) {
    b.hourKey = hk;
    b.hourCount = 0;
  }
  if (b.dayKey !== dk) {
    b.dayKey = dk;
    b.dayCount = 0;
  }
  if (b.hourCount >= perHour) return { allowed: false, reason: 'hour', hourCount: b.hourCount, dayCount: b.dayCount };
  if (b.dayCount >= perDay) return { allowed: false, reason: 'day', hourCount: b.hourCount, dayCount: b.dayCount };
  return { allowed: true, hourCount: b.hourCount, dayCount: b.dayCount };
}

export function recordDraw() {
  const b = loadBudget();
  const now = new Date();
  const hk = hourKey(now);
  const dk = now.toISOString().slice(0, 10);
  if (b.hourKey !== hk) {
    b.hourKey = hk;
    b.hourCount = 0;
  }
  if (b.dayKey !== dk) {
    b.dayKey = dk;
    b.dayCount = 0;
  }
  b.hourCount += 1;
  b.dayCount += 1;
  saveBudget(b);
}

/* ────────────────────────── 错误分类 ────────────────────────── */

function classify(status, text) {
  const t = String(text || '');
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate';
  if (/余额|欠费|额度|insufficient|quota|balance/i.test(t)) return 'billing';
  if (/审核|敏感|违规|sensitive|safety|moderation|content_policy/i.test(t)) return 'blocked';
  if (/timeout|timed out|abort|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(t)) return 'network';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** 失败原因 → 她嘴里的一句话（不许出现"接口/API/报错"） */
export function describeDrawFailure(kind) {
  switch (kind) {
    case 'nokey':
      return '我还没学会画画，画笔都没削';
    case 'auth':
      return '画笔被收走了，我得先找找钥匙';
    case 'billing':
      return '我的颜料用完了，得等补货';
    case 'rate':
      return '手太快了，让我喘口气再画';
    case 'blocked':
      return '这个我画不出来，换个题目吧';
    case 'network':
      return '脑子里的画面有了，但手一抖没画成';
    default:
      return '画笔卡住了，等会儿再试试';
  }
}

/* ────────────────────────── 主入口 ────────────────────────── */

/**
 * 生成一张图并落盘。
 * @returns {{ok:boolean, path?:string, mime?:string, bytes?:number, ms?:number,
 *            model?:string, prompt?:string, kind?:string, error?:string}}
 */
export async function generateImage(subject, { cfg = {}, destDir, log, warn, timeoutMs } = {}) {
  const started = Date.now();
  const say = typeof log === 'function' ? log : () => {};
  const cry = typeof warn === 'function' ? warn : () => {};

  if (cfg.imageGenEnabled === false) {
    return { ok: false, kind: 'nokey', error: '生图被关掉了' };
  }

  const apiKey = String(cfg.imageGenApiKey || process.env.AGNES_API_KEY || '').trim();
  if (!apiKey) return { ok: false, kind: 'nokey', error: '没配 imageGenApiKey' };

  const subjectText = String(subject || '').trim();
  if (!subjectText) return { ok: false, kind: 'unknown', error: '没有描述' };

  const baseUrl = String(cfg.imageGenBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const model = String(cfg.imageGenModel || 'agnes-image-2.5-flash');
  const size = String(cfg.imageGenSize || '1K');
  const ratio = String(cfg.imageGenRatio || '1:1');
  const prompt = buildPrompt(subjectText, cfg);
  const limit = Math.max(30000, Number(timeoutMs ?? cfg.imageGenTimeoutMs ?? 180000));

  const body = {
    model,
    prompt,
    size,
    ratio,
    extra_body: { response_format: 'url' }
  };

  let res;
  try {
    res = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(limit)
    });
  } catch (e) {
    const kind = classify(0, e.message);
    cry(`  [生图] 请求失败 kind=${kind}: ${e.message}`);
    return { ok: false, kind, error: e.message, ms: Date.now() - started, prompt, model };
  }

  const raw = await res.text();
  if (!res.ok) {
    const kind = classify(res.status, raw);
    cry(`  [生图] HTTP ${res.status} kind=${kind}: ${raw.slice(0, 300)}`);
    return { ok: false, kind, error: raw.slice(0, 300), ms: Date.now() - started, prompt, model };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, kind: 'unknown', error: '返回不是 JSON', ms: Date.now() - started, prompt, model };
  }

  const item = json?.data?.[0];
  if (!item) {
    return { ok: false, kind: 'unknown', error: '返回里没有图片', ms: Date.now() - started, prompt, model };
  }

  const dir = destDir || path.join(ROOT, 'data', 'media', 'outgoing');
  fs.mkdirSync(dir, { recursive: true });
  const base = `gen-${Date.now()}-${randomUUID().slice(0, 6)}`;

  let buf = null;
  let ext = 'png';
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
    ext = sniffExt(buf);
  } else if (item.url) {
    try {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(limit) });
      if (!imgRes.ok) throw new Error(`下载图片 HTTP ${imgRes.status}`);
      buf = Buffer.from(await imgRes.arrayBuffer());
      ext = sniffExt(buf);
    } catch (e) {
      const kind = classify(0, e.message);
      cry(`  [生图] 图片下载失败 kind=${kind}: ${e.message}`);
      return { ok: false, kind, error: e.message, ms: Date.now() - started, prompt, model };
    }
  } else {
    return { ok: false, kind: 'unknown', error: '返回里既没有 url 也没有 b64', ms: Date.now() - started, prompt, model };
  }

  if (!buf || buf.length < 1024) {
    return { ok: false, kind: 'unknown', error: '图片数据太小', ms: Date.now() - started, prompt, model };
  }
  // 微信只认图片字节，不认扩展名，但本地落盘还是要给对后缀
  if (buf.length > 24 * 1024 * 1024) {
    return { ok: false, kind: 'unknown', error: '图片超过 25MB', ms: Date.now() - started, prompt, model };
  }

  const out = path.join(dir, `${base}.${ext}`);
  fs.writeFileSync(out, buf);
  const ms = Date.now() - started;
  say(`  [生图] 成功 ${(buf.length / 1024).toFixed(0)}KB ${ext} ${(ms / 1000).toFixed(1)}s → ${path.basename(out)}`);
  say(`  [生图] 提示词: ${prompt.slice(0, 120)}`);

  return {
    ok: true,
    path: out,
    mime: ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
    bytes: buf.length,
    ms,
    model,
    prompt,
    revised: item.revised_prompt || ''
  };
}

function sniffExt(buf) {
  if (!buf || buf.length < 12) return 'png';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  return 'png';
}
