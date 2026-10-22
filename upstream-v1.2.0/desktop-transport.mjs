// Ordinary-friend adapter. The v1.2 handler prepares replies; Python confirms delivery.
import readline from 'node:readline';
import { format } from 'node:util';
import { createHash } from 'node:crypto';

console.log = (...args) => process.stderr.write(format(...args) + '\n');
console.warn = (...args) => process.stderr.write(format(...args) + '\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const { handleWithDsh } = await import('./src/index.js');
const { loadConfig } = await import('./src/config.js');
const { loadHistory, appendTurn, syncConfirmedHistory } = await import('./src/memory.js');
const { MOODS } = await import('./src/emotion.js');
const { loadScene,saveScene,resetScene,createScene,analyzeTurn,recordUserTurn,recordReply } = await import('./src/scene.js');

// Keep the new persistent emotion logic, without importing Lin Muwan's speech habits.
const tones = {
  calm:'日常平静，短句接话，保持人物原来的用词与标点。',
  happy:'自然轻快一点，保持参考对话里的表达，不突然撒娇。',
  clingy:'关系亲近时自然接话，沿用原来的称呼和分寸，不擅自加宝宝或哥哥。',
  shy:'有点不好意思，可以简短回应，保持人物自己的措辞。',
  tired:'句子稍短，直接表达累了，不故作冷漠。',
  bored:'有点无聊，可以顺着对方的话聊，不编造现实中的行踪。',
  annoyed:'简短表达不满，避免长篇说教、威胁或情绪勒索。',
  hurt:'自然表达失落，不套用撒娇台词或逼迫对方安慰。',
  confused:'没听懂就简短问清，保持人物的日常语气。'
};
for (const [mood,tone] of Object.entries(tones)) MOODS[mood].tone=tone;

const uid='desktop:user';
let active=null;
const state={cred:{},contextTokens:new Map(),handled:0,cfg:{}};
state.desktopTransport={
  sendText: async (_user,text) => { throw new Error(String(text).slice(0,220)); },
  sendBubbles: async (_user,bubbles) => {
    const text=bubbles.join('\n\n').trim();
    if (!active || !text || text.length>500) throw new Error('回复为空或过长，没有发送');
    await new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('发送确认超时')),120000);
      active.confirm=ok=>{clearTimeout(timer);ok?resolve():reject(new Error('DELIVERY_ABORTED'));};
      emit({type:'prepared',id:active.id,engine:'wx-bridge-v1.2.0',bubbles});
    });
  }
};

function configForDesktop(){
  const cfg=loadConfig();
  return {...cfg,taskTimeoutMs:Math.min(45000,Math.max(1000,Number(cfg.taskTimeoutMs)||45000)),sendTyping:false,showQueuedNotice:false,
    proactive:false,allowStickers:false,imageGenEnabled:false,autoImageEnabled:false,
    visionEnabled:false,desktopNaturalReplies:true,maxBubbles:1,bubbleSplit:false,
    kaomojiChance:0,emojiChance:0,sceneAnalyzeModel:false};
}

async function syncConfirmedScene(history){
  const h=history.slice(-12);
  if(!h.length){await resetScene(uid);state.desktopSceneDirty=false;return;}
  const key=createHash('sha256').update(JSON.stringify(h)).digest('hex');
  const existing=await loadScene(uid);
  if(!state.desktopSceneDirty && existing?.desktopHistoryKey===key)return;
  let scene=null;
  for(let i=0;i+1<h.length;i+=2){
    const q=h[i].content,a=h[i+1].content;
    if(analyzeTurn(q,scene).mode==='new')scene=createScene(q);
    else recordUserTurn(scene,q);
    recordReply(scene,a);
  }
  scene.desktopHistoryKey=key;await saveScene(uid,scene);state.desktopSceneDirty=false;
}

async function handle(request){
  try {
    if(request.op==='sync'){
      await syncConfirmedHistory(uid,request.history);
      await syncConfirmedScene(request.history);
      emit({type:'done',id:request.id});return;
    }
    if(request.op==='seed'){
      if(!(await loadHistory(uid)).length){
        const h=request.history||[];
        for(let i=0;i+1<h.length;i+=2){
          if(h[i].role==='user' && h[i+1].role==='assistant') await appendTurn(uid,h[i].content,h[i+1].content);
        }
      }
      emit({type:'done',id:request.id});return;
    }
    if(request.op!=='generate') throw new Error('未知操作');
    active={id:request.id,confirm:null};
    state.cfg=configForDesktop();
    state.desktopStyleContext='【当前收发能力】只能收发文字。用户消息中的[图片或表情：内容不可识别]表示确实收到了媒体，只是看不到里面的内容。自然确认收到，如实说明当前只能看文字；不要猜图中内容，不要说没收到，也不要承诺能发表情包或看图。\n'+String(request.context||'');
    await handleWithDsh(state,{from_user_id:uid,item_list:[]},String(request.text||''));
    emit({type:'done',id:request.id});
  }catch(error){
    emit({type:error.message==='DELIVERY_ABORTED'?'aborted':'error',id:request.id,error:error.message});
  }finally{if(request.op==='generate')state.desktopSceneDirty=true;active=null;}
}

let chain=Promise.resolve();
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
  let request;
  try{request=JSON.parse(line);}catch{emit({type:'error',error:'Invalid JSON'});return;}
  if(request.op==='ack'){
    if(active && active.id===request.id && active.confirm) active.confirm(request.ok===true);
    return;
  }
  if(active){emit({type:'error',id:request.id,error:'上一轮还没有确认'});return;}
  chain=chain.then(()=>handle(request));
});
input.on('close',()=>{
  if(active?.confirm) active.confirm(false);
  chain.finally(()=>process.exit(0));
});
emit({type:'ready',engine:'wx-bridge-v1.2.0',features:['scene','emotion','forget','memory']});
