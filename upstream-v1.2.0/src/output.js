/**
 * 输出文本处理
 *
 * 两个职责：
 *   1. 去掉括号里的动作描述 —— 人设在回复里会写"（踮起脚，把头按进颈窝）"，
 *      但在微信里看起来像旁白，很出戏。默认清掉。
 *   2. 把一段回复拆成几段像真人连续发的消息 —— 真人聊天不会一次发一大坨，
 *      而是分两三条短消息。
 *
 * 清洗要保守：只删"明显是动作描述"的括号，不误伤正常内容
 * （比如数学公式、代码、括号补充说明里的正经信息）。
 */

/** 括号里出现这些词，基本可以判定是动作/神态描述 */
const ACTION_HINTS = [
  '笑', '抱', '蹭', '摸', '拍', '捏', '靠', '贴', '牵', '搂', '抱抱',
  '叹', '摇', '点', '抬', '低', '转', '皱', '眨', '看', '望', '凑',
  '声', '语气', '小声', '轻声', '软声', '嘟囔', '嘀咕', '念叨',
  '眼', '脸', '手', '头', '肩膀', '背', '颈', '怀', '衣角', '脚',
  '哼', '鼓', '腮', '伸', '收', '退', '扑', '蹲', '站', '坐', '躺',
  '歪', '怔', '愣', '沉默', '顿了顿', '想了', '认真'
].join('|');

/**
 * 判断一段括号内容是不是动作描述。
 *
 * 判据改进记录：早期版本用"长度 ≤6 且无句末标点"来兜底，
 * 结果把「（2024年）」「（x+y）」这类正经内容也删了。
 * 现在只认「明确的动作特征」——宁可漏删，不可误删。
 */
function looksLikeAction(inner) {
  const t = inner.trim();
  if (!t) return true;

  // 纯标点/符号，删掉无妨
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) return true;

  // 命中动作/神态/身体部位词
  if (new RegExp(ACTION_HINTS).test(t)) return true;

  // 动作常带逗号分隔的连续描写，例如"踮起脚，把头发别到耳后"
  if (/[，,]/.test(t) && /[\u4e00-\u9fa5]/.test(t) && t.length <= 40) return true;

  return false;
}

/**
 * 去掉动作描述的括号内容。
 * @param text 原始回复
 * @param mode  'action'（默认，只删动作）| 'all'（删所有括号内容）| 'keep'（不删）
 */
export function stripActions(text, mode = 'action') {
  if (!text || mode === 'keep') return text || '';

  let out = text;

  if (mode === 'all') {
    // 直接删掉所有括号对（含嵌套一层）
    out = out
      .replace(/（[^（）]*）/g, '')
      .replace(/\([^()]*\)/g, '')
      .replace(/【[^【】]*】/g, '')
      .replace(/\[[^\[\]]*\]/g, '');
  } else {
    // 只删命中动作特征的
    out = out
      .replace(/（([^（）]*)）/g, (m, inner) => (looksLikeAction(inner) ? '' : m))
      .replace(/\(([^()]*)\)/g, (m, inner) => {
        // 半角括号多为英文/代码，保守：只在明显中文动作时删
        return /[\u4e00-\u9fa5]/.test(inner) && looksLikeAction(inner) ? '' : m;
      });
  }

  // 清理删除后留下的空白与孤立标点
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/，\s*，/g, '，')
    .replace(/。\s*。/g, '。')
    .replace(/^\s*[，。、；：]\s*/gm, '')
    .replace(/([。！？…])[ \t]+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}

/**
 * 把气泡数强制调整到目标条数。
 *
 * 为什么要强制：人设里写"发几条"模型执行得不准，而且容易稳定在 2-3 条。
 * 这里直接从结构上调：
 *   多了 → 合并相邻两条（挑最短的那一对，尽量不破坏长消息）
 *   少了 → 把最长的气泡按句子劈开（挑句子边界，不会切在半句上）
 *
 * @param bubbles 已拆好的数组（原地修改）
 * @param target 目标条数 1-8
 */
