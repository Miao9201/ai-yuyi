import {selectMedia} from './companion-media.mjs';

export function qqCompanionConfig(base,persona,options){
  const api={};
  for(const key of ['chatBaseUrl','chatModel','chatTemperature','taskTimeoutMs','visionProvider','visionModel','visionModelDeepseek','visionBaseUrl','visionFallback','visionApiKey'])if(base[key]!==undefined)api[key]=base[key];
  return companionConfig({...api,autoSearch:false,sceneEnabled:true,emotionEnabled:true,visionEnabled:true,historyRecentTurns:3,historyOlderChars:40,...options},persona);
}

export function companionConfig(base,persona){
  return {...base,defaultPersona:persona,proactive:false,allowStickers:false,imageGenEnabled:false,autoImageEnabled:false,
    sendTyping:false,showQueuedNotice:false,desktopNaturalReplies:true,maxBubbles:1,bubbleSplit:false,
    kaomojiChance:0,emojiChance:0,lifeEnabled:false,ragEnabled:false,sceneAnalyzeModel:false,defianceChance:0};
}

export async function prepareReply({state,msg,text,uid,options,handle}){
  if(msg.qq?.kind==='group'&&msg.qq.mentioned&&!msg.qq.text?.trim()&&!msg.qq.replyTo&&!msg.item_list?.some(item=>item.type===2))return {text:'在呢',media:[],vision:'',evidence:[]};
  state.companionMode=true;state.companionVision='';state.companionRequestedMedia=[];
  state.desktopStyleContext=options.context||'';
  state.desktopUserContext=options.userContext||'';
  state.desktopStyleContext+='\n【当前能力】可以理解普通图片，可从当前角色的候选素材中发表情或用户明确索要的图片。不能看到图片以外的环境，目前没有生图或自拍能力。识图失败如实说明，不编造图片内容。';
  if(msg.qq?.imageReferenceUnavailable)state.desktopStyleContext+='\n引用的图片未能取得，本轮没有看见引用图。不要推测内容，可请对方重新发送原图。';
  if(options.candidates?.length)state.desktopStyleContext+='\n【本轮可发送素材】最多选一个，只能用以下ID；需要时在回复结尾单独加一行[sticker:素材ID]，这个标记会实际发送原媒体，不要把ID说给用户。普通照片只在明确索要时发送，表情不必每轮都发。\n'+JSON.stringify(options.candidates);
  else state.desktopStyleContext+='\n本轮没有合适的发图候选，请只用文字，不承诺已发图。';
  let answer='';const prepared=new Error('REPLY_PREPARED');
  state.desktopTransport={sendText:async()=>{throw Error('模型未生成正常回复');},sendBubbles:async(_uid,bubbles)=>{answer=bubbles.join('\n\n').trim();throw prepared;}};
  try{await handle(state,{...msg,from_user_id:uid},text);}catch(error){if(error!==prepared)throw error;}
  if(!answer)answer=options.intent&&options.candidates?.length?'给你来一张':'在呢';
  const media=selectMedia(state.companionRequestedMedia,options);
  if(options.intent&&media.length&&/没(?:有)?(?:什么|合适的)?(?:图|图片|表情)|不能发图|没有(?:可发|能发)|发不了(?:图|表情)|你自己拍/.test(answer))answer=media[0].kind==='emoji'?'给你来张表情':'给你看这张';
  return {text:answer,media,vision:state.companionVision||'',evidence:options.evidence||[]};
}
