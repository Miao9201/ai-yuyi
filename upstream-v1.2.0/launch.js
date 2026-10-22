#!/usr/bin/env node
/**
 * AI语忆 启动器（带 PID 管理）
 *
 * 存在的理由：之前重启桥时用 `Stop-Process node -Force` 杀掉所有 node 进程，
 * 把 DSH Web（3080 端口）一起杀了，导致用户那边老是断联。
 * 这个启动器把自己 fork 出来的子进程 PID 写进 data/bridge.pid，
 * 之后只按这个 PID 精确停止，绝不波及别的 node 进程。
 *
 * 用法：
 *   node launch.js --mode=chat        后台启动
 *   node launch.js --stop             只停止自己启动的那个
 *   node launch.js --status           查看状态
 *   node launch.js --restart --mode=chat   停止后重启
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PID_FILE = path.join(ROOT, 'data', 'bridge.pid');
const LOG_FILE = path.join(ROOT, 'data', 'run.log');
const TMP_DIR = path.join(ROOT, 'data', 'tmp');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (name, fb) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fb;
};

function readPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function status() {
  const pid = readPid();
  if (!pid) { console.log('AI语忆: 未运行（无 PID 记录）'); return 1; }
  if (!isAlive(pid)) { console.log(`AI语忆: 已退出（PID ${pid} 不存在，记录已过期）`); return 1; }
  console.log(`AI语忆: 运行中  PID=${pid}`);
  const log = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
  const lines = log.split('\n').filter((l) => l.trim());
  console.log('最后日志: ' + (lines[lines.length - 1] || '(空)'));
  return 0;
}

function stop() {
  const pid = readPid();
  if (!pid) { console.log('没有 PID 记录，无需停止'); return 0; }
  if (!isAlive(pid)) {
    console.log(`PID ${pid} 已不存在，清理记录`);
    try { unlinkSync(PID_FILE); } catch {}
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    console.log('发送 SIGTERM 失败: ' + e.message);
  }

  // 等最多 5 秒让它自己退，不行再强杀（只针对这一个 PID）
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    // 忙等一小会儿，这个脚本很短命，不值得引入异步等待
    const until = Date.now() + 100;
    while (Date.now() < until) { /* spin */ }
  }
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    console.log(`已强制停止 PID ${pid}`);
  } else {
    console.log(`已停止 PID ${pid}`);
  }
  try { unlinkSync(PID_FILE); } catch {}
  return 0;
}

function start() {
  const existing = readPid();
  if (existing && isAlive(existing)) {
    console.log(`已在运行（PID ${existing}），如需重启请用 --restart`);
    return 0;
  }

  mkdirSync(TMP_DIR, { recursive: true });

  const mode = opt('mode', 'chat');
  const outFd = openSync(LOG_FILE, 'w');
  const errFd = openSync(path.join(TMP_DIR, 'stderr.log'), 'w');

  const child = spawn(process.execPath, ['src/index.js', `--mode=${mode}`, ...argv.filter((a) => !a.startsWith('--mode=') && !has('--restart') && a !== '--stop' && a !== '--status')], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    // 不用管道：受限环境下管道会 EPERM
    stdio: ['ignore', outFd, errFd]
  });

  child.unref();
  writeFileSync(PID_FILE, String(child.pid), 'utf8');
  closeSync(outFd);
  closeSync(errFd);

  console.log(`已启动 AI语忆（mode=${mode}）PID=${child.pid}`);
  console.log(`日志: ${LOG_FILE}`);
  console.log(`停止: node launch.js --stop`);
  return 0;
}

if (has('--status')) {
  process.exit(status());
} else if (has('--stop')) {
  process.exit(stop());
} else if (has('--restart')) {
  stop();
  process.exit(start());
} else {
  process.exit(start());
}
