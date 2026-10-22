/**
 * 语忆AI —— 微信 iLink Bot 客户端主程序
 *
 * 模式：
 *   --mode=echo   收到什么回什么（验证链路）
 *   --mode=dsh    把消息交给 DSH 处理（路线 A：headless 子进程）
 *
 * 其他：
 *   --login       强制重新扫码
 *   --logout      清除登录凭证
 *   --verbose     打印更多细节
 *
 * 凭证存 ./data/credentials.json，配置存 ./data/config.json。
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ILINK_BASE_URL,
  MSG_TYPE,
  ApiError,
  isSessionExpired,
  setBotAgent,
  fetchQrCode,
  pollQrStatus,
  notifyStart,
  notifyStop,
  getUpdates,
  sendMessage,
  getConfig as getBotConfig,
  sendTyping,
  textItem,
  extractText,
  describeItems,
  splitText,
  TYPING_STATUS
} from './ilink.js';

import { runTask, describeRuntime, resolveDshCommand } from './dsh.js';
import { chatComplete, buildChatMessages, readApiKey } from './chat.js';
import { buildTask, appendTurn, clearHistory, loadHistory, compressHistory } from './memory.js';
import {
  listPersonas, getPersona, getUserPersona, setUserPersona, ensurePersonaDir
} from './persona.js';
import { stripActions, splitIntoBubbles, extractStickers, ensureEmoji, ensureSticker, adjustBubbleCount } from './output.js';
import { createProactiveScheduler, touchUser } from './proactive.js';
import {
  recentLines, recentScenarios, isTooSimilar, rememberLine, fallbackLine,
  pickScenario, SCENARIO_HINTS
} from './proactivehistory.js';
import {
  isBusy, setBusy, setFree, getState as getBusyState, getAllBusy,
  extractStateMarker, guessMarker, looksFree
} from './busymode.js';
import { matchAction, runAction, listActions, ensureActionsFile } from './actions.js';
import { webSearch, formatSources, needsSearch, buildSearchQuery, readAnySearchKey } from './websearch.js';

/**
 * 搜索通道参数。
 * 2026-10-20 换引擎（DeepSeek → AnySearch）只动了配置和 websearch.js 内部，
 * 调用点、自动搜索判定、预算闸门、结果注入全部保持原样。
 */
function searchOptions(cfg = {}) {
  return {
    provider: cfg.searchProvider || 'anysearch',
    apiKey: cfg.anysearchApiKey || '',
    baseUrl: cfg.anysearchBaseUrl || '',
    maxResults: cfg.searchMaxResults || 5,
    maxUses: cfg.searchMaxUses || 3,
    timeoutMs: cfg.searchTimeoutMs || 30_000,
    fallbackProvider: cfg.searchFallback === false ? '' : 'deepseek',
    fallbackTimeoutMs: cfg.searchFallbackTimeoutMs || 90_000
  };
}
import { canSearch, recordSearch, getUsage as getSearchUsage } from './searchbudget.js';
import {
  searchVault,
  formatHits,
  formatProfile,
  getProfileDigest,
  getRecentTopics,
  formatRecentTopics,
  ensureIndex as ensureVaultIndex,
  getStatus as getVaultStatus,
  rebuildIndex as rebuildVaultIndex
} from './vault.js';
import {
  loadScene, saveScene, resetScene, createScene, analyzeTurn,
  recordUserTurn, recordReply, canOpenNewTopic, markNewTopic,
  formatSceneForReply, formatSceneForProactive, topicOf, lastQuestionOf
} from './scene.js';
import {
  loadEmotion, saveEmotion, resetEmotion, analyzeEmotion, decideStance,
  stickerPoolFor, kaomojiMoodFor, bubbleBiasFor, moodLabel, MOODS,
  formatEmotionForReply, formatEmotionForProactive, formatStanceForReply
} from './emotion.js';
import {
  noteUserMessage, detectAnnoyance, banRelated, isSuppressed,
  formatForgetBlock, prune as pruneTopics
} from './forget.js';
import {
  loadLife, saveLife, resetLife, activeArc, currentBeat, canStartArc,
  startArc, advanceArc, dropArc, formatLifeForProactive, formatLifeForReply,
  closedTitles, DEFAULT_CAST
} from './life.js';
import { imageItemsOf, downloadInboundImage } from './inbound.js';
import { describeImages, describeVisionFailure, resolveVisionTarget, resolveFallbackTarget } from './vision.js';

/**
 * 这句话是不是在问「关于我自己」的事。
 * 命中就走画像事实卡那条路，而不是干等 BM25 的字面匹配。
 */
function isSelfReferential(text) {
  return /关于我|我的(资料|信息|画像|习惯|爱好|电脑|配置|笔记|知识库|数据)|你知道(我|些)|了解我|记得我|我是谁|我是什么|我平时|我玩|我用|我家|你的?(笔记|资料|知识库)|你(写|记)的|库里(有|存)/.test(String(text || ''));
}

import { sendImage, sendImageVariant } from './media.js';
import { listStickers, pickSticker, ensureStickerDir, stickerDirPath, listCategories } from './sticker.js';
import {
  generateImage,
  looksLikeDrawRequest,
  extractDrawSubject,
  extractDrawMarker,
  checkDrawBudget,
  recordDraw,
  describeDrawFailure
} from './imagegen.js';
import { decideAutoImage, checkAutoBudget, recordAutoImage, formatAutoImageNote } from './autoimage.js';
import { loadConfig, ensureConfigFile, writeConfig, CFG_PATH, ROOT } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRED_PATH = path.join(ROOT, 'data', 'credentials.json');

// ── 命令行参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const MODE = opt('mode', 'dsh');

// chat 模式用的密钥与 DSH 模式同源（都读 DSH 凭证文件），保证只有一把钥匙
const API_KEY = readApiKey();

/** /状态 里显示"主用哪家识图"（配了 Key 才算可用，否则返回空串） */
function visionTargetLabel(cfg) {
  const t = resolveVisionTarget(cfg, API_KEY.key);
  return t.apiKey ? `${t.label} ${t.model}` : '';
}
const FORCE_LOGIN = flag('--login');
const VERBOSE = flag('--verbose');

// ── 日志 ────────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}]`, ...a);

// ── 凭证 ────────────────────────────────────────────────────────────────────
function isValidCred(v) {
  return v && typeof v === 'object'
    && typeof v.token === 'string' && v.token.length > 0
    && typeof v.baseUrl === 'string'
    && typeof v.accountId === 'string'
    && typeof v.userId === 'string';
}

async function loadCred() {
  try {
    const raw = await readFile(CRED_PATH, 'utf8');
    const v = JSON.parse(raw);
    if (isValidCred(v)) return v;
    warn('凭证文件格式不对，将重新登录');
  } catch (e) {
    if (e.code !== 'ENOENT') warn('读取凭证失败:', e.message);
  }
  return undefined;
}

