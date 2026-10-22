/**
 * 她自己的生活线（life.js）
 *
 * 目的：让她听起来像一个真的在过日子的人，而不是一个只会围着他转的应答机。
 *
 * 三条硬规则（用户明确要求）：
 *   1. **连贯**：一个故事一旦开了头，就要一拍一拍讲完（起因 → 变化 → 结果），
 *      不能这条说"楼下新开的面馆"，下一条突然"我妈打电话骂我"。
 *   2. **有始有终**：讲完的故事写进 closed 列表，之后**永远不再主动提**，
 *      除非他主动问起（那时走回复路径，允许提）。
 *   3. **频率可控**：多久开一个故事、故事里有没有冲突，都由配置决定，
 *      不是每次主动消息都甩一个新剧情。
 *
 * 故事不写死在提示词里：代码只给"这一拍发生了什么"的骨架（beat），
 * 具体的话由模型在这个骨架上写。这样同一套模板也不会每轮一模一样。
 *
 * 落盘：data/life.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：不能直接用 new URL(import.meta.url).pathname —— 路径里有空格时
// 会拿到 %20（"D:/DeepSeek%20Harness/..."），mkdirSync 会静默失败、
// 生活线永远存不下来。必须走 fileURLToPath。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIFE_DIR = path.join(ROOT, 'data');
const LIFE_FILE = path.join(LIFE_DIR, 'life.json');

const DAY = 24 * 60 * 60 * 1000;

/** 配角表。名字 + 关系 + 脾气，写死在这里，模型只负责让他们说话 */
export const DEFAULT_CAST = [
  { id: 'mom', name: '妈妈', role: '家人', trait: '爱操心，电话一打就是半小时，总问吃饭没、对象找了没，嘴上嫌弃心里惦记' },
  { id: 'roomie', name: '小满', role: '合租室友', trait: '邋遢但热心，碗堆两天不洗，会在你难过的时候默默点一份炸鸡' },
  { id: 'tutor', name: '王老师', role: '导师', trait: '严格、爱拖堂，口头禅是"这个我讲过"，其实很护着自己带的学生' },
  { id: 'peer', name: '阿哲', role: '同学', trait: '爱吹牛、消息灵通，什么都懂一点，关键时刻靠不住' },
  { id: 'bro', name: '小宇', role: '弟弟', trait: '初中生，叛逆，嘴上不耐烦，偷偷把姐姐的零食吃光' },
  { id: 'aunt', name: '刘阿姨', role: '楼下邻居', trait: '爱打听，谁家的事都知道，说话热情又让人招架不住' }
];

/**
 * 故事模板。
 *   kind: conflict（冲突）| daily（日常）| accident（意外）| curiosity（新鲜事）| money（钱）
 *   beats: 每一拍给模型的一句话骨架，**按顺序走完才算讲完**
 *   askAt: 第几拍适合带一句问他（0 起）
 */
