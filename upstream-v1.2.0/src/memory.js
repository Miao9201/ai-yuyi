/**
 * 对话记忆
 *
 * headless 是一次性任务、跑完就退出，不保留会话。
 * 所以上下文靠这里维护：每个微信用户一份历史，组装任务时把最近几轮塞进去。
 *
 * 设计取舍：
 *   - 只留最近 N 轮（默认 6 轮），避免提示词无限膨胀
 *   - 落盘到 data/memory/<userId 哈希>.json，重启不丢
 *   - 单条长文本截断，防止一条大消息吃光预算
 */
import { readFile, writeFile, mkdir, appendFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.WX_RUNTIME_DATA_DIR || path.join(ROOT, 'data');
const MEM_DIR = path.join(DATA_DIR, 'memory');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

const MAX_TURNS = 6;          // 短期上下文只喂最近 6 轮
const MAX_CHARS_PER_MSG = 1200; // 单条超长截断

/**
 * 归档：完整聊天记录，永不覆盖。
 *
 * 为什么必须有：memory/*.json 只留最近 6 轮，第 7 轮进来就把第 1 轮挤掉了，
 * 等于「聊天记录」在磁盘上根本没存全。归档是 append-only 的 JSONL，
 * 一天一个文件，给知识库采集器和以后做 RAG 用。
 */
async function appendArchive(record) {
  try {
    await mkdir(ARCHIVE_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    await appendFile(
      path.join(ARCHIVE_DIR, `chat-${day}.jsonl`),
      JSON.stringify(record) + '\n',
      'utf8'
    );
  } catch (e) {
    // 归档失败不能影响聊天主流程
    console.warn('[memory] 归档失败:', e.message);
  }
}

/** 用户 id 里有 @ 和特殊字符，做哈希当文件名 */
function memPath(userId) {
  const h = createHash('sha1').update(userId).digest('hex').slice(0, 16);
  return path.join(MEM_DIR, `${h}.json`);
}

const cache = new Map();

/** Desktop delivery history is authoritative in SQLite; replaying this is idempotent. */
export async function syncConfirmedHistory(userId, history) {
  if (!Array.isArray(history) || history.length % 2) throw new Error('确认历史格式错误');
  for (let i=0;i<history.length;i++) {
    if (history[i]?.role !== (i%2?'assistant':'user') || typeof history[i].content !== 'string') throw new Error('确认历史角色错误');
  }
  const safe=history.slice(-MAX_TURNS*2).map(m=>({role:m.role,content:m.content.slice(0,MAX_CHARS_PER_MSG)}));
  await mkdir(MEM_DIR,{recursive:true});
  const dest=memPath(userId),tmp=dest+'.tmp';
  await writeFile(tmp,JSON.stringify(safe,null,2),'utf8');await rename(tmp,dest);
  cache.set(userId,safe);
}

export async function loadHistory(userId) {
  if (cache.has(userId)) return cache.get(userId);
  try {
    const raw = await readFile(memPath(userId), 'utf8');
    const arr = JSON.parse(raw);
    const safe = Array.isArray(arr) ? arr.slice(-MAX_TURNS * 2) : [];
    cache.set(userId, safe);
    return safe;
  } catch {
    cache.set(userId, []);
    return cache.get(userId);
  }
}

async function persist(userId, history) {
  cache.set(userId, history);
  try {
    await mkdir(MEM_DIR, { recursive: true });
    await writeFile(memPath(userId), JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    // 记忆写不进去不影响主流程，只是重启后丢失
    console.warn('[memory] 保存失败:', e.message);
  }
}

/**
 * 把历史 + 新问题组装成一段任务文本。
 * 明确告诉模型这是延续对话，避免它把历史当成无关内容忽略掉。
 */
/**
 * 把历史 + 人设 + 新问题组装成一段任务文本。
 *
 * 顺序有讲究：
 *   1. 人设在最前（决定语气）
 *   2. 对话历史在中间（提供上下文）
 *   3. 用户这句话在最后（紧贴指令，模型注意力最强）
 * 反过来把用户的话放前面，长对话下模型容易跑偏。
 */
export async function buildTask(userId, question, persona = null, opts = {}) {
  const history = await loadHistory(userId);
  const extraContext = String(opts.extraContext || '').trim();

  const lines = [];

  // ── 人设 ──
  if (persona) {
    lines.push(`你现在扮演下面这个角色。请注意：**完成任务优先于人设表演**——`);
    lines.push(`该查的照查、该给的答案照给，只是用这个角色的语气和方式表达。`);
    lines.push(`不要为了演出角色而拒绝干活，也不要编造事实来配合人设。`);
    lines.push('');
    lines.push(`【角色设定】${persona.title}`);
    lines.push(persona.prompt);
    lines.push('');
  }

  // ── 当前场景 / 本轮上下文（条数要求、知识库片段、搜索资料） ──
  if (extraContext) {
    lines.push(extraContext);
    lines.push('');
  }

  // ── 对话历史 ──
  if (history.length) {
    lines.push('以下是我与你的最近对话记录，请据此理解上下文：');
    lines.push('');
    for (const m of history) {
      const who = m.role === 'user' ? '我' : '你';
      const text = m.content.length > MAX_CHARS_PER_MSG
        ? m.content.slice(0, MAX_CHARS_PER_MSG) + '…（已截断）'
        : m.content;
      lines.push(`${who}：${text}`);
    }
    lines.push('');
  }

  // ── 用户这一轮 ──
  lines.push(history.length ? '现在我说：' : '我想问你：');
  lines.push(question);
  lines.push('');
  lines.push('请直接回答我这句话，不要复述上面的对话记录，也不要用"好的，我来扮演…"这类开场白。');
  return lines.join('\n');
}

/** 把这一轮问答记进历史 */
export async function appendTurn(userId, question, answer) {
  const history = await loadHistory(userId);

  // 先归档原文（不受下面的 6 轮裁剪影响）
  await appendArchive({
    at: new Date().toISOString(),
    userId,
    question: String(question ?? ''),
    answer: String(answer ?? '')
  });

  history.push({ role: 'user', content: question });
  history.push({ role: 'assistant', content: answer });
  // 只保留最近 MAX_TURNS 轮
  const trimmed = history.slice(-MAX_TURNS * 2);
  await persist(userId, trimmed);
}

/**
 * 把历史压成「最近 N 轮全文 + 更早的压成一行」。
 *
 * 目的：省 token 且不丢线索。
 * 之前是 6 轮全文，每轮平均 60-100 token，满负荷约 700-900 token/条。
 * 改成 3 轮全文 + 更早每轮压成一句摘要后，稳定在 400-500 token，
 * 而且越聊越久不会继续膨胀（硬上限由 MAX_TURNS 兜住）。
 *
 * 压缩是纯文本截断，不额外调模型 —— 不花一分钱。
 *
 * @param {Array} history [{role, content}]
 * @param {{recentTurns?:number, olderChars?:number}} opts
 * @returns {{digest:string, recent:Array}} digest=更早对话压成的一行摘要，recent=最近几轮原文
 */
export function compressHistory(history, opts = {}) {
  const { recentTurns = 3, olderChars = 40 } = opts;
  if (!Array.isArray(history) || !history.length) return { digest: '', recent: [] };

  const usable = history.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && m.content
  );
  const keepMsgs = recentTurns * 2;
  if (usable.length <= keepMsgs) return { digest: '', recent: usable };

  const older = usable.slice(0, usable.length - keepMsgs);
  const recent = usable.slice(usable.length - keepMsgs);

  // 更早的：一问一答并成一行，各自截断
  const digestLines = [];
  for (let i = 0; i < older.length; i += 2) {
    const q = String(older[i]?.content ?? '').replace(/\s+/g, ' ').trim();
    const a = String(older[i + 1]?.content ?? '').replace(/\s+/g, ' ').trim();
    const qs = q.length > olderChars ? q.slice(0, olderChars) + '…' : q;
    const as = a.length > olderChars ? a.slice(0, olderChars) + '…' : a;
    if (qs) digestLines.push(`我：${qs}` + (as ? ` / 你：${as}` : ''));
  }

  return {
    digest: digestLines.length ? digestLines.join('\n') : '',
    recent
  };
}

/** 清空某个用户的记忆 */
export async function clearHistory(userId) {
  cache.delete(userId);
  try {
    await writeFile(memPath(userId), '[]', 'utf8');
  } catch { /* 文件不存在就算了 */ }
}
