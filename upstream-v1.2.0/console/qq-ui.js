(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  let loaded=false,busy=false;
  for(const id of ['qqSaveUsers','qqSaveParameters','wechatSave'])el(id).disabled=true;
  const list=value=>value.split(/[\s,，;；]+/).filter(Boolean);
  function fields(config){
    el('qqEnabled').checked=config.enabled;
    el('qqPrivateUsers').value=config.privateUsers.join('\n');el('qqGroups').value=config.groups.join('\n');
    el('qqPersona').value=config.persona;el('qqGroupPersona').value=config.groupPersona;
    el('qqProbability').value=Math.round(config.probability*100);el('qqCooldown').value=config.cooldownSeconds;
    el('qqMaxPerMinute').value=config.maxPerMinute;el('qqKeywords').value=config.keywords.join('，');
    el('qqQuietStart').value=config.quietHours[0];el('qqQuietEnd').value=config.quietHours[1];
    el('qqActiveStart').value=config.activeHours[0];el('qqActiveEnd').value=config.activeHours[1];el('qqEmotionAware').checked=config.emotionAware;
    for(const [field,key] of [['qqVisionEnabled','visionEnabled'],['qqSceneEnabled','sceneEnabled'],['qqEmotionEnabled','emotionEnabled']])el(field).checked=config.replyOptions[key];
  }
  async function load(){
    loaded=false;
    for(const id of ['qqSaveUsers','qqSaveParameters','wechatSave'])el(id).disabled=true;
    const [result,roles,wechat]=await Promise.all([api('/api/qq/config'),api('/api/personas'),api('/api/wechat/config')]);
    el('wechatEnabled').checked=wechat.config.enabled;
    const select=el('qqPersona');select.replaceChildren();
    const validRoles=roles.items.filter(r=>/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(r.name));
    for(const role of validRoles){const option=document.createElement('option');option.value=role.name;option.textContent=role.title||role.name;select.append(option);}
    const group=el('qqGroupPersona');group.replaceChildren();
    for(const role of validRoles.filter(r=>!r.isPrivate)){const option=document.createElement('option');option.value=role.name;option.textContent=role.title||role.name;group.append(option);}
    fields(result.config);loaded=true;
    for(const id of ['qqSaveUsers','qqSaveParameters','wechatSave'])el(id).disabled=false;
  }
  async function status(){
    try{
      const [global,settings]=await Promise.all([api('/api/state'),api('/api/qq/config')]),data=global.qq||{},worker=data.worker;
      const identity=data.loggedIn?(data.nickname||data.bot)+' ('+data.bot+')':'未登录';
      const detail=!settings.config.enabled?'未启用':!global.enabled?'已停止回复':worker?.detail||data.detail;
      const title=name=>[...el('qqPersona').options].find(o=>o.value===name)?.textContent||name;
      el('qqOverview').textContent='QQ · '+identity+' · '+detail+' · 私聊人设：'+title(settings.config.persona)+' · 群聊人设：'+title(settings.config.groupPersona);
      el('qqStatus').textContent=detail+(data.loggedIn?' · '+identity:'');
      if(data.loggedIn)el('qqQrPanel').hidden=true;
    }catch{el('qqOverview').textContent='QQ · 状态暂不可用';el('qqStatus').textContent='状态暂不可用，请刷新';}
  }
  async function action(button,task){
    if(busy)return;busy=true;button.disabled=true;
    try{await task();}catch(error){toast(error.message,true);}finally{busy=false;button.disabled=false;}
  }
  el('qqSaveUsers').onclick=()=>action(el('qqSaveUsers'),async()=>{
    await post('/api/qq/config',{enabled:el('qqEnabled').checked,
      privateUsers:list(el('qqPrivateUsers').value),groups:list(el('qqGroups').value),persona:el('qqPersona').value,groupPersona:el('qqGroupPersona').value});
    toast('已保存平台和回复对象');await status();
  });
  el('qqSaveParameters').onclick=()=>action(el('qqSaveParameters'),async()=>{
    await post('/api/qq/config',{probability:Number(el('qqProbability').value)/100,cooldownSeconds:Number(el('qqCooldown').value),maxPerMinute:Number(el('qqMaxPerMinute').value),keywords:list(el('qqKeywords').value),quietHours:[Number(el('qqQuietStart').value),Number(el('qqQuietEnd').value)],activeHours:[Number(el('qqActiveStart').value),Number(el('qqActiveEnd').value)],emotionAware:el('qqEmotionAware').checked,replyOptions:{visionEnabled:el('qqVisionEnabled').checked,sceneEnabled:el('qqSceneEnabled').checked,emotionEnabled:el('qqEmotionEnabled').checked}});
    toast('已保存QQ接话参数');
  });
  el('qqConfigure').onclick=()=>action(el('qqConfigure'),async()=>{
    await post('/api/qq/configure',{shell:el('qqShellPath').value.trim()});toast('QQ运行目录已保存');await status();
  });
  el('qqLogin').onclick=()=>action(el('qqLogin'),async()=>{
    el('qqStatus').textContent='正在生成二维码…';const result=await post('/api/qq/login',{});
    if(!result.loggedIn){el('qqQrImage').src='/api/qq/qr?v='+Date.now();el('qqQrPanel').hidden=false;}
    await status();
  });
  el('qqRefresh').onclick=()=>action(el('qqRefresh'),async()=>{await load();await status();});
  el('wechatSave').onclick=()=>action(el('wechatSave'),async()=>{await post('/api/wechat/config',{enabled:el('wechatEnabled').checked});toast('已保存微信开关');});
  async function visible(){
    if(['#accounts','#config','#overview',''].includes(location.hash)){
      try{if(!loaded||['#accounts','#config'].includes(location.hash))await load();await status();}catch(error){toast(error.message,true);}
    }
  }
  window.addEventListener('hashchange',visible);visible();
  window.addEventListener('personaschange',()=>{loaded=false;});
  setInterval(()=>{if(['#accounts','#overview',''].includes(location.hash))status();},7000);
})();
