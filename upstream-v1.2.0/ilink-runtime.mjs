// Network transport for the existing v1.2 reply handler; no desktop automation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import * as api from './src/ilink.js';
import {uploadMedia,buildImageItem} from './src/media.js';
import {selectMedia,resolveMedia,deliver} from './src/companion-media.mjs';
import {accountContext} from './src/account-policy.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url)), LOCAL=path.dirname(ROOT);
function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+`.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');
  for(let attempt=0;;attempt++){
    try{fs.renameSync(tmp,file);break;}
    catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=9)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}
  }
}
export class Queue {
  constructor(file,owner){
    this.file=file;this.owner=owner;
    this.data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{owner,cursor:'',jobs:[]};
    if(this.data.owner!==owner)throw Error('账号与消息队列不一致，已停止');
    for(const j of this.data.jobs){
      if(j.phase==='generating')j.phase='queued';
      if(j.phase==='sending')j.phase='uncertain';
    }
    this.save();
  }
  save(){writeJson(this.file,this.data);}
  activate(persona){
    let changed=false;
    for(const job of this.data.jobs){
      if(!job.persona){job.persona='private_persona';changed=true;}
      if(job.persona!==persona&&['queued','prepared','generating'].includes(job.phase)){
        job.phase='cancelled';job.error='角色已切换，保留旧任务但不再发送';changed=true;
      }
    }
    if(changed)this.save();
  }
  receive(messages,cursor,persona='private_persona'){
    const seen=new Set(this.data.jobs.map(j=>j.key));
    for(const m of messages){
      if(m.message_type!==1||m.from_user_id!==this.owner)continue;
      const key=String(m.message_id||createHash('sha256').update(JSON.stringify([m.from_user_id,m.create_time_ms,m.item_list])).digest('hex'));
      if(seen.has(key))continue;seen.add(key);
      this.data.jobs.push({key,msg:m,persona,phase:'queued',attempts:0,answer:'',at:Date.now()});
    }
    if(cursor)this.data.cursor=cursor;
    // The cursor and complete inbound batch are committed together before generation.
    this.save();
  }
  next(){return this.data.jobs.find(j=>['queued','prepared'].includes(j.phase)&&!(j.retryAt>Date.now()));}
}

export function confirmedHistory(jobs,persona,excluded=[]){
  const blocked=new Set(excluded);
  return jobs.filter(j=>(j.persona||'private_persona')===persona&&!blocked.has(j.key)&&(j.phase==='sent'||j.textConfirmed)).slice(-6).flatMap(j=>[{role:'user',content:(api.extractText(j.msg)||'[收到图片或其他媒体]')+(j.vision?'\n图片已识别：'+j.vision:'')},{role:'assistant',content:j.answer+(j.mediaConfirmed?'\n[已实际发送媒体]':'')}]);
}

export async function processJob(queue,job,{generate,send,prepare,confirmed,allowed=()=>true,notice=()=>{}}){
  if(!job||!allowed())return;
  if(job.phase==='queued'){
    job.phase='generating';queue.save();notice('generating','已收到消息，正在回复',job);
    try{
      const generated=await generate(job.msg,job);
      if(typeof generated==='string')job.answer=generated;
      else {job.answer=generated.text;job.media=generated.media||[];job.vision=generated.vision||'';job.memoryEvidence=generated.evidence||[];}
      if(!job.answer?.trim()||job.answer.length>500)throw Error('回复为空或过长');
      job.phase='prepared';job.error='';queue.save();
    }catch(e){
      job.attempts++;job.phase=job.attempts>=3?'failed':'queued';job.error=String(e.message).slice(0,180);
      job.retryAt=Date.now()+job.attempts*3000;queue.save();
      notice('api_error',job.phase==='failed'?'本轮生成连续失败，继续接收新消息':'模型暂时失败，稍后自动重试',job);return;
    }
  }
  if(!allowed())return;
  if(prepare){
    try{await prepare(job,()=>queue.save());}
    catch(e){
      job.mediaAttempts=(job.mediaAttempts||0)+1;job.error=String(e.message).slice(0,160);job.retryAt=Date.now()+3000*job.mediaAttempts;
      if(job.mediaAttempts>=3)job.phase='failed';queue.save();notice('media_error','图片准备暂时失败，任务已保存；连续三次失败会停止本轮',job);return;
    }
  }
  if(!allowed())return;
  job.phase='sending';queue.save();notice('sending','正在通过微信接口发送',job);
  try{job.receipt=await send(job.answer,job.msg,job,()=>queue.save());}
  catch(e){
    job.phase=e.beforeSend?'prepared':job.textConfirmed?'partial':'uncertain';job.error=String(e.message).slice(0,180);queue.save();
    notice('needs_check','本轮接口发送未确认，不会重复发送；继续接收新消息',job);return;
  }
  job.phase='sent';job.sentAt=Date.now();queue.save();
  try{await confirmed(job);job.historyPending=false;}
  catch{job.historyPending=true;}
  queue.save();notice('listening','微信接口已确认发送，继续监听',job);
}

function python(script,args=[],input=''){
  return new Promise((resolve,reject)=>{
    const child=execFile(process.env.WX_DESKTOP_PYTHON||'python',['-X','utf8',path.join(LOCAL,script),...args],{cwd:LOCAL,windowsHide:true,timeout:20000,maxBuffer:2*1024*1024},(error,stdout)=>{
      if(!error)return resolve(stdout.trim());
      let message='本地配置处理失败';try{message=JSON.parse(stdout).error||message;}catch{}
      reject(Error(message));
    });
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
function trustedBase(value){
  const u=new URL(value);if(u.protocol!=='https:'||!u.hostname.endsWith('.weixin.qq.com')||u.username||u.password)throw Error('微信返回了非预期的接口地址');
  return u.origin;
}
async function login(notice,allowed){
  let base=api.ILINK_BASE_URL;
  while(allowed()){
    const qr=await api.fetchQrCode(base);
    if(!qr.qrcode||!qr.qrcode_img_content)throw Error('微信未返回登录二维码');
    await python('ilink_bot.py',['--qr'],qr.qrcode_img_content);
    const expiresAt=Date.now()+150000,qrVersion=Date.now();
    notice('awaiting_scan',process.env.WX_ILINK_ACCOUNT_ID?'请让这位朋友用自己的微信扫一扫，并确认连接':'请用日常聊天的大号微信扫一扫，并确认连接',{qr:true,qrVersion,expiresAt});
    while(allowed()&&Date.now()<expiresAt){
      await delay(2000);let s;
      try{s=await api.pollQrStatus(base,qr.qrcode);}catch{continue;}
      if(s.status==='confirmed'){
        if(!s.bot_token||!s.ilink_bot_id||!s.ilink_user_id)throw Error('微信授权响应不完整');
        const cred={token:s.bot_token,baseUrl:trustedBase(s.baseurl||base),accountId:s.ilink_bot_id,userId:s.ilink_user_id};
        try{await python('ilink_bot.py',['--credential-save'],JSON.stringify(cred));}
        catch(error){error.authConflict=true;throw error;}return cred;
      }
      if(s.status==='scaned')notice('awaiting_scan','已扫码，请在手机微信确认连接',{qr:true,qrVersion,expiresAt});
      if(s.status==='need_verifycode'){const error=Error('微信要求附加验证码，请在手机完成验证后重新授权');error.needsVerification=true;throw error;}
      if(s.status==='scaned_but_redirect'&&s.redirect_host){base=trustedBase('https://'+s.redirect_host.replace(/^https?:\/\//,''));break;}
      if(s.status==='expired')break;
    }
  }
  throw Error('已停止连接');
}

let errorStatusFile=null;
async function main(){
  const scope=accountContext(LOCAL,process.env.WX_ILINK_ACCOUNT_ID||'',process.env.WX_ILINK_ACCOUNT_REVISION||'');
  if(process.env.WX_ILINK_ACCOUNT_ID)process.env.WX_RUNTIME_DATA_DIR=path.join(scope.directory,'runtime');
  else delete process.env.WX_RUNTIME_DATA_DIR;
  const statusFile=path.join(scope.directory,'status.json');errorStatusFile=statusFile;
  const allowed=()=>{
    try{const c=JSON.parse(fs.readFileSync(path.join(LOCAL,'data','config.json'),'utf8'));return scope.active()&&c.enabled&&c.transport==='ilink'&&c.run_id===process.env.WX_COMPANION_RUN_ID&&!fs.existsSync(path.join(LOCAL,'data','stop'));}catch{return false;}
  };
  const notice=(state,detail,job={})=>{
    writeJson(statusFile,{state,detail,at:Date.now()/1000,pid:process.pid,transport:'ilink',event:job.key||null,phase:job.phase||'',retries:job.attempts||0,qr:!!job.qr,qrVersion:job.qrVersion,expiresAt:job.expiresAt,runId:process.env.WX_COMPANION_RUN_ID,accountRevision:process.env.WX_ILINK_ACCOUNT_REVISION||''});
    if(state!=='listening')console.log(new Date().toISOString(),detail);
    if(state==='listening'&&job.phase==='sent')console.log(new Date().toISOString(),'微信已确认回复：',job.answer);
  };
  // Import without starting the original CLI's independent polling loop.
  process.argv.push('--desktop-transport','--mode=chat');
  const {handleWithDsh}=await import('./src/index.js');
  const {loadConfig}=await import('./src/config.js');
  const {syncConfirmedHistory}=await import('./src/memory.js');
  const {saveScene,resetScene,createScene,analyzeTurn,recordUserTurn,recordReply}=await import('./src/scene.js');
  const {MOODS}=await import('./src/emotion.js');
  const originalTones=Object.fromEntries(Object.entries(MOODS).map(([key,mood])=>[key,mood.tone]));
  let cred=JSON.parse(await python('ilink_bot.py',['--credential-load'])||'null');
  if(!cred)cred=await login(notice,allowed);
  cred.baseUrl=trustedBase(cred.baseUrl);api.setBotAgent('AIYuYi/1.2.0');
  const id=createHash('sha256').update(cred.userId).digest('hex').slice(0,16);
  const queue=new Queue(path.join(scope.directory,`ilink-queue-${id}.json`),cred.userId);
  const state={cred,contextTokens:new Map(),handled:0,cfg:{},companionMode:true};
  const currentPersona=()=>scope.persona(loadConfig().defaultPersona||'private_persona');
  let activePersona=currentPersona();queue.activate(activePersona);
  const roleJobs=persona=>queue.data.jobs.filter(j=>(j.persona||'private_persona')===persona);
  const historyExclusions=new Map();
  const history=persona=>confirmedHistory(queue.data.jobs,persona,historyExclusions.get(persona)||[]);
  const liveHistory=persona=>roleJobs(persona).map(j=>({key:j.key,text:api.extractText(j.msg),answer:j.answer,vision:j.vision,phase:j.phase,at:j.at,textConfirmed:j.textConfirmed,media:j.media,mediaConfirmed:j.mediaConfirmed}));
  const modelUser=persona=>scope.modelUser(cred.userId,persona);
  const sync=async(persona=activePersona)=>{
    scope.assertPersona(persona);
    const h=history(persona),uid=modelUser(persona);await syncConfirmedHistory(uid,h);let scene=null;
    if(historyExclusions.get(persona)?.length)await resetScene(uid);
    for(let i=0;i+1<h.length;i+=2){if(analyzeTurn(h[i].content,scene).mode==='new')scene=createScene(h[i].content);else recordUserTurn(scene,h[i].content);recordReply(scene,h[i+1].content);}
    if(scene)await saveScene(uid,scene);
  };
  await sync();
  try{await api.notifyStart(cred.baseUrl,cred.token);}catch{}
  notice('listening','已连接微信 AI 会话，后台监听中；电脑微信无需前台');
  const deps={allowed,notice,confirmed:job=>sync(job.persona||'private_persona'),
    generate:async(msg,job)=>{
      const persona=job.persona||'private_persona';scope.assertPersona(persona);await sync(persona);
      for(const [key,mood] of Object.entries(MOODS))mood.tone=persona==='private_persona'?'按她最近两年的真实表达范例接话，可以熟人式反问吐槽，不强行温柔、撒娇或擅加亲昵称呼，不编造现实行踪。':originalTones[key];
      state.cfg={...loadConfig(),proactive:false,allowStickers:false,imageGenEnabled:false,autoImageEnabled:false,sendTyping:false,showQueuedNotice:false,desktopNaturalReplies:true,maxBubbles:1,bubbleSplit:false,kaomojiChance:0,emojiChance:0,lifeEnabled:false,ragEnabled:false,sceneAnalyzeModel:false,defianceChance:0};
      state.cfg.defaultPersona=persona;
      const options=JSON.parse(await python('companion_memory.py',[],JSON.stringify({persona,text:api.extractText(msg)||'收到图片',owner:scope.memoryOwner(id),history:liveHistory(persona)})));
      historyExclusions.set(persona,options.suppressed_history_keys||[]);await sync(persona);
      state.desktopStyleContext=options.context;
      state.desktopStyleContext+='\n【当前能力】可以理解普通图片，可从当前角色的候选素材中发表情或用户明确索要的图片。不能看到图片以外的环境，目前没有生图或自拍能力。识图失败如实说明，不编造图片内容。';
      if(options.candidates?.length)state.desktopStyleContext+='\n【本轮可发送素材】最多选一个，只能用以下ID；需要时在回复结尾单独加一行[sticker:素材ID]，这个标记会实际发送原媒体，不要把ID说给用户。普通照片只在明确索要时发送，表情不必每轮都发。\n'+JSON.stringify(options.candidates);
      else state.desktopStyleContext+='\n本轮没有合适的发图候选，请只用文字，不承诺已发图。';
      let answer='';const prepared=new Error('REPLY_PREPARED');
      state.desktopTransport={sendText:async()=>{throw Error('模型未生成正常回复');},sendBubbles:async(_uid,bubbles)=>{answer=bubbles.join('\n\n').trim();throw prepared;}};
      try{await handleWithDsh(state,{...msg,from_user_id:modelUser(persona)},api.extractText(msg));}catch(e){if(e!==prepared)throw e;}
      if(!answer)answer=options.intent&&options.candidates?.length?'给你来一张':'在呢';
      return {text:answer,media:selectMedia(state.companionRequestedMedia,options),vision:state.companionVision||'',evidence:options.evidence||[]};
    },
    prepare:async(job,checkpoint)=>{
      scope.assertPersona(job.persona||'private_persona');
      job.uploads??=[];
      if(!job.media?.length)return;
      const catalogName=(job.persona||'private_persona')==='private_persona'?'media-catalog.json':`media-catalog-${job.persona}.json`;
      const privateCatalog=path.join(LOCAL,'private',job.persona||'private_persona','media-catalog.json');
      const catalog=JSON.parse(fs.readFileSync(fs.existsSync(privateCatalog)?privateCatalog:path.join(LOCAL,'data',catalogName),'utf8'));
      if(catalog.builtin)catalog.source_root=ROOT;
      for(const selected of job.media){
        if(job.uploads.some(u=>u.id===selected.id))continue;
        if(!allowed())return;
        const item=resolveMedia(selected.id,catalog),uploaded=await uploadMedia(cred.baseUrl,cred.token,cred.userId,item.file,api.UPLOAD_MEDIA_TYPE.IMAGE);
        job.uploads.push({id:item.id,item:buildImageItem(uploaded.encryptQueryParam,uploaded.aesKeyHex,uploaded.cipherSize)});checkpoint();
      }
    },
    send:async(answer,msg,job,checkpoint)=>{
      if(!msg.context_token)throw Error('消息缺少会话凭据');
      return deliver(job,msg,{allowed,checkpoint,send:async items=>{
        const result=await api.sendMessage(cred.baseUrl,cred.token,msg.from_user_id,msg.context_token,items);
        return {accepted:true,ret:result.ret??null,errcode:result.errcode??null};
      }});
    }
  };
  let backoff=1000;
  while(allowed()){
    const persona=currentPersona();
    if(persona!==activePersona){activePersona=persona;queue.activate(persona);await sync(persona);}
    const job=queue.next();
    if(job){await processJob(queue,job,deps);continue;}
    try{
      const r=await api.getUpdates(cred.baseUrl,cred.token,queue.data.cursor,undefined,40000);
      queue.receive(r.msgs||[],r.get_updates_buf,currentPersona());backoff=1000;
      notice('listening','已连接微信 AI 会话，后台监听中；电脑微信无需前台');
    }catch(e){
      if(api.isSessionExpired(e)){
        await python('ilink_bot.py',['--credential-clear']);notice('auth_expired','微信授权已失效，请点击启动 / 重启重新扫码');return;
      }
      notice('reconnecting','微信连接暂时中断，正在重连');await delay(backoff);backoff=Math.min(30000,backoff*2);continue;
    }
  }
  try{await api.notifyStop(cred.baseUrl,cred.token);}catch{}
  notice('stopped','已停止回复，未发送的任务已保存');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  if(errorStatusFile)writeJson(errorStatusFile,{state:error.authConflict?'auth_conflict':error.needsVerification?'needs_verification':'error',detail:String(error.message).replace(/sk-[\w-]+/g,'[密钥已隐藏]'),at:Date.now()/1000,transport:'ilink',runId:process.env.WX_COMPANION_RUN_ID,accountRevision:process.env.WX_ILINK_ACCOUNT_REVISION||''});
  console.error('iLink工作进程停止：',error.message);process.exitCode=1;
});
