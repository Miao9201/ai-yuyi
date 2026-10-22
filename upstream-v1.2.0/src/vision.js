/**
 * 视觉理解 —— 把一张图变成一段客观的中文描述。
 *
 * 定位：**只负责看图说话**，不参与聊天。
 *   DeepSeek（chat.js）负责人设、上下文、拆条；这里只产出"上下文材料"，
 *   交给 DeepSeek 去理解成她自己的意思。
 *
 * 2026-10-19 起的主备分工（用户要求）：
 *   主用：DeepSeek 自己的多模态（deepseek-v4-flash 已支持图片输入），
 *         一条 Key、一个接口，少一套故障线；
 *   备用：豆包（火山方舟 Ark）—— 平时不调用，主用失败且配了方舟 Key 时才顶上。
 *   两套配置都保留，切换只改配置项 visionProvider，不需要动代码。
 *
 * 设计原则（用户明确要求）：识图失败**绝对不能抛错给用户**。
 *   - 欠费 / Key 无效 / 限流 / 超时 / 服务端 500 —— 全部归类成 kind，
 *     由上层换一句人设化的解释（"我的眼睛的费用到期了…"）；
 *   - 同一类失败进入冷却，冷却期内不再重试，避免每张图都撞一次；
 *   - 失败不影响后面的文字聊天。
 *
 * 两家接口都是 OpenAI 兼容格式：
 *   POST <baseUrl>/chat/completions
 *   Authorization: Bearer <API_KEY>
 *   content: [ {type:'text'}, {type:'image_url', image_url:{url:'data:image/jpeg;base64,…'}} ]
 *   关闭思考：body.thinking = { type: 'disabled' }（两家都认，实测有效）
 */
import { readFile } from 'node:fs/promises';

export const VISION_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const VISION_MODEL = 'doubao-seed-1-6-vision-250815';

/** DeepSeek 侧默认走聊天同一个模型（v4-flash 已支持图片输入） */
export const DEEPSEEK_VISION_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash';

/** 给视觉模型的指令：只描述，不聊天，不编造 */
export const VISION_PROMPT = `你是图片描述器，只做客观描述：不聊天、不评价、不编造。
请用中文描述这张图：
1. 画面主体是什么（人物 / 物体 / 界面 / 景色）；
2. 图里有文字的话，原样抄下来（报错信息、聊天内容、标题、按钮都算）；
3. 如果里面有人，说清楚表情、动作、穿着、所处环境；
4. 你确定不了的细节写"看不清"，绝对不要猜。
控制在 200 字以内，只输出描述本身，不要加"这张图是…"这类开场。`;

/**
 * 失败归类。
 * 分类的目的不是给用户看，而是决定「换什么话术」和「冷却多久」。
 */
export const VISION_FAIL_KINDS = {
  nokey: '还没给她配看图的钥匙（没填识图 API Key）',
  billing: '识图服务余额不足或欠费了',
  auth: '识图的钥匙不对（API Key 无效）',
  ratelimit: '识图接口被限流了',
  timeout: '识图接口超时了',
  server: '识图服务端出错了',
  network: '识图的网络断了',
  download: '图片没下载下来',
  empty: '识图模型返回了空内容',
  cooldown: '识图刚失败过，正在冷却',
  error: '识图失败了'
};

/** 这些失败要进冷却：欠费/Key 错属于「修好之前一直别试」 */
const COOLDOWN_KINDS = new Set(['billing', 'auth', 'ratelimit', 'nokey', 'cooldown']);

// `${provider}:${kind}` → 冷却截止时间戳。模块级，进程内共享，重启清空。
const cooldownUntil = new Map();

export function resetVisionCooldown() {
  cooldownUntil.clear();
}

export function getVisionCooldown() {
  return new Map(cooldownUntil);
}

/**
 * 选主通道。返回 { provider, label, baseUrl, model, apiKey, envHint }
 *
 * - visionProvider = 'deepseek'（默认）→ 用 DeepSeek 的 Key 与 baseUrl；
 * - visionProvider = 'doubao'        → 回到方舟（相当于手动切备用）。
 */
