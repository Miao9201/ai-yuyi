/**
 * 忙碌 / 离开模式
 *
 * 用户说「我在忙」「我要去上班」「先不聊了」这类话时，主动消息的节奏要降下来：
 * 从「每 1-3 分钟一条 + 沉默 5 分钟连发 3-5 条」变成「每 25 分钟发 2-3 条」，
 * 内容也从"分享欲"切成"不打扰"，并且不再提问。
 *
 * 三个关键设计：
 *
 * 1. 状态必须落盘。
 *    这些状态如果只放内存，改一次代码重启、或者重启电脑，就会全忘 ——
 *    于是用户明明在忙，她却按普通模式开始高频打扰。
 *    今天已经因为「状态没持久化」踩过一次坑（MAX_TURNS 把聊天记录删了），不再犯。
 *
 * 2. 进入/退出靠模型在回复里打的标记，不是正则硬猜。
 *    正则判断不了「我不忙」「你忙不忙」这类反例；而正常聊天本来就要调一次模型，
 *    让她顺带输出一个 [BUSY]/[FREE] 标记，成本是 0 额外调用。
 *    标记在发送前会被剥掉，用户看不到。
 *
 * 3. 显式命令兜底：/忙 和 /闲 永远生效，不依赖模型的判断。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(process.env.WX_RUNTIME_DATA_DIR || path.join(ROOT, 'data'), 'busy-state.json');

let cache = null;

function readAll() {
  if (cache) return cache;
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    cache = (j && typeof j === 'object' && j.users) ? j : { users: {} };
  } catch {
    cache = { users: {} };
  }
  return cache;
}

function writeAll(state) {
  cache = state;
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[busymode] 保存失败:', e.message);
  }
}

/** 这个用户现在是不是处于忙碌/离开状态 */
export function isBusy(userId) {
  const s = readAll();
  const rec = s.users?.[userId];
  return !!(rec && rec.busy);
}

/** 进入忙碌模式；reason 只用于日志（截前后文各 20 字） */
export function setBusy(userId, reason = '') {
  const s = readAll();
  const prev = s.users[userId];
  if (prev?.busy) {
    // 已经在忙，只更新一下原因，不动 since（保持原有的计时）
    prev.reason = reason || prev.reason;
    prev.updatedAt = new Date().toISOString();
    writeAll(s);
    return { changed: false, since: prev.since };
  }
  s.users[userId] = {
    busy: true,
    since: new Date().toISOString(),
    reason: reason || '',
    updatedAt: new Date().toISOString()
  };
  writeAll(s);
  return { changed: true, since: s.users[userId].since };
}

/** 退出忙碌模式 */
export function setFree(userId, why = '') {
  const s = readAll();
  const prev = s.users[userId];
  if (!prev?.busy) return { changed: false };
  const lastedMin = Math.round((Date.now() - new Date(prev.since).getTime()) / 60000);
  s.users[userId] = {
    busy: false,
    since: prev.since,
    endedAt: new Date().toISOString(),
    lastedMin,
    reason: prev.reason,
    exitWhy: why
  };
  writeAll(s);
  return { changed: true, lastedMin };
}

export function getState(userId) {
  return readAll().users?.[userId] || null;
}

export function getAllBusy() {
  const s = readAll();
  return Object.entries(s.users || {})
    .filter(([, v]) => v?.busy)
    .map(([userId, v]) => ({ userId, ...v }));
}

/**
 * 从模型回复里剥出状态标记。
 *
 * 支持 [BUSY] / [[BUSY]] / 【BUSY】 等写法（模型经常自己加括号）。
 * 返回 { text, marker }，marker 为 'BUSY' | 'FREE' | null。
 * text 里已经不含标记 —— 一定要在拆气泡之前调用，否则标记会被当成正文发出去。
 */
export function extractStateMarker(input) {
  let text = String(input ?? '');
  let marker = null;

  const busyRe = /\[{1,2}\s*BUSY\s*\]{1,2}|【\s*BUSY\s*】/i;
  const freeRe = /\[{1,2}\s*FREE\s*\]{1,2}|【\s*FREE\s*】/i;

  if (busyRe.test(text)) marker = 'BUSY';
  else if (freeRe.test(text)) marker = 'FREE';

  if (marker) {
    text = text.replace(busyRe, '').replace(freeRe, '');
    // 标记独占一行时，会留下空行，顺手清掉多余空行
    text = text.replace(/\n{3,}/g, '\n\n').trim();
  }
  return { text, marker };
}

/**
 * 兜底判断：模型没给标记时用。
 *
 * 只匹配**极高置信度**的模式 —— 宁可漏判（继续普通模式），也不误判
 * （误判的后果是她明明该说话却安静如鸡）。
 *
 * 排除三类反例：
 *   否定  「我不忙」「没那么忙」
 *   问句  「你忙不忙」「忙吗」（在问她，不是自称忙）
 *   假设  「不忙的时候」
 */
export function guessMarker(text) {
  const t = String(text || '');

  // 排除否定
  if (/不忙|没那么忙|不着急|不用忙|不急/.test(t)) return null;
  // 排除问句（问她忙不忙 / 整句是提问）
  if (/你(忙|有空)|忙不忙|忙吗|有空吗|在忙吗/.test(t)) return null;
  if (/[？?]/.test(t)) return null;

  // 高置信度的"我要走了/我在忙"
  if (/^(我)?(在忙|忙着|先忙|得忙|要忙)/.test(t)) return 'BUSY';
  if (/我(要去|得出门|要出门|得去|先去|去打游戏|去上班|要上班|去加班|得加班|去开会|要开会|去洗澡|先睡|要睡了)/.test(t)) return 'BUSY';
  if (/(先不聊|回头聊|晚点聊|等会聊|一会儿聊|晚点说|等会说|先这样|挂了|下了)/.test(t)) return 'BUSY';

  return null;
}

/**
 * 判断这句话是不是**明确表示"我回来了/我有空了"**。
 *
 * 为什么需要它（实测踩到的坑）：
 *   用户说「我忙完了，现在有空」，模型却输出了 [BUSY] ——
 *   结果他刚说自己有空，她反而切进忙碌模式开始 25 分钟一条。
 *   标记是概率行为，这种方向性错误必须由代码强制纠正。
 *
 * 所以这个判断的优先级**高于模型标记**：只要命中，一律退出忙碌模式。
 */
export function looksFree(text) {
  const t = String(text || '');

  // 先排除问句 —— "你忙不忙""不忙吗"里的"不忙"是问句的一部分，不是"我有空了"
  if (/你(忙|有空)|忙不忙|忙吗|有空吗|回来了吗|下班了吗/.test(t)) return false;
  if (/[？?]/.test(t)) return false;

  return /忙完了|忙完啦|忙好啦|我回来了|我回来啦|回来了|回来啦|有空了|现在有空|不忙了|不忙啊|不忙呀|不忙呢|不忙，|闲下来了|闲了|结束啦|下班了|弄完了|搞定了/.test(t);
}
