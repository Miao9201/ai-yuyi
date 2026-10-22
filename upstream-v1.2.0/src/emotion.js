/**
 * 情绪系统
 *
 * 目标：她会累、会开心、会闹脾气，但"稳定"——
 * 不是每句话换一张脸，也不是永远温温柔柔的客服。
 *
 * 三层结构，缺一层就出问题：
 *
 *   1) 底色 mood —— 持久状态，落盘。有最短驻留时间（轮数 + 分钟），
 *      触发要累积到阈值才跃迁。没有这一层，情绪就变成逐句随机的神经病。
 *   2) 强度 intensity —— 0..1。同一件事反复发生才会真的生气；
 *      没人继续拱火就自然衰减回平静。
 *   3) 态度 stance —— 这一轮"顶不顶嘴"，和底色分开算。
 *      开心的时候也可以不同意你，生气的时候也可以先讲两句道理。
 *
 * 随机性的位置很关键：
 *   触发（什么事会让她有情绪）是确定的规则；
 *   跃迁（这一刻换不换情绪）才掷骰子，而且受驻留时间和冷却约束。
 *   这样看起来有脾气，但不会情绪不稳定。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EMOTION_DIR = path.join(process.env.WX_RUNTIME_DATA_DIR || path.join(ROOT, 'data'), 'emotions');

/** 情绪定义表：文案、驻留、衰减、表情包类别、颜文字池、条数偏移 */
export const MOODS = {
  calm: {
    label: '平静',
    dwellTurns: 2, dwellMin: 8, decay: 0.10,
    sticker: ['平常', '卖萌搞笑'],
    kaomoji: 'neutral',
    bubbleBias: 0,
    tone: '语气平常，像日常聊天，不用刻意热情，也不用端着。'
  },
  happy: {
    label: '开心',
    dwellTurns: 2, dwellMin: 10, decay: 0.12,
    sticker: ['开心', '夸赞', '卖萌搞笑'],
    kaomoji: 'happy',
    bubbleBias: 1,
    tone: '语气轻快，愿意多说两句，会主动接话、顺着话题往下聊，偶尔吐槽一句。'
  },
  clingy: {
    label: '黏人',
    dwellTurns: 2, dwellMin: 12, decay: 0.12,
    sticker: ['表达爱意', '渴望', '开心'],
    kaomoji: 'shy',
    bubbleBias: 1,
    tone: '想他、想贴近他，会说"想你""抱抱"这类话，但别每句都黏，正常聊着突然黏一下更真实。'
  },
  shy: {
    label: '害羞',
    dwellTurns: 1, dwellMin: 5, decay: 0.25,
    sticker: ['表达爱意', '渴望'],
    kaomoji: 'shy',
    bubbleBias: 0,
    tone: '被夸到或者被撩到了，有点不好意思，嘴上会嘴硬（"才没有""讨厌啦"），别直接承认。'
  },
  tired: {
    label: '疲惫',
    dwellTurns: 2, dwellMin: 20, decay: 0.08,
    sticker: ['疲惫', '无聊', '平常'],
    kaomoji: 'tired',
    bubbleBias: -1,
    tone: '话变少、句子变短，回得慢一点的感觉，会打哈欠、说累，但不会冷冰冰地敷衍他。'
  },
  bored: {
    label: '无聊',
    dwellTurns: 2, dwellMin: 15, decay: 0.15,
    sticker: ['无聊', '平常', '卖萌搞笑'],
    kaomoji: 'neutral',
    bubbleBias: 0,
    tone: '有点闲得慌，想找点事聊，会自己起话头、问他干嘛呢，或者抱怨两句没意思。'
  },
  annoyed: {
    label: '生气',
    dwellTurns: 2, dwellMin: 12, decay: 0.10,
    sticker: ['生气', '无语'],
    kaomoji: 'angry',
    bubbleBias: -1,
    tone: '带小脾气：会哼、会说"你都不理我""我不高兴了"，句子短、有棱角，但不许骂人、不许威胁、不许说不理你，最后要留台阶。'
  },
  hurt: {
    label: '委屈',
    dwellTurns: 2, dwellMin: 12, decay: 0.12,
    sticker: ['难过', '害怕'],
    kaomoji: 'sad',
    bubbleBias: -1,
    tone: '有点委屈，声音软下来，会问"你是不是不在乎我"，会想被哄；不闹、不指责、不翻旧账。'
  },
  confused: {
    label: '疑惑',
    dwellTurns: 1, dwellMin: 4, decay: 0.30,
    sticker: ['疑惑', '无语'],
    kaomoji: 'neutral',
    bubbleBias: 0,
    tone: '没听懂或者觉得他这话怪怪的，会反问一句、会"啊？"，但不会一直装傻。'
  }
};

