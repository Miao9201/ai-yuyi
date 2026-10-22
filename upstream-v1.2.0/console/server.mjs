// 机器人控制台 —— 零依赖本地 HTTP 服务
//
// 只监听 127.0.0.1，不做鉴权：这是给"本机自己用"的 DIY 面板。
// 启动：node console\server.mjs   （默认 http://127.0.0.1:7788）
// 不建议暴露到公网；如果改了 --host 0.0.0.0 请自己加防火墙/反向代理鉴权。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  loadLife, saveLife, activeArc, startArc, dropArc, resetLife, DEFAULT_CAST, ARCS,
  allTemplates, saveCastMember, deleteCastMember, saveArcTemplate, deleteArcTemplate,
  KIND_LABELS, VALID_KINDS
} from '../src/life.js';
import { chatComplete, readApiKey } from '../src/chat.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP_ROOT = path.resolve(ROOT, '..');
const desktopKeys = new Set(['defaultPersona','chatModel','chatBaseUrl','chatTemperature','taskTimeoutMs','stripActions','sceneEnabled','sceneTtlMinutes','sceneMaxTurns','emotionEnabled','emotionDriftChance','defianceChance','forgetEnabled','topicTtlHours','topicBanHours','historyRecentTurns','historyOlderChars','visionEnabled','visionModelDeepseek']);
const runFile = promisify(execFile);
async function desktopControl(action) {
  await runFile(process.env.WX_DESKTOP_PYTHON || 'python', ['-X','utf8',path.join(DESKTOP_ROOT,'control.py'),action], {cwd:DESKTOP_ROOT,windowsHide:true,timeout:70000});
}
function localOperation(script,action,body={}){
  return new Promise((resolve,reject)=>{
    const child=execFile(process.env.WX_DESKTOP_PYTHON||'python',['-X','utf8',path.join(DESKTOP_ROOT,script),action],{cwd:DESKTOP_ROOT,windowsHide:true,timeout:script==='import_persona.py'&&action==='import'?600000:65000,maxBuffer:2*1024*1024},(error,stdout)=>{
      let result;try{result=JSON.parse(stdout);}catch{return reject(Error('账号管理暂时不可用'));}
      if(error||result.error){const e=Error(result.error||'本地操作失败');e.statusCode=result.status||400;return reject(e);}
      resolve(result);
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(body));
  });
}
const accountOperation=(action,body={})=>localOperation('account_store.py',action,body);
function localSettings(){try{return JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT,'data/config.json'),'utf8'));}catch{return {};}}
function desktopStatus() {
  try { return JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT,'data','status.json'),'utf8')); }
  catch { return {state:'stopped',detail:'尚未启动'}; }
}
function desktopProfile() {
  try {
    const role=safeName(loadConfig().defaultPersona||'private_persona');
    const privateFile=path.join(DESKTOP_ROOT,'private',role,'profile.json');
    const file=fs.existsSync(privateFile)?privateFile:role==='private_persona'?path.join(DESKTOP_ROOT,'data','persona-profile.json'):path.join(DESKTOP_ROOT,'data','persona-profiles',role+'.json');
    const p=JSON.parse(fs.readFileSync(file,'utf8'));return {name:p.name,gender:p.gender,relationship:p.relationship,address:p.address};
  }
  catch {return null;}
}
function localTransport(){
  try{return JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT,'data','config.json'),'utf8')).transport==='ilink'?'ilink':'desktop';}catch{return 'desktop';}
}
function companionStats(){
  try{
    const role=safeName(loadConfig().defaultPersona||'private_persona');
    if(role!=='private_persona'&&!fs.existsSync(path.join(DESKTOP_ROOT,'private',role,'import-report.json'))){
      const catalog=path.join(DESKTOP_ROOT,'data',`media-catalog-${role}.json`);
      const media=fs.existsSync(catalog)?JSON.parse(fs.readFileSync(catalog,'utf8')).items:[];
      return {mode:'role',focus:'当前人设文件',messages:0,memories:0,examples:0,emoji:media.length,images:0,labeled:media.length};
    }
    const privateDir=path.join(DESKTOP_ROOT,'private',role);
    const report=JSON.parse(fs.readFileSync(fs.existsSync(path.join(privateDir,'import-report.json'))?path.join(privateDir,'import-report.json'):path.join(DESKTOP_ROOT,'data','companion-import-report.json'),'utf8'));
    const media=JSON.parse(fs.readFileSync(fs.existsSync(path.join(privateDir,'media-catalog.json'))?path.join(privateDir,'media-catalog.json'):path.join(DESKTOP_ROOT,'data','media-catalog.json'),'utf8')).items||[];
    return {mode:'real',messages:report.indexed_messages,memories:report.memories,examples:report.pairs,focus:report.focus_year?String(report.focus_year)+'年以来':'2025—2026',emoji:report.emoji_assets,images:report.image_assets,labeled:media.filter(i=>i.caption).length};
  }catch{return null;}
}
const PERSONA_DIR = path.join(ROOT, 'personas');
const STICKER_DIR = path.join(ROOT, 'stickers');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const USAGE_PATH = path.join(DATA_DIR, 'sticker-usage.json');
const PID_PATH = path.join(DATA_DIR, 'bridge.pid');
const LOG_PATH = path.join(DATA_DIR, 'run.log');

const PORT = Number(process.env.WX_CONSOLE_PORT || 7788);
const HOST = process.env.WX_CONSOLE_HOST || '127.0.0.1';
const STICKER_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_UPLOAD = 12 * 1024 * 1024;

// ── 小工具 ────────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
};
const bad = (res, code, msg) => json(res, code, { ok: false, error: msg });
const readBody = (req, limit = MAX_UPLOAD) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

function safeName(name, allowDots = false) {
  const s = String(name || '').trim();
  if (!s || s.length > 80) return null;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(s)) return null;
  if (!allowDots && s.includes('..')) return null;
  if (s.startsWith('.')) return null;
  return s;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}
function loadUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')); } catch { return { seq: 0, used: {} }; }
}
function pidAlive() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim()); } catch { return { running: false, pid: 0 }; }
  if (!pid) return { running: false, pid: 0 };
  try { process.kill(pid, 0); return { running: true, pid }; } catch { return { running: false, pid }; }
}
function listPersonas() {
  const cfg = loadConfig();
  const def = String(cfg.defaultPersona || '').replace(/\.md$/i, '');
  let files = [];
  try { files = fs.readdirSync(PERSONA_DIR).filter((f) => f.toLowerCase().endsWith('.md')); } catch { files = []; }
  try{for(const name of fs.readdirSync(path.join(DESKTOP_ROOT,'private')))if(/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)&&fs.existsSync(path.join(DESKTOP_ROOT,'private',name,'persona.md')))files.push(name+'.md');}catch{}
  return [...new Set(files)].map((f) => {
    const name = f.replace(/\.md$/i, '');
    const full = personaFile(name);
    const st = fs.statSync(full);
    const text = fs.readFileSync(full, 'utf8');
    const title = (text.match(/^title:\s*(.+)$/m) || [])[1] || name;
    return { name, title: title.trim(), chars: text.length, bytes: st.size, mtime: st.mtimeMs, isDefault: name === def, isPrivate:full.endsWith(path.sep+'persona.md') };
  }).sort((a, b) => b.mtime - a.mtime);
}
function personaFile(name){const file=path.join(DESKTOP_ROOT,'private',name,'persona.md');return fs.existsSync(file)?file:path.join(PERSONA_DIR,name+'.md');}
function stickerStats() {
  const usage = loadUsage().used || {};
  const out = [];
  let total = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(STICKER_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { dirs = []; }
  for (const dir of dirs) {
    if (dir === '_original') continue;
    const full = path.join(STICKER_DIR, dir);
    let files = [];
    try { files = fs.readdirSync(full).filter((f) => STICKER_EXT.has(path.extname(f).toLowerCase())); } catch { files = []; }
    const items = files.map((f) => {
      const st = fs.statSync(path.join(full, f));
      return { file: f, bytes: st.size, used: usage[`${dir}_${f}`] ?? usage[f] ?? null };
    });
    items.sort((a, b) => (b.used ?? -1) - (a.used ?? -1) || a.file.localeCompare(b.file));
    total += items.length;
    out.push({ name: dir, count: items.length, items });
  }
  out.sort((a, b) => b.count - a.count);
  return { total, categories: out, seq: loadUsage().seq || 0 };
}
function tail(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const arr = text.split(/\r?\n/);
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  } catch { return ''; }
}

// 配置项的类型（用于面板渲染和写入校验）
const CONFIG_META = {
  string: ['defaultPersona', 'chatModel', 'chatBaseUrl', 'stripActions', 'proactiveCompose', 'searchProvider', 'anysearchBaseUrl', 'visionProvider', 'visionModel', 'visionModelDeepseek', 'visionBaseUrl', 'imageGenBaseUrl', 'imageGenModel', 'imageGenSize', 'imageGenRatio', 'imageGenStyle', 'workdir', 'stickerDir', 'botAgent', 'searchFallbackTimeoutMs'],
  number: ['taskTimeoutMs', 'maxQueuePerUser', 'maxBubbles', 'bubbleGapMs', 'shortReplyThreshold', 'chatTemperature', 'stickerChance', 'stickerMinTurns', 'stickerMaxTurns', 'kaomojiChance', 'emojiChance', 'sceneTtlMinutes', 'sceneProfileChars', 'sceneRecentTopics', 'recentTopicDays', 'sceneMaxTurns', 'emotionDriftChance', 'defianceChance', 'defianceMinGapTurns', 'proactiveMinMinutes', 'proactiveMaxMinutes', 'proactiveIdleMinutes', 'proactiveContextTtlMinutes', 'proactiveNewTopicMinutes', 'proactiveRetrySeconds', 'proactiveMaxFailStreak', 'proactiveBurstAfterIdleMinutes', 'proactiveBurstMinCount', 'proactiveBurstMaxCount', 'proactiveQuestionChance', 'busyIntervalMinutes', 'autoImageChance', 'autoImageMinGapTurns', 'autoImageMaxPerHour', 'autoImageMaxPerDay', 'autoImageProactiveChance', 'imageGenTimeoutMs', 'imageGenMaxPerHour', 'imageGenMaxPerDay', 'searchHourlyLimit', 'searchDailyLimit', 'searchMaxResults', 'sceneAnalyzeMaxPerHour', 'visionMaxImagesPerMsg'],
  bool: ['allowStickers', 'bubbleSplit', 'sendTyping', 'autoSearch', 'searchFallback', 'sceneEnabled', 'emotionEnabled', 'autoImageEnabled', 'imageGenEnabled', 'imageGenNoText', 'visionEnabled', 'visionFallback', 'proactive', 'busyModeEnabled', 'ragEnabled', 'proactiveEnabled'],
  text: ['proactiveLines', 'allowedUsers', 'profileNotes'],
  secret: ['visionApiKey', 'visionDeepseekApiKey', 'imageGenApiKey', 'anysearchApiKey', 'chatApiKey']
};
function configKind(key) {
  if (key === 'forgetEnabled') return 'bool';
  if (['topicTtlHours','topicBanHours','historyRecentTurns','historyOlderChars'].includes(key)) return 'number';
  for (const [kind, keys] of Object.entries(CONFIG_META)) if (keys.includes(key)) return kind;
  return 'string';
}