const ARCS = [
  // ── 冲突 ────────────────────────────────────────────────────────────────
  {
    id: 'roomie-bill', kind: 'conflict', cast: ['roomie'], askAt: 1,
    title: '和室友为水电费吵起来',
    beats: [
      '起因：室友又忘了交水电费，催了两次还装没看见，你憋着火',
      '升级：她终于说了句"不就几十块"，你当场炸了',
      '收尾：两个人冷战，你把自己关在房间，心里其实有点后悔话说重了'
    ]
  },
  {
    id: 'tutor-blame', kind: 'conflict', cast: ['tutor'], askAt: 0,
    title: '被老师当众点了名',
    beats: [
      '起因：组里交上去的东西出错了，老师当着所有人问你"这是你做的吗"',
      '委屈：其实不是你负责的那部分，你张了张嘴没解释',
      '收尾：下课后老师又单独找你，说了句其实还算讲道理的话'
    ]
  },
  {
    id: 'mom-call', kind: 'conflict', cast: ['mom'], askAt: 1,
    title: '和妈妈在电话里顶了嘴',
    beats: [
      '起因：妈妈又提相亲/工作的事，你敷衍了两句',
      '升级：她说"我这都是为你好"，你没忍住回了一句重的',
      '收尾：挂了电话有点难受，想打回去又拉不下面子'
    ]
  },
  {
    id: 'bro-computer', kind: 'conflict', cast: ['bro'], askAt: 2,
    title: '弟弟偷用你电脑',
    beats: [
      '起因：回家发现电脑开着，桌面被改得乱七八糟',
      '升级：他还理直气壮说"就玩一会儿"，你火大',
      '收尾：最后用一顿饭把他收买了，但还是设了密码'
    ]
  },
  {
    id: 'landlord-rent', kind: 'conflict', cast: ['aunt'], askAt: 1,
    title: '房东突然说要涨房租',
    beats: [
      '起因：房东发消息说下个月起涨两百',
      '升级：你说合同还没到期，对方开始打感情牌',
      '收尾：谈了半天各退一步，你心里还是有点堵'
    ]
  },
  // ── 意外 ────────────────────────────────────────────────────────────────
  {
    id: 'fell-down', kind: 'accident', cast: [], askAt: 0,
    title: '出门摔了一跤',
    beats: [
      '起因：下楼时踩空一级台阶，膝盖磕了一下',
      '细节：裤子破了个口子，蹲在路边缓了半天',
      '收尾：回家贴了创可贴，走路有点一瘸一拐'
    ]
  },
  {
    id: 'phone-screen', kind: 'accident', cast: [], askAt: 1,
    title: '手机摔碎了屏',
    beats: [
      '起因：手机从口袋滑出来，屏幕裂了一道',
      '麻烦：触控还断断续续，修一下要好几百',
      '收尾：最后贴了个膜凑合用，看着就烦'
    ]
  },
  {
    id: 'lost-keys', kind: 'accident', cast: ['roomie'], askAt: 1,
    title: '钥匙丢了进不去门',
    beats: [
      '起因：回家发现钥匙不在包里，翻了三遍',
      '窘迫：坐在楼道里等室友回来，手机快没电',
      '收尾：室友回来把钥匙丢给你，笑了一路'
    ]
  },
  {
    id: 'soaked-rain', kind: 'accident', cast: [], askAt: 2,
    title: '被雨淋成落汤鸡',
    beats: [
      '起因：出门没带伞，走到一半下大雨',
      '狼狈：躲在便利店门口，头发滴水，鞋里全是水',
      '收尾：最后还是买了把三十块的伞，回家煮了姜茶'
    ]
  },
  // ── 日常 ────────────────────────────────────────────────────────────────
  {
    id: 'noodle-shop', kind: 'daily', cast: [], askAt: 2,
    title: '楼下新开了一家面馆',
    beats: [
      '发现：楼下转角新开了家面馆，香味飘半条街',
      '体验：点了一碗牛肉面，汤很浓，牛肉给得实在',
      '收尾：老板说新店前三天送卤蛋，你打算明天再去'
    ]
  },
  {
    id: 'plant-leaf', kind: 'daily', cast: [], askAt: 1,
    title: '养的绿萝冒了新叶',
    beats: [
      '发现：窗台上的绿萝抽了一片新叶，卷着还没展开',
      '细节：之前差点被养死，你专门查了怎么浇水',
      '收尾：现在长得挺好，你有点小得意'
    ]
  },
  {
    id: 'hotpot-roomie', kind: 'daily', cast: ['roomie'], askAt: 1,
    title: '和室友蹭了顿火锅',
    beats: [
      '起因：室友发工资，说要请你吃火锅',
      '过程：两个人点了太多，最后打包了两盒',
      '收尾：回家路上撑得走不动，说下次不点这么多了'
    ]
  },
  {
    id: 'old-bookstore', kind: 'daily', cast: [], askAt: 2,
    title: '路过一家旧书店',
    beats: [
      '发现：巷子里有家旧书店，门口堆着纸箱',
      '细节：翻到一本旧诗集，扉页上有陌生人的字',
      '收尾：十块钱买下了，回来读了两页就困了'
    ]
  },
  // ── 新鲜事 / 钱 ─────────────────────────────────────────────────────────
  {
    id: 'shocking-video', kind: 'curiosity', cast: [], askAt: 1,
    title: '刷到一条炸裂的消息',
    beats: [
      '起因：刷到一条特别离谱的信息，看得你半天没缓过来',
      '细节：你翻评论翻到半夜，越看越觉得世界很怪',
      '收尾：第二天又觉得没什么大不了，但还是想跟人说'
    ]
  },
  {
    id: 'salary-day', kind: 'money', cast: [], askAt: 1,
    title: '发工资了但转眼花完',
    beats: [
      '起因：工资到账，数字比预期少一点',
      '过程：交完房租水电，余额只剩几百',
      '收尾：列了半天账，决定这个月少喝奶茶'
    ]
  },
  {
    id: 'praised-by-boss', kind: 'praise', cast: [], askAt: 1,
    title: '被夸了',
    beats: [
      '起因：交上去的东西被当众夸了一句"这次做得挺细"',
      '过程：嘴上说没什么，回去路上一直在偷偷笑',
      '收尾：忍不住想跟人说说这件事，又怕显得太得意'
    ]
  },
  {
    id: 'roomie-praised', kind: 'praise', cast: ['roomie'], askAt: 0,
    title: '被室友夸手巧',
    beats: [
      '起因：给室友缝了件衣服的口子，针脚比她自己缝的还齐',
      '过程：室友一直举着看，说"你这手也太巧了吧"',
      '收尾：被夸得有点不好意思，嘴上还嘴硬说随便缝的'
    ]
  },
  {
    id: 'lucky-bus', kind: 'lucky', cast: [], askAt: 1,
    title: '差点迟到但赶上了',
    beats: [
      '起因：出门晚了，一路小跑，心想肯定要迟到',
      '过程：刚到站台车就来了，还正好有个座',
      '收尾：坐下才发现自己心跳得厉害，觉得今天运气真好'
    ]
  },
  {
    id: 'lucky-found', kind: 'lucky', cast: [], askAt: 1,
    title: '丢的东西找回来了',
    beats: [
      '起因：以为耳机丢了，翻遍包和口袋都没找到',
      '过程：第二天在昨天穿的外套内袋里摸到了',
      '收尾：又气又好笑，觉得自己这记性真的没救'
    ]
  },
  {
    id: 'small-disagree', kind: 'small_conflict', cast: ['roomie'], askAt: 1,
    title: '和室友为开空调拌了两句',
    beats: [
      '起因：她觉得冷要关空调，你觉得闷想再开一会儿',
      '过程：两人谁也不让，最后折中开了一档，都还是有点不服气',
      '收尾：晚上她递过来一包薯片，算是和好了，但嘴上还念叨'
    ]
  },
  {
    id: 'small-queue', kind: 'small_conflict', cast: [], askAt: 2,
    title: '排队被人插队',
    beats: [
      '起因：买奶茶排队，后面的人直接挤到前面去点单',
      '过程：你盯着看了两秒，想说又觉得为这个吵有点小题大做',
      '收尾：最后还是没吭声，回来自己生闷气'
    ]
  }
];