async function saveCred(cred) {
  await mkdir(path.dirname(CRED_PATH), { recursive: true });
  await writeFile(
    CRED_PATH,
    JSON.stringify({ ...cred, savedAt: new Date().toISOString() }, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );
}

// ── 登录 ────────────────────────────────────────────────────────────────────
async function login(baseUrl = ILINK_BASE_URL) {
  log('正在获取微信登录二维码…');

  for (let round = 1; round <= 8; round++) {
    const qr = await fetchQrCode(baseUrl);
    if (!qr.qrcode || !qr.qrcode_img_content) {
      throw new Error('接口没有返回二维码：' + JSON.stringify(qr).slice(0, 200));
    }

    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │  用手机微信打开下面的链接完成登录                        │');
    console.log('  └──────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('    ' + qr.qrcode_img_content);
    console.log('');
    console.log('    有效期约 2 分钟，等待扫码中…');
    console.log('');

    let last;
    const deadline = Date.now() + 150_000;

    while (Date.now() < deadline) {
      await delay(2000);
      let status;
      try {
        status = await pollQrStatus(baseUrl, qr.qrcode);
      } catch (e) {
        warn('查询扫码状态出错:', e.message);
        continue;
      }

      if (status.status !== last) {
        if (status.status === 'scaned') console.log('    已扫码，请在微信里点「确认登录」…');
        else if (status.status === 'confirmed') console.log('    登录确认成功');
        else if (status.status === 'expired') console.log('    二维码已过期');
        last = status.status;
      }

      if (status.status === 'confirmed') {
        if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
          throw new Error('扫码已确认，但缺少凭证字段：' + JSON.stringify(status).slice(0, 300));
        }
        const cred = {
          token: status.bot_token,
          baseUrl: status.baseurl ?? baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id
        };
        await saveCred(cred);
        log(`登录成功  账号=${cred.accountId}`);
        return cred;
      }

      if (status.status === 'expired') break;
    }

    if (round < 8) log('二维码过期，重新获取…');
    else throw new Error('连续 8 次二维码过期，请检查网络后重试');
  }
}

// ── 消息发送辅助 ────────────────────────────────────────────────────────────

/** 发一条文本（自动分块），返回是否成功 */
async function sendText(state, toUserId, text) {
  if (state.desktopTransport) return state.desktopTransport.sendText(toUserId, text);
  const contextToken = state.contextTokens.get(toUserId) ?? '';
  if (!contextToken) {
    warn('缺少 context_token，无法回复。这是 iLink 的硬限制：必须由用户先发消息。');
    return false;
  }
  const cred = state.cred;
  let ok = true;
  for (const chunk of splitText(text)) {
    try {
      await sendMessage(cred.baseUrl, cred.token, toUserId, contextToken, [textItem(chunk)]);
    } catch (e) {
      warn('发送消息失败:', e.message);
      ok = false;
      break;
    }
  }
  return ok;
}

/** 尽力发一次"正在输入"，失败就算了 —— 这只是体验优化 */
async function tryTyping(state, toUserId, on = true) {
  if (!state.cfg.sendTyping) return;
  const contextToken = state.contextTokens.get(toUserId) ?? '';
  if (!contextToken) return;
  try {
    const cfgResp = await getBotConfig(state.cred.baseUrl, state.cred.token, toUserId, contextToken);
    const ticket = cfgResp?.typing_ticket;
    if (!ticket) return;
    await sendTyping(state.cred.baseUrl, state.cred.token, toUserId, ticket, on ? 1 : 2);
  } catch {
    /* 输入状态失败不影响主流程 */
  }
}

// ── DSH 处理 ────────────────────────────────────────────────────────────────

/** 每个用户一条串行队列：同一人连发时按顺序处理，不并发抢机器 */
const userQueues = new Map();

/** 每个用户上一次回复发了几条，用来保证这一轮不重复 */
const lastBubbleCount = new Map();
// 最近几句他说的话（判断"别老提那个"时，"那个"指什么只能从这里推）
const recentUserTexts = new Map();

/**
 * 表情包频率闸门。
 *
 * 实测：把人格里"什么时候发哪一类"写详细之后，模型主动发图率从 0/4 涨到 4/6，
 * 但这种密度远超"每 5~8 条一次"的要求 —— 情绪一激动就会每条都甩图。
 * 所以代码里上一道冷却：两次发图之间至少隔 stickerMinTurns 轮。
 */
const replyTurnCount = new Map();     // userId → 已经回复过多少轮
const lastStickerTurn = new Map();    // userId → 上次发图是在第几轮

/**
 * 语境自发生图：她自己判断"这时候给你看张图"更自然。
 *
 * lastAutoImageTurn 记轮次（记忆里的冷却），pendingProactiveImages 存主动消息
 * 里已经决定好、等文字发完再补的那张图（生成要 8~14 秒，不能挡在文字前面）。
 */
const lastAutoImageTurn = new Map();      // userId → 上次自发生图在第几轮
const pendingProactiveImages = new Map(); // userId → {kind, subject, caption, reason}
const pendingLifeAdvance = new Map();     // userId → {life, text, title} 等文字真发出去再推进剧情

/**
 * 挑这一轮要发几条：1-5 随机，且不等于上一次。
 *
 * 为什么排除上一次：连着两轮都发同样条数，聊天节奏会显得机械。
 * 排除后至少保证"条数会变"，这是人眼最容易察觉的地方。
 */
function pickBubbleCount(last, min = 1, max = 5, bias = 0) {
  // 情绪会改变话量：开心/黏人偏多，疲惫/生气偏少。
  // 不是直接加减条数（会出现 0 条或 6 条），而是改变抽中某档的概率。
  const pool = [];
  for (let n = min; n <= max; n++) {
    if (n === last) continue;
    const weight = bias > 0 ? 1 + bias * (n - min) * 0.35 : bias < 0 ? 1 + bias * (max - n) * 0.35 : 1;
    for (let i = 0; i < Math.max(1, Math.round(weight * 3)); i++) pool.push(n);
  }
  if (!pool.length) return min;
  return pool[Math.floor(Math.random() * pool.length)];
}

function enqueue(userId, job) {
  const prev = userQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(job).catch((e) => warn('队列任务出错:', e.message));
  userQueues.set(userId, next);
  next.finally(() => {
    if (userQueues.get(userId) === next) userQueues.delete(userId);
  });
  return next;
}

/**
 * "这句话是不是换了话题"——拿不准时才调的模型判题（折中方案的那一小步）。
 *
 * 为什么要限频：这类判断如果每条消息都做，等于每条多一次调用，白烧钱。
 * 所以只在两个条件同时满足时才问：
 *   ① 本地规则落在"中间地带"（关键词重合度 0.08~0.18，既不重叠也不完全无关）
 *   ② 这一小时还没问满 sceneAnalyzeMaxPerHour 次
 * 其余情况直接按"延续"处理 —— 连贯性优先。
 *
 * 返回 'continue' | 'new' | null（null = 没问/失败，调用方用默认值）
 */
const sceneJudgeTimes = [];
async function judgeSceneChange(state, text, scene) {
  if (!scene || !scene.topic) return null;
  if (state.cfg.sceneAnalyzeModel === false) return null;

  const now = Date.now();
  const limit = Math.max(0, state.cfg.sceneAnalyzeMaxPerHour ?? 6);
  // 清掉一小时前的记录，保持数组很短
  while (sceneJudgeTimes.length && now - sceneJudgeTimes[0] > 60 * 60 * 1000) sceneJudgeTimes.shift();
  if (sceneJudgeTimes.length >= limit) return null;

  sceneJudgeTimes.push(now);
  try {
    const r = await chatComplete({
      baseUrl: state.cfg.chatBaseUrl,
      apiKey: API_KEY.key,
      model: state.cfg.chatModel,
      messages: [
        {
          role: 'system',
          content: '你只做一件事：判断接下来这句话，是不是在跟上面那件事说再见、换一个新话题。\n只输出两个词之一：CONTINUE（还是同一件事）或 NEW（换了新话题）。不要解释。'
        },
        {
          role: 'user',
          content: `当前在聊的事：${scene.topic}\n他上一句说的是：${scene.lastUserText || '（无）'}\n他这句话是：${text}`
        }
      ],
      temperature: 0,
      timeoutMs: 15000
    });
    if (!r.ok) return null;
    const t = r.text.trim().toUpperCase();
    if (t.includes('NEW')) return 'new';
    if (t.includes('CONTINUE')) return 'continue';
    return null;
  } catch {
    return null;
  }
}

async function handleWithDsh(state, msg, text) {
  const userId = msg.from_user_id;
  if(state.companionMode){state.companionVision='';state.companionRequestedMedia=[];}

  // ── 收图识图 ────────────────────────────────────────────────────────────
  //
  // 分工：识图（vision.js）只把图变成一段客观描述；怎么回你，仍由 DeepSeek
  // 带着人设和场景去说。所以这里产出的是一段「上下文材料」，不是回复本身。
  // 2026-10-19 起主用 DeepSeek 自己的多模态（同一把 Key），豆包降为备用。
  //
  // 硬要求（用户原话）：识图失败不许抛错，要像人一样说"我的眼睛看不见了"。
  // 所以下载/识图的每一步都单独兜住，任何失败都退化成一句提示词，由她来说。
  const imgItems = imageItemsOf(msg);
  let imageBlock = '';
  let imageCount = 0;

  if (imgItems.length) {
    const maxImages = Math.max(1, Number(state.cfg.visionMaxImages ?? 1));
    const files = [];

    for (const item of imgItems.slice(0, maxImages)) {
      try {
        const got = await downloadInboundImage(item, {
          destDir: path.join(process.env.WX_RUNTIME_DATA_DIR || path.join(ROOT, 'data'), 'media', 'inbox'),
          timeoutMs: Math.max(5000, Number(state.cfg.visionImageTimeoutMs ?? 20000))
        });
        files.push(got);
        log(`  [识图] 收到图片 ${(got.bytes / 1024).toFixed(0)}KB ${got.mime}`);
      } catch (e) {
        warn(`  [识图] 图片下载失败: ${e.message}`);
      }
    }

    if (files.length) {
      const vision = state.cfg.visionEnabled === false
        ? { ok: false, kind: 'nokey', reason: '识图功能被关掉了', descriptions: [] }
        : await describeImages(files, { cfg: state.cfg, log, warn, apiKey: API_KEY.key });

      if (vision.ok) {
        if(state.companionMode)state.companionVision=vision.descriptions.join('\n').slice(0,1200);
        imageCount = vision.descriptions.length;
        imageBlock = [
          `【他刚发来 ${vision.descriptions.length} 张图片，下面是看图得到的客观描述】`,
          ...vision.descriptions.map((d, i) => `（图${i + 1}）${d}`),
          '【这段描述只用来让你看懂图，不要照着念。用你的人设自然回应，就像你真的看见了：',
          '图里有事（报错、人物、地点、文字）就顺着聊，看不出重点就直接问他。】'
        ].join('\n');
      } else {
        imageBlock = [
          `【他刚发来一张图片，但你现在看不见它：${describeVisionFailure(vision.kind)}。】`,
          '【用你的人设、带点情绪地说明你看不了图，并让他用文字讲讲图里是什么。',
          '绝对不要说"API""接口""报错""系统繁忙""模型"这些词，就当是眼睛这会儿不好使。】'
        ].join('\n');
        log(`  [识图] 失败 kind=${vision.kind}${vision.reason ? `（${vision.reason}）` : ''}`);
      }
    } else {
      imageBlock = '【他发来一张图片，但图没下载下来（网络问题）。请用你的人设自然地让他再发一次。】';
    }
  }

  // 有图就算有内容；既没字也没图才算真的空消息
  if (!text && !imgItems.length) {
    await sendText(state, userId, `这个版本只处理文字和语音（收到的是${describeItems(msg)}）。`);
    return;
  }

  // 只有图没配字时，给模型一个占位话术，让场景/历史/拆条都能正常走
  const contentText = text && String(text).trim() ? text : '（发来一张图片，没配文字）';
  text = contentText;

  const queueLen = userQueues.has(userId) ? 1 : 0;
  if (queueLen >= state.cfg.maxQueuePerUser) {
    await sendText(state, userId, '你前面还有任务在处理，这条先不算了。等会儿再发。');
    return;
  }

  const started = Date.now();

  // 处理中的可见反馈：默认只发"正在输入"，不刷一句话。
  // 想要那句"收到，正在处理…"的话，config.json 里把 showQueuedNotice 设为 true。
  await tryTyping(state, userId, true);
  const pending = state.cfg.showQueuedNotice
    ? sendText(state, userId, '收到，正在处理…')
    : Promise.resolve(false);

  // 组装任务：人设 + 历史 + 这一轮
  const personaName = await getUserPersona(userId) || state.cfg.defaultPersona;
  const basePersona = personaName ? await getPersona(personaName) : null;

  // ── 生图：他直接说"帮我画一张…"时，先把图画出来发过去 ────────────────────
  //
  // 顺序上必须"先画、再说话"：出图要 10 秒左右，如果等模型写完再画，
  // 就会出现"她说画好了"但图还在路上。画完把结果写进本轮上下文，
  // 她只需要自然补一两句 —— 说什么由她（人设+情绪），但图是真的。
  let drawBlock = '';
  let drawSubject = '';
  if (state.cfg.imageGenEnabled !== false && looksLikeDrawRequest(text)) {
    drawSubject = extractDrawSubject(text);
    if (drawSubject) {
      const draw = await drawAndSend(state, userId, drawSubject, 'user');
      if (draw.ok) {
        drawBlock = [
          `【你刚刚已经把他要的画发过去了：「${drawSubject}」】`,
          '【现在只用自然地说一两句 —— 比如画成了什么样、你哪里满意、顺手问他要不要改。',
          '不要说"图已生成""已发送"这种机械话，也不要提你用了什么工具。】'
        ].join('\n');
        log(`  [生图] 他说要画：${drawSubject}`);
      } else {
        drawBlock = [
          `【他让你画「${drawSubject}」，但你这次没画成：${describeDrawFailure(draw.kind)}。】`,
          '【用你的人设自然说明一下，别用"接口/API/报错/额度"这些词；可以说等会儿再试。】'
        ].join('\n');
      }
    }
  }

  // ── 场景状态：先搞清楚"我们正在聊什么"，再决定怎么接 ──────────────────
  //
  // 用户的要求是"一个语境、一个场景、一个整体的事"。实现上分三步：
  //   ① 读出当前场景（落盘的，重启不丢）
  //   ② 判断这句是延续还是换题 —— 本地规则优先，拿不准才问模型（限频）
  //   ③ 把场景段落放进本轮动态上下文，并明确要求"接着讲"
  const sceneEnabled = state.cfg.sceneEnabled !== false;
  let scene = sceneEnabled ? await loadScene(userId) : null;
  let sceneMode = 'new';
  let sceneBlock = '';
  let sceneReason = '';

  // ── 遗忘：旧话题会过期，"这个别再提了"会进黑名单 ────────────────────────
  //
  // 场景记的是"这一件事"，但旧兴趣点（这里、知识库、近期笔记）没有衰减，
  // 于是会出现"总是提 ComfyUI"这种毛病。规则很硬：
  //   ① 只有最近 topicTtlHours（默认 48 小时）他说过的话题，才算"还在聊"；
  //   ② 他说"别老提这个"，立刻把相关关键词拉黑 topicBanHours（默认 7 天）。
  const forgetEnabled = state.cfg.forgetEnabled !== false;
  let forgetBlock = '';
  let droppedByForget = false;
  if (forgetEnabled) {
    const ttlHours = Math.max(1, state.cfg.topicTtlHours ?? 48);
    const banHours = Math.max(1, state.cfg.topicBanHours ?? 168);
    const recentTexts = recentUserTexts.get(userId) || [];
    const annoy = detectAnnoyance(text);

    // 她自己开的话题、他一句都没接（turns=0），超过半小时还挂着 ——
    // 那不是"我们在聊的事"，是她一个人的独白。当它没发生过，别拿来反复开场。
    if (scene && scene.source === 'proactive' && (scene.turns || 0) === 0
        && Date.now() - (scene.updatedAt || 0) > 30 * 60e3) {
      await resetScene(userId);
      scene = null;
      droppedByForget = true;
      log('  [遗忘] 上一条是她自己开的话题、他没接 → 作废，不当作"正在聊的事"');
    }

    if (annoy.annoyed) {
      const banned = banRelated(userId, { scene, recentTexts, hours: banHours });
      await resetScene(userId);
      scene = null;
      droppedByForget = true;
      const what = (banned.labels || []).map((l) => `「${l}」`).join('')
        || (banned.keywords || []).join('、') || '最近这几句';
      log(`  [遗忘] 他不想再提这茬 → 拉黑 ${what}（${banHours} 小时），场景已清`);
    }

    noteUserMessage(userId, text, { ttlHours });
    recentUserTexts.set(userId, [...recentTexts, text].slice(-6));
    forgetBlock = formatForgetBlock(userId, { ttlHours });
  }

  if (sceneEnabled && !droppedByForget) {
    const analysis = analyzeTurn(text, scene, {
      ttlMs: Math.max(30, state.cfg.sceneTtlMinutes ?? 180) * 60 * 1000
    });
    sceneMode = analysis.mode;
    sceneReason = analysis.reason;

    if (sceneMode === 'ambiguous') {
      // 拿不准时的折中：默认当成"延续"（连贯性优先，宁可接错也不突然换题）。
      // 只有配置允许、且限频没超，才花一次小额调用让模型判。
      sceneMode = 'continue';
      const verdict = await judgeSceneChange(state, text, scene);
      if (verdict === 'new') sceneMode = 'new';
      if (verdict) sceneReason += `（模型判 ${verdict}）`;
    }

    if (sceneMode === 'new') {
      const prevTopic = scene?.topic;
      scene = createScene(text, { source: 'user' });
      log(`  [场景] 新场景「${scene.topic}」${prevTopic ? `（上一件：${prevTopic}）` : ''}`);
    } else {
      recordUserTurn(scene, text);
      log(`  [场景] 延续「${scene.topic}」（第 ${scene.turns} 轮，${sceneReason}）`);
    }

    sceneBlock = formatSceneForReply(scene, { mode: sceneMode });
  }

  // ── 情绪：这一轮她是什么底色、要不要顶嘴 ────────────────────────────────
  //
  // 和场景一样是持久状态（data/emotions/*.json），因为情绪最怕的就是逐句随机。
  // 分工：规则决定"什么事会让她有情绪"，掷骰子只决定"这一刻换不换脸"，
  // 而且换脸受驻留时间、强度和冷却约束 —— 所以有脾气但不会情绪不稳定。
  const emotionEnabled = state.cfg.emotionEnabled !== false;
  let emo = emotionEnabled ? await loadEmotion(userId) : null;
  let emotionBlock = '';
  let stanceBlock = '';
  let stance = 'follow';
  if (emotionEnabled && emo) {
    const before = emo.mood;
    const res = analyzeEmotion(emo, { userText: text, cfg: state.cfg });
    emo = res.emotion;
    if (res.changed) {
      log(`  [情绪] ${before} → ${moodLabel(emo)}（${res.reason}，强度 ${Math.round((emo.intensity || 0) * 100)}%）`);
    }
    emotionBlock = formatEmotionForReply(emo);

    const st = decideStance(emo, text, { cfg: state.cfg, turn: emo.totalTurns || 0 });
    emo = st.emotion;
    stance = st.stance;
    if (stance !== 'follow') {
      stanceBlock = formatStanceForReply(stance);
      log(`  [情绪] 这轮不顺着说：${stance}`);
    }
    await saveEmotion(userId, emo);
  }

  // 联网搜索：这句话涉及时效性信息、或明确要求查的时候，先搜一下。
  // 搜到的东西作为「参考资料」塞进提示词，让她基于真实结果回答而不是编。
  //
  // 搜索前先过预算闸：一次搜索约 4000 tokens + 4.8 秒。
  // 不设上限的话她会十句话搜八次，又慢又贵。超预算就静默跳过。
  let searchBlock = '';
  if (state.cfg.autoSearch && needsSearch(text)) {
    const budget = canSearch({
      hourlyLimit: state.cfg.searchHourlyLimit,
      dailyLimit: state.cfg.searchDailyLimit
    });
    if (!budget.allowed) {
      log(`  [搜索] 跳过 —— ${budget.reason}`);
    } else {
      const searchQuery = buildSearchQuery(text, scene && scene.topic);
      log(`  [搜索] 触发联网搜索: ${searchQuery.slice(0, 40)}（本小时 ${budget.hourUsed}${budget.hourlyLimit > 0 ? `/${budget.hourlyLimit}` : ''}，今天 ${budget.dayUsed}${budget.dailyLimit > 0 ? `/${budget.dailyLimit}` : ''}）`);
      try {
        recordSearch();
        const sr = await webSearch(searchQuery, searchOptions(state.cfg));
        if (sr.ok && (sr.sources.length || sr.answer)) {
          const lines = ['【联网搜索到的真实资料】'];
          // answer 是模型拿着真实网页读完之后写的摘要——比只有标题有用得多。
          // 原来只塞 sources（标题+URL），她只会回"我搜到一堆网页但没看到天气"。
          if (sr.answer) {
            lines.push('搜索摘要（根据抓到的网页整理）：', sr.answer.slice(0, 1200), '');
          }
          if (sr.sources.length) {
            lines.push('来源：', formatSources(sr.sources, 4), '');
          }
          lines.push(
            '请基于上面这些真实资料回答，把结果说成自己的话（不要罗列网址）。',
            '如果资料里确实没有相关信息，就老实说没查到，绝对不要凭印象编造。',
            '提到出处时说"网上查到的"就行。'
          );
          searchBlock = lines.join('\n');
          log(`  [搜索] ${sr.provider || '?'} 拿到 ${sr.sources.length} 条结果${sr.answer ? `、摘要 ${sr.answer.length} 字` : ''}${sr.fallbackFrom ? `（${sr.fallbackFrom} 失败后回退）` : ''}`);
        } else {
          log(`  [搜索] 无结果或失败（${sr.provider || '?'}）: ${sr.error || '空'}`);
        }
      } catch (e) {
        warn('  [搜索] 异常: ' + e.message);
      }
    }
  }

  // 知识库检索：从 Obsidian 库里找和这句话相关的笔记片段。
  // 只有分数过线才注入 —— 宁可没有背景资料，也不要塞一堆不相关的东西把回复带歪。
  //
  // 另外有一条单独的路：问到"关于我/你知道我什么/我的电脑"这类自指问题时，
  // 直接注入一份「画像事实卡」。原因是 BM25 只匹配字面，画像笔记的标题写的是
  // 「设备/技术栈/数字足迹」，和用户的问法几乎没有共同词，实测整句只命中
  // 1 条 0.47 的边缘片段，等于没有。事实卡不走检索，直接给事实。
  let ragBlock = '';
  if (state.cfg.ragEnabled && state.cfg.vaultPath && text.length >= 2) {
    const selfRef = isSelfReferential(text);

    if (selfRef) {
      try {
        const digest = getProfileDigest(
          state.cfg.vaultPath,
          state.cfg.profileNotes || [],
          state.cfg.profileMaxChars ?? 1100
        );
        if (digest) {
          ragBlock = formatProfile(digest);
          log(`  [知识库] 自指提问 → 注入完整画像事实卡（${digest.length} 字符）`);
        }
      } catch (e) {
        warn('  [知识库] 画像摘要异常: ' + e.message);
      }
    } else if ((state.cfg.sceneProfileChars ?? 0) > 0) {
      // 分层注入的第一层：每轮都带一小段"她本来就知道的事"。
      // 不做的话，只有问到"关于我"时才想起你的资料，平时聊天像个陌生人。
      // 360 字符 ≈ 250 tokens，换来的是"她一直知道你是什么人、在意什么"。
      try {
        const small = getProfileDigest(
          state.cfg.vaultPath,
          state.cfg.profileNotes || [],
          state.cfg.sceneProfileChars ?? 360
        );
        if (small) {
          ragBlock = [
            '【你本来就记得的、关于他的一些事（真事，别装作不知道）】',
            small,
            '',
            '这些是你的常识，不用刻意提，但他说到相关的事时你要接得上，',
            '不要问那些你明明知道答案的问题。也不要一口气把上面全念出来。'
          ].join('\n');
        }
      } catch (e) {
        warn('  [知识库] 小画像异常: ' + e.message);
      }
    }

    // 分层注入的第二层：他最近在弄什么（笔记标题）。
    // 画像回答「他是个什么人」，这一层回答「他这阵子在忙哪件事」，是"聊什么"的抓手。
    if ((state.cfg.sceneRecentTopics ?? 5) > 0) {
      try {
        // 只认最近两天（默认）的在弄的事；被他明确说"别提了"的，整条滤掉。
        // 旧版本的 30 天窗口正是"总是提 ComfyUI"的帮凶。
        const items = getRecentTopics(state.cfg.vaultPath, {
          days: state.cfg.recentTopicDays ?? 2,
          maxItems: (state.cfg.sceneRecentTopics ?? 5) + 3
        }).filter((i) => !isSuppressed(userId, i.title))
          .slice(0, state.cfg.sceneRecentTopics ?? 5);
        const block = formatRecentTopics(items);
        if (block) {
          ragBlock = ragBlock ? ragBlock + '\n\n' + block : block;
          log(`  [知识库] 近期笔记 ${items.length} 条 → ${items.map((i) => i.title).slice(0, 3).join(' / ')}`);
        }
      } catch (e) {
        warn('  [知识库] 近期话题异常: ' + e.message);
      }
    }

    try {
      // 延续话题时把场景词也带进检索，比只拿当前这句去搜更容易捞到同一条线上的笔记
      const query = sceneMode === 'continue' && scene?.topic
        ? `${scene.topic} ${text}`
        : text;
      const rr = await searchVault(query, state.cfg.vaultPath, {
        topK: selfRef ? 2 : (state.cfg.ragTopK ?? 3),
        minScore: selfRef ? 0.25 : (state.cfg.ragMinScore ?? 0.35)
      });
      if (rr.ok && rr.hits.length) {
        const hitsBlock = formatHits(rr.hits);
        ragBlock = ragBlock ? ragBlock + '\n\n' + hitsBlock : hitsBlock;
        log(`  [知识库] 命中 ${rr.hits.length} 段（最高 ${rr.hits[0].score}，${rr.ms}ms）→ ${rr.hits[0].title}`);
      } else if (!rr.ok) {
        log(`  [知识库] 跳过：${rr.error}`);
      } else if (!selfRef) {
        log(`  [知识库] 无相关内容（${rr.ms}ms）`);
      }
    } catch (e) {
      warn('  [知识库] 异常: ' + e.message);
    }
  }

  // 她自己的生活线：故事讲了一半就让她能顺着说；讲完的只留一句"别再主动提"。
  let lifeBlock = '';
  try {
    if (state.cfg.lifeEnabled !== false) {
      const lifeNow = loadLife(userId);
      lifeBlock = formatLifeForReply(activeArc(lifeNow), { closed: closedTitles(lifeNow) });
    }
  } catch (e) {
    warn('  [生活线] 读取失败: ' + e.message);
  }

  // 这一轮要发几条：1-5 随机，且不能和上一条相同。
  // 人设里写"发几条"模型执行得不准，所以既告诉它、又在代码里强制兜底。
  const targetCount = state.cfg.desktopNaturalReplies ? 1 : pickBubbleCount(lastBubbleCount.get(userId), 1, 5, bubbleBiasFor(emo));

  // 本轮动态上下文：场景 + 情绪 + 态度 + 条数要求 + 知识库 + 搜索结果。
  // 注意：不拼进 persona.prompt，走 buildChatMessages 的 dynamicContext，
  // 这样人格那段 system 前缀保持稳定、能吃上缓存。
  const dynamicContext = [
    state.desktopStyleContext || '',
    sceneBlock,
    forgetBlock,
    lifeBlock,
    emotionBlock,
    stanceBlock,
    imageBlock,
    drawBlock,
    `【本轮要求】这次回 ${targetCount} 条消息，用空行隔开。`,
    `每条短一点，整体别啰嗦。条数必须是 ${targetCount} 条，不能多也不能少。`,
    ragBlock,
    searchBlock
  ].filter(Boolean).join('\n');

  const persona = basePersona;

  // 两条通道：
  //   chat —— 直连 API，只带人设和历史，输入约 2400 tokens，快且省
  //   dsh  —— 走 DSH headless，带全套工具（约 17000 tokens），能干活但贵
  let result;
  if (MODE === 'chat') {
    const history = await loadHistory(userId);
    const messages = buildChatMessages(persona, history, text, {
      dynamicContext,
      recentTurns: state.cfg.historyRecentTurns ?? 3,
      olderChars: state.cfg.historyOlderChars ?? 40,
      compress: compressHistory
    });
    result = await chatComplete({
      baseUrl: state.cfg.chatBaseUrl,
      apiKey: API_KEY.key,
      model: state.cfg.chatModel,
      messages,
      temperature: state.cfg.chatTemperature,
      timeoutMs: state.cfg.taskTimeoutMs
    });
  } else {
    const task = await buildTask(userId, text, persona, { extraContext: dynamicContext });
    const workdir = state.cfg.workdir
      ? path.resolve(ROOT, state.cfg.workdir)
      : ROOT;
    result = await runTask(task, {
      timeoutMs: state.cfg.taskTimeoutMs,
      cwd: workdir
    });
  }

  await pending;
  await tryTyping(state, userId, false);

  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (result.ok) {
    // 处理顺序很重要：
    //   0) 先摘掉状态标记（[BUSY]/[FREE]），绝不能发给你看
    //   1) 再摘表情包标记
    //   2) 去掉括号动作描述
    //   3) 拆成多条短消息，中间带真人停顿
    const markerRes = extractStateMarker(result.text);

    // 判定顺序有讲究：
    //   ① "我回来了/忙完了/有空了" —— 这类话优先级最高，一律退出忙碌模式。
    //      实测模型会把「我忙完了，现在有空」错标成 [BUSY]，所以不能只信标记。
    //   ② 然后才看模型标记
    //   ③ 最后才是高置信度规则兜底
    if (looksFree(text)) {
      const r = setFree(userId, '话里明确表示有空');
      if (r.changed) log(`  [忙碌] 命中"我回来了/忙完了" → 退出忙碌模式（持续 ${r.lastedMin} 分钟），回归普通节奏`);
    } else if (markerRes.marker === 'BUSY') {
      const r = setBusy(userId, text.slice(0, 40));
      log(`  [忙碌] 检测到 [BUSY] → 切进忙碌模式${r.changed ? '（首次）' : '（已在忙）'}：每 ${state.cfg.busyIntervalMinutes ?? 25} 分钟发 ${state.cfg.busyMinCount ?? 2}-${state.cfg.busyMaxCount ?? 3} 条，不连发不提问`);
    } else if (markerRes.marker === 'FREE') {
      const r = setFree(userId, '模型标记 [FREE]');
      if (r.changed) log(`  [忙碌] 检测到 [FREE] → 退出忙碌模式（持续了 ${r.lastedMin} 分钟），回归普通节奏`);
      else log('  [忙碌] 收到 [FREE] 但本来就不在忙碌模式');
    } else {
      // 模型没给标记时，用高置信度规则兜底（宁可漏判，不误判）
      const guess = guessMarker(text);
      if (guess === 'BUSY' && !isBusy(userId)) {
        setBusy(userId, text.slice(0, 40));
        log('  [忙碌] 规则兜底判定为忙碌 → 切进忙碌模式');
      }
    }

    // 画图标记要先摘（[draw: …]），再摘表情包，最后才去括号动作。
    // 顺序反了的话，stripActions 会先把方括号里的东西当动作删掉，图就丢了。
    const withDraw = extractDrawMarker(markerRes.text);
    const withStickers = extractStickers(withDraw.text);
    if(state.companionMode)state.companionRequestedMedia=withStickers.stickers;
    const cleaned = stripActions(withStickers.text, state.cfg.stripActions);
    const bubbles = splitIntoBubbles(cleaned, {
      maxMessages: state.cfg.maxBubbles,
      enabled: state.cfg.bubbleSplit,
      shortReplyThreshold: state.cfg.shortReplyThreshold,
      minimumFragmentLength: state.cfg.minimumFragmentLength
    }).filter((b) => b && b.trim());

    // 强制把条数调到本轮目标（1-5，且与上一轮不同）。
    //
    // 顺序：先按目标条数强制调整，再做随机合并微调。
    // 之所以强制在合并之前，是因为"条数不重复"是硬要求，
    // 而合并只是锦上添花的自然感，不能让它破坏硬要求。
    const beforeAdjust = bubbles.length;
    adjustBubbleCount(bubbles, targetCount);
    if (bubbles.length !== beforeAdjust) {
      log(`  [条数] ${beforeAdjust} → ${bubbles.length} 条（本轮目标 ${targetCount}）`);
    }
    lastBubbleCount.set(userId, bubbles.length);

    const finalBubbles = bubbles.length ? bubbles : [];

    // ── 表情包（先定，因为它会决定"这一条还能不能加颜文字"） ──────────────
    //
    // 人格里的铁律是「颜文字 / emoji / 表情包 三选一，同一条不要叠」。
    // 所以必须先决定发不发图，再决定补不补颜文字 —— 顺序反了就会两个都加。
    //
    // 兜底的原因：人格写"每 5~8 条发一次"，模型会理解成"别发"，
    // 实测 4 个明显该发的场景 0/4。和条数、颜文字是同一个规律。
    let stickerNames = state.cfg.allowStickers ? withStickers.stickers.slice() : [];

    // ── 频率闸门：把发图间隔控制在 [minTurns, maxTurns] 轮 ─────────────────
    //
    // 为什么要区间而不是单一概率：
    //   只设"最少隔 N 轮"，实际频率完全交给模型的心情，忽高忽低；
    //   只设概率，又会出现"连着十轮一张都没有"。
    //   给定上下界之后，间隔就稳定落在 2~3 轮（目标：每 2~3 条回复发一次）。
    //
    //   gap <  minTurns  → 拦掉（哪怕模型自己想发）
    //   gap >= maxTurns  → 必须补一张
    //   中间             → 按 stickerChance 掷骰子
    const turn = (replyTurnCount.get(userId) ?? 0) + 1;
    replyTurnCount.set(userId, turn);
    const lastSt = lastStickerTurn.get(userId) ?? -999;
    const minGapTurns = Math.max(1, state.cfg.stickerMinTurns ?? 2);
    const maxGapTurns = Math.max(minGapTurns, state.cfg.stickerMaxTurns ?? 3);
    const midChance = state.cfg.stickerChance ?? 0.5;
    const gap = turn - lastSt;
    const stickerAllowed = gap >= minGapTurns;
    const stickerForced = gap >= maxGapTurns;

    // 软闸：刚好卡在下限那轮，即使模型自己想发也先掷个骰子。
    // 不加这一层的话，只要模型每轮都想发，节奏就变成严格的"隔一条一次"，
    // 会被他看出是机器在轮询。加了之后间隔自然在 2 和 3 之间浮动。
    let softBlocked = false;
    if (stickerNames.length && gap === minGapTurns && !stickerForced) {
      if (Math.random() >= midChance) {
        softBlocked = true;
        stickerNames = [];
      }
    }

    if (stickerNames.length && !stickerAllowed) {
      log(`  [表情包] 距离上次发图才 ${gap} 轮（下限 ${minGapTurns}），本轮不发`);
      stickerNames = [];
    } else if (softBlocked) {
      log(`  [表情包] 刚够下限、骰子没过，这轮先留着`);
    }

    if (state.cfg.allowStickers && stickerNames.length === 0 && stickerAllowed && !softBlocked) {
      const auto = ensureSticker(finalBubbles, withStickers.stickers, {
        // 到了上限就 100% 补一张，否则按配置概率
        chance: stickerForced ? 1 : midChance,
        recentCategories: recentScenarios(3).filter((x) => x && x.startsWith('sticker:'))
          .map((x) => x.slice(8)),
        // 把用户这句话也交给情绪判断 —— 只看她自己写的内容会漏掉"他累了"这种事
        userText: text,
        // 情绪状态决定这个池子：平静时不会突然发一张暴怒图
        categories: stickerPoolFor(emo)
      });
      if (auto) {
        stickerNames = [auto];
        log(`  [表情包] ${stickerForced ? `已隔 ${gap} 轮，强制补一张` : '按概率兜底补一张'}：${auto}`);
      }
    }

    if (stickerNames.length) lastStickerTurn.set(userId, turn);

    // 表情符号兜底：整条回复一个颜文字/emoji 都没有时按概率补一个。
    // 人设里的比例要求实测执行不稳定（颜文字 24%、emoji 3%），靠代码保底。
    // 这一轮已经要发图了就不补 —— 三选一只留一个。
    if (!stickerNames.length) {
      ensureEmoji(finalBubbles, {
        kaomojiChance: state.cfg.kaomojiChance ?? 0.65,
        emojiChance: state.cfg.emojiChance ?? 0.35,
        // 情绪有状态，比从这一句文本猜更准；也不会生气时贴大笑脸
        moodOverride: kaomojiMoodFor(emo)
      });
    }

    // 记住这次发的是哪个类别，避免连着几张都一样
    for (const n of stickerNames) rememberLine(n, 'sticker:' + n);

    // ── 语境自发生图：她自己觉得"这时候给你看张图"更自然 ────────────────
    //
    // 三条路已经覆盖了"他点播"和"她在回复里写了 [draw:…]"，
    // 这里补的是第三条：她顺手拍/画一张。所以三种触发互斥 ——
    // 他明确要画、或她回复里已经带了画图标记时，这一轮不再额外加图，
    // 否则一次回复能蹦出两张图，像素材库不像人。
    // 表情包和照片同一轮只发一样 —— 真人不会一句配一个表情包再配一张照片
    let autoImg = null;
    if (state.cfg.imageGenEnabled !== false && !drawSubject && !withDraw.prompt && !stickerNames.length) {
      const autoBudget = checkAutoBudget(state.cfg);
      autoImg = decideAutoImage({
        cfg: state.cfg,
        mood: emo?.mood,
        stance,
        userText: text,
        replyText: finalBubbles.join(' '),
        gapTurns: turn - (lastAutoImageTurn.get(userId) ?? -999),
        canDraw: autoBudget.allowed,
        rng: Math.random
      });
      if (autoImg) {
        finalBubbles.push(autoImg.caption);
        lastBubbleCount.set(userId, finalBubbles.length);
        log(`  [生图] 语境自发（${autoImg.kind}，${autoImg.reason}）：${autoImg.subject.slice(0, 40)}`);
      } else if (!autoBudget.allowed) {
        log(`  [生图] 自发预算已用尽（${autoBudget.reason}：本小时 ${autoBudget.hourCount}/天 ${autoBudget.dayCount}），这轮只发文字`);
      }
    }

    await sendBubbles(state, userId, finalBubbles, stickerNames);

    // 模型自己在回复里写了 [draw: …] 时，这里补画一张。
    // 他已经明确要画的那种，在生成回复之前就画完发出去了，不会走到这里。
    let drewNote = '';
    if (withDraw.prompt && !drawSubject) {
      const d = await drawAndSend(state, userId, withDraw.prompt, 'model');
      if (d.ok) {
        drewNote = `[画了一张图：${withDraw.prompt}]`;
        log(`  [生图] 她自己想画：${withDraw.prompt}`);
      }
    }

    // 语境自发的那张：文字已经发出去了，现在补画。
    // 失败只记日志 —— 她已经把话说完了，读者不该看到"画图失败"这种系统提示。
    let autoNote = '';
    if (autoImg) {
      const d = await drawAndSend(state, userId, autoImg.subject, 'auto');
      if (d.ok) {
        recordAutoImage();
        lastAutoImageTurn.set(userId, turn);
        autoNote = formatAutoImageNote(autoImg);
        log(`  [生图] 自发图已发送（${autoImg.kind}）`);
      } else {
        log(`  [生图] 自发图没画成（${d.kind}），这轮当无事发生`);
      }
    }

    // 记进历史的是一条完整的文本（表情包用文字占位，便于后续理解上下文）
    const historyText = [
      finalBubbles.join('\n\n'),
      ...stickerNames.map((n) => `[发了表情包：${n}]`),
      drewNote,
      autoNote
    ].filter(Boolean).join('\n');
    await appendTurn(userId, text, historyText);

    // 把这一轮写回场景：她说了什么、留没留下一个没被回答的问题。
    // 落盘是必须的 —— 内存态一重启就没了，场景会断在重启那一刻。
    if (sceneEnabled && scene) {
      recordReply(scene, finalBubbles.join('\n\n'));
      await saveScene(userId, scene);
    }

    log(`  已回复（${secs}s，${finalBubbles.length} 条${stickerNames.length ? ` + ${stickerNames.length} 个表情` : ''}${imageCount ? `，看图 ${imageCount} 张` : ''}${emo ? `，情绪=${moodLabel(emo)}${stance !== 'follow' ? '/' + stance : ''}` : ''}${persona ? '，人设=' + persona.name : ''}）`);

    // 把实际发出的每一条都记下来。
    // 没有这行日志，"已回复"只能证明调用没抛错，证明不了发了什么内容，
    // 排查"用户说没收到/没效果"时就完全抓瞎。
    for (let i = 0; i < finalBubbles.length; i++) {
      const one = String(finalBubbles[i]).replace(/\n/g, ' / ');
      log(`    [${i + 1}/${finalBubbles.length}] ${one.length > 120 ? one.slice(0, 120) + '…' : one}`);
    }
  } else {
    const detail = result.error || (result.stderr ? result.stderr.slice(-400) : '未知错误');
    // 生成失败也要把"用户刚说过什么"落盘，否则下次她就忘了这句话，场景断掉
    if (sceneEnabled && scene) await saveScene(userId, scene);
    if (emotionEnabled && emo) await saveEmotion(userId, emo);
    await sendText(state, userId, `处理失败（${secs}s）：${detail}\n\n可用 /new 清空上下文后重试。`);
    warn(`  失败（${secs}s）: ${detail}`);
  }
}

/**
 * 分条发送文字，并在合适的位置插表情包。
 *
 * 表情包不单独成"轮"，而是混在聊天气泡之间 —— 真人也是这么发的：
 * 一句话、一个表情、再一句话。
 */
async function sendBubbles(state, userId, bubbles, stickerNames = []) {
  if (state.desktopTransport) return state.desktopTransport.sendBubbles(userId, bubbles);
  // 表情包插在倒数第二条之后（也就是正文说完了、还没收尾的位置），
  // 只有一条时插在最后。这样不会一上来就发表情。
  const stickerPositions = new Set();
  if (stickerNames.length && bubbles.length) {
    const base = Math.max(0, bubbles.length - 1);
    stickerNames.forEach((_, i) => {
      stickerPositions.add(Math.min(base + i, bubbles.length - 1));
    });
  }

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      await tryTyping(state, userId, true);
      const base = state.cfg.bubbleGapMs;
      const jitter = base * 0.4 * (Math.random() * 2 - 1);
      await delay(Math.max(250, Math.round(base + jitter)));
    }
    await sendText(state, userId, bubbles[i]);

    if (stickerPositions.has(i)) {
      await delay(Math.max(300, Math.round(state.cfg.bubbleGapMs * 0.7)));
      await sendStickerBatch(state, userId, stickerNames);
    }
  }
}