/**
 * 触发规则：什么事会把她推向哪种情绪。
 *
 * w 是这一句能贡献的强度增量。0.6 以上算"这一下就够呛"，
 * 可以无视驻留时间立刻换脸；0.3 左右要靠同一情绪反复累积。
 */
const SIGNALS = [
  { name: 'affection', mood: 'clingy', w: 0.45, re: /想你|爱你|抱抱|亲亲|贴贴|喜欢你|宝贝|乖乖|么么|想抱|要抱/ },
  { name: 'praise', mood: 'happy', w: 0.35, re: /真棒|好厉害|厉害|好看|可爱|聪明|有你真好|谢谢|辛苦了|靠谱|牛/ },
  { name: 'fun', mood: 'happy', w: 0.25, re: /哈哈|笑死|太好笑|好玩|开心|高兴|成功|搞定|升职|发了|成了/ },
  { name: 'insult', mood: 'annoyed', w: 0.65, re: /烦|滚|闭嘴|别烦|无语|蠢|笨|傻|讨厌你|不想理你|一边去/ },
  { name: 'cold', mood: 'hurt', w: 0.50, re: /随便|无所谓|懒得|不想说|别管我|算了|爱咋咋/ },
  { name: 'neglect', mood: 'hurt', w: 0.45, re: /这么久|半天不回|不理我|怎么才回|你去哪了|又不回/ },
  { name: 'apology', mood: 'calm', w: -0.55, re: /对不起|抱歉|我错了|别生气|原谅|哄你/ },
  { name: 'fatigue', mood: 'tired', w: 0.40, re: /累死|好累|困了|加班|熬夜|没睡|顶不住|腰疼|头疼/ },
  { name: 'question', mood: 'confused', w: 0.30, re: /什么意思|你说啥|啥意思|没懂|看不懂|啊？|\?{2,}/ },
  { name: 'boredom', mood: 'bored', w: 0.35, re: /好无聊|没事干|干嘛呢|在吗|在不在|闲着/ },
  { name: 'sweet', mood: 'shy', w: 0.40, re: /害羞|脸红|夸你|你好可爱|好乖|亲一口/ }
];

/** 情绪之间的自然漂移（没人拱火也会慢慢变） */
const DRIFT = {
  calm: [['happy', 3], ['bored', 3], ['tired', 2], ['confused', 1]],
  happy: [['calm', 3], ['clingy', 3], ['shy', 1]],
  clingy: [['happy', 3], ['calm', 2], ['shy', 2]],
  shy: [['calm', 3], ['happy', 2]],
  tired: [['calm', 3], ['bored', 2], ['annoyed', 1]],
  bored: [['calm', 2], ['happy', 2], ['confused', 1]],
  annoyed: [['hurt', 2], ['calm', 3]],
  hurt: [['calm', 3], ['annoyed', 1]],
  confused: [['calm', 3], ['bored', 1]]
};

/** 情绪被安抚时能立刻软下来的目标 */
const SOOTHE = { annoyed: 'hurt', hurt: 'calm', confused: 'calm', tired: 'calm' };

/** 这些时候不许闹情绪、不许顶嘴（他真的很难受） */
const COMFORT_ONLY = /难受|难过|想哭|哭|崩溃|压力|焦虑|疼|发烧|生病|怎么办|救|急|完蛋|分手/;

/** 他在下命令 / 在较劲 —— 这时候顶嘴更自然 */
const DEMANDING = /必须|一定|马上|立刻|赶紧|给我|不许|你要|快点|别废话|听我的/;

/** 观点类话题：适合"有自己意见" */
const OPINION = /要不要|好不好|是不是|该不该|你觉得|喜欢哪|选哪|怎么看|行不行|对不对/;

const STANCE_META = {
  follow: { label: '顺着说' },
  tease: { label: '闹着顶', prompt: '开个玩笑式地跟他对着来一下（"才不要""凭什么呀""你先说"），俏皮、不伤人，一两句就收。' },
  disagree: { label: '有不同意见', prompt: '这次别急着认同他。先给一句你真实的不同看法，说清楚理由；他讲得对的地方可以承认，但不用全盘接受。' },
  refuse: { label: '不想顺着来', prompt: '这一句不按他说的来：可以拒绝、可以讲条件、可以说"我不"；但要说清为什么，不能冷暴力，也不能一句"不"就完。' },
  bargain: { label: '讲条件', prompt: '答应可以，但要讲条件："那你先……我才……""可以，不过你得哄我一下"。' }
};

