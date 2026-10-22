// 遗忘机制 —— 让她记得住"最近在聊什么"，也能记住"这个别再提了"
//
// 为什么单独一个模块：
//   场景（scene.js）记的是"当前这一件事"，半小时到三小时就过期；
//   但"反复提 ComfyUI"这类毛病，根因是**旧话题没有衰减**——
//   上周的兴趣点会一直躺在知识库/近期笔记里，被每轮注入，于是她反复拿出来说。
//
// 这里做两件事：
//   ① 话题记忆：只有**最近 48 小时**他提过的话题，才允许被她主动提起；
//   ② 明确厌烦：他说"别老提这个"，立刻把相关关键词拉黑（默认 7 天），
//      场景一起清掉，本轮上下文里也会写明"不要提"。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { keywordsOf, topicOf } from './scene.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = process.env.WX_RUNTIME_DATA_DIR || path.join(ROOT, 'data');
const STORE = path.join(DATA_DIR, 'topics.json');

const HISTORY_MAX = 60;      // 每人最多留 60 条话题
const HISTORY_DAYS = 14;     // 超过 14 天的直接清掉（不参与任何判断）
const KEYWORD_MAX = 8;       // 每条话题留几个关键词

// keywordsOf 是"两个字一切"的粗切，会切出「我下」「午在」「的画」这类碎片。
// 碎片做黑名单会造成误伤（"工作"把"工作流"整片覆盖掉还勉强能接受，
// 但"一下"会把"等一下"也拦了），所以这里再过一道滤网。
const JUNK_CHARS = new Set('的了着过是在有和与就都也还很太我你他她它这那一下么呢吧啊嘛呀地把被给对从到说想会能要不没个上中'.split(''));

function cleanKeywords(text, limit = KEYWORD_MAX) {
  const raw = keywordsOf(text, Math.max(limit * 3, 12));
  const out = [];
  for (const k of raw) {
    if (!k) continue;
    if (/^[a-z0-9]/i.test(k)) {
      if (k.length >= 3) out.push(k);   // 英文/型号：太短没辨识度
    } else if ([...k].every((c) => !JUNK_CHARS.has(c))) {
      out.push(k);
    }
    if (out.length >= limit) break;
  }
  return out;
}

// 明确的"别提了"信号。宁窄不宽：误判会让她突然不敢说话。
const ANNOY_RE = /(别|不要|不用|少|不要再)(再)?(提|说|讲|聊|问)(那个|这个|这些|那些|它)?[，,。！!]?|(老|总是|老是|反复|又来|又)(提|说|讲|问)|提(过|了)?(多少遍|好多次|好几次)|(烦不烦|烦死了|烦人|腻了|够了)|(说过|讲过|聊过)(多少遍|几次|好几)|换个话题|说点别的|说别的|别提了/;

function now() { return Date.now(); }

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch { /* 文件不存在或坏了都重新开始 */ }
  return {};
}
function writeStore(store) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, STORE);
  } catch (e) {
    // 遗忘机制坏了不能影响聊天
    console.warn(`[遗忘] 写入失败：${e?.message || e}`);
  }
}

function bucket(store, userId) {
  const uid = String(userId || '_default');
  if (!store[uid] || typeof store[uid] !== 'object') store[uid] = { history: [], bans: [] };
  if (!Array.isArray(store[uid].history)) store[uid].history = [];
  if (!Array.isArray(store[uid].bans)) store[uid].bans = [];
  return store[uid];
}

const idOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

/** 两条文本的关键词是否有交集（用于判断"说的是不是同一件事"） */
function overlap(a, b) {
  const A = new Set(a);
  for (const k of b) if (A.has(k)) return true;
  return false;
}

/**
 * 记一条他说过的话，更新话题记忆。
 * 同一件小事反复说会累加 mentions —— 可以用来判断"他最近在乎什么"。
 */
export function noteUserMessage(userId, text, { ttlHours = 48 } = {}) {
  const t = String(text || '').trim();
  if (t.length < 2) return null;
  const store = readStore();
  const b = bucket(store, userId);
  const keywords = cleanKeywords(t, KEYWORD_MAX);
  if (!keywords.length) return null;

  // 先看是不是在接着聊某条已有话题（关键词有交集就算）
  const hit = b.history.find((h) => overlap(h.keywords || [], keywords));
  if (hit) {
    hit.lastAt = now();
    hit.mentions = (hit.mentions || 1) + 1;
    hit.keywords = [...new Set([...(hit.keywords || []), ...keywords])].slice(0, KEYWORD_MAX);
    hit.label = hit.label || topicOf(t);
  } else {
    b.history.push({
      id: idOf(`${t}:${now()}`),
      label: topicOf(t),
      keywords,
      firstAt: now(),
      lastAt: now(),
      mentions: 1
    });
  }

  // 清理：太老的、太多的
  const cutoff = now() - HISTORY_DAYS * 86400e3;
  b.history = b.history.filter((h) => (h.lastAt || 0) >= cutoff).slice(-HISTORY_MAX);
  b.bans = b.bans.filter((x) => (x.until || 0) > now());
  writeStore(store);
  return hit || b.history[b.history.length - 1];
}

/** 他这句话是不是在表达"别老提这个" */
export function detectAnnoyance(text) {
  const t = String(text || '');
  const m = ANNOY_RE.exec(t);
  return { annoyed: !!m, matched: m ? m[0] : '', text: t };
}

/**
 * 把相关话题拉黑，并返回被拉黑的标签。
 * 关键词来源：当前场景话题 + 最近几句他说过的话（他说"别老提ComfyUI"时，
 * 单看这句话只有"提/别"这类虚词，必须借助上下文才知道"那个"指的是什么）。
 */
