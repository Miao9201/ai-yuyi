(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  let loaded=false,busy=false;
  const list=value=>value.split(/[\s,，;；]+/).filter(Boolean);
  function fields(config){
    el('qqEnabled').checked=config.enabled;el('qqWechatEnabled').checked=config.wechatEnabled;
    el('qqPrivateUsers').value=config.privateUsers.join('\n');el('qqGroups').value=config.groups.join('\n');
    el('qqPersona').value=config.persona;
    el('qqProbability').value=Math.round(config.probability*100);el('qqCooldown').value=config.cooldownSeconds;
    el('qqMaxPerMinute').value=config.maxPerMinute;el('qqKeywords').value=config.keywords.join('，');
    el('qqQuietStart').value=config.quietHours[0];el('qqQuietEnd').value=config.quietHours[1];
  }
  async function load(){
    const [result,roles]=await Promise.all([api('/api/qq/config'),api('/api/personas')]);
    const select=el('qqPersona');select.replaceChildren();
    for(const role of roles.items){const option=document.createElement('option');option.value=role.name;option.textContent=role.title||role.name;select.append(option);}
    fields(result.config);loaded=true;
  }
  async function status(){
    try{
      const data=await api('/api/qq/state'),worker=data.worker;
      const identity=data.loggedIn?(data.nickname||data.bot)+' ('+data.bot+')':'未登录';
      el('qqOverview').textContent='QQ · '+identity+' · '+(worker?.detail||data.detail);
      el('qqStatus').textContent=(worker?.detail||data.detail)+(data.loggedIn?' · '+identity:'');
      if(data.loggedIn)el('qqQrPanel').hidden=true;
    }catch{el('qqOverview').textContent='QQ · 状态暂不可用';}
  }
  async function action(button,task){
    if(busy)return;busy=true;button.disabled=true;
    try{await task();}catch(error){toast(error.message,true);}finally{busy=false;button.disabled=false;}
  }
  el('qqSaveUsers').onclick=()=>action(el('qqSaveUsers'),async()=>{
    await post('/api/qq/config',{enabled:el('qqEnabled').checked,wechatEnabled:el('qqWechatEnabled').checked,
      privateUsers:list(el('qqPrivateUsers').value),groups:list(el('qqGroups').value),persona:el('qqPersona').value});
    toast('已保存平台和回复对象');await status();
  });
  el('qqSaveParameters').onclick=()=>action(el('qqSaveParameters'),async()=>{
    await post('/api/qq/config',{probability:Number(el('qqProbability').value)/100,cooldownSeconds:Number(el('qqCooldown').value),maxPerMinute:Number(el('qqMaxPerMinute').value),keywords:list(el('qqKeywords').value),quietHours:[Number(el('qqQuietStart').value),Number(el('qqQuietEnd').value)]});
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
  async function visible(){
    if(['#accounts','#config','#overview',''].includes(location.hash)){
      try{if(!loaded)await load();await status();}catch(error){toast(error.message,true);}
    }
  }
  window.addEventListener('hashchange',visible);visible();
  setInterval(()=>{if(['#accounts','#overview',''].includes(location.hash))status();},7000);
})();