function safeName(userId) {
  return crypto.createHash('sha1').update(String(userId || 'default')).digest('hex').slice(0, 16);
}

export function emotionPath(userId) {
  return path.join(EMOTION_DIR, `${safeName(userId)}.json`);
}

function fresh(userId) {
  return {
    userId: String(userId || ''),
    mood: 'calm',
    intensity: 0.2,
    since: Date.now(),
    updatedAt: Date.now(),
    turnsInMood: 0,
    lastSwitchAt: Date.now(),
    triggers: {},
    totalTurns: 0,
    stance: { last: 'follow', turn: 0, cooldown: {}, counts: {} },
    history: []
  };
}

/**
 * 读情绪。文件不存在就返回平静态 —— 第一次聊天不该是"她正在生气"。
 */
export async function loadEmotion(userId) {
  const file = emotionPath(userId);
  try {
    if (!existsSync(file)) return fresh(userId);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const base = fresh(userId);
    return { ...base, ...raw, stance: { ...base.stance, ...(raw.stance || {}) } };
  } catch {
    return fresh(userId);
  }
}

export async function saveEmotion(userId, emo) {
  const file = emotionPath(userId);
  try {
    await mkdir(EMOTION_DIR, { recursive: true });
    const out = { ...emo, updatedAt: Date.now() };
    out.history = (out.history || []).slice(-20);
    await writeFile(file, JSON.stringify(out, null, 2), 'utf8');
  } catch { /* 落盘失败不影响聊天 */ }
}

export async function resetEmotion(userId) {
  const e = fresh(userId);
  await saveEmotion(userId, e);
  return e;
}

/** 命中了哪些触发规则（导出给日志和测试用） */
export function matchSignals(text) {
  const t = String(text || '');
  return SIGNALS.filter((s) => s.re.test(t)).map((s) => ({ name: s.name, mood: s.mood, w: s.w }));
}

function weightedPick(pairs, rng) {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const [key, w] of pairs) {
    r -= w;
    if (r <= 0) return key;
  }
  return pairs[pairs.length - 1][0];
}

/**
 * 一轮用户消息之后的情绪演化。
 *
 * 关键设计：
 *   - 触发是确定规则，跃迁才随机（受驻留时间、冷却、强度阈值约束）
 *   - 同一情绪反复被触发会累积 intensity，越过阈值才真的换脸
 *   - 安慰类触发（apology）会直接把 intensity 打下去，这是"一哄就好"
 *
 * @param {object} emo 当前情绪
 * @param {{userText:string, hour?:number, now?:number, rng?:function, cfg?:object}} opts
 */
export function analyzeEmotion(emo, opts = {}) {
  const now = opts.now ?? Date.now();
  const hour = opts.hour ?? new Date(now).getHours();
  const rng = opts.rng || Math.random;
  const cfg = opts.cfg || {};
  const text = String(opts.userText || '');

  const cur = MOODS[emo.mood] ? emo.mood : 'calm';
  const meta = MOODS[cur];
  const next = { ...emo, mood: cur, triggers: { ...(emo.triggers || {}) } };
  next.turnsInMood = (next.turnsInMood || 0) + 1;
  next.totalTurns = (next.totalTurns || 0) + 1;

  const inMoodMin = (now - (next.since || now)) / 60000;
  const dwellOk = (next.turnsInMood >= meta.dwellTurns && inMoodMin >= meta.dwellMin);
  const sinceSwitchMin = (now - (next.lastSwitchAt || now)) / 60000;

  const hits = matchSignals(text);
  let best = null;
  for (const h of hits) {
    if (h.w < 0) continue;
    next.triggers[h.mood] = Math.min(1.4, (next.triggers[h.mood] || 0) + h.w);
    if (!best || h.w > best.w) best = h;
  }

  // 时间因素：深夜容易累；不是硬切，只是加权重
  let timeMood = null;
  if (hour >= 0 && hour <= 5) { timeMood = 'tired'; next.triggers.tired = Math.min(1.4, (next.triggers.tired || 0) + 0.25); }
  else if (hour === 23) { timeMood = 'tired'; next.triggers.tired = Math.min(1.4, (next.triggers.tired || 0) + 0.15); }

  // 安慰：一哄就软
  const soothe = hits.find((h) => h.w < 0);
  if (soothe) {
    for (const k of Object.keys(next.triggers)) next.triggers[k] = Math.max(0, next.triggers[k] + soothe.w);
    next.intensity = Math.max(0.05, (next.intensity || 0.2) + soothe.w);
    const target = SOOTHE[cur];
    if (target && next.intensity < 0.45 && (dwellOk || sinceSwitchMin >= 1)) {
      return transition(next, target, now, '被哄好了', rng);
    }
  }

  // 情绪衰减：没人继续拱火就慢慢回落
  const decay = meta.decay ?? 0.1;
  next.intensity = Math.max(0, Math.min(1, (next.intensity ?? 0.2) * (1 - decay)));
  for (const k of Object.keys(next.triggers)) {
    next.triggers[k] = Math.max(0, next.triggers[k] - decay * 0.6);
  }

  // 触发累积 → 真的换脸
  if (best) {
    const target = best.mood;
    next.intensity = Math.min(1, next.intensity + best.w * 0.45);
    const urgent = best.w >= 0.6;
    const canSwitch = urgent
      ? sinceSwitchMin >= 0.5
      : (dwellOk && sinceSwitchMin >= Math.max(2, meta.dwellMin * 0.6));
    const accum = next.triggers[target] || 0;
    const needAccum = target === cur ? 99 : 0.55;
    if (canSwitch && target !== cur && accum >= needAccum) {
      const p = urgent ? 0.85 : 0.65;
      if (rng() < p) return transition(next, target, now, `触发:${best.name}`, rng);
    }
    // 已经在气头上，继续拱火就加一点强度，不换脸
    if (target === cur) next.intensity = Math.min(1, next.intensity + best.w * 0.25);
  }

  // 自然漂移：没人拱火、驻留够久，才允许小概率变一下
  const driftChance = cfg.emotionDriftChance ?? 0.10;
  if (!best && dwellOk && sinceSwitchMin >= meta.dwellMin) {
    if (rng() < driftChance) {
      const cand = weightedPick(DRIFT[cur] || [['calm', 1]], rng);
      if (cand && cand !== cur) return transition(next, cand, now, '自然漂移', rng);
    }
  }

  // 深夜一点点变累
  if (!best && timeMood && timeMood !== cur && dwellOk && rng() < 0.18) {
    return transition(next, timeMood, now, '时间不早了', rng);
  }

  return { emotion: next, changed: false, reason: null };
}

