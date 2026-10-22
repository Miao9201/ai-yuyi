/**
 * 场景状态（当前正在聊的那件事）
 *
 * 要解决的问题：
 *   以前每条消息都是「人设 + 最近 3 轮 + 这一句」，模型看不到"我们正在聊什么"，
 *   于是每轮都在重新起一个话题。表现出来就是：说的话都挺像人，但互相没关系。
 *
 * 做法：
 *   把"当前场景"当成一份一等状态落盘（data/scenes/<hash>.json），
 *   回复和主动消息都先读它，并且优先"接着往下走"，而不是重新开题。
 *
 * 三个刻意的设计：
 *   1) 场景是**持久化**的。以前 proactive 的 silentStreak 只存在内存里，
 *      进程一重启就归零，于是又从"随机开新话题"开始 —— 这是"每次都很随机"的
 *      另一个隐藏原因。
 *   2) 判断"是不是同一个话题"用本地关键词重合度（零成本），
 *      拿不准（中间地带）才考虑让模型判一次。默认连模型都不调。
 *   3) "随机开新话题"有独立的冷却时间（proactiveNewTopicMinutes，默认 180 分钟），
 *      和"回复间隔"完全分开：可以很快接话，但不会很快就换题。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCENE_DIR = path.join(process.env.WX_RUNTIME_DATA_DIR || path.join(ROOT, 'data'), 'scenes');

const MAX_KEYWORDS = 18;
const MAX_PROGRESS = 4;
const MAX_TEXT = 120;

/** 内存缓存：同一进程里不反复读盘 */
const cache = new Map();

/** 高频虚词。做二字切分时整对都在里面就丢掉，否则关键词里全是"我们/这个/就是" */
const STOP = new Set(
  '的了着呢吧啊呀嘛哦嗯是我你他她它在有就都也还和与很太不没这那什么怎么为什么可以一个我们你们他们它们个吗呢哈嗯好对行要会能说想觉得'.split('')
);

const ACK_RE = /^(嗯+|哦+|噢+|好+|行|对|是|是的|收到|ok|OK|哈哈+|呵呵+|嘿+|在|在呢|随便|都行)[。！？.!~～\s]*$/;
const REF_RE = /(后来|然后|结果|所以|接着|继续|刚才|上面|刚才那|那个|这件事|这事|它|还有|说起|对了)/;

function scenePath(userId) {
  const h = createHash('sha1').update(String(userId)).digest('hex').slice(0, 16);
  return path.join(SCENE_DIR, `${h}.json`);
}

function clip(s, n = MAX_TEXT) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 抽关键词：英文/数字按词切，中文按二字切分（不引分词库，零依赖）。
 * 只用于"两句是不是同一件事"的粗判断，不追求语言学上的准确。
 */