/** 故事类型：不只是冲突，也要有被夸、走运、小小的拌嘴 */
export const KIND_LABELS = {
  conflict: '冲突（吵架、被为难）',
  small_conflict: '小矛盾（拌两句嘴）',
  praise: '被夸 / 表扬',
  lucky: '幸运的事',
  accident: '意外（倒霉事）',
  daily: '日常小事',
  curiosity: '新鲜事',
  money: '钱的事'
};
export const VALID_KINDS = Object.keys(KIND_LABELS);

const ARC_COOLDOWN_MS = 90 * 60 * 1000;   // 两个故事之间至少隔这么久（可被配置覆盖）
const RECENT_TEMPLATE_DAYS = 14;          // 同一个模板两周内不重复
const MAX_PROGRESS = 6;

function emptyLife() {
  return { cast: cloneCast(DEFAULT_CAST), arcs: [], arc: null, closed: [], recentTemplates: [], lastArcAt: 0 };
}

function cloneCast(list) {
  return list.map((c) => ({ ...c }));
}

/** 用户自己写的故事模板：和内置模板同结构，只是额外带 custom: true */
function normArcTemplate(tpl) {
  const beats = (Array.isArray(tpl.beats) ? tpl.beats : [])
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    id: String(tpl.id || `a_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`),
    kind: VALID_KINDS.includes(tpl.kind) ? tpl.kind : 'daily',
    title: String(tpl.title || '').trim().slice(0, 60) || '（没起名字的事）',
    cast: (Array.isArray(tpl.cast) ? tpl.cast : []).map(String).slice(0, 5),
    askAt: Number.isInteger(tpl.askAt) ? tpl.askAt : -1,
    beats: beats.length ? beats : ['起因：……', '变化：……', '收尾：……'],
    custom: true
  };
}