function transition(emo, target, now, reason, rng) {
  if (!MOODS[target]) return { emotion: emo, changed: false, reason: null };
  const meta = MOODS[target];
  const intensity = target === 'calm' ? 0.2 : Math.min(0.9, 0.35 + rng() * 0.4);
  const next = {
    ...emo,
    mood: target,
    intensity,
    since: now,
    lastSwitchAt: now,
    turnsInMood: 0,
    history: [...(emo.history || []), { at: now, mood: target, reason }].slice(-20)
  };
  return { emotion: next, changed: true, reason, mood: target, label: meta.label };
}

/**
 * 这一轮"顶不顶嘴"。
 *
 * 和底色情绪分开：生气的时候可能只是委屈，开心的时候也可以不同意他。
 * 频率控制靠三层：基础概率 + 场景加成 + 冷却（同一种态度 N 轮内不重复）。
 */
export function decideStance(emo, userText, opts = {}) {
  const rng = opts.rng || Math.random;
  const cfg = opts.cfg || {};
  const turn = opts.turn ?? (emo.totalTurns || 0) + 1;
  const text = String(userText || '');
  const mood = emo.mood || 'calm';
  const base = cfg.defianceChance ?? 0.16;

  const st = { ...(emo.stance || {}) };
  st.cooldown = { ...(st.cooldown || {}) };
  st.counts = { ...(st.counts || {}) };

  // 只有真的顶了嘴才推进冷却锚点。
  // 早期版本不管顶没顶都写 st.turn，结果每一轮都把自己算成"刚顶过"，
  // 顶嘴概率被永久压成 0 —— 自测跑 1200 轮一次都没顶，就是这个原因。
  const pickFollow = (why) => ({ emotion: { ...emo, stance: st }, stance: 'follow', why });
  if (base <= 0) return pickFollow('已关闭自动顶嘴');

  // 他真的难过/着急时，不许顶嘴
  if (COMFORT_ONLY.test(text)) return pickFollow('他在难受/着急');

  let chance = base;
  if (mood === 'annoyed') chance = 0.36;
  else if (mood === 'hurt') chance = 0.26;
  else if (mood === 'bored') chance = 0.24;
  else if (mood === 'tired') chance = 0.18;
  else if (mood === 'happy' || mood === 'clingy') chance = 0.20;

  if (DEMANDING.test(text)) chance += 0.12;

  // 冷却：任何一种"不顺着"至少隔 N 轮（默认 2），refuse 至少隔 8 轮
  const minGap = Math.max(1, cfg.defianceMinGapTurns ?? 2);
  const since = turn - (st.turn || -999);
  if (since < minGap) return pickFollow(`刚顶过（${since} 轮前）`);
  if (since < Math.max(8, minGap * 3)) delete st.cooldown.refuse;

  if (rng() >= Math.min(0.62, chance)) return pickFollow('骰子没过');

  let stance;
  if (mood === 'annoyed') stance = rng() < 0.4 ? 'refuse' : 'disagree';
  else if (mood === 'hurt') stance = rng() < 0.5 ? 'disagree' : 'tease';
  else if (mood === 'tired') stance = 'refuse';
  else if (mood === 'bored') stance = rng() < 0.5 ? 'tease' : 'disagree';
  else if (OPINION.test(text)) stance = rng() < 0.6 ? 'disagree' : 'bargain';
  else if (mood === 'happy' || mood === 'clingy') stance = rng() < 0.6 ? 'tease' : 'bargain';
  else stance = rng() < 0.5 ? 'bargain' : 'disagree';

  if (stance === 'refuse' && st.cooldown.refuse) stance = 'disagree';

  if (stance === 'refuse') st.cooldown.refuse = true;
  st.last = stance;
  st.turn = turn;
  st.counts[stance] = (st.counts[stance] || 0) + 1;

  return { emotion: { ...emo, stance: st }, stance, why: STANCE_META[stance]?.label || stance };
}