// 给人看的中文名与说明。代码里一律用英文键，界面上说人话。
const CONFIG_LABELS = {
  defaultPersona: ['默认人设', '她从哪份 md 人格文件里取性格'],
  allowedUsers: ['白名单用户', '只有这些人发消息她会理；空 = 谁都理'],
  chatModel: ['聊天模型', '直连 API 时用的模型名'],
  chatBaseUrl: ['聊天接口地址', '一般不用改'],
  chatTemperature: ['说话发散度', '越高越跳脱，1.3 是她现在的状态'],
  taskTimeoutMs: ['单次任务超时', '毫秒；dsh 通道比较慢，别设太小'],
  maxBubbles: ['最多几条', '一条回复拆成几个气泡的上限'],
  bubbleGapMs: ['气泡间隔', '毫秒；两条消息之间停顿多久'],
  shortReplyThreshold: ['短回复阈值', '多短算"短回复"，会影响拆条'],
  sendTyping: ['显示"正在输入"', '关掉她打字时对方看不到提示'],
  showQueuedNotice: ['排队提示', '忙的时候先回一句"收到"'],
  stripActions: ['处理括号动作', '模型爱写（笑）这类，按需删掉'],
  bubbleSplit: ['自动拆条', '把一段话拆成几条陆续发'],
  allowStickers: ['允许发表情包', ''],
  stickerChance: ['表情包概率', '每一轮发图的基础概率'],
  stickerMinTurns: ['表情包最短间隔', '至少隔几轮才再发图中'],
  stickerMaxTurns: ['表情包最长间隔', '隔到几轮就强制发一张'],
  kaomojiChance: ['颜文字概率', '纯文字消息里带颜文字的概率'],
  emojiChance: ['emoji 概率', '带 emoji 的概率'],
  ragEnabled: ['读知识库', '是否从 Obsidian 库里检索'],
  vaultPath: ['知识库路径', '你的 Obsidian 库根目录'],
  ragTopK: ['检索条数', '每次最多塞几段笔记'],
  ragMinScore: ['检索门槛', '分数低于这个就不塞，防止塞无关内容'],
  profileMaxChars: ['画像卡长度', '"关于他"的完整画像最多多少字'],
  sceneProfileChars: ['小画像长度', '每轮都带的简短画像字数'],
  sceneRecentTopics: ['近期话题条数', '每轮带几条"他最近在弄的事"'],
  recentTopicDays: ['近期话题窗口', '只认最近几天的笔记（默认 2 天）'],
  sceneEnabled: ['场景延续', '让她围绕一件事往下聊，而不是每句重开'],
  sceneTtlMinutes: ['场景过期', '多久没聊就当作换了一件事（分钟）'],
  sceneMaxTurns: ['场景最多轮数', '同一件事聊到多少轮就该换'],
  sceneAnalyzeModel: ['场景判定方式', 'auto = 拿不准时才问模型'],
  sceneAnalyzeMaxPerHour: ['判定限频', '每小时最多问几次模型'],
  emotionEnabled: ['情绪系统', '有底色、会累会生气'],
  emotionDriftChance: ['情绪漂移概率', '没事发生也会慢慢变心情的概率'],
  defianceChance: ['顶嘴概率', '这一轮说"不"的基础概率'],
  defianceMinGapTurns: ['顶嘴间隔', '至少隔几轮才允许再顶一次'],
  forgetEnabled: ['遗忘机制', '旧话题会过期，"别再提"会进黑名单'],
  topicTtlHours: ['话题保鲜期', '话题超过这么多小时就当她忘了'],
  topicBanHours: ['黑名单时长', '他说"别老提这个"后，多久不许提'],
  proactive: ['主动发消息', '她会不会主动找你'],
  proactiveMinMinutes: ['主动最短间隔', '分钟'],
  proactiveMaxMinutes: ['主动最长间隔', '分钟'],
  proactiveIdleMinutes: ['静默多久才主动', '分钟；他刚说完话不会立刻发'],
  proactiveContextTtlMinutes: ['主动消息有效期', '超过这个时间就不发了（发送窗口）'],
  proactiveNewTopicMinutes: ['换题冷却', '多少分钟内只聊手头这件事'],
  proactiveRetrySeconds: ['发送失败重试', '失败后隔几秒重试'],
  proactiveMaxFailStreak: ['连续失败上限', '连续失败几次就判定窗口关闭'],
  proactiveCompose: ['主动消息来源', 'model = 模型现写，fixed = 固定句子'],
  proactiveLines: ['固定句子池', 'proactiveCompose=fixed 时用'],
  proactiveBurstAfterIdleMinutes: ['连发触发时长', '多久没回就连发几条'],
  proactiveBurstMinCount: ['连发最少条数', ''],
  proactiveBurstMaxCount: ['连发最多条数', ''],
  proactiveQuestionChance: ['带问句概率', '主动消息里问一句的概率'],
  proactiveBurstAfter: ['沉默几次连发', '连续几次没被回就升级'],
  busyModeEnabled: ['忙碌模式', '他说去忙了就别打扰'],
  busyIntervalMinutes: ['忙碌时打扰间隔', '分钟'],
  autoSearch: ['自动联网', '遇到天气/新闻这类会自动搜'],
  searchProvider: ['搜索通道', '主用 AnySearch，失败自动回退'],
  anysearchBaseUrl: ['搜索接口地址', ''],
  anysearchApiKey: ['搜索 Key', '留空则从凭证文件读'],
  searchMaxResults: ['搜索结果条数', ''],
  searchFallback: ['搜索自动回退', '主通道失败时换备用'],
  searchHourlyLimit: ['每小时搜索上限', '0 = 不限'],
  searchDailyLimit: ['每天搜索上限', '0 = 不限'],
  visionEnabled: ['识图', '收到图片能不能看懂'],
  visionProvider: ['识图通道', '默认 DeepSeek 自己看'],
  visionModelDeepseek: ['识图模型', 'DeepSeek 侧的视觉模型'],
  visionModel: ['备用识图模型', '豆包侧'],
  visionFallback: ['识图自动回退', '主用失败时切豆包'],
  visionApiKey: ['豆包 Key', '方舟平台'],
  visionDeepseekApiKey: ['识图专用 Key', '留空则用聊天那把'],
  imageGenEnabled: ['生图', '会不会画画'],
  imageGenModel: ['生图模型', ''],
  imageGenSize: ['生图尺寸档', '1K / 2K / 4K'],
  imageGenRatio: ['生图画幅', '1:1、16:9、9:16…'],
  imageGenStyle: ['画风', '拼进提示词的风格描述'],
  imageGenApiKey: ['生图 Key', '留空则从凭证文件读'],
  imageGenMaxPerHour: ['每小时生图上限', ''],
  imageGenMaxPerDay: ['每天生图上限', ''],
  autoImageEnabled: ['顺手发图', '聊天里自己拍/画一张发出来'],
  autoImageChance: ['顺手发图概率', ''],
  autoImageMinGapTurns: ['发图最短间隔', '至少隔几轮'],
  autoImageMaxPerHour: ['自发图每小时上限', ''],
  autoImageMaxPerDay: ['自发图每天上限', ''],
  autoImageProactiveChance: ['主动带图概率', '主动消息附一张图的概率'],
  // ── 生活线（她自己的日子）──
  lifeEnabled: ['生活线', '她有没有自己正在过的那条日子'],
  lifeArcChance: ['开新故事概率', '每次主动搭话时开一段新剧情的概率'],
  lifeContinueChance: ['接着说概率', '手上有没讲完的故事时，继续说它的概率'],
  lifeConflictChance: ['冲突剧情占比', '新故事里"有冲突"的比例（剩下是日常/意外/好奇）'],
  lifeArcCooldownMinutes: ['故事冷却（分钟）', '一段故事讲完之后，隔多久才开下一段'],
  proactiveCountShortMin: ['主动最少条数', '一次最少发几条'],
  proactiveCountShortMax: ['主动最多条数', '一次最多发几条（常见档）'],
  proactiveCountLongChance: ['连发一波的概率', '偶尔一口气发很多条的概率'],
  proactiveCountLongMin: ['连发最少条数', ''],
  proactiveCountLongMax: ['连发最多条数', ''],
  workdir: ['工作目录', 'dsh 通道执行命令的目录'],
  botAgent: ['UA 标识', ''],
  stickerDir: ['表情包目录', '留空用默认 stickers/']
};

