(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  let loaded=false,busy=false,rolesByName=new Map(),loadVersion=0;
  const saveIds=['qqSaveUsers','qqSaveParameters','wechatSave','qqPersonaSave','qqHoursAll','qqHoursNone'];
  for(const id of saveIds)el(id).disabled=true;
  const list=value=>value.split(/[\s,，;；]+/).filter(Boolean);
  let hours=new Set(),drag=null;
  const bar=el('qqHourBar'),clock=value=>String(value).padStart(2,'0')+':00';
  const cells=Array.from({length:24},(_,hour)=>{
    const cell=document.createElement('button');cell.type='button';cell.className='hour-cell';cell.disabled=true;cell.dataset.hour=String(hour);cell.textContent=String(hour);
    cell.onclick=event=>{if(loaded&&event.detail===0){hours.has(hour)?hours.delete(hour):hours.add(hour);renderHours();}};
    bar.appendChild(cell);return cell;
  });
  function renderHours(){
    for(let hour=0;hour<24;hour++){
      cells[hour].disabled=!loaded;cells[hour].setAttribute('aria-pressed',String(hours.has(hour)));
      cells[hour].setAttribute('aria-label',clock(hour)+'–'+clock(hour+1)+' '+(hours.has(hour)?'活跃':'安静'));
    }
    const ranges=[];let start=null;
    for(let hour=0;hour<=24;hour++){
      if(hour<24&&hours.has(hour)){if(start===null)start=hour;}
      else if(start!==null){ranges.push(clock(start)+'–'+clock(hour));start=null;}
    }
    el('qqHoursSummary').textContent=hours.size===24?'全天活跃':hours.size===0?'全天安静':'活跃：'+ranges.join('、')+'；其余安静';
  }
  function loadHours(config){
    const within=(hour,[start,end],equal)=>start===end?equal:start<end?hour>=start&&hour<end:hour>=start||hour<end;
    hours=new Set(Array.isArray(config.activeHourSlots)?config.activeHourSlots:Array.from({length:24},(_,hour)=>hour).filter(hour=>within(hour,config.activeHours||[0,24],true)&&!within(hour,config.quietHours||[0,7],false)));
    el('qqHoursLegacy').hidden=Array.isArray(config.activeHourSlots);renderHours();
  }
  const pointedHour=event=>{const rect=bar.getBoundingClientRect();return Math.max(0,Math.min(23,Math.floor((event.clientX-rect.left)*24/rect.width)));};
  bar.onpointerdown=event=>{
    if(!loaded||event.button!==0)return;event.preventDefault();
    const hour=pointedHour(event);drag={id:event.pointerId,on:!hours.has(hour),last:hour};bar.setPointerCapture(event.pointerId);
    drag.on?hours.add(hour):hours.delete(hour);renderHours();
  };
  bar.onpointermove=event=>{
    if(!drag||event.pointerId!==drag.id)return;
    const hour=pointedHour(event);for(let i=Math.min(hour,drag.last);i<=Math.max(hour,drag.last);i++)drag.on?hours.add(i):hours.delete(i);
    drag.last=hour;renderHours();
  };
  bar.onpointerup=event=>{if(drag&&event.pointerId===drag.id){drag=null;bar.releasePointerCapture(event.pointerId);}};
  bar.onpointercancel=bar.onlostpointercapture=()=>{drag=null;};
  el('qqHoursAll').onclick=()=>{if(loaded){hours=new Set(Array.from({length:24},(_,i)=>i));renderHours();}};
  el('qqHoursNone').onclick=()=>{if(loaded){hours.clear();renderHours();}};
  function fields(config){
    el('qqEnabled').checked=config.enabled;
    el('qqPrivateUsers').value=config.privateUsers.join('\n');el('qqGroups').value=config.groups.join('\n');
    el('qqPersona').value=config.persona;el('qqGroupPersona').value=config.groupPersona;
    el('qqGroupSeparate').checked=!(config.groupFollowsDefault??config.persona===config.groupPersona);
    groupMode();
    el('personaQQStatus').textContent='已保存的默认：'+(rolesByName.get(config.persona)?.title||config.persona);
    if(typeof state!=='undefined'){state.qqPersonaConfig=config;if(typeof renderPersonaList==='function')renderPersonaList();}
    el('qqProbability').value=Math.round(config.probability*100);el('qqCooldown').value=config.cooldownSeconds;
    el('qqMaxPerMinute').value=config.maxPerMinute;el('qqKeywords').value=config.keywords.join('，');
    loadHours(config);el('qqEmotionAware').checked=config.emotionAware;
    for(const [field,key] of [['qqVisionEnabled','visionEnabled'],['qqSceneEnabled','sceneEnabled'],['qqEmotionEnabled','emotionEnabled']])el(field).checked=config.replyOptions[key];
  }
  async function load(){
    const version=++loadVersion;
    loaded=false;drag=null;for(const cell of cells)cell.disabled=true;
    for(const id of saveIds)el(id).disabled=true;
    const [result,roles,wechat]=await Promise.all([api('/api/qq/config'),api('/api/personas'),api('/api/wechat/config')]);
    if(version!==loadVersion)return;
    el('wechatEnabled').checked=wechat.config.enabled;
    const select=el('qqPersona');select.replaceChildren();
    const validRoles=roles.items.filter(r=>/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(r.name));
    rolesByName=new Map(validRoles.map(r=>[r.name,r]));
    for(const role of validRoles){const option=document.createElement('option');option.value=role.name;option.textContent=role.title||role.name;select.append(option);}
    const group=el('qqGroupPersona');group.replaceChildren();
    for(const role of validRoles.filter(r=>!r.isPrivate)){const option=document.createElement('option');option.value=role.name;option.textContent=role.title||role.name;group.append(option);}
    fields(result.config);loaded=true;renderHours();
    for(const id of saveIds)el(id).disabled=false;
  }
  async function status(){
    try{
      const [global,settings]=await Promise.all([api('/api/state'),api('/api/qq/config')]),data=global.qq||{},worker=data.worker;
      if(typeof state!=='undefined'&&state.serviceUnavailable&&typeof loadState==='function')await loadState();
      const identity=data.loggedIn?(data.nickname||data.bot)+' ('+data.bot+')':'未登录';
      const detail=!settings.config.enabled?'未启用':!global.enabled?'已停止回复':!data.loggedIn?(data.detail||'请扫码并在手机确认登录'):worker?.detail||data.detail;
      const title=name=>[...el('qqPersona').options].find(o=>o.value===name)?.textContent||name;
      el('qqOverview').textContent=!settings.config.enabled?'未启用':!global.enabled?'已停止':data.loggedIn?(worker?.state==='listening'?'已连接':worker?.state==='generating'?'正在回复':'连接中'):'待登录';
      el('qqOverviewAccount').textContent=data.loggedIn?(data.nickname||'已登录QQ'):'未登录';
      el('qqOverviewPersona').textContent=title(settings.config.persona);
      el('qqOverviewGroup').textContent=(settings.config.groupFollowsDefault??settings.config.persona===settings.config.groupPersona)?'跟随默认':title(settings.config.groupPersona)+'（单独指定）';
      el('qqOverviewScope').textContent='私聊 '+settings.config.privateUsers.length+' 个 · 群聊 '+settings.config.groups.length+' 个';
      el('qqOverviewDetails').textContent=(data.bot?'QQ号：'+data.bot+'\n':'')+detail;
      el('qqUserPersonas').textContent='QQ默认：'+title(settings.config.persona)+'；群聊：'+((settings.config.groupFollowsDefault??settings.config.persona===settings.config.groupPersona)?'跟随默认':title(settings.config.groupPersona));
      el('qqStatus').textContent=detail+(data.loggedIn?' · '+identity:'');
      if(data.loggedIn)el('qqQrPanel').hidden=true;
    }catch{if(typeof markServiceUnavailable==='function')markServiceUnavailable();el('qqOverview').textContent='QQ · 状态暂不可用';el('qqStatus').textContent='状态暂不可用，请刷新';}
  }
  async function action(button,task){
    if(busy)return;busy=true;button.disabled=true;++loadVersion;
    try{await task();}catch(error){toast(error.message,true);}finally{busy=false;button.disabled=saveIds.includes(button.id)&&!loaded;}
  }
  el('qqSaveUsers').onclick=()=>action(el('qqSaveUsers'),async()=>{
    await post('/api/qq/config',{enabled:el('qqEnabled').checked,
      privateUsers:list(el('qqPrivateUsers').value),groups:list(el('qqGroups').value)});
    toast('已保存平台和回复对象');await status();
  });
  el('qqSaveParameters').onclick=()=>action(el('qqSaveParameters'),async()=>{
    await post('/api/qq/config',{probability:Number(el('qqProbability').value)/100,cooldownSeconds:Number(el('qqCooldown').value),maxPerMinute:Number(el('qqMaxPerMinute').value),keywords:list(el('qqKeywords').value),activeHourSlots:[...hours].sort((a,b)=>a-b),emotionAware:el('qqEmotionAware').checked,replyOptions:{visionEnabled:el('qqVisionEnabled').checked,sceneEnabled:el('qqSceneEnabled').checked,emotionEnabled:el('qqEmotionEnabled').checked}});
    el('qqHoursLegacy').hidden=true;
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
  function groupMode(){
    if(rolesByName.get(el('qqPersona').value)?.isPrivate)el('qqGroupSeparate').checked=true;
    el('qqGroupBlock').hidden=!el('qqGroupSeparate').checked;
    if(!el('qqGroupSeparate').checked)el('qqGroupPersona').value=el('qqPersona').value;
  }
  el('qqPersona').onchange=groupMode;el('qqGroupSeparate').onchange=groupMode;
  el('qqPersonaSave').onclick=()=>action(el('qqPersonaSave'),async()=>{
    groupMode();
    await post('/api/qq/config',{persona:el('qqPersona').value,groupPersona:el('qqGroupSeparate').checked?el('qqGroupPersona').value:el('qqPersona').value,groupFollowsDefault:!el('qqGroupSeparate').checked});
    await load();await status();if(typeof loadPersonas==='function')await loadPersonas(undefined,true);toast('已保存QQ默认人设');
  });
  async function visible(){
    if(['#accounts','#config','#overview','#personas',''].includes(location.hash)){
      try{if(!loaded||['#accounts','#config','#personas'].includes(location.hash))await load();await status();}catch(error){toast(error.message,true);}
    }
  }
  window.addEventListener('hashchange',visible);visible();
  window.addEventListener('personaschange',()=>{loaded=false;if(location.hash==='#personas')visible();});
  setInterval(()=>{if(['#accounts','#overview',''].includes(location.hash))status();},7000);
})();
