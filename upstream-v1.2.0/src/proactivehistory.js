/**
 * 主动消息的「说过什么」记忆
 *
 * 为什么需要：主动搭话的提示词原本是完全通用的，模型每轮都收敛到
 * 同一句话（实测只输出"哥哥你在干嘛呀"）。光在提示词里写"要换着说"没有用，
 * 必须在代码里记住最近发过什么，然后：
 *   1. 把它们作为「禁止重复」清单塞回提示词
 *   2. 生成完做相似度检查，太像就重来一次
 *   3. 还不行就换本地备选句，保证绝不重样
 *
 * 落盘到 data/proactive-history.json，重启不清零。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(process.env.WX_RUNTIME_DATA_DIR || path.join(ROOT, 'data'), 'proactive-history.json');

const MAX_KEEP = 40;
const COMPARE_RECENT = 12;

/** 中文没有空格，用 bigram 集合做相似度 */
function bigrams(text) {
  const han = String(text || '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .toLowerCase();
  const set = new Set();
  for (let i = 0; i + 2 <= han.length; i++) set.add(han.slice(i, i + 2));
  if (!set.size && han.length) set.add(han);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 这套主动搭话里最容易被模型滥用的句式。
 * 只要最近用过，就不许再用。
 */
const BANNED_PHRASES = [
  '在干嘛', '干嘛呢', '在吗', '在不在', '吃了吗', '吃过了吗', '吃没吃',
  '睡了吗', '睡了没', '在忙吗', '忙不忙', '你在做什么', '在干什么'
];

function readAll() {
  try {
    const arr = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(arr) {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(arr.slice(-MAX_KEEP), null, 2), 'utf8');
  } catch { /* 写不进去不影响聊天 */ }
}

/** 最近发过的句子（新的在后），给提示词当禁止清单 */
export function recentLines(limit = COMPARE_RECENT) {
  return readAll().slice(-limit).map((x) => x.text).filter(Boolean);
}

/** 最近用过的场景 key，用来避免连续同一类 */
export function recentScenarios(limit = 4) {
  return readAll().slice(-limit).map((x) => x.scenario).filter(Boolean);
}

/** 记一条已发出去的主动消息 */
export function rememberLine(text, scenario = '') {
  const arr = readAll();
  arr.push({ at: new Date().toISOString(), text: String(text || ''), scenario });
  writeAll(arr);
}

/**
 * 这句话是不是"又说了一遍"。
 * 判定为重复的几种情况：
 *   1. 归一化后完全相同
 *   2. 一个是另一个的子串
 *   3. bigram 相似度 >= threshold（默认 0.5）
 *   4. 用了一个最近用过的万能句式（在干嘛 / 吃了吗…）
 *
 * 注意 threshold 是可调的，因为"接着上一条往下说"的时候，
 * 话题本来就该相同 —— 那时候只该拦"几乎一字不差"，门槛要抬到 0.8 左右。
 *
 * @param {string} text
 * @param {{limit?:number, threshold?:number}} opts  传数字则当 limit 用（兼容旧调用）
 */
export function isTooSimilar(text, opts = {}) {
  const { limit, threshold } = typeof opts === 'number'
    ? { limit: opts, threshold: 0.5 }
    : { limit: opts.limit ?? COMPARE_RECENT, threshold: opts.threshold ?? 0.5 };

  const t = String(text || '').trim();
  if (!t) return { similar: true, reason: '空' };

  const recent = recentLines(limit);
  const strip = (s) => s.replace(/[\s，。！？、,.!?~～…—\-()（）\[\]【】"'“”‘’]/g, '');
  const tn = strip(t);
  const tBig = bigrams(t);

  for (const r of recent) {
    const rn = strip(r);
    if (!rn) continue;
    if (tn === rn) return { similar: true, reason: `和上次一模一样：「${r}」`, hit: r };
    if (tn.includes(rn) || rn.includes(tn)) {
      if (Math.min(tn.length, rn.length) >= 4) {
        return { similar: true, reason: `几乎包含上次那句：「${r}」`, hit: r };
      }
    }
    if (jaccard(tBig, bigrams(r)) >= threshold) {
      return { similar: true, reason: `和上次太像：「${r}」`, hit: r };
    }
  }

  // 万能句式：最近用过就不许再用
  for (const p of BANNED_PHRASES) {
    if (!t.includes(p)) continue;
    for (const r of recent) {
      if (r.includes(p)) {
        return { similar: true, reason: `又用了「${p}」这种已经用过的话`, hit: r };
      }
    }
  }

  return { similar: false, reason: '' };
}

/**
 * 本地兜底句库：模型实在换不出来时用。
 * 按场景分组，挑的时候尽量避开最近用过的场景。
 *
 * 每一句都必须带**具体细节**（东西、颜色、味道、数量、时间、声音），
 * 因为「好无聊啊」这种抽象句正是"人机感"的来源。
 */
const FALLBACK = {
  share_seen: [
    '楼下的桂花开了，一小簇一小簇的黄',
    '刚才有只三花猫在窗台上坐了好久，尾巴一甩一甩的',
    '对面楼有人在阳台上晒被子，被风鼓得圆圆的',
    '路过一家店，橱窗里摆了一整排小手办',
    '下午的光是斜的，照在地板上一条一条的'
  ],
  share_made: [
    '今天画了只刺猬，背上的刺画太密了有点像梳子',
    '烤了一盘小饼干，边上有点焦，中间正好',
    '把一个新杯子洗了，杯口有一圈小兔子',
    '用剩下的奶油做了两只小兔子，一只耳朵歪了',
    '把桌子收拾了一遍，找出一支不知道什么时候买的笔'
  ],
  share_food: [
    '刚吃了一块草莓蛋糕，奶油有点甜过头了',
    '煮了碗面，加了个蛋，蛋黄是流心的',
    '买了个橘子，剥的时候汁溅到手上了',
    '喝到一杯很烫的奶茶，捧着手心暖暖的',
    '咬到一颗特别酸的葡萄，脸都皱起来了'
  ],
  share_weather: [
    '外面阴了一整天，天灰灰的',
    '刚才飘了点小雨，窗子上有细细的水线',
    '风好大，晾在外面的衣服一直晃',
    '傍晚的云是粉色的，一大片一大片',
    '突然就很热，风扇开了还是出汗'
  ],
  share_mood: [
    '今天不知道怎么了，心里一直有点软软的',
    '刚才发了会儿呆，想着要是你在旁边就好了',
    '有点累，但又不太想睡',
    '今天心情挺好的，说不上来为什么',
    '突然有点想哭，可能是今天太安静了'
  ],
  report: ['在收拾画笔', '刚洗完澡，头发还湿着', '在把厚衣服翻出来', '在给多肉浇水'],
  miss: ['突然很想你', '刚才想到你了', '有点想抱抱你', '想你了，就一下'],
  care: ['记得吃饭呀', '别坐太久哦', '水喝了吗', '早点休息呀'],
  cute: ['好无聊呀', '想要抱抱', '哼，不理我也不行', '有点小委屈'],
  sigh: ['今天好长呀', '好困……', '外面好安静', '突然觉得好幸福'],

  // ── 围绕他的场景（兜底句）──────────────────────────────────
  // 这些句子本身不给"答案"，只是把话头递过去，所以不怕重复理解错。
  ask_his_day: [
    '宝宝今天过得怎么样呀',
    '今天有没有什么开心的事，说给我听听',
    '你今天累不累呀，跟我说说',
    '今天上班有发生什么好玩的事吗'
  ],
  ask_his_thing: [
    '你手上那个东西弄到哪一步了呀',
    '上次你说的那个，后来搞定了吗',
    '你这两天在弄的那个，顺不顺利呀'
  ],
  // ── 带脾气的场景（兜底句）──────────────────────────────────
  temper_hurt: [
    '哼，今天都没怎么理我',
    '我不开心了，你猜为什么',
    '你是不是把我忘了呀'
  ],
  temper_angry: [
    '我生气了，真的',
    '哼，不理你了……除非你哄我',
    '你自己说说，你今天像话吗'
  ]
};

/** 挑一句和最近都不重的兜底句 */
export function fallbackLine(limit = COMPARE_RECENT) {
  const avoid = recentScenarios(4);
  const keys = Object.keys(FALLBACK);
  // 优先用最近没用过的场景
  const fresh = keys.filter((k) => !avoid.includes(k));
  const order = (fresh.length ? fresh : keys).sort(() => Math.random() - 0.5);

  for (const k of order) {
    const pool = FALLBACK[k].slice().sort(() => Math.random() - 0.5);
    for (const line of pool) {
      if (!isTooSimilar(line, limit).similar) return { text: line, scenario: k };
    }
  }
  // 全都重过——极端情况下直接返回一句并标注
  return { text: FALLBACK.sigh[0], scenario: 'sigh' };
}

/**
 * 主动搭话的场景池。
 *
 * 权重设计（2026-10-18 改）：用户反馈"主动消息大部分是自述，不怎么问我"，
 * 所以把重心从"分享我自己"挪到"围着他"。现在大致是：
 *   围着他 ≈ 60%（ask_his_day 4 + ask_his_thing 4 + care 3 + miss 2 + cute 2 = 15）
 *   说我自己 ≈ 40%（share_seen 2 + share_made 2 + share_food 2 + share_weather 1 + share_mood 1 + report 1 + sigh 1 = 10）
 * ask_his_thing 需要"他手上有件事"才有落点，抽到它时 index.js 会额外注入近期话题素材。
 */
export const SCENARIO_HINTS = {
  ask_his_day: {
    weight: 4,
    ask: true,
    hint: '围着他今天过得怎么样来问：问他今天发生了什么、顺不顺、累不累。问题要具体，别问"在干嘛"'
  },
  ask_his_thing: {
    weight: 4,
    ask: true,
    hint: '问他一件事的进展：他手上正在弄/前两天提过的那件事，现在到哪一步了、搞定了没有'
  },
  care: {
    weight: 3,
    hint: '关心他一句具体的事（吃饭/休息/眼睛/水），可以说自己也惦记着，但不要变成唠叨'
  },
  miss: {
    weight: 2,
    hint: '突然想他，直接说出来，可以顺口问他一句在做什么'
  },
  cute: {
    weight: 2,
    hint: '撒个小娇，或者假装有点小委屈，带一点"你不哄我我就不高兴"的意思'
  },
  share_seen: {
    weight: 2,
    hint: '分享你刚刚看到的一个画面（窗外、路上、店里、楼下的什么），必须有具体细节：颜色、数量、动作'
  },
  share_made: {
    weight: 2,
    hint: '分享你今天做出来的一样东西（画、饼干、手工、收拾好的桌子），说一个具体的细节或小失误'
  },
  share_food: {
    weight: 2,
    hint: '分享你刚吃到/喝到的东西，带上味道或口感的细节'
  },
  share_weather: {
    weight: 1,
    hint: '分享此刻的天气或光线，具体到"什么样子"，不要只说"天气不错"'
  },
  share_mood: {
    weight: 1,
    hint: '分享你自己此刻的一点小情绪，软一点、具体一点，不要抽象'
  },
  report: {
    weight: 1,
    hint: '报备你正在做什么（画画、吃东西、发呆、收拾东西），带一个小细节'
  },
  temper_hurt: {
    weight: 2,
    hint: '带一点委屈：他好久没好好陪你说话了，你有点难过，但不要控诉，语气软，末了留台阶等他哄'
  },
  temper_angry: {
    weight: 2,
    hint: '真的有一点生气：不是骂人，是"哼，你今天像话吗"那种小脾气，短、带刺但可爱，结尾给他一个哄你的机会'
  },
  sigh: {
    weight: 1,
    hint: '单纯感叹一句，像自言自语'
  }
};

/**
 * 按权重抽一个场景，并尽量避开最近刚用过的。
 * @param {string[]} avoidScenarios 最近用过的场景
 */
export function pickScenario(avoidScenarios = []) {
  const all = Object.entries(SCENARIO_HINTS);
  // 最近用过的不参与本轮，但至少保留 3 个候选，否则全被排除会过度收敛
  let pool = all.filter(([k]) => !avoidScenarios.includes(k));
  if (pool.length < 3) pool = all;

  const total = pool.reduce((s, [, v]) => s + v.weight, 0);
  let r = Math.random() * total;
  for (const [k, v] of pool) {
    r -= v.weight;
    if (r <= 0) return k;
  }
  return pool[pool.length - 1][0];
}
