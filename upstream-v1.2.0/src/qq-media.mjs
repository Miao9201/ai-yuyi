import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MAX=20*1024*1024;
export async function attachQuotedImage(msg,onebot){
  const qq=msg.qq;
  if(qq?.kind!=='group'||!qq.replyTo||msg.item_list?.some(item=>item.type===2))return msg;
  try{
    const source=await onebot.call('get_msg',{message_id:String(qq.replyTo)});
    if(source.message_type!=='group'||String(source.group_id)!==qq.peer||String(source.message_id)!==String(qq.replyTo)||(source.self_id!==undefined&&String(source.self_id)!==qq.bot))return {...msg,qq:{...qq,imageReferenceUnavailable:true}};
    const images=(Array.isArray(source.message)?source.message:[]).filter(item=>['image','mface'].includes(item?.type)).slice(0,3).map(item=>({type:2,image_item:{media:{full_url:'qq-image://inbound'}},qqImage:{file:String(item.data?.file||''),url:String(item.data?.url||''),summary:String(item.data?.summary||'').slice(0,60)}}));
    return images.length?{...msg,qq:{...qq,imageReference:'quoted'},item_list:[...(msg.item_list||[]),...images]}:msg;
  }catch{return {...msg,qq:{...qq,imageReferenceUnavailable:true}};}
}

function mimeOf(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return ['image/png','.png'];
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return ['image/jpeg','.jpg'];
  if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')))return ['image/gif','.gif'];
  if(bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return ['image/webp','.webp'];
  throw Error('QQ图片格式不支持');
}
function cdnUrl(value){
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&['qq.com','qq.com.cn','qpic.cn','qlogo.cn'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))?url:null;}catch{return null;}
}

export function createImageLoader({onebot,allowedRoots=[],fetchImpl=fetch}={}){
  return async(item,{destDir,timeoutMs=20000}={})=>{
    const source=item.qqImage||{};let url=cdnUrl(source.url),local;
    if(!url&&source.file&&onebot){
      const result=await onebot.call('get_image',{file:source.file});
      url=cdnUrl(result.url);local=result.file||result.path;
    }
    let bytes;
    if(url){
      const response=await fetchImpl(url.href,{redirect:'error',signal:AbortSignal.timeout(Math.min(30000,Math.max(1000,timeoutMs)))});
      if(!response.ok||Number(response.headers.get('content-length'))>MAX)throw Error('QQ图片下载失败或过大');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX)throw Error('QQ图片过大');chunks.push(Buffer.from(value));}}
      finally{await reader.cancel().catch(()=>{});}
      bytes=Buffer.concat(chunks);
    }else if(local){
      const file=fs.realpathSync(local);
      const allowed=allowedRoots.some(root=>{try{const rel=path.relative(fs.realpathSync(root),file);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);}catch{return false;}});
      if(!allowed||!fs.statSync(file).isFile()||fs.statSync(file).size>MAX)throw Error('QQ图片不在允许缓存目录');
      bytes=fs.readFileSync(file);
    }else throw Error('QQ图片暂时无法取得');
    if(!bytes.length||bytes.length>MAX)throw Error('QQ图片为空或过大');
    const [mime,extension]=mimeOf(bytes);fs.mkdirSync(destDir,{recursive:true});
    const file=path.join(destDir,createHash('sha256').update(bytes).digest('hex')+extension);
    fs.writeFileSync(file,bytes);return {ok:true,filePath:file,file,path:file,mime,bytes:bytes.length};
  };
}
