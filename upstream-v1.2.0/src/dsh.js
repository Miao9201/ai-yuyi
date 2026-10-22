/**
 * DSH 运行时 —— 路线 A：每次调用 spawn 一个 `dsh --profile headless` 子进程。
 *
 * 为什么不用 stdio:'pipe'：
 *   受限环境下 Node 无法创建匿名管道，spawn 直接抛 EPERM。
 *   实测只有 inherit / ignore / 文件描述符三种可行。
 *   这里用「把 stdout/stderr 绑到一个临时文件的 fd」——既能捕获输出，
 *   又不碰管道。stderr 和 stdout 合并到同一个文件，
 *   既省一个句柄，也保住了输出顺序（推理过程和最终答案的先后关系）。
 *
 * 升级到路线 C 时只需替换 runTask 的实现，上层不用动。
 */
import { spawn } from 'node:child_process';
import {
  existsSync, openSync, closeSync, readFileSync, unlinkSync, mkdirSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, 'data', 'tmp');
const FAILED_DIR = path.join(ROOT, 'data', 'logs');

/**
 * 这个桥自带的 DSH 主目录。
 *
 * 为什么不直接用 ~/.dsh：
 *   受限环境（沙箱、某些杀软、只读配置）下 DSH 写不进 ~/.dsh/profiles，
 *   表现为 EPERM。把 home 挪到项目内，桥就完全自包含，
 *   换台机器、换个启动方式都不会因为权限而挂掉。
 *   用环境变量 DSH_HOME 可以覆盖回原位置。
 */
const LOCAL_DSH_HOME = path.join(ROOT, 'data', 'dsh-home');

/**
 * 从 ~/.dsh/.credentials.yaml 里取 API Key。
 *
 * 用项目内的 DSH_HOME 意味着拿不到原位置的凭证库，
 * 所以这里把 key 读出来、通过环境变量喂给子进程。
 * DSH 支持 DEEPSEEK_API_KEY 环境变量（报错信息里就写了）。
 */
function readDshApiKey() {
  // 环境变量最优先，方便临时换 key
  if (process.env.DEEPSEEK_API_KEY) {
    return { key: process.env.DEEPSEEK_API_KEY, source: 'environment' };
  }

  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(os.homedir(), '.dsh', 'credentials.yaml')
  ];
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)["']?\s*$/m);
      if (m && m[1]) return { key: m[1], source: file };
    } catch { /* 试下一个 */ }
  }
  return { key: '', source: 'none' };
}

const API_KEY = readDshApiKey();

/**
 * 找到 DSH 的 bin.js。
 * 优先 DSH_BIN 环境变量，其次本机 npx 缓存，最后退回 PATH 上的 dsh 命令。
 */
export function resolveDshCommand() {
  const fromEnv = process.env.DSH_BIN;
  if (fromEnv && existsSync(fromEnv)) return { kind: 'node', bin: fromEnv };

  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx',
      '1e7f6d9597241db0', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { kind: 'node', bin: c };
  }
  return { kind: 'path', bin: 'dsh' };
}

const CMD = resolveDshCommand();

/** 给启动横幅用的运行时说明 */
export function describeRuntime() {
  const target = CMD.kind === 'node' ? `node ${CMD.bin}` : 'PATH 上的 dsh 命令';
  const home = process.env.WX_DSH_HOME || LOCAL_DSH_HOME;
  const keyInfo = API_KEY.key
    ? `API Key 已读取（来源：${API_KEY.source}）`
    : '⚠ 未找到 API Key，DSH 调用会失败';
  return `${target}\n              主目录  : ${home}\n              ${keyInfo}`;
}

/**
 * 跑一个 headless 任务。
 * @param {string} task 任务文本
 * @param {{timeoutMs?:number, cwd?:string, profile?:string, signal?:AbortSignal}} opts
 * @returns {Promise<{ok:boolean, text:string, raw:string, code:number, ms:number, error?:string}>}
 */
