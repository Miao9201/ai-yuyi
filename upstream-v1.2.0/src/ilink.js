/**
 * 微信 iLink Bot API —— 协议层
 *
 * 以腾讯官方实现为规范校准：
 *   仓库 https://github.com/Tencent/openclaw-weixin
 *   包   @tencent-weixin/openclaw-weixin@2.4.10（MIT）
 * 早期版本参考的是 wechaty-puppet-claw-wechat 的逆向实现，
 * 现在端点、字段、版本编码都对齐官方源码。
 *
 * 关键约束（官方文档明确写的）：
 *   - 所有 sendmessage 都必须带 context_token，它来自用户发的消息。
 *     因此 bot 不能主动发起会话，必须先由用户开话题。
 *   - 只支持 1:1 私聊。
 *   - errcode -14 = 会话过期，需重新扫码登录。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * 本通道的 App 标识。
 *
 * 官方 @tencent-weixin/openclaw-weixin 从 package.json 的 ilink_appid 字段读，
 * 值就是 "bot"，并且**每个请求都带 iLink-App-Id 头**。
 * 我们之前完全没发这个头 —— 文字消息服务端宽松放过了，
 * 但媒体要在接收端解密展示，缺这个头很可能被判定成"不属于本通道的媒体"，
 * 表现就是发出去对方显示"已清理 / 已过期"。
 */
export const ILINK_APP_ID = 'bot';

/**
 * 对外声明的版本。
 *
 * 同时用于 base_info.channel_version 和 iLink-App-ClientVersion 头，
 * 两者必须自洽 —— 官方也是这么做的（都取 package.json 的 version）。
 *
 * 对齐官方 2.4.10：换算成 iLink-App-ClientVersion = 2<<16 | 4<<8 | 10 = 132106。
 * 之前写 1.0.0（65536），和官方差了一大截。
 */
export const CHANNEL_VERSION = '2.4.10';

/**
 * iLink-App-ClientVersion: uint32，格式 0x00MMNNPP。
 * 高 8 位固定 0；其余 major<<16 | minor<<8 | patch。
 * 例："1.0.11" -> 0x0001000B = 65547
 */
export function buildClientVersion(version = CHANNEL_VERSION) {
  const parts = String(version).split('.').map((p) => parseInt(p, 10) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION = buildClientVersion();

/**
 * bot_agent：UA 风格的自我标识，仅供服务端做日志归因与监控，不参与鉴权或路由。
 * 语法：product *( SP product )，product = name "/" version [ SP "(" comment ")" ]
 * 仅 ASCII，清洗后总长 ≤ 256 字节；不合法则丢弃。
 */
const DEFAULT_BOT_AGENT = 'WxBridge';
const BOT_AGENT_MAX_BYTES = 256;

/**
 * 把用户配置的 bot_agent 清洗成 wire-safe 字符串。
 *
 * 官方语法（UA 风格）：
 *   bot_agent = product *( SP product )
 *   product   = name "/" version [ SP "(" comment ")" ]
 *   name      = 1*32( ALPHA / DIGIT / "_" / "." / "-" )
 *   version   = 1*32( ALPHA / DIGIT / "_" / "." / "+" / "-" )
 *   comment   = 1*64( printable ASCII 减去 "(" 和 ")" )
 *
 * 做法：逐个 product 解析，超长字段截断到上限后重建，
 * 而不是整串正则校验失败就回退 —— 用户写长一点点不该白配。
 */
export function sanitizeBotAgent(input) {
  const raw = typeof input === 'string' && input.trim() ? input.trim() : DEFAULT_BOT_AGENT;
  const ascii = raw.replace(/[^\x20-\x7E]/g, '').trim();
  if (!ascii) return DEFAULT_BOT_AGENT;

  const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
  const VERSION_RE = /^[A-Za-z0-9_.+-]{1,32}$/;

  // 用一个宽松的整体正则先切出 (name, version, comment) 三元组，
  // 注释允许含空格，所以不能用 \S+ 分词。
  const PRODUCT_RE = /([A-Za-z0-9_.-]{1,32})\/([A-Za-z0-9_.+-]{1,32})(?:\s*\(([^()]{1,64})\))?/g;

  const rebuilt = [];
  let m;
  while ((m = PRODUCT_RE.exec(ascii)) !== null) {
    let name = m[1];
    let version = m[2];
    let comment = m[3];

    if (!NAME_RE.test(name)) name = name.slice(0, 32);
    if (!VERSION_RE.test(version)) version = version.slice(0, 32);
    if (comment) comment = comment.trim().slice(0, 64);

    let product = `${name}/${version}`;
    if (comment) product += ` (${comment})`;
    rebuilt.push(product);
  }

  if (!rebuilt.length) return DEFAULT_BOT_AGENT;

  let out = rebuilt.join(' ');
  if (Buffer.byteLength(out, 'utf8') > BOT_AGENT_MAX_BYTES) {
    // 超总长时从尾部丢弃整个 product，保证不会截出半个 token
    while (rebuilt.length > 1 && Buffer.byteLength(rebuilt.join(' '), 'utf8') > BOT_AGENT_MAX_BYTES) {
      rebuilt.pop();
    }
    out = rebuilt.join(' ');
  }
  return out;
}

let botAgent = DEFAULT_BOT_AGENT;
/** 启动时由 index.js 调一次，把配置里的 botAgent 设进来 */
export function setBotAgent(value) {
  botAgent = sanitizeBotAgent(value);
  return botAgent;
}

export const MSG_TYPE = { NONE: 0, USER: 1, BOT: 2 };
export const MSG_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const ITEM_TYPE = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12
};
export const TYPING_STATUS = { TYPING: 1, CANCEL: 2 };

export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** errcode -14 = 会话过期，需要重新扫码 */
export function isSessionExpired(err) {
  return err instanceof ApiError && err.code === -14;
}

/** 微信客户端要求这个头，值是随机 uint32（大端）十进制字符串再 base64 */
function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token) {
  const h = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    // 官方每条请求都带这两个头，缺了媒体通道可能不认
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION)
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** 每个请求都附带的元信息 */
function buildBaseInfo() {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: botAgent
  };
}

