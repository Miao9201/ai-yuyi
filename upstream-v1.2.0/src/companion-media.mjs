import fs from 'node:fs';
import path from 'node:path';
import {textItem} from './ilink.js';

export function selectMedia(requested,options){
  const candidates=options?.candidates||[],allowed=new Map(candidates.map(i=>[i.id,i]));
  const picked=[...new Set(requested||[])].filter(id=>allowed.has(id)).map(id=>allowed.get(id));
  if(!picked.length&&options?.intent&&candidates.length)picked.push(candidates[0]);
  return picked.slice(0,1);
}

export function resolveMedia(id,catalog){
  const item=catalog.items?.find(i=>i.id===id);
  if(!item||item.allowed===false)throw Error('素材不在允许发送的目录索引中');
  const root=fs.realpathSync(catalog.source_root),file=fs.realpathSync(path.resolve(root,item.uri));
  const subdir=catalog.media_subdir==='stickers'?'stickers':'media';
  const mediaRoot=path.join(root,subdir),relative=path.relative(mediaRoot,file);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('文件不在导入的媒体目录内');
  if(!/\.(png|jpe?g|gif|webp)$/i.test(file)||!fs.statSync(file).isFile()||fs.statSync(file).size>25*1024*1024)throw Error('素材格式或大小不支持');
  return {...item,file};
}

export async function deliver(job,msg,{send,checkpoint,allowed=()=>true}){
  const check=()=>{if(!allowed()){const e=Error('已停止，尚未执行本次发送');e.beforeSend=true;throw e;}};
  job.mediaReceipts??=[];
  if(job.answer&&!job.textConfirmed){
    check();job.receipt=await send([textItem(job.answer)]);job.textConfirmed=true;checkpoint();
  }
  for(const upload of job.uploads||[]){
    if(job.mediaReceipts.some(r=>r.id===upload.id))continue;
    check();const receipt=await send([upload.item]);job.mediaReceipts.push({id:upload.id,receipt});checkpoint();
  }
  job.mediaConfirmed=!!job.uploads?.length&&job.mediaReceipts.length===job.uploads.length;
  return job.receipt;
}
