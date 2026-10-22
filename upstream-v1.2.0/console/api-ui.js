// API settings stay in this local form; saved keys are never returned to the page.
let apiFormDirty=false;
const apiFormFields=['apiBaseUrl','apiChatModel','apiVisionModel','apiTemperature','apiTimeout','apiKey'];
for(const id of apiFormFields)document.getElementById(id).addEventListener('input',()=>{apiFormDirty=true;});
function apiFormBody(){return {base_url:$('#apiBaseUrl').value.trim(),chat_model:$('#apiChatModel').value.trim(),vision_model:$('#apiVisionModel').value.trim(),temperature:Number($('#apiTemperature').value),timeout_ms:Number($('#apiTimeout').value)*1000,key:$('#apiKey').value.trim()};}
async function loadApiConfig(force=false){
  if(apiFormDirty&&!force)return;
  try{
    const {config:c}=await api('/api/model-config');
    $('#apiBaseUrl').value=c.base_url;$('#apiChatModel').value=c.chat_model;$('#apiVisionModel').value=c.vision_model||'';
    $('#apiTemperature').value=c.temperature;$('#apiTimeout').value=c.timeout_ms/1000;
    $('#apiKey').value='';$('#apiKey').placeholder=c.has_key?'已保存密钥，留空保留原密钥':'输入接口平台提供的 API Key';
    $('#apiReplyTarget').textContent=c.transport==='ilink'?'回复对象在“用户”中管理。':'当前普通好友回复对象：'+(c.contact||'尚未设置');
    $('#apiConfigStatus').textContent=c.has_key?'已保存密钥。':'填写接口地址、模型和密钥后保存。';apiFormDirty=false;
  }catch(e){toast('读取 API 配置失败：'+e.message,true);}
}
async function apiFormAction(action){
  const buttons=$$('#tab-api button');buttons.forEach(b=>b.disabled=true);
  $('#apiConfigStatus').textContent=action==='save'?'正在保存并应用…':'正在检测接口…';
  try{
    const result=await post('/api/model-config/'+action,apiFormBody());
    if(action==='models'){
      const list=$('#apiModelOptions');list.textContent='';
      for(const id of result.models||[]){const option=document.createElement('option');option.value=id;list.appendChild(option);}
      $('#apiConfigStatus').textContent='已读取 '+(result.models||[]).length+' 个模型。';
    }else if(action==='test')$('#apiConfigStatus').textContent='接口检测成功 · '+result.model+' · '+result.ms+' ms。配置尚未保存。';
    else{apiFormDirty=false;await loadApiConfig(true);$('#apiConfigStatus').textContent=result.restarted?'已保存并重启回复服务，新配置已应用。':'已保存，下次启动回复服务时使用。';await loadState();toast('API 配置已保存');}
  }catch(e){$('#apiConfigStatus').textContent='未完成：'+e.message;toast(e.message,true);}
  finally{buttons.forEach(b=>b.disabled=false);}
}
$('#btnApiSave').onclick=()=>apiFormAction('save');
$('#btnApiTest').onclick=()=>apiFormAction('test');
$('#btnApiModels').onclick=()=>apiFormAction('models');
$('#btnApiReload').onclick=()=>{if(!apiFormDirty||confirm('重新读取将放弃未保存的 API 修改，继续？'))loadApiConfig(true);};
$('#btnApiDeepSeek').onclick=()=>{$('#apiBaseUrl').value='https://api.deepseek.com';$('#apiChatModel').value='deepseek-flash';$('#apiVisionModel').value='deepseek-flash';apiFormDirty=true;$('#apiConfigStatus').textContent='已填入 DeepSeek 地址和模型，请核对你账号可用的型号后检测、保存。';};
