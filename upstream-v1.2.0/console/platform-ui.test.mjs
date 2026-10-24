import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the shipped scripts with synthetic API responses; never start a server or a bot.
const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const main=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const qq=fs.readFileSync(new URL('./qq-ui.js',import.meta.url),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};

async function browser({full=false,fail=[]}={}){
  const nodes=new Map(),events=new Map(),requests=[],failures=new Set(fail),timers=[],gates=new Map();
  const response=(path,value)=>{const gate=gates.get(path);if(gate){gates.delete(path);return gate.then(()=>value);}return value;};
  class Element{
    constructor(tag='div',id=''){this.tagName=tag.toUpperCase();this.id=id;this.children=[];this.dataset={};this.style={};this.checked=false;this.disabled=false;this.hidden=false;this._value='';this.textContent='';this.classList={add(){},remove(){},toggle(){}};}
    get value(){return this.tagName==='SELECT'?(this.children.find(x=>x.value===this._value)?.value||''):this._value;}
    get options(){return this.children;}
    set value(value){this._value=String(value);}
    append(...children){for(const child of children){this.children.push(child);if(this.tagName==='SELECT'&&this.children.length===1)this._value=child.value;}}
    appendChild(child){this.append(child);return child;}
    replaceChildren(...children){this.children=[];this._value='';this.append(...children);}
    addEventListener(){}
    setAttribute(key,value){this[key]=value;}
    getAttribute(key){return this[key];}
    focus(){}
    remove(){}
    click(){if(!this.disabled)return this.onclick?.();}
    set innerHTML(markup){
      this._html=markup;
      for(const match of markup.matchAll(/<(input|textarea|select)\b([^>]*\bid="([^"]+)"[^>]*)>(?:([\s\S]*?)<\/\1>)?/g)){
        const [,tag,attrs,id,body='']=match,node=new Element(tag,id);nodes.set(id,node);
        node.checked=/\bchecked\b/.test(attrs);node.value=attrs.match(/\bvalue="([^"]*)"/)?.[1]||'';
        if(tag==='textarea')node.value=body;
        if(tag==='select')for(const opt of body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)){
          const child=new Element('option');child.value=opt[1].match(/value="([^"]*)"/)?.[1]||opt[2];node.append(child);
          if(/\bselected\b/.test(opt[1]))node.value=child.value;
        }
      }
    }
    get innerHTML(){return this._html||'';}
  }
  for(const match of html.slice(0,html.indexOf('<script>')).matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g))nodes.set(match[2],new Element(match[1],match[2]));
  const nav=[...html.matchAll(/<button data-tab="([^"]+)"/g)].map(m=>{const button=new Element('button');button.dataset.tab=m[1];return button;});
  const document={body:new Element('body'),title:'',getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element(tag),querySelector:selector=>selector.startsWith('#')?nodes.get(selector.slice(1))||null:nav.find(b=>selector==='nav button[data-tab="'+b.dataset.tab+'"]')||null,querySelectorAll:selector=>selector==='nav button'?nav:selector==='main > section'?[...nodes.values()].filter(n=>n.id.startsWith('tab-')):[]};
  const data={
    qq:{enabled:true,wechatEnabled:true,privateUsers:['100001'],groups:['200001'],persona:'dafeiyu',groupPersona:'dafeiyu',probability:.1,cooldownSeconds:5,maxPerMinute:6,keywords:['大肥鱼'],quietHours:[0,7],activeHours:[0,24],emotionAware:true,replyOptions:{visionEnabled:true,sceneEnabled:true,emotionEnabled:true}},
    roles:[{name:'dafeiyu',title:'大肥鱼'},{name:'private_fixture',title:'私人人设',isPrivate:true}],
    wechat:{enabled:true},
    state:{enabled:true,platforms:{wechat:true,qq:true},bot:{running:true},desktop:{transport:'ilink',detail:'微信已连接'},personas:{count:2,current:'linmuwan'},config:{model:'fixture'}},
    worker:{loggedIn:true,bot:'100002',nickname:'测试机器人',detail:'QQ已登录',worker:{detail:'QQ已连接，后台监听中'}},
    items:[{key:'sceneEnabled',kind:'bool',value:true},{key:'historyRecentTurns',kind:'number',value:3},{key:'defaultPersona',kind:'string',value:'linmuwan'},{key:'chatModel',kind:'string',value:'fixture'},{key:'chatBaseUrl',kind:'string',value:'https://fixture.invalid/v1'},{key:'chatTemperature',kind:'number',value:.75},{key:'taskTimeoutMs',kind:'number',value:45000},{key:'visionModelDeepseek',kind:'string',value:'fixture-vision'}],
  };
  async function api(path,opts){
    const method=opts?.method||'GET',body=opts?.body?JSON.parse(opts.body):undefined;requests.push({method,path,body});
    if(failures.has(path))throw Error('synthetic unavailable');
    if(method==='POST'){
      if(path==='/api/qq/config'){Object.assign(data.qq,body);return {ok:true,config:copy(data.qq)};}
      if(path==='/api/wechat/config'){Object.assign(data.wechat,body);return {ok:true,config:copy(data.wechat)};}
      if(path==='/api/config')return {ok:true,changed:Object.keys(body.patch)};
      if(path==='/api/personas/default'){for(const r of data.roles)r.isDefault=r.name===body.name;return {ok:true,name:body.name};}
      if(path==='/api/personas/save')return {ok:true};
      throw Error('Unexpected synthetic POST '+path);
    }
    if(path==='/api/qq/config')return response(path,{ok:true,config:copy(data.qq)});
    if(path==='/api/wechat/config')return {ok:true,config:copy(data.wechat)};
    if(path==='/api/personas')return response(path,{ok:true,items:copy(data.roles)});
    if(path.startsWith('/api/personas/'))return {ok:true,content:'SAVED_TEMPLATE'};
    if(path==='/api/qq/state')return {ok:true,...copy(data.worker)};
    if(path==='/api/state')return {ok:true,...copy(data.state),qq:copy(data.worker)};
    if(path==='/api/config')return {ok:true,items:copy(data.items)};
    if(path.startsWith('/api/logs'))return {ok:true,text:'synthetic log'};
    throw Error('Unexpected synthetic GET '+path);
  }
  const location={hash:'#overview'};
  const context=vm.createContext({document,location,console,Event:class{constructor(type){this.type=type;}},setTimeout:()=>0,clearTimeout(){},setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){},confirm:()=>true,window:{dispatchEvent:e=>{for(const fn of events.get(e.type)||[])fn(e);},addEventListener:(name,fn)=>{if(!events.has(name))events.set(name,[]);events.get(name).push(fn);}},fetch:async(path,opts)=>({ok:true,status:200,json:()=>api(path,opts)}),api,post:(path,body)=>api(path,{method:'POST',body:JSON.stringify(body)}),toast(){}});
  if(full)vm.runInContext(main,context,{filename:'index.html'});
  vm.runInContext(qq,context,{filename:'qq-ui.js'});await settle();
  return {nodes,data,requests,failures,context,pauseNext(path){let release;gates.set(path,new Promise(r=>{release=r;}));return release;},async navigate(hash){location.hash=hash;await Promise.all((events.get('hashchange')||[]).map(fn=>fn()));await settle();},async poll(){for(const fn of timers)await fn();await settle();}};
}