/** 逐个发表情包（每个之间留点空隙，别刷屏） */
async function sendStickerBatch(state, userId, names) {  const contextToken = state.contextTokens.get(userId) ?? '';
  for (const name of names) {
    const picked = await pickSticker(name);
    if (!picked) {
      warn(`表情包不存在: ${name}（跳过）`);
      continue;
    }
    try {
      await sendImage(state.cred.baseUrl, state.cred.token, userId, contextToken, picked.path);
      log(`  已发表情包: ${picked.name}`);
    } catch (e) {
      warn(`表情包发送失败 ${picked.name}: ${e.message}`);
    }
    await delay(400);
  }
}

/**
 * 画一张图并直接发给他。
 *
 * 为什么单独抽出来：他有两条路会触发出图 ——
 *   ① 他自己说"帮我画一张…"（回复前就画）
 *   ② 模型在回复里写了 [draw: …]（回复后补画）
 * 两条路的发送、预算、失败话术都一样，只差调用时机。
 */
async function drawAndSend(state, userId, subject, tag = '') {
  const budget = checkDrawBudget(state.cfg);
  if (!budget.allowed) {
    log(`  [生图] 预算用尽（${budget.reason}：本小时 ${budget.hourCount} 张 / 今天 ${budget.dayCount} 张），这次只口头答应`);
    return { ok: false, kind: 'budget', subject };
  }

  await tryTyping(state, userId, true);
  const r = await generateImage(subject, {
    cfg: state.cfg,
    destDir: path.join(ROOT, 'data', 'media', 'outgoing'),
    log,
    warn
  });

  await tryTyping(state, userId, false);

  if (!r.ok) return { ...r, subject };

  recordDraw();
  const contextToken = state.contextTokens.get(userId) ?? '';
  try {
    await sendImage(state.cred.baseUrl, state.cred.token, userId, contextToken, r.path);
    log(`  已发图: ${path.basename(r.path)}${tag ? `（${tag}）` : ''}`);
  } catch (e) {
    warn(`发图失败: ${e.message}`);
    return { ok: false, kind: 'send', error: e.message, subject };
  }
  return { ...r, subject };
}