export function resolveVisionTarget(cfg = {}, overrideKey = '') {
  const want = String(cfg.visionProvider || 'deepseek').toLowerCase();
  if (want === 'doubao') {
    return {
      provider: 'doubao',
      label: '豆包',
      baseUrl: String(cfg.visionBaseUrl || VISION_BASE_URL).replace(/\/+$/, ''),
      model: cfg.visionModel || VISION_MODEL,
      apiKey: cfg.visionApiKey || process.env.ARK_API_KEY || '',
      envHint: 'ARK_API_KEY'
    };
  }
  return {
    provider: 'deepseek',
    label: 'DeepSeek',
    baseUrl: String(cfg.chatBaseUrl || DEEPSEEK_VISION_BASE_URL).replace(/\/+$/, ''),
    model: cfg.visionModelDeepseek || cfg.chatModel || DEEPSEEK_VISION_MODEL,
    apiKey: overrideKey || cfg.visionDeepseekApiKey || process.env.DEEPSEEK_API_KEY || '',
    envHint: 'DEEPSEEK_API_KEY'
  };
}

/** 备用通道（只有主用是 deepseek 且配了方舟 Key、且没关兜底时才存在） */
export function resolveFallbackTarget(cfg = {}) {
  const primary = resolveVisionTarget(cfg, '');
  if (primary.provider !== 'deepseek') return null;
  if (cfg.visionFallback === false) return null;
  const key = cfg.visionApiKey || process.env.ARK_API_KEY || '';
  if (!key) return null;
  return {
    provider: 'doubao',
    label: '豆包',
    baseUrl: String(cfg.visionBaseUrl || VISION_BASE_URL).replace(/\/+$/, ''),
    model: cfg.visionModel || VISION_MODEL,
    apiKey: key,
    envHint: 'ARK_API_KEY'
  };
}

/** 按 HTTP 状态 + 响应体判断失败类型 */
export function classifyVisionError(status, body) {
  const text = String(body ?? '');
  // 方舟欠费常见报错体里带 AccountOverdue / InsufficientBalance / 余额
  if (/AccountOverdue|InsufficientBalance|余额不足|欠费|Arrears|overdue/i.test(text)) return 'billing';
  if (status === 402) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimit';
  if (status >= 500) return 'server';
  if (/timeout|timed out|aborted|AbortError/i.test(text)) return 'timeout';
  if (/fetch failed|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(text)) return 'network';
  return 'error';
}

/** 一句人话，给上层写进提示词用（不是直接发给用户的） */
export function describeVisionFailure(kind) {
  return VISION_FAIL_KINDS[kind] ?? VISION_FAIL_KINDS.error;
}

