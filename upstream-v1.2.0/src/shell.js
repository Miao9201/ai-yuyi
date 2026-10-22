/**
 * 安全执行本地命令
 *
 * 和 dsh.js 一样把 stdout/stderr 绑到文件描述符，不用管道 ——
 * 受限环境下 Node 创建管道会 EPERM。
 */
import { spawn } from 'node:child_process';
import {
  existsSync, openSync, closeSync, readFileSync, unlinkSync, mkdirSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, 'data', 'tmp');

/**
 * 跑一条 PowerShell 命令。
 * @param {string} command
 * @param {{timeoutMs?:number, cwd?:string}} opts
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number, ms:number}>}
 */
export function runShell(command, opts = {}) {
  const { timeoutMs = 30_000, cwd = ROOT } = opts;
  const started = Date.now();

  return new Promise((resolve) => {
    let outFile, errFile, outFd, errFd;
    try {
      mkdirSync(TMP_DIR, { recursive: true });
      const base = `cmd-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      outFile = path.join(TMP_DIR, base + '.out');
      errFile = path.join(TMP_DIR, base + '.err');
      outFd = openSync(outFile, 'w');
      errFd = openSync(errFile, 'w');
    } catch (e) {
      return resolve({ ok: false, stdout: '', stderr: '', code: -1, ms: 0, error: '创建临时文件失败: ' + e.message });
    }

    const cleanup = () => {
      try { closeSync(outFd); } catch {}
      try { closeSync(errFd); } catch {}
    };
    const readFileSafe = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
    const removeTmp = () => {
      try { unlinkSync(outFile); } catch {}
      try { unlinkSync(errFile); } catch {}
    };

    let child;
    try {
      // 用 -NoProfile 避免用户 profile 带来的干扰和延迟
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd]
      });
    } catch (e) {
      cleanup(); removeTmp();
      return resolve({ ok: false, stdout: '', stderr: '', code: -1, ms: 0, error: '启动失败: ' + (e.code || e.message) });
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const stdout = readFileSafe(outFile).trim();
      const stderr = readFileSafe(errFile).trim();
      removeTmp();
      resolve({ ...result, stdout, stderr, ms: Date.now() - started });
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, stdout: readFileSafe(outFile).trim(), stderr: readFileSafe(errFile).trim(), code: -1, error: `超时 ${Math.round(timeoutMs / 1000)} 秒` });
    }, timeoutMs);

    child.on('error', (e) => {
      finish({ ok: false, stdout: '', stderr: '', code: -1, error: '子进程错误: ' + (e.code || e.message) });
    });

    child.on('close', (code) => {
      finish({ ok: code === 0, stdout: '', stderr: '', code });
    });
  });
}
