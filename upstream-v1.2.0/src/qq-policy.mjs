const account=value=>typeof value==='string'&&/^[1-9]\d{4,11}$/.test(value);
const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,60);

export function normalizeEvent(event,bot){
  if(!event||event.post_type!=='message'||String(event.self_id)!==bot||!account(bot))return null;
  const sender=String(event.user_id),kind=event.message_type;
  if(!account(sender)||sender===bot||!['private','group'].includes(kind))return null;
  const peer=kind==='group'?String(event.group_id):sender;
  if(!account(peer)||event.message_id===undefined||!/^[-\d]{1,21}$/.test(String(event.message_id))||!Number.isFinite(event.time))return null;
  const segments=Array.isArray(event.message)?event.message:[{type:'text',data:{text:String(event.message??'')}}];
  if(segments.length>100)return null;
  const text=segments.filter(s=>s?.type==='text').map(s=>String(s.data?.text??'')).join('').trim().slice(0,4000);
  const mentions=segments.filter(s=>s?.type==='at').map(s=>String(s.data?.qq));
  return {key:String(event.message_id),bot,kind,peer,sender,senderName:clean(event.sender?.card||event.sender?.nickname||sender),
    scope:`qq:${bot}:${kind}:${peer}`,text,at:event.time*1000,mentioned:mentions.includes(bot),atAll:mentions.includes('all'),
    replyTo:segments.find(s=>s?.type==='reply')?.data?.id,images:segments.filter(s=>s?.type==='image').slice(0,3).map(s=>({file:String(s.data?.file??''),url:String(s.data?.url??''),summary:clean(s.data?.summary)}))};
}

export class ReplyPolicy {
  constructor(){this.sent=new Map();}
  markSent(scope,now=Date.now()){
    const recent=(this.sent.get(scope)||[]).filter(t=>now-t<300000);recent.push(now);this.sent.set(scope,recent);
  }
  decide(msg,cfg,{now=Date.now(),hour=new Date(now).getHours(),random=Math.random}={}){
    const no=reason=>({reply:false,reason});
    if(!msg||!cfg[msg.kind==='private'?'privateUsers':'groups']?.includes(msg.peer))return no('not_allowed');
    if(msg.at>now+60000||now-msg.at>180000)return no('stale');
    if(!msg.text&&!msg.images.length&&!msg.mentioned)return no('empty');
    if(msg.kind==='private')return {reply:true,reason:'private'};
    if(msg.atAll)return no('at_all');
    const recent=(this.sent.get(msg.scope)||[]).filter(t=>now-t<300000);
    if(recent.filter(t=>now-t<60000).length>=(cfg.maxPerMinute??6))return no('density');
    if(recent.length&&now-recent.at(-1)<(cfg.cooldownSeconds??5)*1000)return no('cooldown');
    if(msg.mentioned||msg.repliedToBot||cfg.keywords?.some(k=>msg.text.includes(k)))return {reply:true,reason:'addressed'};
    let probability=cfg.probability??0.1;
    const [start,end]=cfg.quietHours??[0,7];
    if(start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end))probability*=0.15;
    const quality=msg.text.length<3||/^(哈+|[6好哦嗯啊]+)[!！。]*$/.test(msg.text)?0.1:/[?？]/.test(msg.text)?1.5:1;
    const attention=recent.length&&now-recent.at(-1)<120000?1.5:1;
    const fatigue=1/(1+recent.length*0.2);
    return {reply:random()<Math.min(1,Math.max(0,probability*quality*attention*fatigue)),reason:'probability'};
  }
}
