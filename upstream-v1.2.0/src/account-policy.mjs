import fs from 'node:fs';
import path from 'node:path';

export function accountContext(local,id='',revision=''){
  if(id&&!/^[a-f0-9]{32}$/.test(id))throw Error('使用者 ID 无效');
  const data=path.join(local,'data');
  const row=()=>{
    const rows=JSON.parse(fs.readFileSync(path.join(data,'ilink-accounts.json'),'utf8')).accounts;
    const r=rows.find(r=>r.id===id);
    if(!r||r.persona!=='linmuwan'||typeof r.enabled!=='boolean')throw Error('使用者或允许的人设无效');
    return r;
  };
  if(id)row();
  return {
    directory:id?path.join(data,'accounts',id):data,
    active(){if(!id)return true;try{const r=row();return r.enabled&&r.revision===revision;}catch{return false;}},
    persona(defaultPersona){return id?row().persona:defaultPersona;},
    assertPersona(persona){if(id&&(persona!=='linmuwan'||persona!==row().persona))throw Error('该使用者不能访问这个人设');},
    modelUser(user,persona){return (id?'account:'+id+'::':'')+user+'::'+persona;},
    memoryOwner(user){return id?'account:'+id+'::'+user:user;}
  };
}
