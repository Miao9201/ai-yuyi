import test from 'node:test';
import assert from 'node:assert/strict';
import {OneBotClient,parseEvent} from './qq-onebot.mjs';

class Socket extends EventTarget {
  static instance;
  constructor(url){super();this.url=url;this.readyState=0;Socket.instance=this;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(text){this.last=JSON.parse(text);}
  respond(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
test('connects only to loopback, correlates echoes and forwards events',async()=>{
  assert.throws(()=>new OneBotClient('ws://example.com:3001/','secret'),/本机/);
  const events=[],client=new OneBotClient('ws://127.0.0.1:3001/','fixture-token',{WebSocketImpl:Socket,onEvent:e=>events.push(e),timeoutMs:100});
  await client.connect();assert.match(Socket.instance.url,/access_token=fixture-token/);
  const pending=client.call('get_login_info');const echo=Socket.instance.last.echo;
  Socket.instance.respond({status:'ok',retcode:0,data:{user_id:300001},echo:'another-call'});
  Socket.instance.respond({post_type:'message',message_type:'private',user_id:100001});assert.equal(events.length,1);
  Socket.instance.respond({status:'ok',retcode:0,data:{user_id:300001},echo});
  assert.equal((await pending).user_id,300001);client.close();
});
test('failed/ambiguous sends do not retry; disconnect rejects pending requests',async()=>{
  const client=new OneBotClient('ws://127.0.0.1:3001/','fixture-token',{WebSocketImpl:Socket,timeoutMs:15});await client.connect();
  await assert.rejects(client.call('delete_msg'),/不允许/);
  const timeout=client.call('send_private_msg',{user_id:'100001',message:[]});
  await assert.rejects(timeout,e=>e.ambiguous===true&&!e.message.includes('fixture-token'));
  const pending=client.call('get_status');Socket.instance.close();await assert.rejects(pending,/断开/);
  await assert.rejects(client.call('get_status'),e=>e.beforeSend===true);client.close();
});
test('64 bit identifiers remain exact and malformed/oversized input is rejected',()=>{
  assert.equal(parseEvent('{"message_id":9007199254740993123,"time":1000}').message_id,'9007199254740993123');
  assert.throws(()=>parseEvent('not JSON'));
  assert.throws(()=>parseEvent('x'.repeat(2*1024*1024+1)),/过大/);
});