// 枚举值也要翻成人话
const ENUM_LABELS = {
  stripActions: { action: '去掉括号动作', all: '动作和旁白都去掉', keep: '原样保留' },
  proactiveCompose: { model: '让模型现写', fixed: '用固定句子' },
  searchProvider: { anysearch: 'AnySearch（主用）', deepseek: 'DeepSeek 原生（备用）' },
  visionProvider: { deepseek: 'DeepSeek 自己看（主用）', doubao: '豆包方舟（备用）' },
  sceneAnalyzeModel: { auto: '拿不准才问模型', false: '只用本地规则' }
};

// ── 路由 ─────────────────────────────────────────────────────────────────
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/accounts$/,async(req,res)=>json(res,200,{ok:true,...await accountOperation('list')}));
route('POST', /^\/api\/persona-import\/(analyze|import)$/,async(req,res,m)=>{
  const body=JSON.parse((await readBody(req,16384)).toString('utf8')||'{}');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['source','target','self','persona','name','address','gender','relationship','allow_media'].includes(k)))return bad(res,400,'导入参数无效');
  return json(res,200,{ok:true,...await localOperation('import_persona.py',m[1],body)});
});
route('POST', /^\/api\/accounts$/,async(req,res)=>{
  const body=JSON.parse((await readBody(req,16384)).toString('utf8')||'{}');
  if(Object.keys(body).some(k=>k!=='label'))return bad(res,400,'只能填写使用者备注');
  return json(res,200,{ok:true,account:await accountOperation('create',body)});
});
route('POST', /^\/api\/accounts\/([a-f0-9]{32})$/,async(req,res,m)=>{
  const changes=JSON.parse((await readBody(req,16384)).toString('utf8')||'{}');
  return json(res,200,{ok:true,account:await accountOperation('update',{id:m[1],changes})});
});
route('POST', /^\/api\/accounts\/([a-f0-9]{32})\/reauthorize$/,async(req,res,m)=>{
  await readBody(req,16384);
  return json(res,200,{ok:true,account:await accountOperation('reauthorize',{id:m[1]})});
});
route('GET', /^\/api\/accounts\/([a-f0-9]{32})\/qr$/,async(req,res,m)=>{
  let result;try{result=await accountOperation('qr',{id:m[1]});}catch{return bad(res,404,'当前没有有效二维码，请刷新状态');}
  const body=fs.readFileSync(result.file);
  res.writeHead(200,{'content-type':'image/png','content-length':body.length,'cache-control':'no-store'});res.end(body);
});

route('GET', /^\/api\/state$/, async (req, res) => {
  const cfg = loadConfig();
  const p = pidAlive();
  const personas = listPersonas();
  const st = stickerStats();
  const logTail = tail(LOG_PATH, 3).trim().split(/\r?\n/).pop() || '';
  let identity;
  if(cfg.desktopAdapterEnabled&&localTransport()==='ilink'){
    try{identity=await accountOperation('identity');}
    catch{identity={bound:false,name:'绑定信息暂不可用',source:'unavailable'};}
  }
  return json(res, 200, {
    ok: true,
    appId: cfg.desktopAdapterEnabled ? 'ai-yuyi' : 'wx-bridge',
    desktop: cfg.desktopAdapterEnabled ? {...desktopStatus(),version:'1.2.0',transport:localTransport(),contact:identity?identity.name:(localSettings().contact||'未设置'),contactSource:identity?.source} : null,
    profile: cfg.desktopAdapterEnabled ? desktopProfile() : null,
    companion: cfg.desktopAdapterEnabled ? companionStats() : null,
    bot: { running: p.running, pid: p.pid, lastLog: logTail },
    enabled:!!localSettings().enabled&&p.running,
    desiredEnabled:!!localSettings().enabled,
    personas: { count: personas.length, current: personas.find((x) => x.isDefault)?.name || null },
    stickers: { total: st.total, categories: st.categories.length },
    config: { persona: cfg.defaultPersona || '', model: cfg.chatModel || '', proactive: !!cfg.proactive, stickers: cfg.stickerChance ?? null, kaomoji: cfg.kaomojiChance ?? null }
  });
});