function normalizeEndpoint(baseUrl, endpoint) {
  // 官方用 new URL(endpoint, base) 的语义：endpoint 不带前导斜杠
  // 这里手工拼接，保证 /ilink/bot/xxx 一定挂在根上。
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

async function postJson(baseUrl, endpoint, body, token, timeoutMs = 15000, signal) {
  const url = normalizeEndpoint(baseUrl, endpoint);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
    signal: combined
  });

  const text = await res.text();
  // WeChat IDs are uint64; preserve their source digits for durable deduplication.
  const payload = text ? JSON.parse(text, (key, value, context) =>
    /^(message_id|msg_id|seq)$/.test(key) && typeof value === 'number' && !Number.isSafeInteger(value)
      ? context.source : value) : {};

  if (!res.ok) {
    throw new ApiError(payload.errmsg ?? `HTTP ${res.status}`, {
      status: res.status,
      code: payload.errcode
    });
  }

  const appCode =
    typeof payload.ret === 'number' && payload.ret !== 0 ? payload.ret
      : typeof payload.errcode === 'number' && payload.errcode !== 0 ? payload.errcode
        : undefined;

  if (appCode !== undefined) {
    throw new ApiError(payload.errmsg ?? `ret=${appCode}`, { status: res.status, code: appCode });
  }
  return payload;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(payload.errmsg ?? `HTTP ${res.status}`, { status: res.status });
  }
  return payload;
}

// ── 登录 ────────────────────────────────────────────────────────────────────

/** 取登录二维码。bot_type=3 是 ClawBot 用的类型。 */
export async function fetchQrCode(baseUrl = ILINK_BASE_URL) {
  return getJson(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`);
}

/** 轮询扫码状态。status: wait / scaned / confirmed / expired */
export async function pollQrStatus(baseUrl, qrcode) {
  return getJson(
    `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { 'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION) }
  );
}

// ── 上线 / 下线通知 ─────────────────────────────────────────────────────────

/**
 * 告诉服务端"这个客户端上线了"。
 * 缺失时服务端不知道我们是否在线，可能影响消息投递的及时性判断。
 */
export async function notifyStart(baseUrl, token) {
  return postJson(baseUrl, 'ilink/bot/msg/notifystart', {}, token, 15000);
}

/** 告诉服务端"这个客户端要下线了" */
export async function notifyStop(baseUrl, token) {
  return postJson(baseUrl, 'ilink/bot/msg/notifystop', {}, token, 15000);
}

// ── 收发消息 ────────────────────────────────────────────────────────────────

/**
 * 长轮询收消息。
 * @param buf 游标，服务端会回新的 get_updates_buf
 * @param timeoutMs 服务端可能持有的时长；官方会读上一轮的 longpolling_timeout_ms
 */
export async function getUpdates(baseUrl, token, buf, signal, timeoutMs = 40000) {
  return postJson(
    baseUrl,
    'ilink/bot/getupdates',
    // base_info 由 postJson 统一附加，这里不要重复传
    { get_updates_buf: buf, sync_buf: '' },
    token,
    timeoutMs,
    signal
  );
}

/**
 * 发消息。
 * @param itemList 形如 [{ type: 1, text_item: { text: 'hi' } }]
 */
export async function sendMessage(baseUrl, token, toUserId, contextToken, itemList, messageState = MSG_STATE.FINISH) {
  return postJson(
    baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: MSG_TYPE.BOT,
        message_state: messageState,
        context_token: contextToken,
        item_list: itemList
      }
    },
    token,
    15000
  );
}

/** 构造一个文本消息项 */
export function textItem(text) {
  return { type: ITEM_TYPE.TEXT, text_item: { text } };
}

/** 工具调用开始项（让用户看到 agent 正在干什么） */
export function toolCallStartItem(toolName, toolCallId) {
  return { type: ITEM_TYPE.TOOL_CALL_START, tool_call_start_item: { tool_name: toolName, tool_call_id: toolCallId } };
}

