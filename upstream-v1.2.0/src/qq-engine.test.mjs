import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {QQEngine} from './qq-engine.mjs';

const cfg={enabled:true,privateUsers:['100001'],groups:['200001'],persona:'linmuwan',groupPersona:'linmuwan',privatePersonas:{},probability:0,cooldownSeconds:0,maxPerMinute:6,quietHours:[0,0],keywords:[]};
const event=(id=1,extra={})=>({post_type:'message',self_id:300001,user_id:100001,message_type:'private',message_id:id,time:Date.now()/1000,message:[{type:'text',data:{text:'你好'}}],...extra});
async function fixture(run){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-engine-'));
  try{await run(directory);}finally{fs.rmSync(directory,{recursive:true,force:true});}
}
test('private reply survives restart and deduplicates; unapproved chats never create queues',()=>fixture(async directory=>{
  const sent=[];let config=structuredClone(cfg);
  const args={directory,bot:'300001',config:()=>config,allowed:()=>true,generate:async()=>({text:'在画画',media:[]}),send:async(items)=>{sent.push(items);return {message_id:9};}};
  let engine=new QQEngine(args);
  assert.equal(engine.receive(event(1,{user_id:100002})),false);
  assert.equal(engine.receive(event()),true);await engine.tick();assert.equal(sent.length,1);
  engine=new QQEngine(args);assert.equal(engine.receive(event()),false);await engine.tick();assert.equal(sent.length,1);
  assert.equal(fs.readdirSync(directory).filter(f=>f.endsWith('.json')).length,1);
}));
test('group mentions obey whitelist, receive dedup and speaker context; stop prevents send',()=>fixture(async directory=>{
  let enabled=true,seen='';const sent=[];
  const engine=new QQEngine({directory,bot:'300001',config:()=>cfg,allowed:()=>enabled,
    generate:async(msg)=>{seen=msg.item_list[0].text_item.text;enabled=false;return {text:'收到'};},send:async(items)=>sent.push(items)});
  const group=event(2,{message_type:'group',group_id:200001,sender:{nickname:'甲'},message:[{type:'at',data:{qq:300001}},{type:'text',data:{text:'在吗'}}]});
  assert.equal(engine.receive({...group,group_id:200002}),false);
  assert.equal(engine.receive(group),true);await engine.tick();assert.match(seen,/甲/);assert.equal(sent.length,0);
  assert.equal(engine.receive(group),false);
}));
test('ambiguous sends never repeat; later messages still work; media partial keeps text receipt',()=>fixture(async directory=>{
  let fail=true,calls=0;
  const engine=new QQEngine({directory,bot:'300001',config:()=>cfg,allowed:()=>true,
    generate:async()=>({text:'给你',media:[{id:'fixture'}]}),prepare:async(job)=>{job.uploads=[{id:'fixture',item:{type:'image',data:{file:'fixture'}}}];},
    send:async()=>{calls++;if(fail&&calls===2)throw Error('uncertain');return {message_id:calls};}});
  engine.receive(event(1));await engine.tick();assert.equal(engine.queues.values().next().value.data.jobs[0].phase,'partial');
  await engine.tick();assert.equal(calls,2);fail=false;engine.receive(event(2));await engine.tick();assert.equal(calls,4);
}));
test('untriggered group replay cannot reroll probability; persona changes cancel pending work',()=>fixture(async directory=>{
  let config=structuredClone(cfg),calls=0;
  const engine=new QQEngine({directory,bot:'300001',config:()=>config,allowed:()=>true,generate:async()=>{calls++;return {text:'hi'};},send:async()=>({message_id:3})});
  const group=event(3,{message_type:'group',group_id:200001});assert.equal(engine.receive(group),false);
  config={...config,probability:1};assert.equal(engine.receive(group),false);
  engine.receive(event(4));config={...config,persona:'another'};await engine.tick();assert.equal(calls,0);
}));
test('restart resumes saved private work without requiring a new incoming event',()=>fixture(async directory=>{
  let active=true,calls=0;
  const args={directory,bot:'300001',config:()=>cfg,allowed:()=>active,generate:async()=>{active=false;return {text:'saved'};},send:async()=>{calls++;return {message_id:7};}};
  const first=new QQEngine(args);first.receive(event(8));await first.tick();active=true;
  const second=new QQEngine(args);await second.tick();assert.equal(calls,1);
}));
test('restart cancels pending group work and keeps dedup without blocking new mentions',()=>fixture(async directory=>{
  let active=true,calls=0;
  const args={directory,bot:'300001',config:()=>cfg,allowed:()=>active,
    generate:async()=>{active=false;return {text:'saved'};},send:async()=>{calls++;return {message_id:7};}};
  const group=event(10,{message_type:'group',group_id:200001,message:[{type:'at',data:{qq:300001}},{type:'text',data:{text:'在吗'}}]});
  const first=new QQEngine(args);first.receive(group);await first.tick();active=true;
  const second=new QQEngine({...args,generate:async()=>({text:'new'})});await second.tick();
  assert.equal(calls,0);assert.equal(second.receive(group),false);
  assert.equal(second.queues.values().next().value.data.jobs[0].phase,'cancelled');
  assert.equal(second.receive({...group,message_id:11}),true);await second.tick();assert.equal(calls,1);
}));
