/**
 * autoimage.js —— 语境自发生图
 *
 * 目的：让她像一个真人那样「顺手把图给你看」，而不是等你下命令。
 * 真人发图的三种动机（本模块按这三类建模）：
 *   1. 生活照  —— 「我到家了」顺手拍一张窗外 / 桌上那杯咖啡
 *   2. 手绘涂鸦 —— 「我画了个小猫，给你看看」
 *   3. 情绪表情 —— 生气了画一个气鼓鼓的自己，「哼」
 *
 * 频率是硬约束，不是全随机：
 *   轮次闸门（minGapTurns）+ 小时/天上限（autoImageMax*）+ 情绪权重 + 语境触发加权。
 * 三层叠起来的效果是「平均十几轮来一次，生气或聊到具体东西时更可能来」，
 * 而不是「有时候连着三条都在发图」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BUDGET_PATH = path.join(ROOT, 'data', 'autoimage-budget.json');

/* ────────────────────────── 情绪权重 ────────────────────────── */
//
// 生气/委屈时最容易「甩一张图表达情绪」，疲惫/疑惑时基本不会。
// 这不是随机——情绪状态机已经把「什么时候会累、会生气」管住了，这里只做放大。
const MOOD_WEIGHT = {
  calm: 0.8,
  happy: 1.2,
  clingy: 1.35,
  shy: 0.9,
  tired: 0.25,
  bored: 1.0,
  annoyed: 1.7,
  hurt: 1.45,
  confused: 0.2
};

/* ────────────────────────── 语境触发词 ────────────────────────── */
//
// 他说到这些词，说明话题里有具体的东西可以「给你看」。
// 命中加权而不是必发 —— 必发会显得像关键词机器人。
const CONTEXT_HINTS = [
  { re: /到家|回家|在路上了|下班吗|出门/, subject: '推开门的玄关，暖黄的灯，地上一双拖鞋', kind: 'photo' },
  { re: /吃饭|饿了|好吃|夜宵|早饭|午饭|晚饭|咖啡|奶茶|零食/, subject: '桌上摆着一份刚做好的饭，旁边半杯饮料', kind: 'photo' },
  { re: /猫|小猫|橘猫|狗|小狗|宠物/, subject: '一只软乎乎的小猫趴在毛毯上，抬头看镜头', kind: 'photo' },
  { re: /花|玫瑰|樱花|多肉|草|树|叶/, subject: '窗台上的一盆小花，叶子被阳光照亮', kind: 'photo' },
  { re: /雨|下雨|雪|下雪|阴天|乌云/, subject: '雨滴贴在窗玻璃上，外面街道模糊成一片光', kind: 'photo' },
  { re: /晚霞|日落|夕阳|傍晚|天空|月亮|星星|夜里/, subject: '傍晚的天空，橘粉色的云铺满一大片', kind: 'photo' },
  { re: /上班|加班|下班|工作|工位|会议|开会/, subject: '乱糟糟的桌子，摊开的笔记本和冷掉的咖啡', kind: 'photo' },
  { re: /画|涂鸦|涂|画图|画的|手绘|临摹/, subject: '一张手绘的小画，纸边有点卷，颜色涂到线外面', kind: 'draw' },
  { re: /累|困|睡|熬夜|失眠/, subject: '埋进被子里的自己，只露出一点头发', kind: 'photo' }
];

/* ────────────────────────── 主体池 ────────────────────────── */

// 情绪表情：生气/委屈时「画一个自己」
const EXPRESSION_SUBJECTS = {
  annoyed: [
    '一只气鼓鼓的卡通小女孩抱臂背对镜头，脸颊圆鼓鼓，头顶冒小烟',
    '卡通女孩鼓着脸皱眉，手里攥着一个小拳头，背景是暗紫色',
    '卡通女孩缩成一团背过身去，头顶画着几根竖线，明摆着不高兴'
  ],
  hurt: [
    '卡通女孩蹲在角落，眼圈红红，抱着一只小抱枕',
    '卡通女孩眼角挂着一滴泪，嘴巴抿着，样子委屈巴巴',
    '卡通小女孩缩在被子里只露出眼睛，眼神湿漉漉的'
  ],
  tired: [
    '卡通女孩趴在桌上，脸贴在桌面，眼睛闭成一条线',
    '卡通女孩抱着枕头打哈欠，头发乱糟糟的'
  ]
};

// 手绘涂鸦：她「刚画的」那只小猫/小房子
const DRAW_SUBJECTS = [
  '一张蜡笔手绘的小猫，线条歪歪扭扭，颜色涂到了线外面',
  '一张手绘的小房子，屋顶画歪了，烟囱冒着歪歪的烟',
  '一张手绘的小女孩头像，旁边写着几个歪字',
  '一张铅笔草的窗景，几笔就画完了，纸上有擦过的痕迹'
];

// 生活照：她「随手拍」手边的东西
const DAILY_SUBJECTS = [
  '窗台上的杯子，热气还没散，外面天已经暗了',
  '台灯下摊开的书和一支笔，光线暖黄',
  '桌角一小碟水果，旁边手机亮着',
  '阳台上晾着的衣服，风把衣角吹起来',
  '一只拖鞋歪在床边，被子掀开一角',
  '厨房台面上一碗刚煮好的面，还冒着热气'
];

