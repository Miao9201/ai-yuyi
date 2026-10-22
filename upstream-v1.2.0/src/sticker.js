/**
 * 表情包
 *
 * 微信里的"表情包"本质就是一张图片，走的是同一条 CDN 上传链路。
 * 这个模块负责管理 stickers/ 目录里的素材。
 *
 * 目录约定（两种都支持）：
 *   1) 平铺：stickers/开心.png            → 名字就叫「开心」
 *   2) 分类：stickers/开心/xxx.jpg        → 名字是「开心_1」「开心_2」...
 *      分类模式下同一类的若干张会被自动编号，`[sticker:开心]` 会随机挑一张。
 *
 * 文件名即标签。压缩过的大图放在 _original 子目录里，不会被当作素材。
 */
import { readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STICKER_DIR = path.join(ROOT, 'stickers');
const USAGE_FILE = path.join(ROOT, 'data', 'sticker-usage.json');

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_SIZE = 5 * 1024 * 1024; // 单张 5MB 上限
/** 这些子目录不算素材（放原图备份用） */
const IGNORED_DIRS = new Set(['_original', '_backup', 'backup', 'original']);

/**
 * 表情包使用顺序（防"来回就那几张"）。
 *
 * 每发一张就把它的序号记到 data/sticker-usage.json，挑的时候只在
 * 「最久没发过的 35%（至少 3 张）」里随机 —— 效果是全部轮一遍才会重复，
 * 而不是纯随机导致同几张反复中签。
 */
let usageCache = null;

function loadUsage() {
  if (usageCache) return usageCache;
  try {
    usageCache = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
    if (!usageCache || typeof usageCache !== 'object') throw new Error('bad');
    if (!usageCache.used) usageCache.used = {};
    if (!Number.isFinite(usageCache.seq)) usageCache.seq = 0;
  } catch {
    usageCache = { seq: 0, used: {} };
  }
  return usageCache;
}

function saveUsage() {
  try {
    mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(usageCache), 'utf8');
  } catch { /* 记不住顺序不影响发表情 */ }
}

/** 记一次使用（名字用 listStickers 里的 name，如「开心_3」） */
export function recordStickerUse(name) {
  if (!name) return;
  const u = loadUsage();
  u.seq = (u.seq || 0) + 1;
  u.used[name] = u.seq;
  saveUsage();
}

/** 从候选里挑「最久没发过」的一批，再随机 */
function pickLeastUsed(list) {
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  const u = loadUsage();
  const sorted = [...list].sort((a, b) => (u.used[a.name] || 0) - (u.used[b.name] || 0));
  const poolSize = Math.min(sorted.length, Math.max(3, Math.ceil(sorted.length * 0.35)));
  const pool = sorted.slice(0, poolSize);
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 用旧次数把长期不用的先清一遍（防止旧记录压着一堆条目） */
export function resetStickerUsage() {
  usageCache = { seq: 0, used: {} };
  saveUsage();
}

export async function ensureStickerDir() {
  try {
    await mkdir(STICKER_DIR, { recursive: true });
  } catch { /* 建不了就让 listStickers 返回空 */ }
}

function isUsable(ext) {
  return ALLOWED_EXT.has(ext);
}

/**
 * 列出所有可用表情包。
 *
 * 分类目录里的文件会以「分类_序号」命名，categories 字段记录归属，
 * 这样 /sticker 开心 可以模糊匹配到该分类下的任意一张。
 *
 * @returns {Promise<Array<{name:string, label:string, category:string, path:string, size:number}>>}
 */
export async function listStickers() {
  if (!existsSync(STICKER_DIR)) return [];

  let entries;
  try {
    entries = await readdir(STICKER_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];

  for (const entry of entries) {
    // 平铺文件
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!isUsable(ext)) continue;
      const full = path.join(STICKER_DIR, entry.name);
      try {
        const s = await stat(full);
        if (!s.isFile() || s.size > MAX_SIZE) continue;
        const base = path.basename(entry.name, ext);
        out.push({ name: base, label: base, category: '', path: full, size: s.size });
      } catch { /* 跳过坏文件 */ }
      continue;
    }

    // 分类目录
    if (!entry.isDirectory()) continue;
    if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;

    const category = entry.name;
    let files;
    try {
      files = await readdir(path.join(STICKER_DIR, category), { withFileTypes: true });
    } catch {
      continue;
    }

    const usable = [];
    for (const f of files) {
      if (!f.isFile()) continue;
      const ext = path.extname(f.name).toLowerCase();
      if (!isUsable(ext)) continue;
      const full = path.join(STICKER_DIR, category, f.name);
      try {
        const s = await stat(full);
        if (!s.isFile() || s.size > MAX_SIZE) continue;
        usable.push({ full, size: s.size, base: path.basename(f.name, ext) });
      } catch { /* 跳过 */ }
    }

    usable.sort((a, b) => a.base.localeCompare(b.base));
    usable.forEach((f, i) => {
      // 名字带上分类，既能按分类随机，也能精确指定某一张
      const name = `${category}_${i + 1}`;
      out.push({
        name,
        label: f.base,
        category,
        path: f.full,
        size: f.size
      });
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按名字挑一张表情包。
 *
 * 匹配顺序：精确名字 → 分类名（随机取该分类一张）→ 名字包含 → 都没有则返回 undefined。
 * 不传名字时随机挑一张。
 */
export async function pickSticker(name, opts = {}) {
  const { rotate = true } = opts;
  const all = await listStickers();
  if (!all.length) return undefined;

  const finish = (picked) => {
    if (picked && rotate) recordStickerUse(picked.name);
    return picked;
  };

  if (!name) {
    return finish(pickLeastUsed(all));
  }

  const q = String(name).trim();
  if (!q) return finish(pickLeastUsed(all));

  const lower = q.toLowerCase();

  // 1) 精确名字：开心_1（点名要哪张就给哪张）
  const exact = all.find((s) => s.name.toLowerCase() === lower);
  if (exact) return finish(exact);

  // 2) 分类名：开心 → 该分类里挑最久没发的
  const inCategory = all.filter((s) => s.category && s.category.toLowerCase() === lower);
  if (inCategory.length) return finish(pickLeastUsed(inCategory));

  // 3) 名字包含：开心 命中 开心_1
  const fuzzy = all.filter((s) => s.name.toLowerCase().includes(lower));
  if (fuzzy.length) return finish(pickLeastUsed(fuzzy));

  return undefined;
}

/** 按分类汇总，给帮助信息用 */
export async function listCategories() {
  const all = await listStickers();
  const map = new Map();
  for (const s of all) {
    const key = s.category || '未分类';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s.name);
  }
  return [...map.entries()].map(([category, names]) => ({ category, count: names.length, names }));
}

export function stickerDirPath() {
  return STICKER_DIR;
}

export { STICKER_DIR, MAX_SIZE };
