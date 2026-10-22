/**
 * 媒体上传与发送
 *
 * 微信 iLink 发图片要走三步：
 *   1. getuploadurl   —— 申请上传地址，同时把 md5 / 大小 / aeskey 报给服务端
 *   2. AES-128-ECB 加密后 POST 到 CDN —— 拿到 x-encrypted-param 响应头
 *   3. sendmessage    —— 用 image_item 引用那个 CDN 参数
 *
 * 密钥与参数都按官方实现（Tencent/openclaw-weixin）对齐。
 */
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { readFile, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import {
  CDN_BASE_URL,
  UPLOAD_MEDIA_TYPE,
  getUploadUrl,
  buildCdnUploadUrl,
  imageItem,
  sendMessage
} from './ilink.js';

/** AES-128-ECB 加密（PKCS7 补位由 Node 默认完成） */
export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** PKCS7 补位后的密文长度 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** 按扩展名猜 MIME，用于区分图片/视频/文件 */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain'
};

export function mimeOf(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function isImage(filePath) {
  return mimeOf(filePath).startsWith('image/');
}

/**
 * 上传一个本地文件到微信 CDN。
 * @returns {{encryptQueryParam:string, aesKeyHex:string, cipherSize:number, rawSize:number}}
 */
export async function uploadMedia(baseUrl, token, toUserId, filePath, mediaType) {
  const plaintext = await readFile(filePath);
  const rawSize = plaintext.length;
  const rawMd5 = createHash('md5').update(plaintext).digest('hex');
  const encryptedSize = aesEcbPaddedSize(rawSize);
  const filekey = randomBytes(16).toString('hex');
  const aesKey = randomBytes(16);
  const aesKeyHex = aesKey.toString('hex');

  // 1) 申请上传地址
  const resp = await getUploadUrl(baseUrl, token, {
    filekey,
    mediaType,
    toUserId,
    rawSize,
    rawMd5,
    encryptedSize,
    aesKeyHex
  });

  const fullUrl = typeof resp.upload_full_url === 'string' ? resp.upload_full_url.trim() : '';
  const uploadParam = resp.upload_param;
  if (!fullUrl && !uploadParam) {
    throw new Error('服务端没有返回上传地址（upload_full_url 与 upload_param 都为空）');
  }

  // 2) 加密并 POST 到 CDN
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const cdnUrl = fullUrl || buildCdnUploadUrl(CDN_BASE_URL, uploadParam, filekey);

  const uploadRes = await fetch(cdnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
    signal: AbortSignal.timeout(30000)
  });

  if (uploadRes.status !== 200) {
    const hint = uploadRes.headers.get('x-error-message') || `HTTP ${uploadRes.status}`;
    throw new Error(`CDN 上传失败：${hint}`);
  }

  const encryptQueryParam = uploadRes.headers.get('x-encrypted-param');
  if (!encryptQueryParam) {
    throw new Error('CDN 上传成功但响应里缺少 x-encrypted-param 头');
  }

  return { encryptQueryParam, aesKeyHex, cipherSize: ciphertext.length, rawSize };
}

/**
 * 构造图片消息项。
 *
 * 字段依据腾讯官方实现（@tencent-weixin/openclaw-weixin 的 send.ts）：
 *   media.encrypt_query_param = 上传响应里的 x-encrypted-param（原样用）
 *   media.aes_key             = base64(hex 字符串)，不是 base64(原始16字节)
 *   media.encrypt_type        = 1
 *   mid_size                  = 密文字节数
 *
 * 那个 aes_key 的编码很容易搞错：官方写的是 Buffer.from(aeskey)，
 * 而 aeskey 本身是 hex 字符串，Buffer.from 默认按 UTF-8 处理，
 * 所以得到的是「32 个 ASCII 字符的 base64」，不是「16 字节原始密钥的 base64」。
 *
 * @param opts 排查用开关，正常发送不要传
 */
export function buildImageItem(encryptQueryParam, aesKeyHex, cipherSize, opts = {}) {
  const { topAeskey = false, encryptType = 1, doubleB64 = false } = opts;

  const param = doubleB64
    ? Buffer.from(encryptQueryParam, 'ascii').toString('base64')
    : encryptQueryParam;

  const imageItem = {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: param,
        // 关键：base64(hex 字符串)，不是 base64(密钥原始字节)
        aes_key: Buffer.from(aesKeyHex).toString('base64')
      },
      mid_size: cipherSize
    }
  };

  if (topAeskey) imageItem.image_item.aeskey = aesKeyHex;
  if (encryptType !== null && encryptType !== undefined) {
    imageItem.image_item.media.encrypt_type = encryptType;
  }

  return imageItem;
}

/**
 * 发送一张本地图片（默认使用官方结构）。
 */
export async function sendImage(baseUrl, token, toUserId, contextToken, filePath) {
  return sendImageVariant(baseUrl, token, toUserId, contextToken, filePath, {});
}

/**
 * 按指定参数变体发送图片，供诊断使用。
 * @returns {{ok:boolean, error?:string, uploaded?:object}}
 */
export async function sendImageVariant(baseUrl, token, toUserId, contextToken, filePath, opts = {}) {
  const s = await fsStat(filePath);
  if (!s.isFile()) throw new Error('不是文件：' + filePath);
  if (s.size > 25 * 1024 * 1024) throw new Error('图片超过 25MB 上限');

  const uploaded = await uploadMedia(baseUrl, token, toUserId, filePath, UPLOAD_MEDIA_TYPE.IMAGE);
  const item = buildImageItem(
    uploaded.encryptQueryParam,
    uploaded.aesKeyHex,
    uploaded.cipherSize,
    opts
  );

  try {
    await sendMessage(baseUrl, token, toUserId, contextToken, [item]);
    return { ok: true, uploaded };
  } catch (e) {
    return { ok: false, error: e.message || String(e), uploaded };
  }
}

export { UPLOAD_MEDIA_TYPE };