export function adjustBubbleCount(bubbles, target) {
  if (!Array.isArray(bubbles) || bubbles.length === 0) return bubbles;
  const want = Math.max(1, Math.min(8, Math.round(target)));
  if (bubbles.length === want) return bubbles;

  // ── 太多：合并相邻的短气泡 ──
  while (bubbles.length > want) {
    let bestIdx = 0;
    let bestLen = Infinity;
    for (let i = 0; i < bubbles.length - 1; i++) {
      const combined = bubbles[i].length + bubbles[i + 1].length;
      if (combined < bestLen) { bestLen = combined; bestIdx = i; }
    }
    bubbles[bestIdx] = bubbles[bestIdx] + '\n' + bubbles[bestIdx + 1];
    bubbles.splice(bestIdx + 1, 1);
  }

  // ── 太少：把最长的气泡劈开 ──
  let guard = 0;
  while (bubbles.length < want && guard++ < 10) {
    // 找最长的、还能再劈的那个
    let idx = -1;
    let maxLen = 0;
    for (let i = 0; i < bubbles.length; i++) {
      if (bubbles[i].length > maxLen) { maxLen = bubbles[i].length; idx = i; }
    }
    if (idx < 0 || maxLen < 6) break; // 已经没有可劈的了

    const parts = splitSentences(bubbles[idx]);
    if (parts.length < 2) break;      // 单句，劈不了

    // 从中间附近切，保持两半长度接近
    const mid = Math.ceil(parts.length / 2);
    const a = parts.slice(0, mid).join('').trim();
    const b = parts.slice(mid).join('').trim();
    if (!a || !b) break;

    bubbles.splice(idx, 1, a, b);
  }

  return bubbles;
}

/** 按句末标点切句，找不到就返回空 */
function splitSentences(text) {
  // 这里不能用 u 标志：字符类里带转义的 . 和 ! ? 在 unicode 模式下是非法转义。
  // 这些标点都是 BMP 字符，不加 u 也完全正确。
  const parts = String(text)
    .split(/(?<=[。！？!?…])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [];
}

/**
 * 把一条长回复拆成若干条"像真人连续发出的"短消息。
 *
 * 拆分依据：按段落 → 按句号 → 合并过短的。
 * 不是随机切，切完必须读得通顺。
 *
 * @param text 已清洗的回复
 * @param opts.maxMessages 最多拆几条（默认 3）
 * @param opts.enabled 是否启用拆分
 * @returns 消息数组
 */
export function splitIntoBubbles(text, opts = {}) {
  const {
    maxMessages = 3,
    enabled = true,
    shortReplyThreshold = 40,
    // 低于这个长度的片段会被并入相邻气泡。
    // 粘人模式把 minimumFragmentLength 设为 0，让"哥哥～""在呢"单独成条。
    minimumFragmentLength = 8
  } = opts;
  if (!enabled || !text) return [text];

  const trimmed = text.trim();
  if (!trimmed) return [];

  // 先按段落看有几段。
  // 阈值只决定"单段要不要再往下拆"，不能阻止本来就分好段的文本分条 ——
  // 早期版本把 length<=threshold 直接 return，导致模型用空行分好的
  // 短消息被合成一条，粘人效果全废。
  let parts = trimmed.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

  // 只有一整段、而且本身很短，才不拆（"好的呀"这种）
  if (parts.length <= 1 && trimmed.length <= shortReplyThreshold) return [trimmed];

  // 段落太少就按句子切
  if (parts.length === 1) {
    parts = trimmed
      .split(/(?<=[。！？!?…])/u)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 某一段还是太长的话，再按句子切开。
  // 不加这步的话，会出现"第一条三个字、第二条五十字"的畸形分条，
  // 聊天气泡的观感比一次发一大段还差。
  const SEGMENT_SOFT_MAX = 60;
  const refined = [];
  for (const p of parts) {
    if (p.length <= SEGMENT_SOFT_MAX) {
      refined.push(p);
      continue;
    }
    let buf = '';
    for (const sentence of p.split(/(?<=[。！？!?…])/u)) {
      if (!sentence) continue;
      if (buf && buf.length + sentence.length > SEGMENT_SOFT_MAX) {
        refined.push(buf.trim());
        buf = sentence;
      } else {
        buf += sentence;
      }
    }
    if (buf.trim()) refined.push(buf.trim());
  }
  parts = refined;

  // 把真正的"碎片"合并掉。
  // 判据：只有不以句末标点收尾、且短于 minimumFragmentLength 的片段才算碎片。
  // 早期版本用"长度 <15 就合并"，会把「哥哥……过来让我抱一下。」这种
  // 已经完整的句子也并进下一句，导致该分条的没分。
  const isFragment = (s) =>
    minimumFragmentLength > 0 &&
    s.length < minimumFragmentLength &&
    !/[。！？!?…~～]$/.test(s);

  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    const canMerge =
      last !== undefined &&
      (isFragment(last) || isFragment(p)) &&
      last.length + p.length <= 120;
    if (canMerge) merged[merged.length - 1] = last + p;
    else merged.push(p);
  }

  // 超过上限：把多余的并进最后一条，而不是丢掉
  if (merged.length > maxMessages) {
    const head = merged.slice(0, maxMessages - 1);
    const tail = merged.slice(maxMessages - 1).join('\n\n');
    return [...head, tail];
  }
  return merged;
}

/**
 * 从回复里抽出表情包标记。
 *
 * 人设被要求单独一行写 `[sticker:开心]`。这里把标记摘出来，
 * 同时保证正文里不留残留。
 *
 * @returns {{text:string, stickers:string[]}}
 */
export function extractStickers(text) {
  const stickers = [];
  // 容忍全角冒号、圆括号、多余空格
  const re = /^[ \t]*[[［][ \t]*sticker[ \t]*[：:][ \t]*([^\]]+?)[ \t]*[\]］][ \t]*$/gim;
  let out = text.replace(re, (m, name) => {
    const clean = name.trim();
    if (clean) stickers.push(clean);
    return '';
  });

  // 行内的也处理一下（模型有时不听话写在句子里）
  const inlineRe = /[[［]\s*sticker\s*[：:]\s*([^\]]+?)\s*[\]］]/gi;
  out = out.replace(inlineRe, (m, name) => {
    const clean = name.trim();
    if (clean) stickers.push(clean);
    return '';
  });

  // 摘掉标记后可能留下双空格（"我想你了  你在干嘛"），
  // 也可能留下空行串；这里一并收干净。
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: out, stickers };
}

