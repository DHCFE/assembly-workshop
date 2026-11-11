const ui=Object.fromEntries([...document.querySelectorAll('[id]')].map(element=>[element.id,element]));
const api='../api/';
let timer,previewUrl;
async function request(path,options){
  const response=await fetch(api+path,{cache:'no-store',...options});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error);
  return body;
}
function message(text,error=false){ui.status.textContent=text;ui.status.toggleAttribute('data-error',error)}
function controls(config){
  ui.login.hidden=!config.needsAccess;
  ui.photo.hidden=config.needsAccess||!config.generation;
  ui.setup.hidden=config.needsAccess||config.generation;
  ui.projects.hidden=config.needsAccess;
  message(config.needsAccess?'输入自建服务的访问口令。':config.generation?'':'当前入口提供内置场景。照片开工需要接通生成服务。');
}
async function refresh(){
  clearTimeout(timer);
  const jobs=await request('projects');
  ui.projects.hidden=!jobs.length;
  ui.jobs.replaceChildren(...jobs.map(job=>{
    const item=document.createElement('li');
    const date=document.createElement('strong');
    date.textContent=new Date(job.created).toLocaleString();
    const summary=document.createElement('span');summary.textContent=job.message;
    item.append(date,summary);
    if(job.playUrl){const link=document.createElement('a');link.href=job.playUrl;link.textContent='继续搭建';item.append(link)}
    if(job.status==='stopped'){
      const button=document.createElement('button');button.type='button';button.textContent='继续生成';
      button.addEventListener('click',async()=>{
        button.disabled=true;
        try{await request(`projects/${job.id}/retry`,{method:'POST'});await refresh()}
        catch(error){message(error.message,true);button.disabled=false}
      });
      item.append(button);
    }
    return item;
  }));
  if(jobs.some(job=>job.status==='building'))timer=setTimeout(()=>refresh().catch(error=>message(error.message,true)),1800);
}
async function connect(){
  try{const config=await request('config');controls(config);if(!config.needsAccess)await refresh()}
  catch{ui.setup.hidden=false;message('这个网页可以直接试玩。上传照片需要运行生成服务。')}
}
ui.login.addEventListener('submit',async event=>{
  event.preventDefault();
  try{
    await request('session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:ui.token.value})});
    ui.token.value='';await connect();
  }catch(error){message(error.message,true)}
});
ui.reference.addEventListener('change',()=>{
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  const file=ui.reference.files[0];
  ui.preview.hidden=!file;
  if(file){previewUrl=URL.createObjectURL(file);ui.preview.src=previewUrl}
  message(file?.size>12*1024**2?'图片需小于 12 MB。':'',file?.size>12*1024**2);
});
ui.photo.addEventListener('submit',async event=>{
  event.preventDefault();
  const image=ui.reference.files[0];
  if(!image||image.size>12*1024**2){message('请选择 12 MB 以内的图片。',true);return}
  ui.start.disabled=true;message('正在准备地台…');
  try{
    const job=await request('projects',{method:'POST',headers:{'Content-Type':image.type||'application/octet-stream'},body:image});
    while(true){
      const state=await request(`projects/${job.id}`);
      if(state.playUrl){location.assign(state.playUrl);return}
      if(state.status==='stopped')throw new Error(state.message);
      message(state.message);
      await new Promise(resolve=>setTimeout(resolve,800));
    }
  }catch(error){message(error.message,true);await refresh().catch(()=>{})}
  finally{ui.start.disabled=false}
});
connect();