test('QQ and WeChat save only their own platform fields',async()=>{
  const b=await browser();
  b.nodes.get('wechatEnabled').checked=false;await b.nodes.get('wechatSave').click();
  assert.deepEqual(b.requests.find(r=>r.method==='POST'&&r.path==='/api/wechat/config').body,{enabled:false});
  b.nodes.get('qqPersona').value='private_fixture';await b.nodes.get('qqSaveUsers').click();
  const users=b.requests.find(r=>r.method==='POST'&&r.path==='/api/qq/config').body;
  assert.equal('persona' in users,false);assert.equal('groupPersona' in users,false);assert.equal('wechatEnabled' in users,false);
  await b.nodes.get('qqSaveParameters').click();
  const params=b.requests.filter(r=>r.method==='POST'&&r.path==='/api/qq/config').at(-1).body;
  assert.deepEqual(params.replyOptions,{visionEnabled:true,sceneEnabled:true,emotionEnabled:true});
  assert.deepEqual(params.activeHours,[0,24]);assert.equal('enabled' in params,false);assert.equal('persona' in params,false);
  assert.deepEqual(b.nodes.get('qqGroupPersona').children.map(x=>x.value),['dafeiyu']);
});

test('entering users reloads custom personas and excludes invalid QQ identifiers',async()=>{
  const b=await browser();
  b.data.roles.push({name:'custom_teacher',title:'老师'},{name:'老师',title:'无效标识'});
  await b.navigate('#personas');await b.navigate('#accounts');
  for(const id of ['qqPersona','qqGroupPersona']){
    const options=b.nodes.get(id).children.map(x=>x.value);
    assert.ok(options.includes('custom_teacher'),id+' should reload the saved role');
    assert.equal(options.includes('老师'),false,id+' should omit identifiers rejected by QQ settings');
  }
});