route('POST', /^\/api\/accounts\/([a-f0-9]{32})\/delete$/,async(req,res,m)=>{await readBody(req,16384);return json(res,200,{ok:true,...await accountOperation('delete',{id:m[1]})});});
route('GET', /^\/api\/model-config$/,async(req,res)=>json(res,200,{ok:true,config:await localOperation('api_settings.py','get')}));
for(const action of ['save','test','models'])route('POST',new RegExp('^/api/model-config/'+action+'$'),async(req,res)=>{
  const body=JSON.parse((await readBody(req,32768)).toString('utf8')||'{}');
  const wasRunning=pidAlive().running&&!!localSettings().enabled;
  const result=await localOperation('api_settings.py',action,body);
  if(action==='save'&&wasRunning)await desktopControl('restart');
  return json(res,200,{ok:true,...(action==='save'?{config:result,restarted:wasRunning}:result)});
});
route('GET', /^\/api\/memory\/scopes$/,async(req,res)=>json(res,200,{ok:true,...await localOperation('memory_editor.py','scopes')}));
route('GET', /^\/api\/memory(?:\/(topics))?$/,async(req,res,m,url)=>{
  const body=Object.fromEntries(url.searchParams);body.offset=Number(body.offset||0);
  return json(res,200,{ok:true,...await localOperation('memory_editor.py',m[1]||'list',body)});
});
for(const action of ['add','change','undo'])route('POST',new RegExp('^/api/memory/'+action+'$'),async(req,res)=>{
  const body=JSON.parse((await readBody(req,65536)).toString('utf8')||'{}');return json(res,200,{ok:true,...await localOperation('memory_editor.py',action,body)});
});

route('GET', /^\/api\/personas$/, (req, res) => json(res, 200, { ok: true, items: listPersonas() }));

route('GET', /^\/api\/personas\/(.+)$/, (req, res, m) => {
  const name = safeName(decodeURIComponent(m[1]));
  if (!name) return bad(res, 400, '名字不合法');
  const full = personaFile(name);
  if (!fs.existsSync(full)) return bad(res, 404, '人设不存在');
  return json(res, 200, { ok: true, name, content: fs.readFileSync(full, 'utf8'), mtime: fs.statSync(full).mtimeMs });
});

route('POST', /^\/api\/personas\/save$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const name = safeName(body.name);
  if (!name) return bad(res, 400, '名字不合法（不能含 \\ / : * ? " < > |）');
  if (typeof body.content !== 'string' || !body.content.trim()) return bad(res, 400, '内容不能为空');
  const full = personaFile(name);
  const isNew = !fs.existsSync(full);
  if (isNew && listPersonas().length >= 200) return bad(res, 400, '人设太多了');
  fs.writeFileSync(full, body.content, 'utf8');
  return json(res, 200, { ok: true, name, created: isNew });
});

route('POST', /^\/api\/personas\/rename$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const from = safeName(body.from);
  const to = safeName(body.to);
  if (!from || !to) return bad(res, 400, '名字不合法');
  const src = personaFile(from);
  if(src.endsWith(path.sep+'persona.md'))return bad(res,400,'私密人设的资料关联固定，请保留当前标识');
  const dst = path.join(PERSONA_DIR, to + '.md');
  if (!fs.existsSync(src)) return bad(res, 404, '人设不存在');
  if (fs.existsSync(dst)) return bad(res, 409, '目标名字已存在');
  fs.renameSync(src, dst);
  const cfg = loadConfig();
  if (String(cfg.defaultPersona || '').replace(/\.md$/i, '') === from) { cfg.defaultPersona = to; saveConfig(cfg); }
  return json(res, 200, { ok: true, from, to });
});

route('POST', /^\/api\/personas\/delete$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const name = safeName(body.name);
  if (!name) return bad(res, 400, '名字不合法');
  const full = personaFile(name);
  if (!fs.existsSync(full)) return bad(res, 404, '人设不存在');
  if (listPersonas().length <= 1) return bad(res, 400, '至少保留一个人设');
  fs.unlinkSync(full);
  const cfg = loadConfig();
  if (String(cfg.defaultPersona || '').replace(/\.md$/i, '') === name) { cfg.defaultPersona = ''; saveConfig(cfg); }
  return json(res, 200, { ok: true });
});

route('POST', /^\/api\/personas\/default$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const name = String(body.name || '').trim();
  if (name) {
    const safe = safeName(name);
    if (!safe || !fs.existsSync(personaFile(safe))) return bad(res, 400, '人设不存在');
    const cfg = loadConfig();
    cfg.defaultPersona = safe;
    saveConfig(cfg);
    return json(res, 200, { ok: true, name: safe });
  }
  const cfg = loadConfig();
  cfg.defaultPersona = '';
  saveConfig(cfg);
  return json(res, 200, { ok: true, name: '' });
});

route('GET', /^\/api\/config$/, (req, res) => {
  const cfg = loadConfig();
  const items = Object.keys(cfg).filter((k) => k !== '_说明' && (!cfg.desktopAdapterEnabled || desktopKeys.has(k))).sort().map((k) => {
    const meta = CONFIG_LABELS[k] || [];
    const enumMap = ENUM_LABELS[k];
    return {
      key: k,
      kind: configKind(k),
      value: k.includes('ApiKey') ? (cfg[k] ? '<已设置>' : '') : cfg[k],
      zh: meta[0] || '',
      desc: meta[1] || '',
      options: enumMap
        ? Object.entries(enumMap).map(([value, label]) => ({ value, label }))
        : null
    };
  });
  return json(res, 200, { ok: true, items });
});

