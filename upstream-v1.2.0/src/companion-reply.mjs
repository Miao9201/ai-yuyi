import {selectMedia} from './companion-media.mjs';

export function companionConfig(base,persona){
  return {...base,defaultPersona:persona,proactive:false,allowStickers:false,imageGenEnabled:false,autoImageEnabled:false,
    sendTyping:false,showQueuedNotice:false,desktopNaturalReplies:true,maxBubbles:1,bubbleSplit:false,
    kaomojiChance:0,emojiChance:0,lifeEnabled:false,ragEnabled:false,sceneAnalyzeModel:false,defianceChance:0};
}

export async function prepareReply({state,msg,text,uid,options,handle}){
  state.companionMode=true;state.companionVision='';state.companionRequestedMedia=[];
  state.desktopStyleContext=options.context||'';
  state.desktopUserContext=options.userContext||'';
  state.desktopStyleContext+='\n【当前能力】可以理解普通图片，可从当前角色的候选素材中发表情或用户明确索要的图片。不能看到图片以外的环境，目前没有生图或自拍能力。识图失败如实说明，不编造图片内容。';
  if(options.candidates?.length)state.desktopStyleContext+='\n【本轮可发送素材】最多选一个，只能用以下ID；需要时在回复结尾单独加一行[sticker:素材ID]，这个标记会实际发送原媒体，不要把ID说给用户。普通照片只在明确索要时发送，表情不必每轮都发。\n'+JSON.stringify(options.candidates);
  else state.desktopStyleContext+='\n本轮没有合适的发图候选，请只用文字，不承诺已发图。';
  let answer='';const prepared=new Error('REPLY_PREPARED');
  state.desktopTransport={sendText:async()=>{throw Error('模型未生成正常回复');},sendBubbles:async(_uid,bubbles)=>{answer=bubbles.join('\n\n').trim();throw prepared;}};
  try{await handle(state,{...msg,from_user_id:uid},text);}catch(error){if(error!==prepared)throw error;}
  if(!answer)answer=options.intent&&options.candidates?.length?'给你来一张':'在呢';
  return {text:answer,media:selectMedia(state.companionRequestedMedia,options),vision:state.companionVision||'',evidence:options.evidence||[]};
}