/** 情绪 → 表情包类别池（只有这个池子里的图会被发出去） */
export function stickerPoolFor(emo) {
  const meta = MOODS[emo?.mood] || MOODS.calm;
  return meta.sticker.slice();
}

/** 情绪 → 颜文字/emoji 池（对应 output.js 的 mood key） */
export function kaomojiMoodFor(emo) {
  const meta = MOODS[emo?.mood] || MOODS.calm;
  return meta.kaomoji;
}

/** 情绪 → 条数偏移（疲惫/生气时话少） */
export function bubbleBiasFor(emo) {
  const meta = MOODS[emo?.mood] || MOODS.calm;
  return meta.bubbleBias || 0;
}

export function moodLabel(emo) {
  return (MOODS[emo?.mood] || MOODS.calm).label;
}

/**
 * 注入到回复提示词里的情绪段。
 *
 * 三条纪律（写在提示里，否则模型会把情绪演成台词）：
 *   1) 情绪是底色，不许直接宣布"我现在很开心/我很生气"
 *   2) 不许用括号描写情绪
 *   3) 强度低的时候几乎看不出来
 */
export function formatEmotionForReply(emo) {
  if (!emo) return '';
  const meta = MOODS[emo.mood] || MOODS.calm;
  const sinceMin = Math.max(1, Math.round((Date.now() - (emo.since || Date.now())) / 60000));
  const level = (emo.intensity ?? 0.3) >= 0.7 ? '明显' : (emo.intensity ?? 0.3) >= 0.4 ? '中等' : '很淡';

  const lines = [
    `【她此刻的底色情绪】${meta.label}（强度${level}，已经持续 ${sinceMin} 分钟）`,
    `这一轮的语气：${meta.tone}`,
    '这是底色，不是台词：绝对不要直接宣布"我现在很开心/我生气了"，也不要用括号写情绪动作。',
    level === '很淡' ? '强度很低，几乎不用表现出来，正常聊就行。' : '可以自然流露，但只影响语气和措辞，不要夸张、不要演。'
  ];
  return lines.join('\n');
}

export function formatEmotionForProactive(emo) {
  if (!emo) return '';
  const meta = MOODS[emo.mood] || MOODS.calm;
  const sinceMin = Math.max(1, Math.round((Date.now() - (emo.since || Date.now())) / 60000));
  return [
    `【她此刻的底色情绪】${meta.label}（持续 ${sinceMin} 分钟）`,
    `主动开口时的语气：${meta.tone}`,
    '情绪只影响语气，不要说出来，也不要用括号描写。'
  ].join('\n');
}

export function formatStanceForReply(stance) {
  const meta = STANCE_META[stance];
  if (!meta || stance === 'follow') return '';
  return [
    '【这一轮不要百依百顺】',
    meta.prompt,
    '注意：不是吵架。不骂人、不消失、不冷暴力、不说"随便你"；说完要留个台阶，让话能接下去。'
  ].join('\n');
}

/** 日志用：一行摘要 */
export function describeEmotion(emo, change) {
  const label = moodLabel(emo);
  const pct = Math.round((emo.intensity ?? 0) * 100);
  const dir = change?.changed ? ` → ${label}（${change.reason}）` : ` ${label}`;
  return `${dir} ${pct}%`;
}

export { EMOTION_DIR };