// ── 话题记忆（遗忘机制）────────────────────────────────────────────────
const TOPICS_FILE = path.join(DATA_DIR, 'topics.json');
function loadTopics() {
  try { return JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')); } catch { return {}; }
}
route('GET', /^\/api\/topics$/, (req, res) => {
  const all = loadTopics();
  const now = Date.now();
  const users = Object.entries(all).map(([uid, b]) => ({
    uid,
    history: (b.history || []).map((h) => ({
      label: h.label, keywords: h.keywords || [], mentions: h.mentions || 1,
      lastAt: h.lastAt || 0, ageHours: Math.round((now - (h.lastAt || now)) / 3600e3)
    })).sort((a, b2) => b2.lastAt - a.lastAt),
    bans: (b.bans || []).filter((x) => (x.until || 0) > now).map((x) => ({
      labels: (x.labels && x.labels.length ? x.labels : [x.label]).filter(Boolean),
      keywords: x.keywords || [],
      until: x.until, remainHours: Math.round(((x.until || 0) - now) / 3600e3), reason: x.reason || ''
    }))
  }));
  return json(res, 200, { ok: true, users, ttlHours: loadConfig().topicTtlHours ?? 48 });
});
route('POST', /^\/api\/topics\/clear$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const all = loadTopics();
  const uid = body.uid ? String(body.uid) : null;
  const scope = body.scope || 'bans'; // bans | history | all
  let touched = 0;
  for (const [k, b] of Object.entries(all)) {
    if (uid && k !== uid) continue;
    if (scope === 'bans' || scope === 'all') { touched += (b.bans || []).length; b.bans = []; }
    if (scope === 'history' || scope === 'all') { touched += (b.history || []).length; b.history = []; }
  }
  fs.writeFileSync(TOPICS_FILE, JSON.stringify(all, null, 2), 'utf8');
  return json(res, 200, { ok: true, cleared: touched, scope });
});

