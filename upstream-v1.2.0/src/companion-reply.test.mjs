import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareReply,companionConfig} from './companion-reply.mjs';

test('a bare QQ mention with no actual image cannot invent a loading failure',async()=>{
  const result=await prepareReply({state:{},msg:{qq:{kind:'group',mentioned:true,text:'',images:[]},item_list:[]},text:'群友: ',uid:'qq:fixture',options:{candidates:[]},handle:async()=>{throw Error('empty mention should not need model generation');}});
  assert.equal(result.text,'在呢');assert.equal(result.vision,'');assert.deepEqual(result.media,[]);
});

test('available requested media is not accompanied by a false no-images claim',async()=>{
  const result=await prepareReply({state:{},msg:{},text:'发点图片',uid:'qq:fixture',options:{intent:'emoji',candidates:[{id:'happy',kind:'emoji'}]},handle:async s=>s.desktopTransport.sendBubbles('ignored',['我这儿没图可发 你自己拍一张'])});
  assert.equal(result.media[0].id,'happy');assert.doesNotMatch(result.text,/没图|自己拍/);
});

test('shared preparation keeps persona config, current context and allowed media only',async()=>{
  const cfg=companionConfig({chatModel:'fixture-model',visionEnabled:true},'linmuwan');
  assert.equal(cfg.chatModel,'fixture-model');assert.equal(cfg.defaultPersona,'linmuwan');assert.equal(cfg.proactive,false);
  const state={companionVision:'old picture',companionRequestedMedia:['old-id']};
  const result=await prepareReply({state,msg:{item_list:[]},text:'开心',uid:'qq:fixture::linmuwan',
    options:{context:'THIS_SCOPE_ONLY',intent:'emoji',candidates:[{id:'happy',kind:'emoji'}],evidence:[]},
    handle:async(s,msg,text)=>{
      assert.equal(msg.from_user_id,'qq:fixture::linmuwan');assert.equal(text,'开心');
      assert.ok(s.desktopStyleContext.includes('THIS_SCOPE_ONLY'));assert.equal(s.companionVision,'');
      s.companionRequestedMedia=['happy','outside'];s.companionVision='一张笑脸';
      await s.desktopTransport.sendBubbles('ignored',['给你','看看']);
    }});
  assert.equal(result.text,'给你\n\n看看');assert.equal(result.vision,'一张笑脸');assert.ok(!result.media.some(m=>m.id==='outside'));
});
test('unrelated generation errors remain errors; missing answer uses the existing bounded fallback',async()=>{
  await assert.rejects(prepareReply({state:{},msg:{},text:'a',uid:'fixture',options:{context:'',candidates:[]},handle:async()=>{throw Error('model failed');}}),/model failed/);
  const result=await prepareReply({state:{},msg:{},text:'a',uid:'fixture',options:{context:'',candidates:[]},handle:async()=>{}});
  assert.equal(result.text,'在呢');assert.deepEqual(result.media,[]);
});