function readAll() {
  try {
    const raw = readFileSync(LIFE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    mkdirSync(LIFE_DIR, { recursive: true });
    writeFileSync(LIFE_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch { /* 落盘失败不影响聊天 */ }
}

export function lifeFilePath() {
  return LIFE_FILE;
}

export function loadLife(userId) {
  const all = readAll();
  const life = all[userId];
  if (!life || typeof life !== 'object') return emptyLife();
  return {
    cast: Array.isArray(life.cast) && life.cast.length ? cloneCast(life.cast) : cloneCast(DEFAULT_CAST),
    arcs: Array.isArray(life.arcs) ? life.arcs.map((a) => ({ ...a, custom: true })) : [],
    arc: life.arc || null,
    closed: Array.isArray(life.closed) ? life.closed : [],
    recentTemplates: Array.isArray(life.recentTemplates) ? life.recentTemplates : [],
    lastArcAt: life.lastArcAt || 0
  };
}

export function saveLife(userId, life) {
  const all = readAll();
  all[userId] = life;
  writeAll(all);
}

export function resetLife(userId) {
  const all = readAll();
  all[userId] = emptyLife();
  writeAll(all);
  return loadLife(userId);
}

/** 当前挂着的故事（没讲完的） */
export function activeArc(life) {
  const arc = life?.arc;
  if (!arc || arc.status !== 'active') return null;
  return arc;
}

/** 这一拍该讲什么 */
export function currentBeat(arc) {
  if (!arc || !Array.isArray(arc.beats)) return null;
  const idx = Math.min(arc.stage || 0, arc.beats.length - 1);
  return {
    index: idx,
    total: arc.beats.length,
    hint: arc.beats[idx],
    isLast: idx >= arc.beats.length - 1
  };
}

/** 是否该开一个新故事：冷却到了、没有挂着的故事 */
export function canStartArc(life, { cooldownMs = ARC_COOLDOWN_MS } = {}) {
  if (activeArc(life)) return false;
  const now = Date.now();
  if (life?.lastArcAt && now - life.lastArcAt < cooldownMs) return false;
  return true;
}

/** 抽一个模板：冲突占比由 conflictChance 控制，两周内用过的模板排除 */
export function pickTemplate(life, { conflictChance = 0.35, rng = Math.random } = {}) {
  const recent = new Set(life?.recentTemplates || []);
  const now = Date.now();
  const fresh = (life?.closed || []).filter((c) => now - (c.closedAt || 0) < RECENT_TEMPLATE_DAYS * DAY);
  const recentlyClosed = new Set(fresh.map((c) => c.templateId));
  // 自定义模板也在池子里：自己写的故事优先被讲到，但仍受"两周不重复"约束。
  const all = [...ARCS, ...(life?.arcs || [])];
  const pool = all.filter((a) => !recent.has(a.id) && !recentlyClosed.has(a.id));
  const usable = pool.length ? pool : all;
  const wantConflict = rng() < conflictChance;
  const conflicts = usable.filter((a) => a.kind === 'conflict' || a.kind === 'accident');
  const others = usable.filter((a) => a.kind !== 'conflict' && a.kind !== 'accident');
  const basket = wantConflict ? (conflicts.length ? conflicts : others) : (others.length ? others : conflicts);
  return basket[Math.floor(rng() * basket.length)];
}

/** 所有可用模板（内置 + 自定义），给控制台和"指定讲哪段"用 */
export function allTemplates(life) {
  return [
    ...ARCS.map((a) => ({ ...a, custom: false })),
    ...((life?.arcs || []).map((a) => ({ ...a, custom: true })))
  ];
}

/** 开一个新故事（返回新的 life）。传 templateId 就讲指定的那段。 */
export function startArc(userId, life, { conflictChance = 0.35, rng = Math.random, templateId = null } = {}) {
  const tpl = templateId
    ? allTemplates(life).find((t) => t.id === templateId)
    : pickTemplate(life, { conflictChance, rng });
  if (!tpl) return life;
  const names = (tpl.cast || []).map((id) => life.cast.find((c) => c.id === id)).filter(Boolean);
  const arc = {
    templateId: tpl.id,
    kind: tpl.kind,
    title: tpl.title,
    cast: names.map((c) => ({ id: c.id, name: c.name, role: c.role, trait: c.trait })),
    beats: tpl.beats.slice(),
    askAt: tpl.askAt ?? -1,
    stage: 0,
    progress: [],
    startedAt: Date.now(),
    lastAt: Date.now(),
    status: 'active'
  };
  life.arc = arc;
  life.lastArcAt = Date.now();
  life.recentTemplates = [...(life.recentTemplates || []).slice(-10), tpl.id];
  saveLife(userId, life);
  return life;
}

/**
 * 记下这一拍已经讲出去了：写入 progress，stage++；
 * 讲完最后一拍就把故事关掉，写进 closed —— 以后不再主动提。
 */
export function advanceArc(userId, life, toldText) {
  const arc = activeArc(life);
  if (!arc) return life;
  const beat = currentBeat(arc);
  if (beat) {
    arc.progress = [...(arc.progress || []), { stage: beat.index, hint: beat.hint, told: String(toldText || '').slice(0, 160), at: Date.now() }]
      .slice(-MAX_PROGRESS);
  }
  arc.stage = (arc.stage || 0) + 1;
  arc.lastAt = Date.now();

  if (arc.stage >= arc.beats.length) {
    arc.status = 'done';
    arc.closedAt = Date.now();
    life.closed = [...(life.closed || []), {
      templateId: arc.templateId,
      title: arc.title,
      summary: arc.progress.map((p) => p.told).filter(Boolean).join(' / ').slice(0, 400),
      closedAt: Date.now()
    }].slice(-30);
    life.arc = null;
  }
  saveLife(userId, life);
  return life;
}

/** 手动结束（不写 closed，用于"这条线不要了"） */
export function dropArc(userId, life) {
  if (life.arc) {
    life.arc = null;
    life.lastArcAt = Date.now();
    saveLife(userId, life);
  }
  return life;
}

/** 主动消息：这一拍怎么写、不能跳到别的事 */
export function formatLifeForProactive(arc, beat, { closed = [] } = {}) {
  if (!arc || !beat) return '';
  const castLine = arc.cast.length
    ? `出场的人：${arc.cast.map((c) => `${c.name}（${c.role}，${c.trait}）`).join('；')}`
    : '';
  const told = (arc.progress || []).map((p) => `  · ${p.told}`).filter(Boolean);
  const closedLine = closed.length
    ? `\n【已经讲完、不要再主动提的故事】${closed.slice(-4).map((c) => c.title).join('、')}`
    : '';
  return [
    '',
    `【你身上正发生的事：${arc.title}（${KIND_LABELS[arc.kind] || '日常小事'}，第 ${beat.index + 1}/${beat.total} 拍）】`,
    `这一拍的事：${beat.hint}`,
    castLine,
    told.length ? `你前面已经跟他说过：\n${told.join('\n')}` : '',
    '**接着说这一件事**，不要跳到别的话题、不要新开一件事。',
    beat.isLast
      ? '这是这个故事的最后一拍：把结果和你的心情收个尾，之后这件事就算了结了。'
      : '只讲这一拍，别提前把后面的结局说完。',
    closedLine
  ].filter(Boolean).join('\n');
}

/** 回复路径：让她在被问到时能接着自己的故事说，但别主动提讲完的 */
export function formatLifeForReply(arc, { closed = [] } = {}) {
  const closedLine = closed.length
    ? `\n【已经聊完的事】${closed.slice(-5).map((c) => c.title).join('、')}——他没问就别主动提。`
    : '';
  if (!arc) return closedLine.trim();
  const beat = currentBeat(arc);
  return [
    '',
    `【你自己身上挂着的事：${arc.title}】`,
    arc.progress?.length ? `已经跟他说过：${arc.progress.map((p) => p.told).slice(-3).join(' / ')}` : '',
    beat ? `接下来可以往下说的一点：${beat.hint}` : '',
    '他要是问起就自然接着说；他没问就别硬拗到这个话题上。',
    closedLine
  ].filter(Boolean).join('\n');
}

/** 讲完的故事标题（给遗忘/提示词做"别主动提"清单） */
export function closedTitles(life, { limit = 6 } = {}) {
  return (life?.closed || []).slice(-limit).map((c) => c.title);
}

/* ────────────────────────────────────────────────────────────────────────
 * DIY：人物与故事都可以自己加、自己改
 * 这一层只碰 life.cast / life.arcs，不碰正在讲的那段故事（arc）。
 * ──────────────────────────────────────────────────────────────────────── */

/** 新增或修改一个配角。没有 id 就是新增，返回 life。 */
export function saveCastMember(userId, life, member) {
  const name = String(member?.name || '').trim().slice(0, 20);
  if (!name) throw new Error('人物名字不能为空');
  const next = {
    id: String(member.id || '').trim() || `c_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name,
    role: String(member.role || '朋友').trim().slice(0, 20),
    trait: String(member.trait || '').trim().slice(0, 300),
    relation: String(member.relation || '').trim().slice(0, 60)
  };
  const cast = Array.isArray(life.cast) ? life.cast.slice() : [];
  const i = cast.findIndex((c) => c.id === next.id);
  if (i >= 0) cast[i] = { ...cast[i], ...next };
  else cast.push(next);
  life.cast = cast;
  saveLife(userId, life);
  return life;
}

/** 删掉一个配角（正在讲的故事里出场过也没关系，历史照旧） */
export function deleteCastMember(userId, life, id) {
  life.cast = (life.cast || []).filter((c) => c.id !== id);
  saveLife(userId, life);
  return life;
}

/** 新增或修改一个"故事/事件"模板。cast 可以传 id、名字，或者留空。 */
export function saveArcTemplate(userId, life, tpl) {
  const norm = normArcTemplate(tpl);
  if (!String(tpl?.title || '').trim()) throw new Error('故事标题不能为空');
  // cast 里写名字也认：统一转成人物 id
  norm.cast = norm.cast.map((x) => {
    const byId = (life.cast || []).find((c) => c.id === x);
    if (byId) return byId.id;
    const byName = (life.cast || []).find((c) => c.name === x);
    return byName ? byName.id : x;
  });
  const arcs = Array.isArray(life.arcs) ? life.arcs.slice() : [];
  const i = arcs.findIndex((a) => a.id === norm.id);
  if (i >= 0) arcs[i] = { ...arcs[i], ...norm };
  else arcs.push(norm);
  life.arcs = arcs;
  saveLife(userId, life);
  return life;
}

/** 删掉一个自定义故事模板 */
export function deleteArcTemplate(userId, life, id) {
  life.arcs = (life.arcs || []).filter((a) => a.id !== id);
  saveLife(userId, life);
  return life;
}

/** 直接开某一段（控制台"讲这段"用） */
export function startArcByTemplate(userId, life, templateId) {
  return startArc(userId, life, { templateId });
}

export { ARCS, ARC_COOLDOWN_MS };
