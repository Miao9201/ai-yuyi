import {randomUUID} from 'node:crypto';

const ACTIONS=new Set(['get_login_info','get_status','get_image','get_msg','send_private_msg','send_group_msg']);
export function parseEvent(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)throw Error('QQ消息过大');
  return JSON.parse(text,(key,value,context)=>{
    if(typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)){
      if(!context?.source)throw Error('当前Node版本不能精确保留消息ID');
      return context.source;
    }
    return value;
  });
}

export class OneBotClient {
  constructor(url,token,{WebSocketImpl=globalThis.WebSocket,onEvent=()=>{},onDisconnect=()=>{},timeoutMs=20000}={}){
    const parsed=new URL(url);
    if(parsed.protocol!=='ws:'||parsed.hostname!=='127.0.0.1'||!parsed.port||parsed.username||parsed.password||parsed.search||parsed.hash||!['','/'].includes(parsed.pathname))throw Error('QQ接口仅允许本机回环地址');
    if(typeof token!=='string'||!token||token.length>200)throw Error('QQ连接令牌无效');
    parsed.searchParams.set('access_token',token);
    this.address=parsed.href;this.Socket=WebSocketImpl;this.onEvent=onEvent;this.onDisconnect=onDisconnect;this.timeoutMs=timeoutMs;this.pending=new Map();this.socket=null;
  }
  connect(){
    if(this.socket?.readyState===1)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const socket=new this.Socket(this.address);this.socket=socket;
      const timer=setTimeout(()=>{reject(Error('QQ连接超时'));socket.close();},this.timeoutMs);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('QQ本机接口连接失败'));},{once:true});
      socket.addEventListener('close',()=>{
        clearTimeout(timer);reject(Error('QQ连接已断开'));
        if(this.socket!==socket)return;
        this.socket=null;
        for(const [id,call] of this.pending){clearTimeout(call.timer);const error=Error('QQ连接已断开，未确认的发送不自动重发');error.ambiguous=call.action.startsWith('send_');call.reject(error);this.pending.delete(id);}
        this.onDisconnect();
      });
      socket.addEventListener('message',event=>{
        if(this.socket!==socket)return;
        let result;try{result=parseEvent(event.data);}catch{return;}
        if(!result||typeof result!=='object')return;
        if(result.post_type){try{this.onEvent(result);}catch{}return;}
        const call=this.pending.get(result.echo);if(!call)return;
        this.pending.delete(result.echo);clearTimeout(call.timer);
        if(result.status==='ok'&&result.retcode===0)call.resolve(result.data??{});
        else {const error=Error('QQ接口未确认操作，错误码 '+String(result.retcode).slice(0,10));error.ambiguous=call.action.startsWith('send_');call.reject(error);}
      });
    });
  }
  async call(action,params={}){
    if(!ACTIONS.has(action))throw Error('不允许此QQ操作');
    if(this.socket?.readyState!==1){const error=Error('QQ连接尚未就绪');error.beforeSend=true;throw error;}
    const echo=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(echo);const error=Error('QQ接口结果未确认，发送不会自动重试');error.ambiguous=action.startsWith('send_');reject(error);},this.timeoutMs);
      this.pending.set(echo,{resolve,reject,timer,action});
      try{this.socket.send(JSON.stringify({action,params,echo}));}
      catch{this.pending.delete(echo);clearTimeout(timer);const error=Error('QQ消息提交失败，结果未确认');error.ambiguous=action.startsWith('send_');reject(error);}
    });
  }
  close(){this.socket?.close();}
}
