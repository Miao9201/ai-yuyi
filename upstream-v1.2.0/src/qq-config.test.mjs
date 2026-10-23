import test from 'node:test';
import assert from 'node:assert/strict';
import * as reply from './companion-reply.mjs';
import {resolveVisionTarget,resolveFallbackTarget} from './vision.js';
test('QQ retains the configured primary and fallback vision credentials',()=>{
  const base={visionProvider:'doubao',visionApiKey:'fixture-secret',visionModel:'fixture-vision'};
  const cfg=reply.qqCompanionConfig(base,'dafeiyu',{});
  assert.equal(resolveVisionTarget(cfg).apiKey,'fixture-secret');
  assert.equal(resolveFallbackTarget({...cfg,visionProvider:'deepseek',visionFallback:true}).apiKey,'fixture-secret');
});
test('QQ reply settings ignore WeChat behavioral parameters and preserve shared model API',()=>{
  const cfg=reply.qqCompanionConfig({chatBaseUrl:'https://fixture.invalid/v1',chatModel:'fixture',visionEnabled:false,sceneEnabled:false,emotionEnabled:false,historyRecentTurns:99},'dafeiyu',{visionEnabled:true,sceneEnabled:true,emotionEnabled:true});
  assert.equal(cfg.chatModel,'fixture');assert.equal(cfg.defaultPersona,'dafeiyu');
  assert.equal(cfg.visionEnabled,true);assert.equal(cfg.sceneEnabled,true);assert.notEqual(cfg.historyRecentTurns,99);
  assert.equal(reply.qqCompanionConfig({},'dafeiyu',{visionEnabled:false,sceneEnabled:true,emotionEnabled:true}).visionEnabled,false);
});