export function runTask(task, opts = {}) {
  const {
    timeoutMs = 180_000,
    cwd = ROOT,
    profile = 'headless',
    signal
  } = opts;

  const started = Date.now();

  return new Promise((resolve) => {
    // 答案和推理分开存两个文件。
    //
    // 为什么必须分开：DSH headless 把最终答案写 stdout、把思考过程写 stderr。
    // 之前两者合并到一个文件，导致推理内容直接混进回复发到微信里
    // （出现 "dsh: reasoning: ..." 和大段英文思考）。
    // 分开之后：stdout 才是要发给用户的内容，stderr 只进日志备查。
    let outFile, errFile, outFd, errFd;
    try {
      mkdirSync(TMP_DIR, { recursive: true });
      const base = `dsh-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      outFile = path.join(TMP_DIR, base + '.out');
      errFile = path.join(TMP_DIR, base + '.err');
      outFd = openSync(outFile, 'w');
      errFd = openSync(errFile, 'w');
    } catch (e) {
      return resolve({
        ok: false, text: '', raw: '', code: -1,
        ms: Date.now() - started, error: '无法创建输出文件: ' + e.message
      });
    }

    const cleanup = () => {
      try { closeSync(outFd); } catch { /* 已关闭 */ }
      try { closeSync(errFd); } catch { /* 已关闭 */ }
    };

    const readFileSafe = (f) => {
      try { return readFileSync(f, 'utf8'); } catch { return ''; }
    };

    // 答案只取 stdout
    const readOut = () => readFileSafe(outFile);
    // 推理取 stderr
    const readErr = () => readFileSafe(errFile);

    const removeTmp = () => {
      try { unlinkSync(outFile); } catch { /* 已清理 */ }
      try { unlinkSync(errFile); } catch { /* 已清理 */ }
    };

    // 答案和推理分开存两个文件。
    //
    // 为什么必须分开：DSH headless 把最终答案写 stdout、把思考过程写 stderr。
    // 之前两者合并到一个文件，导致推理内容直接混进回复发到微信里
    // （出现 "dsh: reasoning: ..." 和大段英文思考）。
    // 分开之后：stdout 才是要发给用户的内容，stderr 只进日志备查。

    let child;
    try {
      const isNodeMode = CMD.kind === 'node';
      const file = isNodeMode ? process.execPath : CMD.bin;
      const args = isNodeMode
        ? [CMD.bin, '--profile', profile, task]
        : ['--profile', profile, task];

      child = spawn(file, args, {
        cwd,
        windowsHide: true,
        // stdout → 答案文件，stderr → 推理文件，互不污染；不用管道
        stdio: ['ignore', outFd, errFd],
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          // 桥自带 DSH 主目录，完全脱离 ~/.dsh 的写入权限依赖。
          //
          // 注意：不能让继承来的 DSH_HOME 生效。这个桥本身可能就从某个
          // DSH 会话里启动，而那个会话已经把 DSH_HOME 设成了 ~/.dsh；
          // 若沿用它会绕回原来的权限问题。所以默认强制用项目内目录，
          // 只有显式设置 WX_DSH_HOME 才覆盖。
          DSH_HOME: process.env.WX_DSH_HOME || LOCAL_DSH_HOME,
          // 项目内的 home 里没有凭证库，key 通过环境变量传进去
          ...(API_KEY.key ? { DEEPSEEK_API_KEY: API_KEY.key } : {})
        }
      });
    } catch (e) {
      cleanup();
      removeTmp();
      return resolve({
        ok: false, text: '', raw: '', code: -1,
        ms: Date.now() - started, error: '无法启动 DSH: ' + (e.code || e.message)
      });
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      // 只有 stdout 是给用户看的答案；stderr 是思考过程，留作诊断
      const answer = readOut().trim();
      const reasoning = readErr().trim();
      removeTmp();
      resolve({
        ...result,
        text: (result.text !== undefined ? result.text : answer).trim(),
        raw: answer,
        reasoning,
        ms: Date.now() - started
      });
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({
        ok: false,
        text: readOut().trim(),
        code: -1,
        error: `超时 ${Math.round(timeoutMs / 1000)} 秒未完成`
      });
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        finish({
          ok: false,
          text: readOut().trim(),
          code: -1,
          error: '已取消'
        });
      }, { once: true });
    }

    child.on('error', (e) => {
      finish({
        ok: false, text: '', code: -1,
        error: '子进程错误: ' + (e.code || e.message)
      });
    });

    child.on('close', (code) => {
      const answer = readOut();
      if (code === 0) {
        finish({ ok: true, text: undefined, code });
        return;
      }

      // 失败时优先看 stderr（真正的报错在那里），再看 stdout。
      // 同时把两份都落盘到 data/logs，保留完整现场。
      const errText = readErr().trim();
      const outText = answer.trim();
      const detail = errText || outText;
      const why = detail
        ? detail.slice(-700)
        : '（子进程没有任何输出）';

      try {
        mkdirSync(FAILED_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        writeFileSync(
          path.join(FAILED_DIR, `failed-${stamp}.log`),
          `=== exit ${code} ===\n--- stderr ---\n${errText}\n--- stdout ---\n${outText}\n`,
          'utf8'
        );
      } catch { /* 存不下就算了，不影响上报 */ }

      finish({
        ok: false,
        text: undefined,
        code,
        error: `DSH 退出码 ${code}\n${why}`
      });
    });
  });
}
