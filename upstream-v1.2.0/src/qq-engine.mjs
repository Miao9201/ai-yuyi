import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Queue,processJob} from '../ilink-runtime.mjs';
import {normalizeEvent,ReplyPolicy} from './qq-policy.mjs';
import {deliver} from './companion-media.mjs';

const pending=job=>['queued','prepared','generating'].includes(job.phase);
export class QQEngine {
  constructor({directory,bot,config,allowed,generate,prepare,send,confirmed=async()=>{},notice=()=>{},now=Date.now,random=Math.random}){
    Object.assign(this,{directory,bot,config,allowed,generate,prepare,send,confirmed,notice,now,random});
    this.queues=new Map();this.policy=new ReplyPolicy();this.busy=false;
    const cfg=config();
    for(const [kind,peers] of [['private',cfg.privateUsers],['group',cfg.groups]])for(const peer of peers||[]){
      const scope=`qq:${bot}:${kind}:${peer}`;
      if(fs.existsSync(this.file(scope))){
        const queue=this.queue({scope});
        if(kind==='group'){
          // Group replies belong to the current connection, even after a brief stop.
          for(const job of queue.data.jobs)if(pending(job)){job.phase='cancelled';job.error='群聊连接已更新，不补发旧消息';}
          queue.data.room=[];queue.save();
        }
      }
    }
  }
  file(scope){return path.join(this.directory,createHash('sha256').update(scope).digest('hex').slice(0,32)+'.json');}
  persona(msg,cfg){return msg.kind==='group'?cfg.groupPersona:(cfg.privatePersonas?.[msg.peer]||cfg.persona);}
  queue(msg){
    if(!this.queues.has(msg.scope)){
      const file=this.file(msg.scope);
      const queue=new Queue(file,msg.scope);this.queues.set(msg.scope,queue);
      for(const job of queue.data.jobs)if(job.sentAt)this.policy.markSent(msg.scope,job.sentAt);
    }
    return this.queues.get(msg.scope);
  }
  receive(event){
    const cfg=this.config(),msg=normalizeEvent(event,this.bot);
    if(!this.allowed()||!cfg.enabled||!msg||!cfg[msg.kind==='private'?'privateUsers':'groups']?.includes(msg.peer))return false;
    if(this.now()-msg.at>180000||msg.at>this.now()+60000)return false;
    const queue=this.queue(msg),received=queue.data.received||[];
    if(received.includes(msg.key))return false;
    queue.data.received=[...received,msg.key].slice(-1000);
    if(msg.kind==='group'){
      msg.repliedToBot=queue.data.jobs.some(j=>j.textConfirmed&&String(j.receipt?.message_id)===String(msg.replyTo));
      queue.data.room=[...(queue.data.room||[]),{sender:msg.sender,nickname:msg.senderName,text:msg.text||'[图片]'}].slice(-20);
    }
    // Record even messages that did not trigger, so replay cannot reroll probability.
    queue.save();
    if(!this.policy.decide(msg,cfg,{now:this.now(),random:this.random}).reply)return false;
    const active=queue.data.jobs.filter(pending);
    if(active.length>=(msg.kind==='group'?1:3))return false;
    const text=(msg.kind==='group'?`${msg.senderName}(${msg.sender}): `:'')+(msg.text||'');
    const input={message_type:1,from_user_id:msg.scope,message_id:msg.key,create_time_ms:msg.at,qq:msg,
      item_list:[{type:1,text_item:{text}},...msg.images.map(image=>({type:2,image_item:{media:{full_url:'qq-image://inbound'}},qqImage:image}))]};
    if(msg.kind==='group')input.qqRoom=queue.data.room||[];
    queue.receive([input],'',this.persona(msg,cfg));
    queue.data.jobs=queue.data.jobs.filter(j=>pending(j)||queue.data.jobs.indexOf(j)>=queue.data.jobs.length-100);
    queue.save();return true;
  }
  async tick(){
    if(this.busy||!this.allowed())return false;this.busy=true;
    try{
      for(const queue of this.queues.values()){
        const cfg=this.config(),first=queue.data.jobs.find(pending);
        if(!first)continue;
        const msg=first.msg.qq,persona=this.persona(msg,cfg);
        queue.activate(persona);
        const job=queue.next();if(!job)continue;
        const allowed=()=>{const current=this.config();return this.allowed()&&current.enabled&&current[msg.kind==='group'?'groups':'privateUsers'].includes(msg.peer)&&job.persona===this.persona(msg,current);};
        if(!allowed()||(msg.kind==='group'&&this.now()-job.msg.qq.at>180000)){
          job.phase='cancelled';queue.save();continue;
        }
        if(msg.kind==='group'&&!this.policy.decide({...job.msg.qq,mentioned:true},cfg,{now:this.now()}).reply){job.phase='cancelled';queue.save();continue;}
        await processJob(queue,job,{allowed,notice:(state,detail,j)=>this.notice(state,detail.replaceAll('微信','QQ'),j),
          generate:(input,j)=>this.generate(input,j,queue),
          prepare:this.prepare?(j,checkpoint)=>this.prepare(j,checkpoint):undefined,
          send:async(_answer,input,j,checkpoint)=>deliver(j,input,{allowed,checkpoint,send:items=>this.send(items,input,j)}),
          confirmed:async j=>{this.policy.markSent(msg.scope,this.now());await this.confirmed(j,queue);}});
        return true;
      }
      return false;
    }finally{this.busy=false;}
  }
}