// ── 生活线（她自己正在过的日子：配角 / 进行中的故事 / 已讲完）──────────
function lifeUserIds() {
  const file = path.join(DATA_DIR, 'life.json');
  try { return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return []; }
}
route('GET', /^\/api\/life$/, (req, res) => {
  // 白名单里的用户也要列出来：这样还没开过故事时也能编辑人物和故事模板。
  const ids = [...new Set([...lifeUserIds(), ...(loadConfig().allowedUsers || [])])];
  const now = Date.now();
  const users = ids.map((uid) => {
    const life = loadLife(uid);
    const arc = activeArc(life);
    return {
      uid,
      cast: (life.cast || DEFAULT_CAST).map((c) => ({ id: c.id, name: c.name, role: c.role, relation: c.relation || '', trait: c.trait })),
      arcs: (life.arcs || []).map((a) => ({
        id: a.id, title: a.title, kind: a.kind, cast: a.cast || [], beats: a.beats || [], custom: true
      })),
      arc: arc ? {
        title: arc.title, kind: arc.kind, stage: arc.stage, total: arc.beats?.length || 0,
        startedAt: arc.startedAt || 0,
        ageMinutes: Math.round((now - (arc.startedAt || now)) / 60000),
        progress: (arc.progress || []).map((p) => p.told).filter(Boolean),
        next: (typeof arc.beats?.[arc.stage] === 'string' ? arc.beats[arc.stage] : (arc.beats?.[arc.stage]?.hint || ''))
      } : null,
      closed: (life.closed || []).slice(-8).reverse().map((c) => ({ title: c.title, kind: c.kind, endedAt: c.closedAt || 0 })),
      lastArcAt: life.lastArcAt || 0,
      templates: ARCS.length
    };
  });
  const all = allTemplates(loadLife(ids[0] || '__none__')).map((a) => ({
    id: a.id, title: a.title, kind: a.kind, cast: a.cast || [], beats: a.beats || [], custom: !!a.custom
  }));
  return json(res, 200, { ok: true, users, castDefaults: DEFAULT_CAST, allTemplates: all, kinds: VALID_KINDS.map((k) => ({ id: k, label: KIND_LABELS[k] })) });
});
route('POST', /^\/api\/life\/new$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const uid = String(body.uid || '').trim();
  if (!uid) return bad(res, 400, '缺少 uid');
  let life = loadLife(uid);
  if (activeArc(life)) return bad(res, 409, '还有一段故事没讲完，先讲完或丢弃');
  life = startArc(uid, life, {
    conflictChance: Number(body.conflictChance ?? 0.35),
    templateId: body.templateId ? String(body.templateId) : null
  });
  saveLife(uid, life);
  const arc = activeArc(life);
  if (!arc) return bad(res, 400, '没找到这段模板');
  return json(res, 200, { ok: true, title: arc.title, kind: arc.kind, total: arc.beats?.length });
});
route('POST', /^\/api\/life\/cast\/save$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const uid = String(body.uid || '').trim();
  if (!uid) return bad(res, 400, '缺少 uid');
  try {
    const life = saveCastMember(uid, loadLife(uid), body.member || {});
    return json(res, 200, { ok: true, cast: life.cast });
  } catch (e) { return bad(res, 400, e.message); }
});
route('POST', /^\/api\/life\/cast\/delete$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const uid = String(body.uid || '').trim();
  const id = String(body.id || '').trim();
  if (!uid || !id) return bad(res, 400, '缺少参数');
  const life = deleteCastMember(uid, loadLife(uid), id);
  return json(res, 200, { ok: true, cast: life.cast });
});
route('POST', /^\/api\/life\/arcs\/generate$/, async (req, res) => {
  // 用 DeepSeek 现场写一段三拍故事，只返回草稿（不落盘），用户改完再保存。
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const uid = String(body.uid || '').trim();
  const idea = String(body.idea || '').trim().slice(0, 200);
  const wantKind = VALID_KINDS.includes(String(body.kind || '')) ? String(body.kind) : '';
  if (!uid) return bad(res, 400, '缺少 uid');

  const cfg = loadConfig();
  const apiKey = readApiKey().key;
  if (!apiKey) return bad(res, 400, '没有可用的 DeepSeek Key');

  const life = loadLife(uid);
  const castNames = (life.cast || DEFAULT_CAST).map((c) => `${c.name}（${c.role}）`).join('、');
  const kindList = Object.entries(KIND_LABELS).map(([k, v]) => `${k}=${v}`).join('；');
  const system = [
    '你是一个剧情模板生成器，只输出 JSON，不要代码块、不要解释。',
    `可选类型（必须原样使用英文键）：${kindList}`,
    `可用人物（cast 里只能填这些人物的名字）：${castNames}`,
    '输出格式：{"title":"不超过 20 字","kind":"类型英文键","cast":["人物名"],"beats":["起因：…","过程：…","收尾：…"]}',
    'beats 必须正好 3 条，每条 12~40 个汉字，具体、有画面、像真事；',
    '用第二人称"你"写，不要写旁白，不要写她"说"什么台词。',
    '事情要有情绪落点但别夸张：可能是被夸、走运、小小拌嘴、倒霉、日常小事。'
  ].join('\n');
  const userPrompt = idea
    ? `想写的事：${idea}${wantKind ? `（类型固定为 ${wantKind}）` : ''}`
    : `随便写一件最近可能发生的小事${wantKind ? `（类型固定为 ${wantKind}）` : ''}`;

  const r = await chatComplete({
    baseUrl: cfg.chatBaseUrl,
    apiKey,
    model: cfg.chatModel || 'deepseek-v4-flash',
    temperature: 1.0,
    timeoutMs: 60000,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt }
    ]
  });
  if (!r.ok) return bad(res, 502, '生成失败：' + (r.error || '未知错误'));

  const raw = String(r.text || '').trim().replace(/^\u0060\u0060\u0060(?:json)?/i, '').replace(/\u0060\u0060\u0060$/, '').trim();
  let draft;
  try {
    draft = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return bad(res, 502, '模型返回的不是合法 JSON，再试一次');
  }
  const castIds = [];
  for (const name of Array.isArray(draft.cast) ? draft.cast : []) {
    const hit = (life.cast || DEFAULT_CAST).find((c) => c.name === String(name).trim());
    if (hit) castIds.push(hit.id);
  }
  return json(res, 200, {
    ok: true,
    draft: {
      title: String(draft.title || '').slice(0, 40),
      kind: VALID_KINDS.includes(draft.kind) ? draft.kind : (wantKind || 'daily'),
      cast: castIds,
      beats: (Array.isArray(draft.beats) ? draft.beats : []).map((b) => String(b).trim()).filter(Boolean).slice(0, 6)
    },
    ms: r.ms
  });
});
route('POST', /^\/api\/life\/arcs\/save$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const uid = String(body.uid || '').trim();
  if (!uid) return bad(res, 400, '缺少 uid');
  try {
    const life = saveArcTemplate(uid, loadLife(uid), body.arc || {});
    return json(res, 200, { ok: true, arcs: life.arcs });
  } catch (e) { return bad(res, 400, e.message); }
});
route('POST', /^\/api\/life\/arcs\/delete$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const uid = String(body.uid || '').trim();
  const id = String(body.id || '').trim();
  if (!uid || !id) return bad(res, 400, '缺少参数');
  const life = deleteArcTemplate(uid, loadLife(uid), id);
  return json(res, 200, { ok: true, arcs: life.arcs });
});
route('POST', /^\/api\/life\/drop$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const uid = String(body.uid || '').trim();
  if (!uid) return bad(res, 400, '缺少 uid');
  const life = loadLife(uid);
  dropArc(uid, life);
  return json(res, 200, { ok: true });
});
route('POST', /^\/api\/life\/reset$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const uid = String(body.uid || '').trim();
  if (!uid) return bad(res, 400, '缺少 uid');
  resetLife(uid);
  return json(res, 200, { ok: true });
});

route('POST', /^\/api\/config$/, async (req, res) => {  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
  const cfg = loadConfig();
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (cfg.desktopAdapterEnabled && !desktopKeys.has(k)) continue;
    if (!(k in cfg)) continue;
    const kind = configKind(k);
    if (kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return bad(res, 400, `${k} 必须是数字`);
      if (cfg.desktopAdapterEnabled && k === 'taskTimeoutMs' && (n < 1000 || n > 45000)) return bad(res,400,'本次微信适配的单次模型超时须在 1000–45000 毫秒之间');
      cfg[k] = n;
    } else if (kind === 'bool') {
      cfg[k] = v === true || v === 'true';
    } else if (kind === 'secret') {
      if (typeof v === 'string' && v.trim()) cfg[k] = v.trim();
    } else {
      cfg[k] = v;
    }
    changed.push(k);
  }
  saveConfig(cfg);
  return json(res, 200, { ok: true, changed });
});

route('GET', /^\/api\/stickers$/, (req, res) => json(res, 200, { ok: true, ...stickerStats() }));

