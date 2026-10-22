/**
 * 被动收图 —— 把用户发来的 image_item 从微信 CDN 下载下来、AES 解密、落盘。
 *
 * 协议事实（对着官方包 @tencent-weixin/openclaw-weixin@2.4.10 校准）：
 *   收消息的 item_list 里，图片长这样：
 *     { type: 2, image_item: { media: {
 *         encrypt_query_param: '…',   // CDN 上的密文地址参数
 *         aes_key: '…',               // base64(16 字节原始 key)  —— 注意图片是「原始字节」
 *         full_url: '…'               // 可选，服务端给了就直接用
 *     } } }
 *   下载：GET {CDN_BASE_URL}/download?encrypted_query_param=…
 *   解密：AES-128-ECB + PKCS7
 *
 * 一个关键的坑（官方 pic-decrypt.js 注释里写的）：
 *   图片的 aes_key 是 base64(16 字节)，而文件/语音/视频是 base64(32 位十六进制字符串)。
 *   两种都可能出现，所以这里要兼容。搞错了会解出乱码，然后图片打不开。
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CDN_BASE_URL } from './ilink.js';

/** iLink 消息项类型：图片 = 2 */
export const ITEM_IMAGE = 2;

/** 从一条消息里挑出所有「能下载」的图片项 */
export function imageItemsOf(msg) {
  const items = msg?.item_list ?? [];
  return items.filter((it) =>
    it.type === ITEM_IMAGE &&
    (it.image_item?.media?.encrypt_query_param || it.image_item?.media?.full_url));
}

/** base64 的 aes_key → 16 字节原始 key（兼容 base64(hex) 那种写法） */
export function parseAesKey(aesKeyBase64) {
  const raw = Buffer.from(String(aesKeyBase64), 'base64');
  if (raw.length === 16) return raw;
  const ascii = raw.toString('ascii');
  if (raw.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) {
    return Buffer.from(ascii, 'hex');
  }
  throw new Error(`aes_key 解不出 16 字节（得到 ${raw.length} 字节）`);
}

/** AES-128-ECB 解密（PKCS7） */
export function decryptAesEcb(cipher, key) {
  const d = createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(cipher), d.final()]);
}

/** 靠文件头认图片类型（不装依赖，自己认） */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return '';
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
};

/**
 * 下载 + 解密 + 落盘一张入站图片。
 *
 * 返回 { ok:true, filePath, mime, bytes } 或抛错（调用方自己兜底）。
 */
export async function downloadInboundImage(item, { destDir, timeoutMs = 20000 } = {}) {
  const media = item?.image_item?.media ?? {};
  const param = media.encrypt_query_param;
  if (!param && !media.full_url) throw new Error('图片没有 CDN 地址参数');

  const url = media.full_url ||
    `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(param)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDN 下载失败 HTTP ${res.status}`);

  let buf = Buffer.from(await res.arrayBuffer());
  if (media.aes_key) {
    buf = decryptAesEcb(buf, parseAesKey(media.aes_key));
  }

  const mime = sniffImageMime(buf);
  if (!mime) throw new Error('下载到的内容不是可识别的图片');

  await mkdir(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const filePath = path.join(destDir, `${stamp}-${hash}${EXT_BY_MIME[mime] ?? '.bin'}`);
  await writeFile(filePath, buf);

  return { ok: true, filePath, mime, bytes: buf.length };
}
