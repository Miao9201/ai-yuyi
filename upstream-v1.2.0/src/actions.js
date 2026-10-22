/**
 * 预设动作
 *
 * 为什么要预设：让 AI 现场探索（找路径、查进程、试启动）要几十秒，
 * 而微信的回复窗口撑不了那么久。把常用操作写成固定命令，
 * 命中时直接执行，3 秒内完事。
 *
 * 匹配不上预设的，才回落到 DSH（慢但灵活）。
 *
 * 配置文件：data/actions.json
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShell } from './shell.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ACTIONS_FILE = path.join(ROOT, 'data', 'actions.json');

const DEFAULTS = {
  _说明: [
    '预设动作表：发「/do 动作名」时直接执行 command，不经过 AI，所以很快（3秒内）。',
    '  name    ：动作名，用户会这样叫它',
    '  aliases ：别名，可以写多个',
    '  command ：实际执行的 PowerShell 命令',
    '  desc    ：一句话说明',
    '  danger  ：true 表示有风险（比如关程序、锁屏），执行前会先确认',
    '',
    '匹配不上任何动作时，会自动回落到 DSH 模式（AI 现场处理，较慢但灵活）。'
  ],
  actions: [
    {
      name: '打开抖音',
      aliases: ['开抖音', '抖音'],
      command: "Start-Process -FilePath 'F:\\douyin\\douyin.exe' -WorkingDirectory 'F:\\douyin'",
      desc: '启动抖音客户端'
    },
    {
      name: '打开微信',
      aliases: ['开微信', '微信'],
      command: "Start-Process -FilePath 'F:\\Weixin\\Weixin.exe' -ErrorAction SilentlyContinue; if (-not $?) { Start-Process 'F:\\Weixin\\Weixin.exe' }",
      desc: '启动微信'
    },
    {
      name: '查磁盘空间',
      aliases: ['看空间', '剩余空间', '磁盘空间', 'C盘空间'],
      command: "Get-PSDrive C,D,E,F -ErrorAction SilentlyContinue | Select-Object Name,@{n='已用GB';e={[math]::Round($_.Used/1GB,1)}},@{n='剩余GB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize | Out-String",
      desc: '列出各磁盘的已用和剩余空间'
    },
    {
      name: '查进程',
      aliases: ['看进程', '进程占用'],
      command: "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name,@{n='内存MB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String",
      desc: '列出内存占用前 10 的进程'
    },
    {
      name: '锁屏',
      aliases: ['锁电脑'],
      command: "rundll32.exe user32.dll,LockWorkStation",
      desc: '锁定电脑屏幕',
      danger: true
    },
    {
      name: '打开记事本',
      aliases: ['记事本', '开记事本'],
      command: "Start-Process notepad.exe",
      desc: '打开记事本'
    },
    {
      name: '打开浏览器',
      aliases: ['开浏览器', '浏览器'],
      command: "Start-Process msedge.exe -ErrorAction SilentlyContinue; if (-not $?) { Start-Process 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }",
      desc: '打开 Edge 浏览器'
    },
    {
      name: '看时间',
      aliases: ['现在几点', '时间'],
      command: "Get-Date -Format 'yyyy年MM月dd日 HH:mm:ss dddd'",
      desc: '显示当前时间'
    }
  ]
};

export function ensureActionsFile() {
  if (existsSync(ACTIONS_FILE)) return;
  try {
    mkdirSync(path.dirname(ACTIONS_FILE), { recursive: true });
    writeFileSync(ACTIONS_FILE, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  } catch (e) {
    console.warn('[actions] 无法创建 actions.json:', e.message);
  }
}

/** 读取动作表 */
export function loadActions() {
  try {
    if (!existsSync(ACTIONS_FILE)) return DEFAULTS.actions;
    const raw = JSON.parse(readFileSync(ACTIONS_FILE, 'utf8'));
    const list = Array.isArray(raw.actions) ? raw.actions : [];
    return list.filter((a) => a && typeof a.name === 'string' && typeof a.command === 'string');
  } catch {
    return [];
  }
}

/**
 * 在用户输入里找匹配的动作。
 * 匹配优先级：名字完全相等 → 别名完全相等 → 输入包含名字/别名
 */
export function matchAction(text, actions = loadActions()) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;

  for (const a of actions) {
    if (a.name.toLowerCase() === t) return a;
  }
  for (const a of actions) {
    for (const alias of a.aliases || []) {
      if (String(alias).toLowerCase() === t) return a;
    }
  }
  for (const a of actions) {
    if (t.includes(a.name.toLowerCase())) return a;
    for (const alias of a.aliases || []) {
      if (t.includes(String(alias).toLowerCase())) return a;
    }
  }
  return null;
}

/**
 * 执行一个预设动作。
 * @returns {Promise<{ok:boolean, output:string, action:object}>}
 */
export async function runAction(action, opts = {}) {
  const r = await runShell(action.command, { timeoutMs: opts.timeoutMs ?? 20000 });

  // 有的命令（如 Start-Process）成功时没有任何输出，这不算失败
  const output = (r.stdout || '').trim();
  if (r.ok) {
    return { ok: true, output: output || '（已执行，无输出）', action };
  }
  const errMsg = (r.stderr || '').trim() || r.error || `退出码 ${r.code}`;
  return { ok: false, output: errMsg.slice(0, 400), action };
}

export { ACTIONS_FILE };

/** 列出所有动作，用于帮助信息 */
export function listActions() {
  return loadActions().map((a) => ({
    name: a.name,
    desc: a.desc || '',
    aliases: a.aliases || []
  }));
}