/** 控制指令：/new /role /help */
async function handleCommand(state, msg, text) {
  const userId = msg.from_user_id;
  const raw = text.trim();
  const cmd = raw.toLowerCase();
  const arg = raw.split(/\s+/).slice(1).join(' ').trim();

  if (cmd === '/new' || cmd === '/clear') {
    await clearHistory(userId);
    await sendText(state, userId, '上下文已清空，可以重新开始了。');
    return true;
  }

  // /画 —— 让她画一张图
  if (cmd === '/画' || cmd === '/draw' || cmd.startsWith('/画 ') || cmd.startsWith('/draw ')) {
    if (!arg) {
      await sendText(state, userId,
        '用法：/画 一只趴在键盘上的橘猫\n也可以直接说"帮我画一张…"，她会自己判断。');
      return true;
    }
    log(`  [生图] 指令触发：${arg}`);
    const draw = await drawAndSend(state, userId, arg, 'cmd');
    if (draw.ok) {
      await sendText(state, userId, '画好啦，看看喜不喜欢～');
    } else {
      await sendText(state, userId, `没画成：${describeDrawFailure(draw.kind)}。过会儿再试试。`);
    }
    return true;
  }

  // /role —— 人设切换
  if (cmd === '/role' || cmd.startsWith('/role ')) {
    const all = await listPersonas();
    const current = await getUserPersona(userId) || state.cfg.defaultPersona;

    if (!arg) {
      if (!all.length) {
        await sendText(state, userId,
          '还没有任何人设。在 语忆AI/personas/ 目录下放 .md 文件即可，格式见 README。');
        return true;
      }
      const lines = ['可用人设：'];
      for (const p of all) {
        const mark = p.name === current ? ' ← 当前' : '';
        lines.push(`  /role ${p.name} — ${p.title}${p.description ? '：' + p.description : ''}${mark}`);
      }
      lines.push('');
      lines.push('发送 /role 名称 切换。发送 /role off 关掉人设。');
      await sendText(state, userId, lines.join('\n'));
      return true;
    }

    if (arg.toLowerCase() === 'off' || arg.toLowerCase() === 'none') {
      await setUserPersona(userId, '');
      await sendText(state, userId, '已关掉人设，恢复默认说话方式。');
      return true;
    }

    const target = await getPersona(arg);
    if (!target) {
      const names = all.map((p) => p.name).join('、') || '（无）';
      await sendText(state, userId, `没有名为「${arg}」的人设。可用的：${names}`);
      return true;
    }

    await setUserPersona(userId, target.name);
    await sendText(state, userId, `已切换人设：${target.title}${target.description ? '\n' + target.description : ''}`);
    return true;
  }

  if (cmd === '/help' || cmd === '/?') {
    await sendText(state, userId,
      ['语忆AI 控制指令：',
        '',
        '【调整她】',
        '/状态           看当前设置（含忙碌模式状态）',
        '/场景           看现在聊的是哪件事（/场景 清空 可重置）',
        '/情绪           看她此刻什么情绪（/情绪 生气 可手动指定）',
        '/节奏 慢        调发送间隔（慢/中/快/很慢/很快）',
        '/条数 3         改一次最多发几条（1-8）',
        '',
        '【忙碌模式】',
        '/忙             我要去忙了 → 改成每 25 分钟发 2-3 条，不催不提问',
        '/闲             我回来了 → 恢复原来的节奏',
        '  （直接说"我在忙""我去上班了""我忙完了"也会自动切换）',
        '',
        '【联网】',
        '/搜 关键词      搜一下网上的资料',
        '',
        '【画画】',
        '/画 描述        让她画一张图（说"帮我画一张…"也行）',
        '',
        '【对话】',
        '/new            清空对话上下文',
        '/role           查看可用人设',
        '/role 名称      切换人设',
        '/role off       关掉人设',
        '',
        '【操作电脑】',
        '/do             看可执行的电脑操作',
        '/do 动作名      让电脑执行（如 /do 打开抖音）',
        '/do 任意任务    交给 AI 现场处理（较慢）',
        '',
        '/help           显示本说明',
        '',
        '直接发文字或语音，她就会以聊天方式回你。'].join('\n'));
    return true;
  }

  // /do —— 执行电脑操作
  //
  // /节奏、/条数 —— 用聊天调整发送节奏和条数
  //
  // 为什么需要：在微信里说"慢一点""多发几条"，AI 只会顺着你应承，
  // 但改不了任何设置。这几个指令才是真的改配置（同时写文件和内存）。
  if (cmd === '/节奏' || cmd === '/speed' || cmd.startsWith('/节奏 ')) {
    const arg2 = arg.toLowerCase();
    const presets = {
      慢: 3500, 很慢: 5000, 中: 2200, 正常: 2200, 快: 1200, 很快: 700
    };
    const preset = presets[arg2];
    if (preset) {
      state.cfg.bubbleGapMs = preset;
      await writeConfig({ bubbleGapMs: preset });
      await sendText(state, userId,
        `已调整：每条消息间隔约 ${(preset * 0.6 / 1000).toFixed(1)}-${(preset * 1.4 / 1000).toFixed(1)} 秒\n\n常用：/节奏 慢 · /节奏 中 · /节奏 快`);
      log(`  [设置] bubbleGapMs → ${preset}`);
      return true;
    }
    await sendText(state, userId,
      `当前每条间隔约 ${(state.cfg.bubbleGapMs * 0.6 / 1000).toFixed(1)}-${(state.cfg.bubbleGapMs * 1.4 / 1000).toFixed(1)} 秒\n\n用法：/节奏 慢 | 中 | 快 | 很慢 | 很快`);
    return true;
  }

  if (cmd === '/条数' || cmd === '/count' || cmd.startsWith('/条数 ')) {
    const n = parseInt(arg, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 8) {
      state.cfg.maxBubbles = n;
      await writeConfig({ maxBubbles: n });
      await sendText(state, userId, `已调整：一次最多发 ${n} 条（实际会按内容多少在 1-${n} 之间变）`);
      log(`  [设置] maxBubbles → ${n}`);
    } else {
      await sendText(state, userId,
        `当前一次最多 ${state.cfg.maxBubbles} 条\n\n用法：/条数 3（范围 1-8）\n注意这是上限，实际条数会按内容自动变`);
    }
    return true;
  }

  // /库 —— 查知识库检索（用来确认 RAG 到底检索到了什么）
  if (cmd === '/库' || cmd === '/rag' || cmd.startsWith('/库 ') || cmd.startsWith('/rag ')) {
    const st = getVaultStatus();
    if (!arg) {
      await sendText(state, userId, [
        `知识库检索：${state.cfg.ragEnabled ? '开启' : '关闭'}`,
        `  目录：${state.cfg.vaultPath}`,
        st.ready
          ? `  索引：${st.files} 篇 / ${st.chunks} 个片段，建于 ${st.ageMinutes} 分钟前（耗时 ${st.buildMs}ms）`
          : '  索引：还没建（发一句话就会自动建）',
        `  阈值：${state.cfg.ragMinScore}，每次最多 ${state.cfg.ragTopK} 段`,
        '',
        '用法：/库 关键词 —— 看看她会检索到什么'
      ].join('\n'));
      return true;
    }
    const rr = await searchVault(arg, state.cfg.vaultPath, {
      topK: state.cfg.ragTopK, minScore: state.cfg.ragMinScore
    });
    if (!rr.ok) {
      await sendText(state, userId, `检索失败：${rr.error}`);
      return true;
    }
    if (!rr.hits.length) {
      await sendText(state, userId, `「${arg}」没检索到相关内容（${rr.ms}ms）\n\n说明这话题她库里没有，回答时会不注入背景资料。`);
      return true;
    }
    const lines = [`「${arg}」检索到 ${rr.hits.length} 段（${rr.ms}ms）：`];
    rr.hits.forEach((h, i) => {
      const label = h.heading && h.heading !== h.title ? `${h.title} · ${h.heading}` : h.title;
      lines.push(`${i + 1}. [${h.score}] ${label}`);
      lines.push(`   ${String(h.text).replace(/\s+/g, ' ').slice(0, 60)}…`);
    });
    await sendText(state, userId, lines.join('\n'));
    return true;
  }

  // /搜 —— 手动联网搜索
  if (cmd === '/搜' || cmd === '/search' || cmd.startsWith('/搜 ')) {
    if (!arg) {
      await sendText(state, userId,
        '用法：/搜 关键词\n\n例如：/搜 2026年诺贝尔奖\n\n（平时聊天时，涉及"最新/今天/天气/新闻"这类话题她也会自动搜）');
      return true;
    }

    await tryTyping(state, userId, true);
    await sendText(state, userId, `正在搜「${arg}」…`);
    log(`  [搜索] 手动: ${arg}`);

    const sr = await webSearch(arg, searchOptions(state.cfg));
    await tryTyping(state, userId, false);

    if (!sr.ok || (!sr.sources.length && !sr.answer)) {
      await sendText(state, userId, `没搜到结果：${sr.error || '结果为空'}`);
      warn(`  [搜索] 失败（${sr.provider || '?'}）: ${sr.error}`);
      return true;
    }

    // 有摘要就先给摘要（人能直接看懂），再附几条来源
    const parts = [];
    if (sr.answer) parts.push(sr.answer.slice(0, 900));
    if (sr.sources.length) parts.push(formatSources(sr.sources, 4));
    const head = `搜到 ${sr.sources.length} 条（${(sr.ms / 1000).toFixed(1)}s）：`;
    const body = parts.join('\n\n');
    await sendText(state, userId, `${head}\n\n${body}`);
    log(`  [搜索] 成功（${sr.provider || '?'}），${sr.sources.length} 条${sr.answer ? '，含摘要' : ''}${sr.fallbackFrom ? `，${sr.fallbackFrom} 失败后回退` : ''}`);

    // 把她搜到的结果也记进对话历史，这样后面聊到能接上
    await appendTurn(userId, `[搜索] ${arg}`, sr.answer
      ? sr.answer.slice(0, 300)
      : sr.sources.slice(0, 3).map((s) => `${s.title || s.url}`).join('；'));
    return true;
  }

  // /忙 /闲 —— 手动切换忙碌模式（不依赖模型判断，100% 准确）
  if (cmd === '/忙' || cmd === '/busy' || cmd === '/闲' || cmd === '/free') {
    if (cmd === '/忙' || cmd === '/busy') {
      const r = setBusy(userId, '/忙 命令');
      // 注意：颜文字里的反引号必须转义，否则会提前闭合模板字符串
      await sendText(state, userId,
        '好啦，你去忙吧 (´｡・ᵕ・｡`)\n\n我记得你在忙：\n' +
        `  每隔 ${state.cfg.busyIntervalMinutes ?? 25} 分钟发 ${state.cfg.busyMinCount ?? 2}-${state.cfg.busyMaxCount ?? 3} 条，不催你、不提问\n` +
        '  你回来随便说句话，或者发 /闲 就恢复原来的节奏' +
        (r.changed ? '' : '\n\n（本来就在忙碌模式）'));
      log(`  [忙碌] /忙 命令 → 进入忙碌模式${r.changed ? '' : '（已在忙）'}`);
    } else {
      const r = setFree(userId, '/闲 命令');
      await sendText(state, userId, r.changed
        ? `你回来啦！那我恢复正常啦 (＾▽＾)\n\n（刚才忙了 ${r.lastedMin} 分钟）`
        : '我现在本来就是正常的呀');
      log(`  [忙碌] /闲 命令 → ${r.changed ? `退出忙碌模式（持续 ${r.lastedMin} 分钟）` : '本来就不在忙碌模式'}`);
    }
    return true;
  }

  // /场景 —— 看现在挂着的那件事，也可以手动清掉
  if (cmd === '/场景' || cmd === '/scene' || cmd.startsWith('/场景 ') || cmd.startsWith('/scene ')) {
    if (arg === '换' || arg === '清空' || arg === 'new' || arg === 'reset') {
      await resetScene(userId);
      log('  [场景] 手动清空');
      await sendText(state, userId, '场景已清空。下一句话会开一个新场景。');
      return true;
    }

    const sc = await loadScene(userId);
    if (!sc) {
      await sendText(state, userId, '现在没有挂着的场景。你说一句话就会开一个。');
      return true;
    }

    const mins = Math.round((Date.now() - (sc.startedAt || Date.now())) / 60000);
    const intervalMin = Math.max(1, state.cfg.proactiveNewTopicMinutes ?? 180);
    const sinceNew = sc.lastNewTopicAt ? Date.now() - sc.lastNewTopicAt : Infinity;
    const cooldown = sinceNew >= intervalMin * 60000
      ? '已到，允许开新话题'
      : `还剩 ${Math.ceil((intervalMin * 60000 - sinceNew) / 60000)} 分钟`;

    await sendText(state, userId, [
      `当前场景：${sc.topic}`,
      `开始于 ${mins} 分钟前，已经聊了 ${sc.turns || 0} 轮`,
      sc.lastUserText ? `他最后说的：「${sc.lastUserText}」` : '',
      sc.openQuestion ? `你问过、他还没答的：「${sc.openQuestion}」` : '',
      '',
      `换题冷却：${cooldown}（/场景 清空 可手动重置）`
    ].filter(Boolean).join('\n'));
    return true;
  }

  // /情绪 —— 看她现在什么底色，也能手动改（调试和哄她都方便）
  if (cmd === '/情绪' || cmd === '/emotion' || cmd.startsWith('/情绪 ') || cmd.startsWith('/emotion ')) {
    if (arg === '清空' || arg === '重置' || arg === 'reset') {
      const e = await resetEmotion(userId);
      await sendText(state, userId, `情绪已重置为「${moodLabel(e)}」。`);
      return true;
    }

    const labelMap = {};
    for (const [k, v] of Object.entries(MOODS)) labelMap[v.label] = k;
    const want = arg ? (MOODS[arg] ? arg : labelMap[arg]) : null;
    if (want) {
      const e = await loadEmotion(userId);
      const next = { ...e, mood: want, intensity: 0.6, since: Date.now(), lastSwitchAt: Date.now(), turnsInMood: 0 };
      await saveEmotion(userId, next);
      log(`  [情绪] 手动设为 ${want}`);
      await sendText(state, userId, `已把她此刻的情绪设成「${moodLabel(next)}」。`);
      return true;
    }
    if (arg) {
      await sendText(state, userId, `没有「${arg}」这种情绪。可选：${Object.values(MOODS).map((m) => m.label).join(' / ')}`);
      return true;
    }

    const e = await loadEmotion(userId);
    const mins = Math.max(1, Math.round((Date.now() - (e.since || Date.now())) / 60000));
    const trig = Object.entries(e.triggers || {})
      .filter(([, v]) => v > 0.05)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${MOODS[k]?.label || k} ${Math.round(v * 100)}%`);
    await sendText(state, userId, [
      `此刻的情绪：${moodLabel(e)}（强度 ${Math.round((e.intensity || 0) * 100)}%）`,
      `已经持续 ${mins} 分钟，这个情绪里说了 ${e.turnsInMood || 0} 轮`,
      trig.length ? `正在累积的倾向：${trig.join('，')}` : '没有明显的倾向，比较平静',
      `顶嘴统计：${Object.entries(e.stance?.counts || {}).map(([k, v]) => `${k}×${v}`).join('，') || '还没顶过'}`,
      '',
      '（/情绪 清空 可重置；/情绪 生气 可手动指定）'
    ].join('\n'));
    return true;
  }

  if (cmd === '/状态' || cmd === '/status') {
    const su = getSearchUsage();
    const emoNow = await loadEmotion(userId);
    await sendText(state, userId, [
      '当前设置：',
      `  发送间隔：${(state.cfg.bubbleGapMs * 0.6 / 1000).toFixed(1)}-${(state.cfg.bubbleGapMs * 1.4 / 1000).toFixed(1)} 秒`,
      `  最多条数：${state.cfg.maxBubbles} 条`,
      `  合并概率：${Math.round((state.cfg.bubbleMergeChance || 0) * 100)}%`,
      `  联网搜索：${state.cfg.autoSearch ? `自动开启（通道 ${state.cfg.searchProvider ?? 'anysearch'}）` : '仅手动（/搜 关键词）'}`,
      `  搜索预算：本小时已搜 ${su.hourUsed} 次（${state.cfg.searchHourlyLimit > 0 ? `上限 ${state.cfg.searchHourlyLimit}` : '不限'}），今天已搜 ${su.dayUsed} 次（${state.cfg.searchDailyLimit > 0 ? `上限 ${state.cfg.searchDailyLimit}` : '不限'}）`,
      `  知识库：${state.cfg.ragEnabled ? `开启（阈值 ${state.cfg.ragMinScore}，最多 ${state.cfg.ragTopK} 段，每轮固定注入 ${state.cfg.sceneProfileChars ?? 0} 字画像）` : '关闭'}`,
      `  场景延续：${state.cfg.sceneEnabled === false ? '关闭' : `开启（过期 ${state.cfg.sceneTtlMinutes ?? 180} 分钟，同一件事最多聊 ${state.cfg.sceneMaxTurns ?? 12} 轮）`}`,
      `  随机换题：${state.cfg.proactiveNewTopicMinutes ?? 180} 分钟内只接着说，不另起话题`,
      `  情绪：${state.cfg.emotionEnabled === false ? '关闭' : `开启（此刻 ${moodLabel(emoNow)}，强度 ${Math.round((emoNow.intensity || 0) * 100)}%，已持续 ${Math.max(1, Math.round((Date.now() - (emoNow.since || Date.now())) / 60000))} 分钟；顶嘴频率 ${Math.round((state.cfg.defianceChance ?? 0.16) * 100)}%）`}`,
      `  识图：${state.cfg.visionEnabled === false ? '关闭' : (visionTargetLabel(state.cfg) ? `开启（主用 ${visionTargetLabel(state.cfg)}${resolveFallbackTarget(state.cfg) ? '，豆包备用' : ''}）` : '开启但没配 Key')}`,
      `  记忆档位：最近 ${state.cfg.historyRecentTurns} 轮全文 + 更早的压成摘要`,
      `  主动消息：${state.cfg.proactive ? `开启（沉默 ${state.cfg.proactiveIdleMinutes} 分钟后开始，每 ${state.cfg.proactiveMinMinutes}-${state.cfg.proactiveMaxMinutes} 分钟一条）` : '关闭'}`,
      `  连发规则：沉默满 ${state.cfg.proactiveBurstAfterIdleMinutes ?? 5} 分钟 → 连发 ${state.cfg.proactiveBurstMinCount ?? 3}-${state.cfg.proactiveBurstMaxCount ?? 5} 条（间隔 ${((state.cfg.proactiveBurstGapMs ?? 500) / 1000).toFixed(1)} 秒）`,
      (() => {
        const bs = getBusyState(userId);
        if (!state.cfg.busyModeEnabled) return '  忙碌模式：已关闭';
        if (bs?.busy) {
          const min = Math.round((Date.now() - new Date(bs.since).getTime()) / 60000);
          return `  忙碌模式：⏸ 生效中（已 ${min} 分钟）→ 每 ${state.cfg.busyIntervalMinutes ?? 25} 分钟发 ${state.cfg.busyMinCount ?? 2}-${state.cfg.busyMaxCount ?? 3} 条，不提问`;
        }
        return `  忙碌模式：待命（你说"在忙"或发 /忙 就切进去）`;
      })()
    ].join('\n'));
    return true;
  }

  // /do 前缀：让电脑执行操作
  if (cmd === '/do' || cmd.startsWith('/do ')) {
    // 权限：/do 等于把命令执行权交给微信消息，必须限定在白名单内
    const doUsers = Array.isArray(state.cfg.doUsers) ? state.cfg.doUsers : [];
    const allowList = doUsers.length ? doUsers : state.cfg.allowedUsers;
    if (!allowList.length) {
      await sendText(state, userId,
        '⛔ /do 还没启用。为了安全，需要先在 data/config.json 的 allowedUsers 里写上你自己的微信 id。\n\n你的 id 是：' + userId);
      return true;
    }
    if (!allowList.includes(userId)) {
      await sendText(state, userId, '⛔ 你没有执行电脑操作的权限。');
      return true;
    }

    if (!arg) {
      const list = listActions();
      const lines = ['可执行的电脑操作：'];
      for (const a of list) {
        lines.push(`  /do ${a.name}${a.desc ? '  — ' + a.desc : ''}`);
      }
      lines.push('');
      lines.push('匹配不上时会交给 AI 现场处理（较慢）。');
      await sendText(state, userId, lines.join('\n'));
      return true;
    }

    // 1) 预设动作
    const action = matchAction(arg);
    if (action) {
      await sendText(state, userId, `执行：${action.name}`);
      log(`  [do] 预设动作: ${action.name}`);
      const r = await runAction(action);
      if (r.ok) {
        await sendText(state, userId, String(r.output).slice(0, 800) || '完成');
        log(`  [do] 成功`);
      } else {
        await sendText(state, userId, `执行失败：${r.output}`);
        warn(`  [do] 失败: ${r.output}`);
      }
      return true;
    }

    // 2) 回落 DSH
    await sendText(state, userId, '没有对应的预设动作，交给 AI 处理，可能要等几十秒…');
    log(`  [do] 回落 DSH: ${arg}`);

    const r = await runTask(arg, {
      timeoutMs: Math.min(state.cfg.doTimeoutMs || 120000, 180000),
      cwd: ROOT
    });

    if (r.ok) {
      const cleaned = stripActions(r.text, state.cfg.stripActions);
      const out = splitIntoBubbles(cleaned, {
        maxMessages: 4, enabled: true, shortReplyThreshold: 0, minimumFragmentLength: 0
      }).filter(Boolean);
      await sendBubbles(state, userId, out, []);
      log(`  [do] DSH 完成，${out.length} 条`);
    } else {
      await sendText(state, userId, `执行失败：${(r.error || '').slice(0, 500)}`);
      warn(`  [do] DSH 失败: ${r.error}`);
    }
    return true;
  }

  // 图片/表情包功能已停用：iLink 的图片上传虽然返回成功，
  // 但消息在微信客户端始终显示为「已过期」，排查多轮未解决。
  // 为免用户发 /sticker 后收到错误提示，这里给出明确说明而不是静默失败。
  if (cmd === '/sticker' || cmd.startsWith('/sticker ')) {
    await sendText(state, userId, '图片和表情包功能暂未启用（iLink 图片通道未打通），目前只支持文字和语音。');
    return true;
  }

  return false;
}

// ── 主循环 ──────────────────────────────────────────────────────────────────
async function main() {
  if (flag('--logout')) {
    await rm(CRED_PATH, { force: true });
    log('已清除登录凭证，下次运行需要重新扫码');
    return;
  }

  ensureConfigFile();
  await ensurePersonaDir();
  await ensureStickerDir();
  let cfg = loadConfig();
  let cfgStamp = statSync(CFG_PATH).mtimeMs;
  const personas = await listPersonas();
  const stickers = await listStickers();

  console.log('');
  console.log('  语忆AI  ·  微信 iLink Bot');
  console.log('  ─────────────────────────────────────────');
  console.log(`  模式     : ${MODE}${MODE === 'chat' ? '（直连 API，轻量）' : MODE === 'dsh' ? '（DSH headless，带工具）' : ''}`);
  console.log(`  协议地址 : ${ILINK_BASE_URL}`);
  if (MODE === 'dsh') {
    console.log(`  DSH 运行时: ${describeRuntime()}`);
  } else if (MODE === 'chat') {
    console.log(`  模型     : ${cfg.chatModel}`);
    console.log(`  接口地址 : ${cfg.chatBaseUrl}`);
    console.log(`  API Key  : ${API_KEY.key ? `已就绪（${API_KEY.source}）` : '⚠ 缺失'}`);
    console.log(`  温度     : ${cfg.chatTemperature}`);
  }
  if (MODE === 'dsh' || MODE === 'chat') {
    console.log(`  任务超时 : ${cfg.taskTimeoutMs / 1000} 秒`);
    console.log(`  人设     : ${personas.length} 个可用${cfg.defaultPersona ? `，默认 ${cfg.defaultPersona}` : '（未设默认）'}`);
    console.log(`  表情包   : ${stickers.length} 个${cfg.allowStickers ? '' : '（已停用）'}`);
    console.log(`  处理提示 : ${cfg.showQueuedNotice ? '会先回"收到，正在处理…"' : '仅"正在输入"，不刷消息'}`);
    console.log(`  场景记忆 : ${cfg.sceneEnabled === false
      ? '关闭（每条回复独立生成）'
      : `开启（过期 ${cfg.sceneTtlMinutes ?? 180} 分钟，最多 ${cfg.sceneMaxTurns ?? 12} 轮，判定=${cfg.sceneAnalyzeModel ?? 'auto'}）`}`);
    console.log(`  换题冷却 : ${cfg.proactiveNewTopicMinutes ?? 180} 分钟内只说手头这件事`)
    ;
    console.log(`  遗忘     : ${cfg.forgetEnabled === false
      ? '关闭（话题永不过期）'
      : `开启（话题只保鲜 ${cfg.topicTtlHours ?? 48} 小时；说"别老提这个"就拉黑 ${cfg.topicBanHours ?? 168} 小时）`}`);
    console.log(`  情绪     : ${cfg.emotionEnabled === false
      ? '关闭（语气永远温柔）'
      : `开启（有底色、会累会生气；顶嘴 ${Math.round((cfg.defianceChance ?? 0.16) * 100)}%，至少隔 ${cfg.defianceMinGapTurns ?? 2} 轮）`}`);
    const vision = resolveVisionTarget(cfg, API_KEY.key);
    const visionFallback = resolveFallbackTarget(cfg);
    console.log(`  识图     : ${cfg.visionEnabled === false
      ? '关闭'
      : vision.apiKey
        ? `开启（主用 ${vision.label} ${vision.model}${visionFallback ? `，备用 ${visionFallback.label} ${visionFallback.model}` : ''}，一次最多 ${cfg.visionMaxImages ?? 1} 张，识别失败会自己说看不见）`
        : '开启但没配 Key（收到图会说"眼睛不好使"）'}`);
    console.log(`  生图     : ${cfg.imageGenEnabled === false
      ? '关闭'
      : cfg.imageGenApiKey
        ? `开启（Agnes ${cfg.imageGenModel ?? 'agnes-image-2.5-flash'}，${cfg.imageGenSize ?? '1K'} ${cfg.imageGenRatio ?? '1:1'}，每小时最多 ${cfg.imageGenMaxPerHour ?? 5} 张）`
        : '开启但没配 Key（他说要画只会口头答应）'}`);
    console.log(`  自发图   : ${cfg.autoImageEnabled === false
      ? '关闭'
      : `开启（基础 ${Math.round((cfg.autoImageChance ?? 0.08) * 100)}%，最少隔 ${cfg.autoImageMinGapTurns ?? 8} 轮，每小时 ${cfg.autoImageMaxPerHour ?? 1} / 每天 ${cfg.autoImageMaxPerDay ?? 4} 张；生气委屈时更容易甩图）`}`);
    console.log(`  生活线   : ${cfg.lifeEnabled === false
      ? '关闭（只聊当下）'
      : `开启（有 ${DEFAULT_CAST.length} 个配角；开新故事 ${Math.round((cfg.lifeArcChance ?? 0.45) * 100)}%，`
        + `冲突占比 ${Math.round((cfg.lifeConflictChance ?? 0.35) * 100)}%，`
        + `讲完才换、冷却 ${cfg.lifeArcCooldownMinutes ?? 90} 分钟）`}`);
    console.log(`  主动条数 : 以 ${Math.max(1, cfg.proactiveCountShortMin ?? 1)}-${Math.max(1, cfg.proactiveCountShortMax ?? 3)} 条为主，`
      + `${Math.round((cfg.proactiveCountLongChance ?? 0.2) * 100)}% 概率来一波 ${Math.max(1, cfg.proactiveCountLongMin ?? 2)}-${Math.max(1, cfg.proactiveCountLongMax ?? 6)} 条`);
    const searchProvider = cfg.searchProvider ?? 'anysearch';
    const searchKeyReady = searchProvider === 'deepseek'
      ? !!API_KEY.key
      : !!readAnySearchKey(cfg.anysearchApiKey || '');
    console.log(`  联网搜索 : ${cfg.autoSearch === false ? '仅手动 /搜' : '自动'}`
      + `（通道 ${searchProvider}${searchKeyReady ? '' : '，⚠ 没配 Key'}，`
      + `${cfg.searchHourlyLimit > 0 ? `每小时 ${cfg.searchHourlyLimit} 次` : '每小时不限'}，`
      + `${cfg.searchDailyLimit > 0 ? `每天 ${cfg.searchDailyLimit} 次` : '每天不限'}`
      + `${cfg.searchFallback === false ? '，不回退' : `，失败回退 ${searchProvider === 'deepseek' ? 'anysearch' : 'deepseek'}`}）`);
  }
  console.log(`  配置文件 : ${CFG_PATH}`);
  if (cfg.allowedUsers.length) {
    console.log(`  白名单   : ${cfg.allowedUsers.length} 个用户`);
  } else {
    console.log('  白名单   : 未设置（任何能给 bot 发消息的人都可用）');
  }
  console.log('  ─────────────────────────────────────────');
  console.log('');

  // ── 知识库自检 + 预热 ────────────────────────────────────────────────────
  //
  // 为什么要在这里做，而不是等第一条消息：RAG 是懒加载的，如果库目录被改名、
  // 盘符变了、或者权限出问题，她会整整一段时间"静默地没有知识库"——
  // 用户只会觉得"怎么又不好用了"，而日志里什么都没有。
  // 所以启动时就把索引建好并把结果打出来，出了问题当场能看见。
  if (cfg.ragEnabled && (MODE === 'dsh' || MODE === 'chat')) {
    if (!cfg.vaultPath) {
      warn('知识库：未配置 vaultPath，RAG 不会生效');
    } else if (!existsSync(cfg.vaultPath)) {
      warn(`知识库：目录不存在 → ${cfg.vaultPath}（RAG 不生效，检查盘符或路径）`);
    } else {
      try {
        const t0 = Date.now();
        const st = await ensureVaultIndex(cfg.vaultPath);
        const missing = (cfg.profileNotes || []).filter(
          (rel) => !existsSync(path.join(cfg.vaultPath, rel))
        );
        log(`知识库就绪：${st.files} 篇 / ${st.N} 个片段 / 建索引 ${Date.now() - t0}ms`);
        log(`  目录：${cfg.vaultPath}`);
        log(`  阈值 ${cfg.ragMinScore}，最多 ${cfg.ragTopK} 段；画像卡 ${cfg.profileNotes?.length || 0} 篇`);
        if (missing.length) {
          warn(`  画像卡缺文件：${missing.join('、')}（这几篇不会注入）`);
        }
        // 深呼吸一次：真的检索一遍，确认从「按键」到「出结果」整条路是通的
        const probe = await searchVault('显卡 配置', cfg.vaultPath, { topK: 1, minScore: 0.2 });
        if (probe.ok && probe.hits.length) {
          log(`  自测检索通过（${probe.ms}ms）→ ${probe.hits[0].title}`);
        } else {
          warn('  自测检索没有命中，知识库可能是空的或全是无关文件');
        }
      } catch (e) {
        warn('知识库初始化失败（RAG 不会生效）: ' + e.message);
      }
    }
  }

  let cred = FORCE_LOGIN ? undefined : await loadCred();
  if (cred) log(`复用已有凭证  账号=${cred.accountId}`);
  else cred = await login();

  // 上报自我标识（UA 风格，仅用于服务端日志归因，不参与鉴权）
  const agent = setBotAgent(cfg.botAgent);
  log(`bot_agent=${agent}`);

  const state = { cred, contextTokens: new Map(), handled: 0, cfg };
  let cursor = '';
  // 长轮询超时由服务端建议值决定，初始 40 秒
  let pollTimeoutMs = 40000;
  let stopped = false;
  let controller;
  let notifiedStop = false;

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    log('正在停止…');
    controller?.abort();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 告诉服务端我们上线了。失败不影响收消息，只记一笔。
  try {
    await notifyStart(cred.baseUrl, cred.token);
    log('已上报上线通知');
  } catch (e) {
    warn('上线通知失败（不影响正常收发）:', e.message);
  }

  // ── 主动消息调度 ──────────────────────────────────────────────────────
  //
  // 两档行为：
  //   普通档 —— 用户安静一会儿，发一条，像正常搭话
  //   升级档 —— 连着发了好几次都没回音，一次性连发 5 条，表达"你到底理不理我"
  const composeProactive = async (userId, _user, info = {}) => {
    const { escalate = false, wantCount = 1, streak = 0, idleMinutes = 0, busy = false } = info;

    if (cfg.proactiveCompose === 'fixed') {
      const pool = Array.isArray(cfg.proactiveLines) && cfg.proactiveLines.length
        ? cfg.proactiveLines
        : ['在忙吗？'];
      if (!escalate) return pool[Math.floor(Math.random() * pool.length)];
      // 固定句子连发时循环取值
      const out = [];
      for (let i = 0; i < wantCount; i++) out.push(pool[i % pool.length]);
      return out;
    }

    const personaName = (await getUserPersona(userId)) || cfg.defaultPersona;
    const persona = personaName ? await getPersona(personaName) : null;

    // ── 主动搭话：连贯性 + 内容轮换 ──────────────────────────────────────
    //
    // 三个层次，缺一个都会让消息显得"莫名其妙"：
    //   1. 只有「用户不理她之后的第一条」是随机开新话题
    //   2. 之后每一条都接着上一条往下说（补充细节 / 说后来怎样）
    //   3. 偶尔在句末带一句具体的问题（问后来怎么了、为什么）
    //
    // 以前的问题：提示词写得太通用，模型每轮都收敛到同一句
    // （实测永远输出"哥哥你在干嘛呀"）。光写"要换着说"没用，所以代码里三层：
    //   1. 随机指定一个场景，提示词带上具体方向
    //   2. 把最近发过的话列进"禁止重复"清单
    //   3. 生成完做相似度检查，太像就重来一次，还不行用本地兜底句
    const recent = recentLines(12);
    const usedScenarios = recentScenarios(5);

    // ── 场景：先看"有没有一件挂着的事"，再决定说这件事还是开新题 ──────────
    //
    // 用户要的是"一个语境、一个整体的事，随机开新话题每 3 小时才一次"。
    // 所以这里的判定顺序是：
    //   ① 有当前场景、且没到换题冷却 → 必须接着说这件事
    //   ② 到了冷却（proactiveNewTopicMinutes，默认 180 分钟）→ 有资格抽新题
    //   ③ 同一件事已经聊了 sceneMaxTurns 轮 → 也允许换，不然会反复嚼同一件事
    const sceneEnabled = cfg.sceneEnabled !== false;
    let scene = sceneEnabled ? await loadScene(userId) : null;
    const newTopicIntervalMs = Math.max(1, cfg.proactiveNewTopicMinutes ?? 180) * 60 * 1000;
    const topicCooledDown = canOpenNewTopic(scene, { intervalMs: newTopicIntervalMs });
    const sceneExhausted = scene && (scene.turns || 0) >= Math.max(1, cfg.sceneMaxTurns ?? 12);
    const allowNewTopic = !scene || topicCooledDown || sceneExhausted;

    // 情绪：主动发什么，也要看她此刻的底色。
    // 累的时候不会兴致勃勃地分享；气头上更容易说一句带脾气的话。
    // 注意这里只读不结算 —— 情绪的演化还是要由"他说了一句话"来驱动，
    // 否则她一个人在那儿自说自话也能越来越气，那就不真实了。
    const emotionEnabled = cfg.emotionEnabled !== false;
    const emo = emotionEnabled ? await loadEmotion(userId) : null;
    const emotionContext = emo ? formatEmotionForProactive(emo) : '';
    const emoMood = emo?.mood || 'calm';
    const emoTemper = emoMood === 'annoyed' || emoMood === 'hurt';

    // ── 她自己的生活线：一个故事必须一拍一拍讲完 ──────────────────────────
    //
    // 用户原话：「每一条故事要有连贯性，不能这边没讲完，一会又冒出另一个故事」。
    // 所以这里不是"每次随机抽一件小事"，而是：
    //   · 有故事挂着 → 大多数时候接着讲下一拍（lifeContinueChance）
    //   · 没故事      → 冷却到了才可能开一个新的（lifeArcChance）
    // 讲完的一拍写进 life.json 的 progress；最后一拍讲完就关进 closed，
    // 之后只在"别再主动提"的清单里出现。
    const lifeEnabled = cfg.lifeEnabled !== false;
    let life = lifeEnabled ? loadLife(userId) : null;
    let lifeMode = false;
    let lifeArc = null;
    let lifeBeat = null;
    if (lifeEnabled && !busy && !escalate) {
      const cooldownMs = Math.max(10, cfg.lifeArcCooldownMinutes ?? 90) * 60 * 1000;
      const hanging = activeArc(life);
      if (hanging) {
        lifeArc = hanging;
        lifeBeat = currentBeat(hanging);
        lifeMode = !!lifeBeat && Math.random() < (cfg.lifeContinueChance ?? 0.85);
      } else if (canStartArc(life, { cooldownMs }) && Math.random() < (cfg.lifeArcChance ?? 0.45)) {
        life = startArc(userId, life, { conflictChance: cfg.lifeConflictChance ?? 0.35 });
        lifeArc = activeArc(life);
        lifeBeat = currentBeat(lifeArc);
        lifeMode = !!lifeArc;
        if (lifeMode) log(`  [生活线] 开新故事「${lifeArc.title}」（${lifeArc.kind}，共 ${lifeArc.beats.length} 拍）`);
      }
    }
    const lifeBlock = lifeMode
      ? formatLifeForProactive(lifeArc, lifeBeat, { closed: closedTitles(life) })
      : '';

    // streak 是「上次用户说话之后，她已经主动发过几次」。
    const isFirstAfterSilence = streak === 0;
    const prevLine = recent.length ? recent[recent.length - 1] : '';

    // 冷却到了也不一定立刻换题（每次都掐着 3 小时整换，反而像闹钟）。
    // 给 85% 概率换新题，剩下 15% 继续把手上这件事说完。
    const wantNewTopic = allowNewTopic && Math.random() < 0.85;
    const continueMode = !escalate && !wantNewTopic && !!prevLine;

    // 分享类场景权重更高（合计约 62%），所以大多数主动消息都在分享具体的小事。
    // 气头上/委屈时，主动消息更容易是带脾气的那两句（但不许连发，见 noRepeatBlock）
    const scenario = escalate
      ? 'cute'
      : (emoTemper && !busy && Math.random() < 0.5)
        ? (Math.random() < 0.5 ? 'temper_hurt' : 'temper_angry')
        : pickScenario(usedScenarios);
    const scenarioMeta = SCENARIO_HINTS[scenario] || {};
    const scenarioHint = scenarioMeta.hint || SCENARIO_HINTS.care.hint;
    // 有些场景本身就是"围着他"（权重高），必须带问句；带脾气的场景不强制提问。
    const wantsAsk = scenarioMeta.ask === true;
    const isTemper = scenario.startsWith('temper_');

    // 接着说的时候，把"你们挂着的那件事"喂给它。
    // 没有这一段，模型只能看到"上一条说过的话"，不知道那件事的来龙去脉。
    const sceneBlock = sceneEnabled && scene && !wantNewTopic
      ? formatSceneForProactive(scene, { canNewTopic: allowNewTopic })
      : '';

    // 偶尔带一个具体的问题。这里是纯代码掷骰子，不靠模型自己想。
    // 忙碌模式绝对不提问 —— 忙的人最烦被追问。
    const askChance = Number.isFinite(cfg.proactiveQuestionChance) ? cfg.proactiveQuestionChance : 0.35;
    const withQuestion = !escalate && !busy && (wantsAsk || Math.random() < askChance);

    // 忙碌模式的四种"不打扰"表达，轮着来，避免每 25 分钟都一句"我不催你"
    const BUSY_FLAVORS = [
      { key: 'report', hint: '说一句你自己在做什么（画画、吃东西、收拾东西），短，不要求回应' },
      { key: 'care', hint: '一句很轻的关心（记得喝水 / 别熬太晚），不追问、不说教' },
      { key: 'wait', hint: '让他安心的一句（我在这儿 / 你忙你的 / 我不催你）' },
      { key: 'cute', hint: '一个小小的撒娇，但绝不能带催促或委屈的语气' }
    ];
    const busyFlavor = busy ? BUSY_FLAVORS[Math.floor(Math.random() * BUSY_FLAVORS.length)] : null;

    // "禁止重复"清单。
    // 注意两种模式的要求是相反的：开新话题时连"同一件事"都不许重复；
    // 接着讲时相反 —— 必须还是那件事，只是话要换。
    // 忙碌模式：只禁止原句重复，不禁止同一件事（因为"等你"本来就是同一个主题）
    const noRepeatBlock = !recent.length
      ? ''
      : (continueMode || busy)
        ? [
            '',
            '**你已经发过的原句不能再重复**（但话题要继续，说的还是同一件事）：',
            ...recent.slice(-6).map((r) => `  · ${r}`),
            '',
            '不要问"在干嘛""在吗""吃了吗"这类空话。'
          ].join('\n')
        : [
            '',
            '你最近主动发过下面这些，**这一句绝对不能再重复，也不能换个说法说同一件事**：',
            ...recent.slice(-8).map((r) => `  · ${r}`),
            '',
            '尤其不要问"在干嘛""在吗""吃了吗""忙不忙"这类问题——这些你已经问过了。'
          ].join('\n');

    // 提问要求：让问题有真正的落点，而不是"你在干嘛"
    const questionHint = withQuestion
      ? [
          '',
          '【这条消息必须包含一个问题】',
          '说完那件小事之后，**句末一定要问他一句**，而且必须问得具体。可选方向：',
          '- 问那件事的**后来**："你猜后来怎么着""后来我还是没找到"',
          '- 问他**为什么/怎么了**："你怎么突然这么累呀"',
          '- 问他**做了什么/选哪个**："那你打算怎么办"',
          '✗ 不要问："在干嘛""在吗""吃了吗""忙不忙"',
          '整句话可以稍微长一点（10~35 个字），因为要多一个问句。'
        ].join('\n')
      : '';

    // 带问题时，从画像里挑一块他真实的信息当"提问素材"，
    // 这样问出来的东西有落点（问他电脑、问他游戏、问他工作），而不是空问。
    let questionContext = '';
    if (withQuestion && !escalate && cfg.ragEnabled && cfg.vaultPath) {
      try {
        const d = getProfileDigest(cfg.vaultPath, cfg.profileNotes || [], 320);
        if (d) {
          questionContext = [
            '',
            '【你可以问的素材（你记得的关于他的事）】',
            d,
            '挑其中**一件**，问一个具体的问题。不要全列出来，也不要问"你的电脑是什么配置"这种像查户口的。'
          ].join('\n');
        }
      } catch { /* 拿不到素材就不带，问题照样能问 */ }
    }

    // 开新话题时，从「他最近在弄的东西」里挑一个当话题候选。
    // 纯随机的烘焙/下雨天聊一百次也就那样，而聊他手上那件事更容易接下去。
    let recentTopicContext = '';
    if ((wantNewTopic || wantsAsk) && !busy && !escalate && cfg.ragEnabled && cfg.vaultPath) {
      try {
        const items = getRecentTopics(cfg.vaultPath, {
          days: cfg.recentTopicDays ?? 2,
          maxItems: (cfg.sceneRecentTopics ?? 5) + 3
        }).filter((i) => !isSuppressed(userId, i.title))
          .slice(0, cfg.sceneRecentTopics ?? 5);
        const block = formatRecentTopics(items, { maxChars: 200 });
        if (block) {
          recentTopicContext = [
            '',
            block,
            wantsAsk
              ? '这次就挑上面**一件**问他一句具体的（弄到哪一步了/搞定了没），别列清单、别像查户口。'
              : '如果你想聊他，就从上面挑**一件**问一句具体的（进展/有没有搞定/好不好玩）；',
            wantsAsk ? '' : '不想聊他就照【这次说什么】说自己的事，别硬扯。'
          ].filter(Boolean).join('\n');
        }
      } catch { /* 拿不到就不带，场景照样能说 */ }
    }

    const buildInstruction = (extraBan = '') => (busy
      ? [
          `他说了要去忙，现在过了 ${idleMinutes} 分钟了。`,
          '',
          '你不打扰他，但你还在，你想让他知道这一点。',
          '',
          `【这次说什么】${busyFlavor.hint}`,
          '',
          '要求：',
          `1. 一共输出 ${wantCount} 条，用空行隔开，每条之间不要编号。`,
          '2. 每条都很短，3~12 个字，看他手机屏幕一眼就能看完。',
          '3. **绝对不要提问**。不要问"忙完了吗""在忙吗""几点回来""还忙吗"。',
          '4. **不要催他**，不要表达委屈，不要说"你都不理我"。',
          '5. 不要提"忙""等很久""这么久"这类带时间暗示的词。',
          '6. 不要写括号动作，不要加引号。',
          '7. 语气是"我懂你在忙"，不是"你怎么还不回我"。',
          emotionContext,
          noRepeatBlock,
          extraBan
        ].filter(Boolean).join('\n')
      : escalate
      ? [
          idleMinutes > 0
            ? `他已经 ${idleMinutes} 分钟没回你了。`
            : `你已经主动找过对方 ${streak} 次了，对方一直没回你。`,
          `你等不住了，想一口气连发 ${wantCount} 条短消息给他。`,
          '',
          prevLine ? `你上一条发的是：「${prevLine}」` : '',
          prevLine ? `**这 ${wantCount} 条要接着上面那件事往下走**，不要突然换话题。` : '',
          sceneBlock,
          emotionContext,
          '',
          '要求：',
          `1. 一共输出 ${wantCount} 条，用空行隔开，每条之间不要编号。`,
          '2. 每条都很短，5-12 个字，像真的急了在连发微信。',
          '3. 情绪要有递进：先接着说那件事，再委屈，再有点生气/赌气，最后一条软下来留台阶。',
          '4. 不要提"主动""定时""第几次""几分钟"之类的字眼。',
          '5. 不要写括号动作，不要加引号。',
          noRepeatBlock,
          extraBan
        ].filter(Boolean).join('\n')
      : continueMode
        ? [
            '现在没有人跟你说话。你上面已经跟他说过一件事了，他没回，你还想接着说。',
            '',
            `【你上一条说的是】${prevLine}`,
            '',
            sceneBlock,
            emotionContext,
            '**这次接着说同一件事**，不要开新话题。可以选一种往下走：',
            '- 补充一个刚想起来的新细节',
            '- 说这件事后来怎样了（哪怕只是"还是没找到"）',
            '- 就这件事再问一句',
            '',
            '要求：',
            '- 只说一句很短的话（5~25 个字），像真人接着自己的话发第二条。',
            '- 还是要有具体的东西（东西、颜色、味道、几个、什么时候）。',
            '- 原句绝不能重复，但话题必须连着。',
            '- 只输出这一句话本身：不要引号、不要括号里的动作、不要解释。',
            '- 不要提到"主动""定时"之类的字眼。',
            questionHint,
            questionContext,
            noRepeatBlock,
            extraBan
          ].filter(Boolean).join('\n')
        : [
            '现在没有人跟你说话，你想主动找他聊一句。',
            '',
            wantsAsk
              ? '这次**围着他**说，不要说自己的事。你说这句话，是因为你想知道他今天怎么样、他手上那件事怎么样了。'
              : isTemper
                ? '这次你心里有点不痛快：他最近陪你说话太少，或者回得敷衍。你想说一句带脾气的话，但这种脾气是"要人哄"的，不是吵架。'
                : '你分享欲很强。看到什么、吃到什么、做了什么，都忍不住想跟他说一句。',
            wantsAsk
              ? '所以这次不说身边的小事，也不问"在干嘛"，而是**问一件跟他有关的具体的事**。'
              : '所以这次不说"没事"，也不问"在干嘛"，而是**把一件具体的小事说给他听**。',
            '',
            lifeMode
              ? lifeBlock
              : `【这次说什么】${scenarioHint}`,
            '',
            emotionContext,
            '要求：',
            wantCount > 1
              ? `- 一共写 ${wantCount} 条，用空行隔开；每条 5~20 个字，像真人连着发好几条微信。`
              : '- 只说一句很短的话（5~25 个字），像真人随手发的一条微信。',
            wantsAsk
              ? '- **必须问得具体**：问的是哪件事、哪一天、哪一步，不要泛泛一句"今天怎么样"。'
              : '- **必须带一个具体细节**：什么东西、什么颜色、什么味道、几个、什么时候。',
            '  ✗ 不行："好无聊呀""今天好累"（太抽象，没有可以说下去的钩子）',
            '  ✓ 可以："楼下桂花开了，一小簇一小簇的黄"',
            '  ✓ 可以："烤饼干焦了一盘，就中间那两个还能看"',
            isTemper
              ? '- 脾气要露出来一点（哼、才不、你都不、我不高兴了），但**不许真的骂人、不许威胁、不许说"再也不理你"**，结尾要留个台阶让他哄你。'
              : '',
            '- 只输出这一句话本身：不要引号、不要括号里的动作、不要解释。',
            '- 不要提到"主动""定时"之类的字眼。',
            questionHint || '- 尽量别用问句；要问也只问一件具体的小事。',
            questionContext,
            recentTopicContext,
            noRepeatBlock,
            extraBan
          ].filter(Boolean).join('\n'));

    // 主动搭话也走当前模式的通道：chat 模式用直连 API（省 token），dsh 模式用 headless
    const generate = async (instruction) => {
      if (MODE === 'chat') {
        const history = await loadHistory(userId);
        const messages = buildChatMessages(persona, history, instruction, {
          recentTurns: cfg.historyRecentTurns ?? 3,
          olderChars: cfg.historyOlderChars ?? 40,
          compress: compressHistory
        });
        return chatComplete({
          baseUrl: cfg.chatBaseUrl,
          apiKey: API_KEY.key,
          model: cfg.chatModel,
          messages,
          temperature: cfg.chatTemperature,
          timeoutMs: 60000
        });
      }
      const task = await buildTask(userId, instruction, persona);
      return runTask(task, { timeoutMs: Math.min(cfg.taskTimeoutMs, 90000) });
    };

    let result = await generate(buildInstruction());
    if (!result.ok || !result.text) return '';

    let cleaned = stripActions(result.text, cfg.stripActions);

    // ── 忙碌模式：发 2-3 条，逐条去重 ────────────────────────────────────
    // 这里不重试、不换话题：重复的直接丢掉，宁少一条也不重复。
    // 因为忙碌模式本来就是"轻轻说一句"，少一条完全没影响。
    if (busy) {
      const rawBubbles = cleaned
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, wantCount);

      const kept = [];
      for (const b of rawBubbles) {
        if (isTooSimilar(b, { threshold: 0.8 }).similar) {
          log(`  [忙碌] 丢弃重复句：${b.slice(0, 20)}`);
          continue;
        }
        kept.push(b);
        rememberLine(b, 'busy');
      }

      if (!kept.length) {
        const fb = fallbackLine();
        log(`  [忙碌] 全部重复，改用兜底句（${fb.scenario}）`);
        rememberLine(fb.text, fb.scenario);
        return fb.text;
      }
      return kept;
    }

    if (!escalate) {
      let first = cleaned.split(/\n{2,}/)[0].trim().slice(0, 200);

      // 踩到他明确说过"别再提"的话题：换一件，别再来一遍。
      if (first && isSuppressed(userId, first)) {
        log('  [遗忘] 主动消息踩到他不愿再提的话题，重生成一次');
        const re = await generate(buildInstruction(
          '\n【换一件】他明确说过不想再提刚才那个话题。这次说一件完全无关的。'
        ));
        const c2 = re.ok && re.text
          ? stripActions(re.text, cfg.stripActions).split(/\n{2,}/)[0].trim().slice(0, 200)
          : '';
        if (c2 && !isSuppressed(userId, c2)) {
          first = c2;
        } else {
          const fb = fallbackLine();
          first = fb.text;
          rememberLine(fb.text, fb.scenario);
          log('  [遗忘] 换不出来，用兜底句');
        }
      }

      // 重复判定分两档：
      //   · 开新话题 → 门槛 0.5，连"说同一件事"都不行
      //   · 接着讲   → 门槛 0.8，只拦"几乎一字不差"，因为这里**本来就要说同一件事**
      const simOpts = continueMode ? { threshold: 0.8 } : {};
      let check = isTooSimilar(first, simOpts);

      // 带问题的那一轮，如果生成的句子里根本没有问句，就再要一次。
      // 实测：光在提示词里写"必须问一句"，模型照样会漏掉 —— 得有代码检查。
      // 注意不能只看问号：中文经常靠"怎么/为什么/哪/多少"来提问而不带问号。
      const hasQuestion = (s) => {
        const t = String(s || '');
        if (/[？?]/.test(t)) return true;
        if (/(吗|呢|呀|吧)\s*$/.test(t.trim())) return true;
        return /怎么|为什么|为啥|什么|哪[个里儿]|多少|几个|多久|是不是|有没有|要不要|行不行|好不好/.test(t);
      };

      if (withQuestion && !hasQuestion(first)) {
        log('  [主动] 要求带问题但没问号，重生成一次');
        const qRetry = await generate(buildInstruction(
          `\n【刚才你写的是】${first}\n这句话里**没有问他任何问题**。必须在这一句的末尾加一个具体的问题（问后来怎样、为什么、怎么了）。`
        ));
        if (qRetry.ok && qRetry.text) {
          const c3 = stripActions(qRetry.text, cfg.stripActions).split(/\n{2,}/)[0].trim().slice(0, 200);
          if (c3 && hasQuestion(c3)) {
            first = c3;
            check = isTooSimilar(first, simOpts);
          }
        }
      }

      if (check.similar) {
        log(`  [主动] 第一版被判定重复（${check.reason}），重生成一次`);
        const retry = await generate(buildInstruction(
          continueMode
            ? `\n【刚才你写的是】${first}\n这句和上一条几乎一模一样，换句话接着说同一件事。`
            : `\n【刚才你写的是】${first}\n这句不能用（${check.reason}）。换一个完全不同的说法和角度。`
        ));
        if (retry.ok && retry.text) {
          const c2 = stripActions(retry.text, cfg.stripActions).split(/\n{2,}/)[0].trim().slice(0, 200);
          if (c2 && !isTooSimilar(c2, simOpts).similar) {
            first = c2;
            check = { similar: false };
          }
        }
      }

      if (check.similar && continueMode) {
        // 接着讲的时候**不要**换成无关的兜底句 —— 那才是真正"莫名其妙"。
        // 宁可这句话和上一条有点近，也要保住话题连贯。
        log(`  [主动] 仍在同话题上重复，但为保连贯，保留当前这句`);
        check = { similar: false };
      } else if (check.similar) {
        // 开新话题时还重复 → 用本地兜底句，保证绝不重样
        const fb = fallbackLine();
        log(`  [主动] 模型两次都重复，改用本地兜底句（场景 ${fb.scenario}）`);
        first = fb.text;
        rememberLine(first, fb.scenario);
        if (sceneEnabled) {
          if (wantNewTopic || !scene) {
            scene = markNewTopic(scene, first, { source: 'proactive' });
            log(`  [场景] 兜底句作为新话题「${scene.topic}」`);
          } else {
            scene = recordReply(scene, first);
          }
          await saveScene(userId, scene);
        }
        return first;
      }

      // 一口气发几条：用户要「1-3 条为主，偶尔 2-6 条」。
      // 模型经常只写一句，所以首句之外再从原文里补；补不满就按实际条数发。
      let outgoing = first;
      if (wantCount > 1) {
        const parts = splitIntoBubbles(cleaned, {
          maxMessages: wantCount,
          enabled: true,
          shortReplyThreshold: 0,
          minimumFragmentLength: 0
        }).filter(Boolean);
        const byLine = cleaned.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        const pool = parts.length >= 2 ? parts : (byLine.length > parts.length ? byLine : parts);
        const out = [];
        for (const p of [first, ...pool]) {
          const t = String(p || '').trim().slice(0, 200);
          if (!t || out.includes(t)) continue;
          if (out.length < wantCount) out.push(t);
        }
        if (out.length > 1) outgoing = out;
      }

      const outgoingText = Array.isArray(outgoing) ? outgoing.join(' ') : outgoing;
      if (Array.isArray(outgoing)) {
        for (const o of outgoing) rememberLine(o, continueMode ? 'continue' : scenario);
        log(`  [主动] 这一批发 ${outgoing.length} 条`);
      } else {
        rememberLine(first, continueMode ? 'continue' : scenario);
      }

      // ── 把这次主动消息写回场景 ──────────────────────────────────────────
      // 开新题：markNewTopic 会重置场景并落"换题冷却"，这是 3 小时阈值的锚点。
      // 接着说：只更新"上次说到"和"欠他一个问题"，话题本身不动。
      if (sceneEnabled) {
        if (wantNewTopic || !scene) {
          if (!escalate) {
            scene = markNewTopic(scene, outgoingText, { source: 'proactive' });
            await saveScene(userId, scene);
            log(`  [场景] 主动开了新话题「${scene.topic}」，下次换题至少 ${Math.round(newTopicIntervalMs / 60000)} 分钟后`);
          }
        } else {
          scene = recordReply(scene, outgoingText);
          await saveScene(userId, scene);
        }
      }

      // 剧情要等文字真的发出去了才算"讲过这一拍"，先挂起，afterSend 里推进。
      if (lifeMode && lifeArc) {
        pendingLifeAdvance.set(userId, { life, title: lifeArc.title, text: outgoingText });
      }
      return outgoing;
    }

    // 升级档：先按空行拆；模型常常只用单换行，那就再按单换行拆。
    // 不处理单换行的话，四句话会被挤进一条，连发就失去意义了。
    let bubbles = splitIntoBubbles(cleaned, {
      maxMessages: wantCount,
      enabled: true,
      shortReplyThreshold: 0,
      minimumFragmentLength: 0
    }).filter((b) => b && b.trim());

    // 如果条数还不够，且原文里本来就有单换行，就按单换行重拆
    if (bubbles.length < wantCount && /\n/.test(cleaned)) {
      const byLine = cleaned
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (byLine.length > bubbles.length) bubbles = byLine;
    }

    // 模型给的条数还不够就补几句，别让"连发 5 条"变成"发了 2 条就没了"。
    // 补的句子也要避开"在干嘛/在吗"这类被用烂的句式。
    const fillers = ['宝宝？', '理我一下嘛…', '哼', '我先去吃饼干了', '……好吧'];
    let i = 0;
    while (bubbles.length < wantCount && i < fillers.length) {
      bubbles.push(fillers[i++]);
    }

    const result2 = bubbles.slice(0, wantCount).map((b) => b.slice(0, 200));
    for (const b of result2) rememberLine(b, 'cute');
    log(`  [主动] 升级连发 ${result2.length} 条（沉默 ${streak} 次）`);

    // 升级连发也是"接着那件事急起来了"，不当作换题
    if (sceneEnabled && scene) {
      scene = recordReply(scene, result2.join('\n\n'));
      await saveScene(userId, scene);
    }
    return result2;
  };

  // ── 发送窗口"续期"尝试 ─────────────────────────────────────────────────
  //
  // 背景：iLink 只允许在用户最后说话之后的一段时间内主动发消息，超了返回 ret=-2。
  // 协议里没有任何官方"续期"接口（我查过 ilink.js 全部 18 个端点）。
  // 所以这里选了个最不打扰的试探：先 getconfig（纯读接口，用户看不见），
  // 再发一次「正在输入」并立刻取消（一闪而过）。
  //
  // 这个动作到底能不能延长窗口，目前**未知** —— 所以每次尝试的结果都会记进
  // data/window-probe.jsonl，攒几天就能测出真实窗口到底多长。
  const keepAliveFor = async (userId) => {
    if (cfg.busyKeepAlive === false) return;
    const contextToken = state.contextTokens.get(userId) ?? '';
    if (!contextToken) return;
    try {
      const cfgResp = await getBotConfig(state.cred.baseUrl, state.cred.token, userId, contextToken);
      const ticket = cfgResp?.typing_ticket;
      if (ticket) {
        await sendTyping(state.cred.baseUrl, state.cred.token, userId, ticket, 1);
        await sendTyping(state.cred.baseUrl, state.cred.token, userId, ticket, 2);
      }
    } catch { /* 续期只是试探，失败不影响发送 */ }
  };

  // 记录「沉默多久 → 能不能发出去」，用来反推真实窗口
  const recordWindowProbe = (rec) => {
    try {
      const dir = path.join(ROOT, 'data');
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        path.join(dir, 'window-probe.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n',
        'utf8'
      );
    } catch { /* 记录失败不影响主流程 */ }
  };

  // 调度器参数（间隔/静默/连发条数）是构造时的快照，
  // 所以包成工厂函数：配置热加载时重建一次，让它也吃上新值。
  let proactive;
  const buildProactive = () => createProactiveScheduler({
    enabled: cfg.proactive,
    minGapMs: Math.max(1, cfg.proactiveMinMinutes) * 60 * 1000,
    maxGapMs: Math.max(cfg.proactiveMinMinutes, cfg.proactiveMaxMinutes) * 60 * 1000,
    idleBeforeMs: Math.max(1, cfg.proactiveIdleMinutes) * 60 * 1000,
    contextTtlMs: Math.max(cfg.proactiveIdleMinutes, cfg.proactiveContextTtlMinutes) * 60 * 1000,
    tickEveryMs: Math.max(3, cfg.proactiveTickSeconds ?? 15) * 1000,
    burstAfter: Math.max(1, cfg.proactiveBurstAfter ?? 3),
    burstAfterIdleMs: Math.max(1, cfg.proactiveBurstAfterIdleMinutes ?? 5) * 60 * 1000,
    burstCount: Math.max(1, cfg.proactiveBurstCount ?? 5),
    burstMinCount: Math.max(1, cfg.proactiveBurstMinCount ?? 3),
    burstMaxCount: Math.max(1, cfg.proactiveBurstMaxCount ?? 5),
    burstGapMs: Math.max(200, cfg.proactiveBurstGapMs ?? 500),
    // 忙碌模式
    busyGapMs: Math.max(1, cfg.busyIntervalMinutes ?? 25) * 60 * 1000,
    busyMinCount: Math.max(1, cfg.busyMinCount ?? 2),
    busyMaxCount: Math.max(1, cfg.busyMaxCount ?? 3),
    busyBurstGapMs: Math.max(300, cfg.busyBurstGapMs ?? 1500),
    getBusy: (userId) => (cfg.busyModeEnabled === false ? false : isBusy(userId)),
    keepAlive: cfg.busyKeepAlive === false ? null : keepAliveFor,
    recordProbe: recordWindowProbe,
    retryDelayMs: Math.max(10, cfg.proactiveRetrySeconds ?? 60) * 1000,
    maxFailStreak: Math.max(1, cfg.proactiveMaxFailStreak ?? 3),
    // 普通档一次发几条：1-3 条为主，20% 概率来一波 2-6 条。
    wantCountFn: () => {
      const longChance = Math.max(0, Math.min(1, cfg.proactiveCountLongChance ?? 0.2));
      if (Math.random() < longChance) {
        const lo = Math.max(1, cfg.proactiveCountLongMin ?? 2);
        const hi = Math.max(lo, cfg.proactiveCountLongMax ?? 6);
        return lo + Math.floor(Math.random() * (hi - lo + 1));
      }
      const lo = Math.max(1, cfg.proactiveCountShortMin ?? 1);
      const hi = Math.max(lo, cfg.proactiveCountShortMax ?? 3);
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    },
    compose: async (userId, user, info = {}) => {
      const r = await composeProactive(userId, user, info);
      // 文字定下来之后再决定要不要带张图 —— 图的内容要跟这句话的意思对得上
      try {
        const txt = Array.isArray(r) ? r.join(' ') : r;
        if (txt && !info.busy && !pendingProactiveImages.has(userId)) {
          const b = checkAutoBudget(cfg);
          if (b.allowed) {
            const emo = cfg.emotionEnabled !== false ? await loadEmotion(userId) : null;
            const turn = replyTurnCount.get(userId) ?? 0;
            const d = decideAutoImage({
              cfg,
              mood: emo?.mood,
              stance: 'follow',
              userText: '',
              replyText: txt,
              gapTurns: turn - (lastAutoImageTurn.get(userId) ?? -999),
              canDraw: true,
              chance: cfg.autoImageProactiveChance ?? 0.05,
              rng: Math.random
            });
            if (d) {
              pendingProactiveImages.set(userId, d);
              log(`  [生图] 这条主动消息打算带一张${d.kind === 'expression' ? '表情图' : d.kind === 'draw' ? '手绘' : '照片'}：${d.subject.slice(0, 30)}`);
            }
          }
        }
      } catch { /* 决定失败就当这次不带图 */ }
      return r;
    },
    send: async (userId, text) => sendText(state, userId, text),
    // 一批主动消息发完后，把挂着的那张图补上。
    // 放在文字之后是刻意的：生成要 8~14 秒，反过来的话她会先沉默十几秒才说话。
    afterSend: async (userId) => {
      // ① 剧情推进：这一拍确实发出去了，才写进 progress
      const story = pendingLifeAdvance.get(userId);
      if (story) {
        pendingLifeAdvance.delete(userId);
        try {
          const before = (activeArc(story.life)?.stage) ?? 0;
          advanceArc(userId, story.life, story.text);
          const after = activeArc(story.life);
          if (!after) {
            log(`  [生活线] 「${story.title}」讲完了，收进"别再主动提"清单`);
          } else {
            log(`  [生活线] 「${story.title}」讲完第 ${before + 1}/${after.beats.length} 拍`);
          }
        } catch (e) {
          warn(`[生活线] 推进失败: ${e.message}`);
        }
      }

      const p = pendingProactiveImages.get(userId);
      if (!p) return;
      pendingProactiveImages.delete(userId);
      try {
        await sendText(state, userId, p.caption);
        const d = await drawAndSend(state, userId, p.subject, 'proactive');
        if (d.ok) {
          recordAutoImage();
          lastAutoImageTurn.set(userId, replyTurnCount.get(userId) ?? 0);
          log(`  [生图] 主动带图已发送（${p.kind}）`);
        } else {
          log(`  [生图] 主动带图没画成（${d.kind}），文字已经发出去了，就不提了`);
        }
      } catch (e) {
        warn(`主动带图失败: ${e.message}`);
      }
    },
    log,
    warn
  });

  if (cfg.forgetEnabled !== false) {
    try {
      pruneTopics();
      log('  [遗忘] 话题记忆已清理（只留最近的，过期的自己忘记）');
    } catch (e) {
      warn(`  [遗忘] 清理失败: ${e.message}`);
    }
  }

  // ── 配置热加载 ──────────────────────────────────────────────────────
  // 控制台保存参数后不用重启机器人：每 5 秒看一眼 config.json 的修改时间，
  // 变了就重新读一遍并替换 state.cfg（所有读 state.cfg 的位置立即生效）。
  // 放在定时器里而不是轮询循环里，是因为长轮询会阻塞 40 秒，那样反应太慢。
  setInterval(() => {
    try {
      const st = statSync(CFG_PATH);
      if (st.mtimeMs === cfgStamp) return;
      cfgStamp = st.mtimeMs;
      const next = loadConfig();
      cfg = next;
      state.cfg = next;
      // 调度器参数是构造时快照，重建一次让新配置立刻生效
      // （userState 是 proactive.js 模块级的，lastUserSpokeAt 不会丢）
      try { proactive?.stop(); } catch { /* 旧调度器本来就没跑 */ }
      proactive = buildProactive();
      if (cfg.proactive) proactive.start();
      log(`[配置] config.json 已更新，热加载完成（${Object.keys(next).length} 项）`);
    } catch { /* 文件一时读不到就跳过 */ }
  }, 5000);

  proactive = buildProactive();
  proactive.start();

  log('开始长轮询，等待微信消息…');
  console.log('');

  let retryMs = 1000;
  let emptyPolls = 0;

  while (!stopped) {
    try {
      controller = new AbortController();
      const resp = await getUpdates(cred.baseUrl, cred.token, cursor, controller.signal, pollTimeoutMs);
      controller = undefined;

      if (resp.get_updates_buf) cursor = resp.get_updates_buf;

      // 服务端可以建议下次轮询的时长，听从它
      if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
        pollTimeoutMs = Math.min(Math.max(resp.longpolling_timeout_ms, 5000), 120000);
      }

      const msgs = resp.msgs ?? [];
      if (msgs.length === 0) {
        emptyPolls++;
        if (emptyPolls % 20 === 0) log(`仍在等待…（已空轮询 ${emptyPolls} 次，超时 ${Math.round(pollTimeoutMs / 1000)}s）`);
      } else {
        emptyPolls = 0;
      }

      for (const msg of msgs) {
        if (msg.message_type !== MSG_TYPE.USER) continue;
        if (!msg.from_user_id) continue;

        // 把收到的原始消息落盘一份。
        // 用途：排查协议问题（比如收发的 image_item 结构差异）时，
        // 这就是最权威的对照物，比猜参数组合靠谱得多。
        if (MODE === 'dsh' || VERBOSE) {
          try {
            const { mkdirSync, writeFileSync } = await import('node:fs');
            const dir = path.join(ROOT, 'data', 'received');
            mkdirSync(dir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            writeFileSync(
              path.join(dir, `${stamp}.json`),
              JSON.stringify(msg, null, 2),
              'utf8'
            );
          } catch { /* 落盘失败不影响主流程 */ }
        }

        if (msg.context_token) {
          state.contextTokens.set(msg.from_user_id, msg.context_token);
        }

        const userId = msg.from_user_id;

        // 记录活跃时间，并把"沉默计数"清零 ——
        // 用户回话了说明撒娇该收敛，不能继续按"他不理我"的档位发连珠炮。
        touchUser(userId, { lastSeenAt: Date.now(), userSpoke: true });

        // 白名单
        if (cfg.allowedUsers.length && !cfg.allowedUsers.includes(userId)) {
          warn(`拒绝未授权用户: ${userId}`);
          continue;
        }

        const text = extractText(msg);
        log(`收到  来自=${userId}  类型=${describeItems(msg)}` +
          (text ? `  内容=${JSON.stringify(text.slice(0, 60))}` : ''));

        if (VERBOSE) {
          log(`  context_token=${(state.contextTokens.get(userId) || '').slice(0, 16)}…`);
        }

        try {
          if (MODE === 'echo') {
            await sendText(state, userId, text
              ? `收到：${text}\n\n—— 语忆AI echo 模式，链路正常`
              : '这个模式目前只处理文字消息。');
            state.handled++;
          } else if (MODE === 'dsh' || MODE === 'chat') {
            // chat 和 dsh 共用同一条处理链路（人设/记忆/分条/指令都一样），
            // 只在真正调用模型那一步分岔。之前只放行了 dsh，导致 chat 模式
            // 掉进"未知模式"分支。
            if (await handleCommand(state, msg, text ?? '')) {
              state.handled++;
              continue;
            }
            // 丢进该用户的队列，不阻塞长轮询
            enqueue(userId, async () => {
              await handleWithDsh(state, msg, text);
              state.handled++;
            });
          } else {
            await sendText(state, userId, `未知模式 ${MODE}`);
          }
        } catch (e) {
          warn('处理消息失败:', e.message);
        }
      }

      retryMs = 1000;
    } catch (e) {
      controller = undefined;
      if (stopped) break;

      if (e.name === 'AbortError' || e.name === 'TimeoutError') continue;

      if (isSessionExpired(e)) {
        warn('会话已过期（errcode -14），需要重新扫码登录');
        await rm(CRED_PATH, { force: true });
        try {
          cred = await login(cred.baseUrl);
          state.cred = cred;
          state.contextTokens.clear();
          cursor = '';
          retryMs = 1000;
          continue;
        } catch (loginErr) {
          warn('重新登录失败:', loginErr.message);
          break;
        }
      }

      warn('长轮询出错:', e.message);
      await delay(retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    }
  }

  // 停掉主动消息调度，避免退出过程中还在发东西
  proactive.stop();

  // 告诉服务端我们下线了。放在这里而不是 shutdown 里，是因为 shutdown 只做中断，
  // 真正退出在这里 —— 这样通知一定能发出去，不会因进程被打断而丢失。
  if (!notifiedStop) {
    notifiedStop = true;
    try {
      await notifyStop(cred.baseUrl, cred.token);
      log('已上报下线通知');
    } catch (e) {
      warn('下线通知失败（不影响已收到的消息）:', e.message);
    }
  }

  log(`已停止。本次共处理 ${state.handled} 条消息`);
}

export { handleWithDsh };

if (!flag('--desktop-transport')) main().catch((e) => {
  console.error('');
  console.error('  启动失败:', e.message);
  if (e instanceof ApiError && e.status) console.error('  HTTP 状态:', e.status);
  console.error('');
  process.exit(1);
});
