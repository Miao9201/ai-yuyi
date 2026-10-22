(() => {
  const el=id=>document.getElementById(id);
  let analyzedSource='',busy=false;
  const nameFrom=(select,input)=>{const option=el(select).selectedOptions[0];if(option)el(input).value=option.dataset.name;};
  el('importTarget').onchange=()=>nameFrom('importTarget','importName');
  el('importSelf').onchange=()=>nameFrom('importSelf','importAddress');
  el('importSource').oninput=()=>{analyzedSource='';el('importRun').disabled=true;};
  async function run(action){
    if(busy)return;busy=true;el('importAnalyze').disabled=true;el('importRun').disabled=true;
    el('importStatus').textContent=action==='analyze'?'正在读取…':'正在创建本地资料库…';
    try{
      const source=el('importSource').value.trim().replace(/^"|"$/g,'');
      if(!source)throw Error('请填写JSON路径');
      if(action==='import'&&source!==analyzedSource)throw Error('请先读取当前文件的参与者');
      const body=action==='analyze'?{source}:{source,target:el('importTarget').value,self:el('importSelf').value,name:el('importName').value,address:el('importAddress').value,gender:el('importGender').value,relationship:el('importRelationship').value,allow_media:el('importMedia').checked};
      const response=await fetch('/api/persona-import/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'导入未完成');
      if(action==='analyze'){
        for(const id of ['importTarget','importSelf']){
          el(id).replaceChildren();
          for(const person of data.participants){const option=document.createElement('option');option.value=person.id;option.dataset.name=person.name;option.textContent=person.name+' · '+person.count+'条';el(id).append(option);}
        }
        if(data.participants.length<2)throw Error('记录至少需要两位参与者');
        el('importSelf').selectedIndex=1;nameFrom('importTarget','importName');nameFrom('importSelf','importAddress');
        analyzedSource=source;el('importStatus').textContent='请核对模仿对象和你自己的身份';
      }else{
        await loadPersonas(data.persona);
        el('importStatus').textContent='已导入 '+data.indexed_messages+' 条文字、'+data.pairs+' 组范例。点击“保存并设为默认”后用于回复。';
        analyzedSource='';
      }
    }catch(error){el('importStatus').textContent=error.message;}
    finally{busy=false;el('importAnalyze').disabled=false;el('importRun').disabled=!analyzedSource;}
  }
  el('importAnalyze').onclick=()=>run('analyze');el('importRun').onclick=()=>run('import');
})();