export function keywordsOf(text, limit = MAX_KEYWORDS) {
  const s = String(text ?? '');
  const out = [];

  for (const w of s.match(/[a-zA-Z][a-zA-Z0-9_+#.-]{1,}/g) || []) out.push(w.toLowerCase());

  for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (STOP.has(bg[0]) && STOP.has(bg[1])) continue;
      out.push(bg);
    }
  }

  const seen = new Set();
  const uniq = [];
  for (const w of out) {
    if (seen.has(w)) continue;
    seen.add(w);
    uniq.push(w);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

/** 从用户这句话里提炼一个"场景标题"（不调模型，纯截断） */
export function topicOf(text) {
  const t = String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '闲聊';
  const first = t.split(/[。！？!?；;]/)[0].trim() || t;
  return clip(first, 28);
}

/** 新建一个场景 */
export function createScene(userText, opts = {}) {
  const now = Date.now();
  const source = opts.source || 'user';
  return {
    topic: topicOf(userText),
    keywords: keywordsOf(userText),
    startedAt: now,
    updatedAt: now,
    turns: 0,
    lastUserText: clip(userText),
    lastReplyText: '',
    openQuestion: '',
    progress: [],
    source,
    // 主动开的新话题才计入"随机换题"冷却
    lastNewTopicAt: source === 'proactive' ? now : 0
  };
}

function normalize(scene) {
  const s = scene && typeof scene === 'object' ? scene : null;
  if (!s || !s.topic) return null;
  s.keywords = Array.isArray(s.keywords) ? s.keywords : [];
  s.progress = Array.isArray(s.progress) ? s.progress : [];
  s.turns = Number.isFinite(s.turns) ? s.turns : 0;
  s.startedAt = s.startedAt || Date.now();
  s.updatedAt = s.updatedAt || s.startedAt;
  s.lastNewTopicAt = Number.isFinite(s.lastNewTopicAt) ? s.lastNewTopicAt : 0;
  return s;
}

export async function loadScene(userId) {
  if (cache.has(userId)) return cache.get(userId);
  try {
    const raw = await readFile(scenePath(userId), 'utf8');
    const s = normalize(JSON.parse(raw));
    cache.set(userId, s);
    return s;
  } catch {
    cache.set(userId, null);
    return null;
  }
}

export async function saveScene(userId, scene) {
  const s = normalize(scene);
  cache.set(userId, s);
  if (!s) return null;
  try {
    await mkdir(SCENE_DIR, { recursive: true });
    await writeFile(scenePath(userId), JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    console.warn('[scene] 保存失败:', e.message);
  }
  return s;
}

export async function resetScene(userId) {
  cache.delete(userId);
  try {
    await writeFile(scenePath(userId), 'null', 'utf8');
  } catch { /* 文件不存在就算了 */ }
}

/**
 * 判断用户这句话是「延续当前场景」还是「换话题」。
 *
 * 返回 mode：
 *   'new'       —— 没有场景 / 已过期 / 明确换了话题
 *   'continue'  —— 延续，回复时要顺着往下说
 *   'ambiguous' —— 拿不准，调用方决定（默认当成 continue，更安全；
 *                  配置了 sceneAnalyzeModel 时可以再让模型判一次）
 *
 * 注意：这里判"用户换话题"和"AI 主动换话题"是两件事。
 * 用户想换就换，不需要等冷却；冷却只约束 AI 自己起新话头。
 */
export function analyzeTurn(userText, scene, opts = {}) {
  const ttlMs = opts.ttlMs ?? 180 * 60 * 1000;
  const text = String(userText ?? '').trim();

  if (!scene || !scene.topic) return { mode: 'new', score: 0, reason: '还没有场景' };

  const gap = Date.now() - (scene.updatedAt || scene.startedAt || 0);
  if (gap > ttlMs) {
    return { mode: 'new', score: 0, reason: `距上次已经 ${Math.round(gap / 60000)} 分钟，场景过期` };
  }

  if (!text) return { mode: 'continue', score: 0.5, reason: '空消息' };
  if (ACK_RE.test(text)) return { mode: 'continue', score: 0.5, reason: '短应答，按延续处理' };

  const kw = keywordsOf(text);
  const sceneKw = new Set([...(scene.keywords || []), ...keywordsOf(scene.topic)]);
  let inter = 0;
  for (const w of kw) if (sceneKw.has(w)) inter++;
  const denom = Math.max(2, Math.min(kw.length, sceneKw.size));
  const score = inter / denom;

  if (REF_RE.test(text)) return { mode: 'continue', score, reason: '句子里有承接词（后来/那个/接着）' };
  if (score >= 0.18) return { mode: 'continue', score, reason: `关键词重合 ${score.toFixed(2)}` };
  if (text.length <= 6) return { mode: 'continue', score, reason: '短句，按延续处理' };
  // 几乎零重合 + 句子有内容 → 判定为换话题。
  // 这是"用户自己换题"，不需要等换题冷却（冷却只约束 AI 主动开新题）。
  if (score <= 0.08) return { mode: 'new', score, reason: `几乎没有重合（${score.toFixed(2)}）` };
  return { mode: 'ambiguous', score, reason: `重合度在中间地带（${score.toFixed(2)}）` };
}

/** 用户说了话：更新场景（换话题时由调用方先 createScene） */
export function recordUserTurn(scene, userText) {
  if (!scene) return null;
  const now = Date.now();
  const text = clip(userText, 60);

  scene.lastUserText = clip(userText);
  scene.updatedAt = now;
  scene.turns = (scene.turns || 0) + 1;

  // 关键词缓慢扩张：新话题相关词进来，但不超过上限，避免关键词池无限变大
  const fresh = keywordsOf(userText).filter((w) => !scene.keywords.includes(w));
  if (fresh.length) scene.keywords = [...scene.keywords, ...fresh].slice(0, MAX_KEYWORDS + 6);

  if (text) {
    scene.progress = [...(scene.progress || []), `他：${clip(text, 40)}`].slice(-MAX_PROGRESS);
  }
  return scene;
}

/** 她回复完了：记下说了什么、有没有留下一个没被回答的问题 */
export function recordReply(scene, replyText) {
  if (!scene) return null;
  const now = Date.now();
  const text = String(replyText ?? '').replace(/\s+/g, ' ').trim();

  scene.lastReplyText = clip(text);
  scene.updatedAt = now;

  const q = lastQuestionOf(text);
  if (q) scene.openQuestion = clip(q, 60);

  const short = clip(text, 40);
  if (short) scene.progress = [...(scene.progress || []), `你：${short}`].slice(-MAX_PROGRESS);
  return scene;
}

/** 取最后一句问句（中文经常不带问号，靠疑问词判断） */
export function lastQuestionOf(text) {
  const parts = String(text ?? '').split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/[？?]/.test(p)) return p;
    if (/(吗|呢|吧|呀)\s*$/.test(p) && p.length >= 4) return p;
    if (/怎么|为什么|为啥|什么|哪[个里儿]|多少|几个|多久|是不是|有没有|要不要/.test(p)) return p;
  }
  return '';
}

/**
 * AI 是否可以"随机开新话题"。
 * 冷却未到就必须顺着当前场景说 —— 这就是用户要的"一个语境、一个整体的事"。
 */
export function canOpenNewTopic(scene, opts = {}) {
  const intervalMs = opts.intervalMs ?? 180 * 60 * 1000;
  if (!scene || !scene.lastNewTopicAt) return true;
  return Date.now() - scene.lastNewTopicAt >= intervalMs;
}

/** 主动开了一个新话题：落冷却时间，同时把场景切过去 */
export function markNewTopic(scene, userText, opts = {}) {
  const s = scene || createScene(userText, { source: 'proactive' });
  s.topic = topicOf(userText);
  s.keywords = keywordsOf(userText);
  s.startedAt = Date.now();
  s.updatedAt = Date.now();
  s.turns = 0;
  s.progress = [];
  s.openQuestion = '';
  s.source = opts.source || 'proactive';
  s.lastNewTopicAt = Date.now();
  s.lastUserText = '';
  s.lastReplyText = clip(userText);
  return s;
}

function ageText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}

/**
 * 回复路径用的场景段落。
 * 只有"延续"时才强调"必须接着讲"；换话题时反过来要求先收尾。
 */
export function formatSceneForReply(scene, opts = {}) {
  if (!scene || !scene.topic) return '';
  const mode = opts.mode || 'continue';

  const lines = [
    '【你和他现在正在聊的这件事（真实存在的上下文，不是设定）】',
    `这件事是：${scene.topic}`,
    `已经聊了 ${scene.turns || 0} 轮，${ageText(Date.now() - (scene.startedAt || Date.now()))}开始的`
  ];

  if (scene.progress?.length) {
    lines.push('最近的来龙去脉：');
    for (const p of scene.progress.slice(-MAX_PROGRESS)) lines.push(`  · ${p}`);
  }
  if (scene.openQuestion) {
    lines.push(`你上一次问过他：「${scene.openQuestion}」`);
  }
  lines.push('');

  if (mode === 'new') {
    lines.push('他这句话像是在说另一件事了。');
    lines.push('先把上一个小尾巴收一下（半句就够，别硬拗），再自然接到他新说的事上。');
    lines.push('不要假装之前那件事没发生过，也不要生硬地"好的我们换个话题"。');
  } else {
    lines.push('**这条回复必须顺着上面这件事往下走，不要另起一个新话题。**');
    lines.push('可以：回答他这句 / 补一个和它有关的细节 / 说这件事的后续 / 问一个具体的后续问题。');
    if (scene.openQuestion) {
      lines.push('如果他还没回答你上次的问题，不要换个问题再问一遍，也别催。');
    }
    lines.push('如果你确实想把话头引到别处，只能是在这件事上顺出来的一句话，不能凭空开新题。');
  }
  return lines.join('\n');
}

/** 主动消息路径用的场景段落 */
export function formatSceneForProactive(scene, opts = {}) {
  if (!scene || !scene.topic) return '';
  const lines = [
    '【你们之间现在挂着的那件事】',
    `话题：${scene.topic}`,
    `上次说到：${scene.lastReplyText || scene.lastUserText || '（还没聊开）'}`
  ];
  if (scene.progress?.length) {
    lines.push('更早的来龙去脉：');
    for (const p of scene.progress.slice(-3)) lines.push(`  · ${p}`);
  }
  if (scene.openQuestion) lines.push(`你问过他、他还没答的：「${scene.openQuestion}」`);
  if (opts.canNewTopic === false) {
    lines.push('');
    lines.push('**这次必须接着说这件事**，不能说一件完全无关的新事先。');
    lines.push('可以补充一个细节、说后来怎样、或者就这件事再问一句。');
  }
  return lines.join('\n');
}