/* ────────────────────────── 配文池 ────────────────────────── */
//
// 配文要像人随手发的，不要解释「我画了一张图」这种机器口吻。
const CAPTION_POOL = {
  expression: ['哼', '不理你了', '自己看', '……', '你看我这个样子', '气死我了'],
  draw: ['给你看我刚画的', '画了半天，勉强看吧', '喏，我画的', '手笨，别嫌弃', '画好啦'],
  photo: ['喏，我这边', '给你看看', '刚拍的', '你看这个', '随手拍的，糊了别嫌弃', '我这边挺好的']
};

function pick(arr, rng = Math.random) {
  if (!arr.length) return '';
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/* ────────────────────────── 预算 ────────────────────────── */

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
    /* 预算文件写不进去也不能影响聊天 */
  }
}

/**
 * 自发图预算（比用户点播的预算更紧）。
 * 点播是他要的，可以每小时 5 张；自发是她自己想发，每小时 1 张就够，否则刷屏。
 */
export function checkAutoBudget(cfg = {}) {
  const perHour = Math.max(0, Number(cfg.autoImageMaxPerHour ?? 1));
  const perDay = Math.max(0, Number(cfg.autoImageMaxPerDay ?? 4));
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
  if (perHour <= 0) return { allowed: false, reason: 'disabled', hourCount: b.hourCount, dayCount: b.dayCount };
  if (b.hourCount >= perHour) return { allowed: false, reason: 'hour', hourCount: b.hourCount, dayCount: b.dayCount };
  if (b.dayCount >= perDay) return { allowed: false, reason: 'day', hourCount: b.hourCount, dayCount: b.dayCount };
  return { allowed: true, hourCount: b.hourCount, dayCount: b.dayCount };
}

export function recordAutoImage() {
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

/* ────────────────────────── 决策 ────────────────────────── */

/**
 * 这一轮要不要自己发一张图？
 *
 * @param {object} p
 * @param {string} p.mood        当前情绪底色（emotion.js 的 mood）
 * @param {string} p.stance      这一轮的态度（follow/tease/disagree/refuse/bargain）
 * @param {string} p.userText    他刚说的话
 * @param {string} p.replyText   她准备回的话
 * @param {number} p.gapTurns    距离上一次自发图隔了几轮
 * @param {boolean} p.canDraw    预算是否允许
 * @param {number} [p.chance]    覆盖基础概率（主动消息用更低的）
 * @param {Function} [p.rng]
 * @returns {{kind:'expression'|'draw'|'photo', subject:string, caption:string, reason:string}|null}
 */
export function decideAutoImage({
  cfg = {},
  mood = 'calm',
  stance = 'follow',
  userText = '',
  replyText = '',
  gapTurns = 999,
  canDraw = true,
  chance = null,
  rng = Math.random
} = {}) {
  if (cfg.autoImageEnabled === false) return null;
  if (!canDraw) return null;

  const minGap = Math.max(1, Number(cfg.autoImageMinGapTurns ?? 8));
  if (gapTurns < minGap) return null;

  // 基础概率 × 情绪权重 × 语境加权
  let p = Number(chance ?? cfg.autoImageChance ?? 0.08);
  const moodW = MOOD_WEIGHT[mood] ?? 1;
  p *= moodW;

  const hay = `${userText} ${replyText}`;
  const hit = CONTEXT_HINTS.find((h) => h.re.test(hay));
  if (hit) p *= 1.8;

  // 顶嘴/不同意的那一轮，顺手甩图的概率略高（人真的会这么干）
  if (stance === 'tease' || stance === 'refuse') p *= 1.15;

  // 上限压到 0.35：再高就会显得她只在发图
  p = Math.min(0.35, Math.max(0, p));
  if (rng() >= p) return null;

  // 决定类别：情绪重 → 表情图；聊到具体东西/画画 → 对应类别；否则日常照
  let kind;
  if (mood === 'annoyed' || mood === 'hurt') kind = 'expression';
  else if (mood === 'tired') kind = rng() < 0.6 ? 'expression' : 'photo';
  else if (hit && hit.kind === 'draw') kind = 'draw';
  else if (hit) kind = 'photo';
  else kind = rng() < 0.35 ? 'draw' : 'photo';

  let subject;
  if (kind === 'expression') {
    const pool = EXPRESSION_SUBJECTS[mood] || EXPRESSION_SUBJECTS.annoyed;
    subject = pick(pool, rng);
  } else if (kind === 'draw') {
    subject = hit && hit.kind === 'draw' ? hit.subject : pick(DRAW_SUBJECTS, rng);
  } else {
    subject = hit && hit.kind !== 'draw' ? hit.subject : pick(DAILY_SUBJECTS, rng);
  }

  const caption = pick(CAPTION_POOL[kind], rng);
  return {
    kind,
    subject,
    caption,
    reason: `${mood}${hit ? `+语境(${hit.re.source.slice(0, 12)})` : ''}`
  };
}

/** 历史记录里怎么标注这一轮发了图 */
export function formatAutoImageNote(decision) {
  if (!decision) return '';
  const label = decision.kind === 'expression' ? '表情图' : decision.kind === 'draw' ? '手绘' : '照片';
  return `[发了一张${label}：${decision.subject.slice(0, 30)}]`;
}