test('a failed initial platform load cannot overwrite saved settings',async()=>{
  const b=await browser({fail:['/api/qq/config']});
  await b.nodes.get('qqSaveUsers').click();await b.nodes.get('qqSaveParameters').click();await b.nodes.get('wechatSave').click();
  assert.deepEqual(b.requests.filter(r=>r.method==='POST'),[]);
});

test('a failed refresh also blocks saves until settings have loaded again',async()=>{
  const b=await browser();b.failures.add('/api/qq/config');await b.navigate('#accounts');
  await b.nodes.get('qqSaveUsers').click();await b.nodes.get('qqSaveParameters').click();await b.nodes.get('wechatSave').click();
  assert.deepEqual(b.requests.filter(r=>r.method==='POST'),[]);
  b.failures.clear();await b.navigate('#config');await b.nodes.get('qqSaveUsers').click();
  assert.equal(b.requests.filter(r=>r.method==='POST'&&r.path==='/api/qq/config').length,1);
});

test('failed status requests replace the previous listening status in both QQ views',async()=>{
  const b=await browser();assert.match(b.nodes.get('qqStatus').textContent,/监听/);
  b.failures.add('/api/state');await b.poll();
  for(const id of ['qqStatus','qqOverview'])assert.match(b.nodes.get(id).textContent,/不可用|失败|暂未|未能/,id+' must not keep reporting a stale healthy connection');
});

test('QQ status reflects its switch and the global reply stop',async()=>{
  const b=await browser();b.data.qq.enabled=false;await b.poll();assert.match(b.nodes.get('qqStatus').textContent,/未启用/);
  b.data.qq.enabled=true;b.data.state.enabled=false;await b.poll();assert.match(b.nodes.get('qqStatus').textContent,/停止/);
  assert.equal(b.requests.some(r=>/\/api\/model-config\/(test|models)/.test(r.path)),false);
  assert.equal(b.requests.some(r=>r.path==='/api/qq/state'),false,'status should reuse /api/state instead of probing NapCat twice');
});

test('WeChat parameter saves exclude API settings and the shared API table saves them separately',async()=>{
  const b=await browser({full:true});await vm.runInContext('loadConfig()',b.context);await settle();
  const shared=['chatModel','chatBaseUrl','chatTemperature','taskTimeoutMs','visionModelDeepseek'];
  assert.ok(b.nodes.has('cfgSharedBody'));assert.ok(b.nodes.has('btnSaveSharedConfig'));
  b.nodes.get('cfg_sceneEnabled').checked=false;await b.nodes.get('btnSaveConfig').click();
  const wx=b.requests.filter(r=>r.path==='/api/config'&&r.method==='POST').at(-1).body.patch;
  assert.equal(wx.sceneEnabled,false);for(const key of shared)assert.equal(key in wx,false,key+' leaks from the WeChat form');
  b.nodes.get('cfg_chatTemperature').value='1.1';await b.nodes.get('btnSaveSharedConfig').click();
  const api=b.requests.filter(r=>r.path==='/api/config'&&r.method==='POST').at(-1).body.patch;
  assert.equal(api.chatTemperature,1.1);assert.equal('sceneEnabled' in api,false);assert.equal('defaultPersona' in api,false);
  assert.ok(b.nodes.has('personaWechatSave'));assert.ok(b.nodes.has('qqPersonaSave'));
});