route('GET', /^\/api\/stickers\/file$/, (req, res, m, url) => {
  const cat = safeName(url.searchParams.get('category'));
  const file = safeName(url.searchParams.get('file'), true);
  if (!cat || !file) return bad(res, 400, '参数不合法');
  const full = path.join(STICKER_DIR, cat, file);
  if (!full.startsWith(path.join(STICKER_DIR, cat)) || !fs.existsSync(full)) return bad(res, 404, '不存在');
  const ext = path.extname(full).toLowerCase();
  if (!STICKER_EXT.has(ext)) return bad(res, 400, '不是图片');
  const mime = ext === '.gif' ? 'image/gif' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const stat = fs.statSync(full);
  res.writeHead(200, { 'content-type': mime, 'content-length': stat.size, 'cache-control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
});

route('POST', /^\/api\/stickers\/upload$/, async (req, res, m, url) => {
  const cat = safeName(url.searchParams.get('category'));
  const name = safeName(url.searchParams.get('name'), true);
  if (!cat) return bad(res, 400, '缺少分类');
  if (!name) return bad(res, 400, '文件名不合法');
  const ext = path.extname(name).toLowerCase();
  if (!STICKER_EXT.has(ext)) return bad(res, 400, '只支持 png/jpg/jpeg/gif/webp');
  const catDir = path.join(STICKER_DIR, cat);
  fs.mkdirSync(catDir, { recursive: true });
  const buf = await readBody(req);
  if (!buf.length) return bad(res, 400, '空文件');
  let target = path.join(catDir, name);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(catDir, `${path.basename(name, ext)}_${i}${ext}`);
    i++;
  }
  fs.writeFileSync(target, buf);
  return json(res, 200, { ok: true, file: path.basename(target), bytes: buf.length });
});

route('POST', /^\/api\/stickers\/move$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const from = safeName(body.from);
  const to = safeName(body.to);
  const file = safeName(body.file, true);
  if (!from || !to || !file) return bad(res, 400, '参数不合法');
  const src = path.join(STICKER_DIR, from, file);
  if (!fs.existsSync(src)) return bad(res, 404, '图片不存在');
  const dstDir = path.join(STICKER_DIR, to);
  fs.mkdirSync(dstDir, { recursive: true });
  let dst = path.join(dstDir, file);
  if (fs.existsSync(dst)) {
    const ext = path.extname(file);
    dst = path.join(dstDir, `${path.basename(file, ext)}_${Date.now()}${ext}`);
  }
  fs.renameSync(src, dst);
  return json(res, 200, { ok: true, file: path.basename(dst) });
});

route('POST', /^\/api\/stickers\/delete$/, async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const cat = safeName(body.category);
  const file = safeName(body.file, true);
  if (!cat || !file) return bad(res, 400, '参数不合法');
  const full = path.join(STICKER_DIR, cat, file);
  if (!fs.existsSync(full)) return bad(res, 404, '不存在');
  fs.unlinkSync(full);
  return json(res, 200, { ok: true });
});

route('POST', /^\/api\/stickers\/reset-usage$/, (req, res) => {
  fs.writeFileSync(USAGE_PATH, JSON.stringify({ seq: 0, used: {} }, null, 2), 'utf8');
  return json(res, 200, { ok: true });
});

route('POST', /^\/api\/bot\/start$/,async(req,res)=>{await desktopControl('start');return json(res,200,{ok:true,note:'已启动回复服务'});});
route('POST', /^\/api\/bot\/restart$/, async (req, res) => {
  if (loadConfig().desktopAdapterEnabled) {
    await desktopControl('restart');
    return json(res,200,{ok:true,note:localTransport()==='ilink'?'已启动后台连接，首次使用请扫码授权':'已启动普通好友自动回复，请保持微信前台'});
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'launch.js'), '--restart'], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  return json(res, 200, { ok: true, note: '已发出重启指令，约 3 秒后生效' });
});

route('POST', /^\/api\/bot\/stop$/, async (req, res) => {
  if (loadConfig().desktopAdapterEnabled) {
    await desktopControl('stop');return json(res,200,{ok:true});
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'launch.js'), '--stop'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return json(res, 200, { ok: true });
});

route('GET', /^\/api\/logs$/, (req, res, m, url) => {
  const lines = Math.min(2000, Math.max(20, Number(url.searchParams.get('lines') || 300)));
  const text = loadConfig().desktopAdapterEnabled ? tail(LOG_PATH,Math.ceil(lines/2))+'\n—— 微信收发 ——\n'+tail(path.join(DESKTOP_ROOT,'data','run.log'),Math.ceil(lines/2)) : tail(LOG_PATH,lines);
  return json(res, 200, { ok: true, text });
});

route('POST', /^\/api\/desktop\/(locate|config)$/, async (req,res,m) => {
  if (!loadConfig().desktopAdapterEnabled) return bad(res,400,'未启用普通好友适配');
  await desktopControl(m[1]);return json(res,200,{ok:true});
});

route('GET', /^\/api\/ilink\/qr$/, (req,res)=>{
  const file=path.join(DESKTOP_ROOT,'data','ilink-qr.png');
  if(localTransport()!=='ilink'||!desktopStatus().qr||!pidAlive().running||!fs.existsSync(file))return bad(res,404,'当前无需扫码，请刷新状态');
  const body=fs.readFileSync(file);res.writeHead(200,{'content-type':'image/png','content-length':body.length,'cache-control':'no-store'});res.end(body);
});

route('GET', /^\/(api-ui|memory-ui|import-ui)\.js$/, (req,res,m)=>{const body=fs.readFileSync(path.join(HERE,m[1]+'.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','content-length':body.length,'cache-control':'no-store'});res.end(body);});
// 静态文件（console/index.html）
route('GET', /^\/$|^\/index\.html$/, (req, res) => {
  const file = path.join(HERE, 'index.html');
  if (!fs.existsSync(file)) return bad(res, 404, '缺少 index.html');
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
});

const server = http.createServer(async (req, res) => {
  if(req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${HOST}:${PORT}`) return bad(res,403,'只允许本机控制台操作');
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    try {
      await r.handler(req, res, m, url);
    } catch (e) {
      if (!res.headersSent) bad(res, e.statusCode||500, e?.message || String(e));
      else res.end();
    }
    return;
  }
  return bad(res, 404, '没有这个接口');
});

server.listen(PORT, HOST, () => {
  console.log(`机器人控制台: http://${HOST}:${PORT}`);
  console.log(`项目目录: ${ROOT}`);
  console.log('按 Ctrl+C 停止。');
});