/** 工具调用结果项 */
export function toolCallResultItem(toolName, toolCallId, status) {
  return { type: ITEM_TYPE.TOOL_CALL_RESULT, tool_call_result_item: { tool_name: toolName, tool_call_id: toolCallId, status } };
}

// ── "正在输入" ──────────────────────────────────────────────────────────────

export async function getConfig(baseUrl, token, userId, contextToken) {
  return postJson(
    baseUrl,
    'ilink/bot/getconfig',
    { ilink_user_id: userId, context_token: contextToken },
    token,
    15000
  );
}

export async function sendTyping(baseUrl, token, userId, ticket, status = TYPING_STATUS.TYPING) {
  return postJson(
    baseUrl,
    'ilink/bot/sendtyping',
    { ilink_user_id: userId, typing_ticket: ticket, status },
    token,
    15000
  );
}

// ── 媒体 ────────────────────────────────────────────────────────────────────

/** 上传媒体类型（官方 UploadMediaType） */
export const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

/**
 * 向服务端申请 CDN 上传地址。
 * 返回 upload_full_url 或 upload_param，二选一用于后续 POST 密文。
 */
export async function getUploadUrl(baseUrl, token, opts) {
  return postJson(
    baseUrl,
    'ilink/bot/getuploadurl',
    {
      filekey: opts.filekey,
      media_type: opts.mediaType,
      to_user_id: opts.toUserId,
      rawsize: opts.rawSize,
      rawfilemd5: opts.rawMd5,
      filesize: opts.encryptedSize,
      no_need_thumb: true,
      aeskey: opts.aesKeyHex
    },
    token,
    15000
  );
}

/**
 * 构造图片来源消息项。
 *
 * ⚠ 这个函数的 aes_key 编码**必须和官方一致**，很容易写错：
 *   官方：Buffer.from(uploaded.aeskey).toString("base64")
 *   其中 uploaded.aeskey 是**hex 字符串**，Buffer.from 不带 'hex' 参数时按 UTF-8 处理，
 *   所以结果是「32 个 ASCII 字符的 base64」= 44 字符。
 *
 *   如果写成 Buffer.from(aesKeyHex, 'hex')，得到的是「16 字节原始密钥的 base64」= 24 字符，
 *   接收端解不出来 —— 这正是之前踩过的坑，之前这里就是错的。
 *
 * 实际发送走的是 media.js 的 buildImageItem（编码正确），
 * 这个函数保留是为了别处可能直接调 ilink 层，逻辑已对齐官方。
 *
 * encrypt_type = 1 表示带缩略图/中图信息；mid_size 必须是**密文**长度（PKCS7 补齐后）。
 */
export function imageItem(encryptQueryParam, aesKeyHex, cipherSize) {
  return {
    type: ITEM_TYPE.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: encryptQueryParam,
        // 注意：不要传 'hex'，官方就是按 utf8 编码这个 hex 字符串
        aes_key: Buffer.from(aesKeyHex).toString('base64'),
        encrypt_type: 1
      },
      mid_size: cipherSize
    }
  };
}

/** 从 CDN 下载（用于接收用户的图片，当前未使用） */
export async function downloadFromCdn(encryptQueryParam) {
  const url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new ApiError(`CDN download HTTP ${res.status}`, { status: res.status });
  return Buffer.from(await res.arrayBuffer());
}

/** 拼 CDN 上传地址（服务端没给 upload_full_url 时用） */
export function buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

// ── 消息解析 ────────────────────────────────────────────────────────────────

/**
 * 从消息里取出可读文本。
 * 语音消息微信会带语音转文字（voice_item.text），所以语音也能当文本处理 ——
 * 这是我们这个纯文本桥接能支持语音输入的关键。
 */
export function extractText(msg) {
  const items = msg?.item_list ?? [];
  const parts = [];
  for (const it of items) {
    if (it.type === ITEM_TYPE.TEXT && it.text_item?.text) {
      parts.push(it.text_item.text);
    } else if (it.type === ITEM_TYPE.VOICE) {
      // 优先用微信自带的转写结果
      const spoken = it.voice_item?.text;
      if (spoken) parts.push(spoken);
    }
  }
  return parts.join('\n').trim();
}

/** 描述消息类型，便于日志 */
export function describeItems(msg) {
  const items = msg?.item_list ?? [];
  if (!items.length) return '(无内容)';
  const names = {
    [ITEM_TYPE.TEXT]: '文本',
    [ITEM_TYPE.IMAGE]: '图片',
    [ITEM_TYPE.VOICE]: '语音',
    [ITEM_TYPE.FILE]: '文件',
    [ITEM_TYPE.VIDEO]: '视频',
    [ITEM_TYPE.TOOL_CALL_START]: '工具调用',
    [ITEM_TYPE.TOOL_CALL_RESULT]: '工具结果'
  };
  return items.map((it) => names[it.type] ?? `未知(${it.type})`).join('+');
}

/** iLink 消息按 2000 字分块上限 */
export function splitText(text, limit = 2000) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export { DEFAULT_BOT_AGENT };
