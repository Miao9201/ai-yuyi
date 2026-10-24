import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createImageLoader} from './qq-media.mjs';
import * as media from './qq-media.mjs';

test('quoted images are read only from the exact group message and current images take precedence',async()=>{
  const msg={qq:{bot:'300001',kind:'group',peer:'200001',sender:'100001',replyTo:'88'},item_list:[{type:1,text_item:{text:'看看这张图'}}]};
  const original={message_type:'group',group_id:200001,message_id:88,message:[{type:'image',data:{url:'https://gchat.qpic.cn/fixture.png',file:'fixture'}}]};
  const onebot={call:async(action,params)=>{assert.equal(action,'get_msg');assert.equal(String(params.message_id),'88');return original;}};
  const attached=await media.attachQuotedImage(msg,onebot);assert.equal(attached.item_list.at(-1).type,2);assert.equal(attached.qq.imageReference,'quoted');assert.equal(msg.item_list.length,1);
  for(const invalid of [{...original,group_id:200002},{...original,message_type:'private'},{...original,message_id:89},{...original,self_id:300002}]){
    const denied=await media.attachQuotedImage(msg,{call:async()=>invalid});assert.equal(denied.item_list.length,1);
  }
  const current={...msg,item_list:[{type:2,qqImage:{file:'current'}}]};
  assert.equal(await media.attachQuotedImage(current,{call:()=>{throw Error('should not read a quote when current image is present');}}),current);
});

test('QQ images reject arbitrary paths, loopback URLs, oversized and non-image responses',async()=>{
  const folder=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'yuyi-qq-media-')));
  try {
    const file=path.join(folder,'secret.txt');fs.writeFileSync(file,'private');
    const loader=createImageLoader({allowedRoots:[],onebot:{call:async()=>({file})},fetchImpl:async()=>{throw Error('Unexpected network');}});
    await assert.rejects(loader({qqImage:{url:'http://127.0.0.1:7788/api/state',file:'fixture'}},{destDir:folder}));
    const oversized=createImageLoader({fetchImpl:async()=>new Response('bad',{headers:{'Content-Length':String(30*1024*1024)}})});
    await assert.rejects(oversized({qqImage:{url:'https://gchat.qpic.cn/test'}},{destDir:folder}));
    const invalid=createImageLoader({fetchImpl:async()=>new Response('<html>not an image</html>')});
    await assert.rejects(invalid({qqImage:{url:'https://gchat.qpic.cn/test'}},{destDir:folder}));
  }finally {assert.equal(path.dirname(folder),fs.realpathSync(os.tmpdir()));fs.rmSync(folder,{recursive:true,force:true});}
});
test('a QQ CDN image is bounded, copied to the inbox and retains its real mime type',async()=>{
  const folder=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'yuyi-qq-media-')));
  try {
    const bytes=Buffer.from('89504e470d0a1a0a00000000','hex');
    const loader=createImageLoader({fetchImpl:async(url,options)=>{assert.equal(options.redirect,'error');return new Response(bytes);}});
    const result=await loader({qqImage:{url:'https://multimedia.nt.qq.com.cn/download?fileid=fixture'}},{destDir:folder});
    assert.equal(result.mime,'image/png');assert.equal(result.bytes,bytes.length);assert.deepEqual(fs.readFileSync(result.file),bytes);
    assert.equal(path.dirname(result.file),folder);
  }finally {assert.equal(path.dirname(folder),fs.realpathSync(os.tmpdir()));fs.rmSync(folder,{recursive:true,force:true});}
});