function mimeOf(filePath) {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

/** 单次请求：一个通道、若干张图。返回统一结构，不抛错。 */
async function callVision(target, picked, { cfg = {}, log = () => {}, warn = () => {} } = {}) {
  const started = Date.now();
  const tag = target.provider === 'doubao' ? '豆包' : 'DeepSeek';

  // 冷却期直接挡掉，不浪费一次请求
  const now = Date.now();
  for (const [key, until] of cooldownUntil) {
    if (!key.startsWith(`${target.provider}:`)) continue;
    if (now < until) {
      const kind = key.slice(target.provider.length + 1);
      return {
        ok: false,
        kind,
        provider: target.provider,
        reason: `${tag} ${describeVisionFailure(kind)}（冷却中，还剩 ${Math.ceil((until - now) / 60000)} 分钟）`,
        descriptions: [],
        ms: 0
      };
    }
  }

  const content = [{ type: 'text', text: VISION_PROMPT }];
  for (const f of picked) {
    const buf = await readFile(f.filePath);
    const mime = f.mime || mimeOf(f.filePath);
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${buf.toString('base64')}` }
    });
  }

  const body = {
    model: target.model,
    messages: [{ role: 'user', content }],
    temperature: 0.2,
    max_tokens: 700
  };

  // 看图描述这类任务不需要"思考"：
  //   豆包实测 reasoning 262 → 0、3.4s → 1.4s；
  //   DeepSeek 实测 2186ms/300 tokens → 885ms/21 tokens，质量不变。
  const thinking = String(cfg.visionThinking ?? 'disabled').toLowerCase();
  if (target.provider === 'doubao' || new URL(target.baseUrl).hostname.toLowerCase() === 'api.deepseek.com') {
    body.thinking = { type: thinking === 'enabled' || thinking === 'auto' ? thinking : 'disabled' };
  }

  let status = 0;
  let respText = '';
  try {
    const res = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(5000, Number(cfg.visionTimeoutMs ?? 45000)))
    });
    status = res.status;
    respText = await res.text();
  } catch (e) {
    const kind = /abort|timeout/i.test(String(e?.name) + String(e?.message)) ? 'timeout' : 'network';
    const reason = `${tag} ${describeVisionFailure(kind)}：${e?.message ?? e}`;
    warn(`  [识图] ${reason}`);
    return { ok: false, kind, provider: target.provider, reason, descriptions: [], ms: Date.now() - started };
  }

  if (status < 200 || status >= 300) {
    const kind = classifyVisionError(status, respText);
    const brief = respText.replace(/\s+/g, ' ').slice(0, 220);
    const reason = `${tag} ${describeVisionFailure(kind)}（HTTP ${status}）：${brief}`;
    warn(`  [识图] ${reason}`);
    if (COOLDOWN_KINDS.has(kind)) {
      const minutes = Math.max(1, Number(cfg.visionCooldownMinutes ?? 30));
      cooldownUntil.set(`${target.provider}:${kind}`, Date.now() + minutes * 60000);
      log(`  [识图] ${tag} 进入冷却 ${minutes} 分钟（同类失败不再重试）`);
    }
    return { ok: false, kind, provider: target.provider, reason, descriptions: [], ms: Date.now() - started };
  }

  let parsed;
  try {
    parsed = JSON.parse(respText);
  } catch {
    const reason = '识图返回的不是 JSON';
    warn(`  [识图] ${reason}`);
    return { ok: false, kind: 'error', provider: target.provider, reason, descriptions: [], ms: Date.now() - started };
  }

  const raw = parsed?.choices?.[0]?.message?.content;
  const text = typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? raw.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
      : '';

  const cleaned = String(text).trim();
  if (!cleaned) {
    const reason = describeVisionFailure('empty');
    warn(`  [识图] ${reason}`);
    return { ok: false, kind: 'empty', provider: target.provider, reason, descriptions: [], ms: Date.now() - started };
  }

  const usage = parsed?.usage ?? {};
  log(
    `  [识图] ${target.label}（${target.model}）识别成功（${Date.now() - started}ms，` +
    `输入 ${usage.prompt_tokens ?? '?'} tokens，输出 ${usage.completion_tokens ?? '?'} tokens）`
  );

  return {
    ok: true,
    descriptions: [cleaned],
    kind: 'ok',
    provider: target.provider,
    reason: '',
    ms: Date.now() - started,
    usage
  };
}

/**
 * 描述若干张图。主通道失败且有备用通道时自动顶上（只顶一次）。
 *
 * @param {Array<{filePath:string, mime?:string}>} files
 * @param {{cfg?:object, log?:Function, warn?:Function, apiKey?:string}} opts
 *        apiKey：DeepSeek 的 Key（index.js 启动时已读好，直接传进来最省事）
 * @returns {Promise<{ok:boolean, kind?:string, reason?:string, descriptions:string[],
 *                    ms:number, provider?:string, fallback?:boolean}>}
 */
export async function describeImages(files, { cfg = {}, log = () => {}, warn = () => {}, apiKey = '' } = {}) {
  const started = Date.now();
  const list = (files || []).filter((f) => f && f.filePath);
  if (!list.length) {
    return { ok: false, kind: 'download', reason: '没有可用的图片文件', descriptions: [], ms: 0 };
  }

  const primary = resolveVisionTarget(cfg, apiKey);
  const fallback = resolveFallbackTarget(cfg);
  const maxImages = Math.max(1, Number(cfg.visionMaxImages ?? 1));
  const picked = list.slice(0, maxImages);

  // 1) 没 Key：主用和备用都没配，才直接判 nokey
  if (!primary.apiKey && !fallback?.apiKey) {
    return {
      ok: false,
      kind: 'nokey',
      reason: `还没配识图 Key（${primary.envHint} 或 ARK_API_KEY）`,
      descriptions: [],
      ms: 0
    };
  }

  // 2) 主用
  let result = primary.apiKey
    ? await callVision(primary, picked, { cfg, log, warn })
    : { ok: false, kind: 'nokey', provider: primary.provider, reason: `主用（${primary.label}）没配 Key`, descriptions: [], ms: 0 };

  if (result.ok) return result;

  // 3) 备用顶上
  if (fallback && fallback.apiKey) {
    log(`  [识图] 主用 ${primary.label} 失败（${result.kind}），切备用 ${fallback.label}`);
    const second = await callVision(fallback, picked, { cfg, log, warn });
    if (second.ok) return { ...second, fallback: true };
    return {
      ...second,
      reason: `${primary.label}: ${result.reason || result.kind}；${fallback.label}: ${second.reason || second.kind}`,
      fallback: true,
      ms: Date.now() - started
    };
  }

  return { ...result, ms: Date.now() - started };
}
