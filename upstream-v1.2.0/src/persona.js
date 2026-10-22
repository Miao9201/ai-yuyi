/**
 * 人设（persona）
 *
 * 为什么要单独一个模块：
 *   DSH headless 每次都是全新进程，没有跨调用记忆，
 *   所以"人设"只能靠每一轮往任务前面注入一段角色说明。
 *
 * 设计取舍：
 *   - 人设是 Markdown 文件，带 YAML front matter，用户可以直接编辑
 *   - 人设只影响"怎么说"，不该盖掉"能不能干"——所以它在任务里排在最前，
 *     而且明确告诉模型：完成任务优先于人设表演
 *   - 支持 /role 切换，按微信用户持久化
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PERSONA_DIR = path.join(ROOT, 'personas');
const STATE_DIR = path.join(process.env.WX_RUNTIME_DATA_DIR || path.join(ROOT, 'data'), 'personas');

/** 人设名允许的字符（也用作文件名） */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const PRIVATE_DIR = path.resolve(ROOT,'..','private');
export function personaFile(name){
  const privateFile=path.join(PRIVATE_DIR,name,'persona.md');
  return existsSync(privateFile)?privateFile:path.join(PERSONA_DIR,`${name}.md`);
}

/** 极简 front matter 解析：只支持顶层 key: value，够用且不引依赖 */
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };

  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const hit = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!hit) continue;
    let value = hit[2].trim();
    // 去掉成对引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[hit[1]] = value;
  }
  return { meta, body: m[2].trim() };
}

/**
 * 读取所有人设。
 * @returns {Promise<Array<{name:string, title:string, description:string, prompt:string}>>}
 */
export async function listPersonas() {
  if (!existsSync(PERSONA_DIR)) return [];
  let files;
  try {
    files = await readdir(PERSONA_DIR);
  } catch {
    return [];
  }

  try{for(const name of await readdir(PRIVATE_DIR))if(NAME_RE.test(name)&&existsSync(path.join(PRIVATE_DIR,name,'persona.md')))files.push(name+'.md');}catch{}
  const out = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (!NAME_RE.test(name)) continue;
    try {
      const text = await readFile(personaFile(name), 'utf8');
      const { meta, body } = parseFrontMatter(text);
      if (!body) continue;
      out.push({
        name,
        title: meta.title || name,
        description: meta.description || '',
        prompt: body
      });
    } catch { /* 单个文件坏了不影响其他人设 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 读一个指定人设；不存在返回 undefined */
export async function getPersona(name) {
  if (!name || !NAME_RE.test(name)) return undefined;
  const file = personaFile(name);
  if (!existsSync(file)) return undefined;
  try {
    const text = await readFile(file, 'utf8');
    const { meta, body } = parseFrontMatter(text);
    if (!body) return undefined;
    return {
      name,
      title: meta.title || name,
      description: meta.description || '',
      prompt: body
    };
  } catch {
    return undefined;
  }
}

/** 保证 personas 目录存在（首次启动引导用户去建） */
export async function ensurePersonaDir() {
  try {
    await mkdir(PERSONA_DIR, { recursive: true });
  } catch { /* 建不了就让 listPersonas 返回空 */ }
}

// ── 每个用户当前用的人设 ────────────────────────────────────────────────────

function statePath(userId) {
  const h = createHash('sha1').update(userId).digest('hex').slice(0, 16);
  return path.join(STATE_DIR, `${h}.json`);
}

const stateCache = new Map();

/** 取某用户当前人设名；未设置返回空串 */
export async function getUserPersona(userId) {
  if (stateCache.has(userId)) return stateCache.get(userId);
  try {
    const raw = await readFile(statePath(userId), 'utf8');
    const v = JSON.parse(raw);
    const name = typeof v?.persona === 'string' ? v.persona : '';
    stateCache.set(userId, name);
    return name;
  } catch {
    stateCache.set(userId, '');
    return '';
  }
}

/** 设置某用户人设；传空串表示清除 */
export async function setUserPersona(userId, persona) {
  const next = persona && NAME_RE.test(persona) ? persona : '';
  stateCache.set(userId, next);
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(statePath(userId), JSON.stringify({ persona: next, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[persona] 保存失败:', e.message);
  }
  return next;
}

/**
 * 把用户发的话包上人设，形成最终交给 DSH 的任务。
 *
 * 关键点：人设段落里明确写了"完成任务优先于人设表演"。
 * 否则一个"说话可爱"的人设会让模型把「帮我查下磁盘占用」也答成撒娇，
 * 那就本末倒置了。
 */
export function applyPersona(persona, question) {
  if (!persona) return question;
  return [
    `你现在扮演下面这个角色。请注意：**完成任务优先于人设表演**——`,
    `该查的照查、该给的答案照给，只是用这个角色的语气和方式表达。`,
    `不要为了演出角色而拒绝干活，也不要编造事实来配合人设。`,
    ``,
    `【角色设定】${persona.title}`,
    persona.prompt,
    ``,
    `【用户这一轮说的是】`,
    question
  ].join('\n');
}

export { PERSONA_DIR };