/**
 * 预估"真人打字"的延迟。
 * 短消息快发，长消息慢一点，但都控制在人类合理的范围内。
 */
export function humanDelayMs(text, opts = {}) {
  const { min = 600, max = 2200, perChar = 45, cap = 3500 } = opts;
  const base = Math.min(text.length * perChar, cap);
  const jitter = Math.random() * (max - min);
  return Math.round(Math.min(base + jitter, cap));
}

// ── 表情符号兜底 ────────────────────────────────────────────────────────────
//
// 为什么需要：人设里写了"每 2-3 条带一个颜文字""每 5-6 条一个 emoji"，
// 但实测只有 24% 和 3% —— 模型对比例类指令执行得很不稳定。
// 这里做兜底：整条回复一个符号都没有时，按概率补一个。
// 补的时候按情绪分组挑，对方难过时不会贴大笑颜文字。

const KAOMOJI_BY_MOOD = {
  happy: ['(＾▽＾)', '(◍・ᴗ・◍)', '(*´▽`*)', '(๑˃̵ᴗ˂̵)', '(｡・̀ᴗ-)✧', '٩(◕‿◕｡)۶', 'o(≧▽≦)o', '(●´ω`●)'],
  shy: ['(๑´ω`๑)', '(*/ω＼*)', '(´｡・ᵕ・｡`)', '(￣▽￣*)ゞ'],
  sad: ['(´；ω；`)', '(｡•́︿•̀｡)', '(๑•́ ₃ •̀๑)', '(｡╥﹏╥｡)'],
  tired: ['(´-ω-`)', '(￣o￣) z z Z', '( ˘ω˘ )', '(∪.∪ )...zzz'],
  angry: ['(╬ Ò﹏Ó)', '(｀Д´*)', '(￣^￣)', '(・`ω´・)', '(#`皿´)'],
  neutral: ['(・∀・)', '(｡・̀ᴗ-)✧', '(≧∇≦)ﾉ', '(◕‿◕)']
};

const EMOJI_BY_MOOD = {
  happy: ['🌸', '✨', '🍰', '🍡'],
  shy: ['🌸', '🍓', '🐰', '🧸'],
  sad: ['☁️', '🍂'],
  tired: ['💤', '☁️', '🌙'],
  angry: ['💢', '🔥', '😤', '😠'],
  neutral: ['🌸', '☁️', '🐾', '🍪']
};

/** 从文本判断情绪，决定补哪一类 */
function detectMood(text) {
  const t = String(text || '');
  // 顺序有讲究：
  //   1) "生气"排在"难过"前面 —— 替他出气、闹小脾气是愤怒，不是委屈。
  //      现在有 22 张生气表情包，值得单独识别。
  //   2) 负面整体排在正面前面，避免"被骂了但我说没事"被判成开心。
  if (/气死|生气|不爽|讨厌|过分|凶|骂|谁让他|揍|敢|哼|欺负/.test(t)) return 'angry';
  if (/委屈|难过|哭|烦|难受|伤心|失落|不理我|不搭理|冷落|没回我|半天不回|敷衍/.test(t)) return 'sad';
  if (/累|困|睡|加班|疲惫|没力气/.test(t)) return 'tired';
  // 撩人 / 被甜到 —— 必须排在 happy 前面，
  // 否则"想你了""爱你"会被 happy 的"喜欢"抢走，发出去的是开心图而不是暧昧图
  if (/想你|爱你|抱抱|亲亲|贴贴|喜欢你|么么|想抱|要抱|撒娇/.test(t)) return 'shy';
  if (/害羞|脸红|讨厌啦|不好意思|夸我|才没有|别说了/.test(t)) return 'shy';
  if (/开心|高兴|好棒|太好了|喜欢|爱你|想你了|嘿嘿|哈哈|升职|成功|最棒|庆祝/.test(t)) return 'happy';
  return 'neutral';
}