test('persona defaults save independently and optional group role remains explicit',async()=>{
  const b=await browser({full:true});
  await b.navigate('#personas');await settle();
  b.nodes.get('personaBody').value='UNSAVED_DRAFT';
  b.nodes.get('personaWechatDefault').value='private_fixture';await b.nodes.get('personaWechatSave').click();await settle();
  assert.deepEqual(b.requests.find(r=>r.path==='/api/personas/default').body,{name:'private_fixture'});
  assert.equal(b.requests.some(r=>r.path==='/api/qq/config'&&r.method==='POST'),false);
  b.nodes.get('qqPersona').value='dafeiyu';b.nodes.get('qqGroupSeparate').checked=false;await b.nodes.get('qqPersonaSave').click();await settle();
  assert.deepEqual(b.requests.filter(r=>r.path==='/api/qq/config'&&r.method==='POST').at(-1).body,{persona:'dafeiyu',groupPersona:'dafeiyu',groupFollowsDefault:true});
  b.nodes.get('qqPersona').value='private_fixture';b.nodes.get('qqGroupSeparate').checked=true;b.nodes.get('qqGroupPersona').value='dafeiyu';await b.nodes.get('qqPersonaSave').click();
  assert.equal(b.requests.filter(r=>r.path==='/api/qq/config'&&r.method==='POST').at(-1).body.groupFollowsDefault,false,JSON.stringify({disabled:b.nodes.get('qqPersonaSave').disabled,choice:b.nodes.get('qqPersona').value,requests:b.requests.filter(r=>r.method==='POST')}));
  assert.equal(b.requests.filter(r=>r.path==='/api/personas/default'&&r.method==='POST').length,1);
  assert.equal(b.nodes.get('personaBody').value,'UNSAVED_DRAFT');
  const userMarkup=html.split('id="tab-accounts"')[1].split('id="tab-overview"')[0];
  assert.equal(userMarkup.includes('id="qqPersona"'),false);
});

test('an old QQ read cannot undo a newer saved persona choice',async()=>{
  const b=await browser(),release=b.pauseNext('/api/qq/config');
  const pending=b.navigate('#config');await settle();
  await b.navigate('#accounts');
  b.nodes.get('qqPersona').value='private_fixture';b.nodes.get('qqGroupSeparate').checked=true;
  await b.nodes.get('qqPersonaSave').click();release();await pending;await settle();
  assert.equal(b.data.qq.persona,'private_fixture');assert.equal(b.nodes.get('qqPersona').value,'private_fixture');
});

test('an old persona list cannot reset the saved WeChat default or the editing draft',async()=>{
  const b=await browser({full:true});await b.navigate('#personas');
  b.nodes.get('personaBody').value='UNSAVED_DRAFT';
  const release=b.pauseNext('/api/personas'),pending=vm.runInContext('loadPersonas(undefined,true)',b.context);await settle();
  await vm.runInContext('loadPersonas(undefined,true)',b.context);
  b.nodes.get('personaWechatDefault').value='private_fixture';await b.nodes.get('personaWechatSave').click();
  release();await pending;await settle();
  assert.equal(b.nodes.get('personaWechatDefault').value,'private_fixture');assert.equal(b.nodes.get('personaBody').value,'UNSAVED_DRAFT');
});

test('overview management links and browser hash navigation open the requested page',async()=>{
  const b=await browser({full:true});await b.navigate('#personas');
  assert.equal(vm.runInContext('state.currentTab',b.context),'personas');
  await b.navigate('#accounts');assert.equal(vm.runInContext('state.currentTab',b.context),'accounts');
});
