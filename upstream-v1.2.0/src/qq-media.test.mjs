import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createImageLoader} from './qq-media.mjs';

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
