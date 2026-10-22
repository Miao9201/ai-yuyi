/**
 * 联网搜索预算
 *
 * 为什么需要：搜索一次要回来 10 条结果，约 4000 tokens 输入、+4.8 秒延迟。
 * 如果每句话都搜，成本翻 3 倍、回复慢到没法聊。所以给搜索上闸：
 *   - 每小时上限
 *   - 每天上限
 * 超了就跳过搜索，直接正常聊天（不报错、不提示用户，静默降级）。
 *
 * 计数落盘到 data/search-budget.json，重启不清零。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'search-budget.json');

function hourKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readState() {
  const now = new Date();
  const empty = {
    hourKey: hourKey(now), hourCount: 0,
    dayKey: dayKey(now), dayCount: 0
  };
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    const s = { ...empty, ...j };
    // 跨小时/跨天自动归零
    if (s.hourKey !== empty.hourKey) { s.hourKey = empty.hourKey; s.hourCount = 0; }
    if (s.dayKey !== empty.dayKey) { s.dayKey = empty.dayKey; s.dayCount = 0; }
    return s;
  } catch {
    return empty;
  }
}

function writeState(s) {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch { /* 计数写不进去不影响聊天 */ }
}

/**
 * 还能不能搜。
 * @param {{hourlyLimit?:number, dailyLimit?:number}} opts  0 表示不限制
 * @returns {{allowed:boolean, reason:string, hourUsed:number, dayUsed:number,
 *            hourlyLimit:number, dailyLimit:number}}
 */
export function canSearch(opts = {}) {
  const hourlyLimit = Number.isFinite(opts.hourlyLimit) ? opts.hourlyLimit : 6;
  const dailyLimit = Number.isFinite(opts.dailyLimit) ? opts.dailyLimit : 30;
  const s = readState();

  if (hourlyLimit > 0 && s.hourCount >= hourlyLimit) {
    return {
      allowed: false,
      reason: `本小时已搜 ${s.hourCount}/${hourlyLimit} 次，达到上限`,
      hourUsed: s.hourCount, dayUsed: s.dayCount, hourlyLimit, dailyLimit
    };
  }
  if (dailyLimit > 0 && s.dayCount >= dailyLimit) {
    return {
      allowed: false,
      reason: `今天已搜 ${s.dayCount}/${dailyLimit} 次，达到上限`,
      hourUsed: s.hourCount, dayUsed: s.dayCount, hourlyLimit, dailyLimit
    };
  }
  return {
    allowed: true, reason: '',
    hourUsed: s.hourCount, dayUsed: s.dayCount, hourlyLimit, dailyLimit
  };
}

/** 记一次搜索（只在真的发出搜索请求时调用） */
export function recordSearch() {
  const s = readState();
  s.hourCount += 1;
  s.dayCount += 1;
  writeState(s);
  return { hourUsed: s.hourCount, dayUsed: s.dayCount };
}

/** 查当前用量（给 /状态 用） */
export function getUsage() {
  const s = readState();
  return { hourUsed: s.hourCount, dayUsed: s.dayCount, hourKey: s.hourKey, dayKey: s.dayKey };
}