/** 文本里是否已有颜文字 */
export function hasKaomoji(text) {
  return /[\(（][^\)）\n]{0,24}[•´`｡╥﹏ㅂㅁω＼▽◍\*・ᴗ◕‿≧∇≦ﾉ٩۶][^\)）\n]{0,24}[\)）]/.test(String(text || ''));
}

/** 文本里是否已有 emoji */
export function hasEmoji(text) {
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(String(text || ''));
}

/**
 * 表情包兜底。
 *
 * 为什么需要：人格里写了"每 6~10 条发一次表情包"，模型直接理解成"别发"，
 * 实测 4 个明显该发的场景（升职、被冷落、很累、闲聊）**一次都没发**。
 * 和条数、颜文字是同一个规律：prompt 只能表达意图，代码才能保证结果。
 *
 * 这里按概率兜底：命中就根据情绪挑一个类别，返回类别名（调用方负责真发图）。
 * 概率要小 —— 发一张图要上传 50-800 KB，而且表情包太密会显得敷衍。
 *
 * @param {string[]} bubbles 已经拆好的气泡
 * @param {string[]} emitted 模型自己已经给出的表情包标记
 * @param {{chance?:number, recentCategories?:string[]}} opts
 * @returns {string|null} 要发的类别名，或 null
 */
export function ensureSticker(bubbles, emitted = [], opts = {}) {
  const { chance = 0.18, recentCategories = [], userText = '', categories = null } = opts;
  if (emitted && emitted.length) return null;   // 模型自己发了就不插手
  if (Math.random() >= chance) return null;

  // 情绪从两处看：他自己说的话（更能代表场合），和她回的正文。
  // 只看她自己的话会漏掉"他说他累了"这种场合。
  const mood = detectMood(`${userText || ''} ${(bubbles || []).join(' ')}`);

  // 传了 categories 就用调用方给的池子 —— 那是"她此刻的情绪允许发哪些类别"，
  // 比按文本猜情绪更可靠（情绪是有状态的，一句话看不出来）。
  let explicitPool = null;
  if (Array.isArray(categories) && categories.length) {
    explicitPool = categories.filter((c) => c);
    if (explicitPool.length) {
      const fresh = explicitPool.filter((c) => !recentCategories.includes(c));
      return pickOne(fresh.length ? fresh : explicitPool);
    }
  }

  const BY_MOOD = {
    happy: ['开心', '卖萌搞笑'],
    shy: ['表达爱意', '开心'],
    angry: ['生气', '无语'],
    sad: ['难过', '害怕'],
    tired: ['疲惫', '平常'],
    neutral: ['平常', '卖萌搞笑']
  };
  let pool = (BY_MOOD[mood] || BY_MOOD.neutral).slice();
  // 最近发过的类别往后排，避免连着几张都是一个表情
  const fresh = pool.filter((c) => !recentCategories.includes(c));
  if (fresh.length) pool = fresh;
  if (!pool.length) return null;
  return pickOne(pool);
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 给一组气泡补表情符号（原地修改）。
 *
 * @param bubbles 拆好的消息数组
 * @param opts.kaomojiChance 这条回复至少带一个颜文字的概率
 * @param opts.emojiChance   这条回复至少带一个 emoji 的概率
 */
export function ensureEmoji(bubbles, opts = {}) {
  const { kaomojiChance = 0.65, emojiChance = 0.35, moodOverride = null } = opts;
  if (!Array.isArray(bubbles) || bubbles.length === 0) return bubbles;

  // moodOverride 来自情绪系统：有状态的情绪比"从这一句文本猜"更准
  const mood = (moodOverride && (KAOMOJI_BY_MOOD[moodOverride] || EMOJI_BY_MOOD[moodOverride]))
    ? moodOverride
    : detectMood(bubbles.join('\n'));

  // 颜文字：整条回复都没有才补
  if (!hasKaomoji(bubbles.join('\n')) && Math.random() < kaomojiChance) {
    const k = pickOne(KAOMOJI_BY_MOOD[mood] || KAOMOJI_BY_MOOD.neutral);
    // 挂在最长的气泡末尾，读起来最自然
    let idx = 0;
    for (let i = 1; i < bubbles.length; i++) {
      if (bubbles[i].length > bubbles[idx].length) idx = i;
    }
    bubbles[idx] = bubbles[idx].replace(/[。！？!?…~～\s]+$/, '') + ' ' + k;
  }

  // emoji：更克制
  if (!hasEmoji(bubbles.join('\n')) && Math.random() < emojiChance) {
    const e = pickOne(EMOJI_BY_MOOD[mood] || EMOJI_BY_MOOD.neutral);
    const idx = Math.floor(Math.random() * bubbles.length);
    bubbles[idx] = bubbles[idx] + ' ' + e;
  }

  return bubbles;
}