export function banRelated(userId, { scene = null, recentTexts = [], hours = 168, reason = '他说不想再提' } = {}) {
  const store = readStore();
  const b = bucket(store, userId);
  const kws = new Set();
  const labels = new Set();

  if (scene?.topic) {
    cleanKeywords(scene.topic, 10).forEach((k) => kws.add(k));
    labels.add(scene.topic);
  }
  if (Array.isArray(scene?.keywords)) scene.keywords.forEach((k) => kws.add(k));

  // 最近几句里出现频率高的实词，才值得拉黑（避免把"今天/什么"也拉黑）
  const fresh = new Set();
  for (const txt of recentTexts.slice(-4)) cleanKeywords(txt, 10).forEach((k) => fresh.add(k));
  for (const h of b.history.slice(-6)) {
    if ((h.keywords || []).some((k) => fresh.has(k))) {
      (h.keywords || []).forEach((k) => kws.add(k));
      if (h.label) labels.add(h.label);
      h.lastAt = now();
    }
  }

  // 一句话里全是虚词时，兜底拉黑最近一条话题
  if (!kws.size && b.history.length) {
    const last = b.history[b.history.length - 1];
    (last.keywords || []).forEach((k) => kws.add(k));
    if (last.label) labels.add(last.label);
  }

  const until = now() + Math.max(1, hours) * 3600e3;
  b.bans.push({
    id: idOf([...kws].join('|') + until),
    label: [...labels][0] || '',
    labels: [...labels].slice(0, 4),
    keywords: [...kws].slice(0, 12),
    until,
    reason
  });
  b.history = b.history.filter((h) => !(h.keywords || []).some((k) => kws.has(k)));
  writeStore(store);
  return { keywords: [...kws], labels: [...labels] };
}

/** 某段文本是否踩到黑名单（用于过滤知识库注入、主动消息候选） */
export function isSuppressed(userId, text) {
  const t = String(text || '');
  if (!t) return false;
  const store = readStore();
  const b = store[String(userId || '_default')];
  if (!b || !Array.isArray(b.bans)) return false;
  const kws = cleanKeywords(t, 12);
  if (!kws.length) return false;
  // 命中一个通用词（"工作"）不足以判定在说同一件事，会误伤；
  // 两个以上，或者命中一个够长的专有词（"comfyui"），才算踩线。
  return b.bans.some((x) => {
    if ((x.until || 0) <= now()) return false;
    const hits = (x.keywords || []).filter((k) => kws.includes(k));
    return hits.length >= 2 || hits.some((k) => k.length >= 5);
  });
}

/** 有效话题：48 小时内说过、且没被拉黑 */
export function activeTopics(userId, { ttlHours = 48, limit = 6 } = {}) {
  const store = readStore();
  const b = store[String(userId || '_default')];
  if (!b || !Array.isArray(b.history)) return [];
  const cutoff = now() - Math.max(1, ttlHours) * 3600e3;
  const bans = (b.bans || []).filter((x) => (x.until || 0) > now());
  return b.history
    .filter((h) => (h.lastAt || 0) >= cutoff)
    .filter((h) => !bans.some((x) => (x.keywords || []).some((k) => (h.keywords || []).includes(k))))
    .sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0))
    .slice(0, limit);
}

/** 当前生效的黑名单（给提示词用） */
export function activeBans(userId) {
  const store = readStore();
  const b = store[String(userId || '_default')];
  if (!b || !Array.isArray(b.bans)) return [];
  return b.bans.filter((x) => (x.until || 0) > now());
}

function hoursAgo(ts) {
  const h = (now() - (ts || now())) / 3600e3;
  if (h < 1) return '刚刚';
  if (h < 24) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/**
 * 把"记得什么/别碰什么"拼成本轮提示词。
 * 注意措辞：话题是**他可以接着聊的**，不是"你要主动提"。
 */
export function formatForgetBlock(userId, { ttlHours = 48, limit = 6, maxChars = 300 } = {}) {
  const topics = activeTopics(userId, { ttlHours, limit });
  const bans = activeBans(userId);
  const parts = [];

  if (topics.length) {
    const lines = topics.map((t) => `- ${t.label}（${hoursAgo(t.lastAt)}${t.mentions > 1 ? `，提过 ${t.mentions} 次` : ''}）`);
    parts.push('【他最近两天真正在弄的事】他要是聊到就顺着聊，别硬拐过去：');
    parts.push(lines.join('\n'));
  }

  if (bans.length) {
    const labels = [...new Set(bans.flatMap((x) => (x.labels && x.labels.length ? x.labels : [x.label]).filter(Boolean)))];
    const kw = [...new Set(bans.flatMap((x) => x.keywords || []))].filter((k) => k.length >= 2).slice(0, 8);
    parts.push(`【他明确表示不想再提的】${labels.length ? labels.map((l) => `「${l}」`).join('') : ''}${kw.length ? `（相关词：${kw.join('、')}）` : ''}——不要主动提，也不要换着说法绕回来；他先开口再说。`);
  }

  if (!parts.length) return '';
  let out = parts.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…';
  return out;
}

/** 定期清理：由 index.js 启动时调一次即可 */
export function prune(userId = null) {
  const store = readStore();
  const cutoff = now() - HISTORY_DAYS * 86400e3;
  const uids = userId ? [String(userId)] : Object.keys(store);
  for (const uid of uids) {
    const b = bucket(store, uid);
    b.history = b.history.filter((h) => (h.lastAt || 0) >= cutoff).slice(-HISTORY_MAX);
    b.bans = b.bans.filter((x) => (x.until || 0) > now());
  }
  writeStore(store);
}

export const TOPICS_PATH = STORE;
