export async function fetchJson(url, options={}) {
  const response = await fetch(url, {cache:'no-store', ...options});
  const result = await response.json().catch(()=>null);
  if (!response.ok || result===null) throw new Error(result?.error || `读取项目失败 (${response.status})`);
  return result;
}

export function checkpointState(checkpoint, project, steps, owners) {
  if (checkpoint?.format!=='assembly-workshop/1' || checkpoint.project!==project) {
    throw new Error('请选择这个建筑的搭建存档。');
  }
  const {values,active}=checkpoint.progress || {};
  if (!values || Array.isArray(values) || typeof values!=='object' || !steps.has(active)) {
    throw new Error('存档格式无效。');
  }
  for (const [id,value] of Object.entries(values)) {
    const step=steps.get(id);
    if (!step || !Number.isFinite(value) || value<0 || value>1) throw new Error('存档里包含未知步骤。');
    if (value && step.revisit && step.parts.some(name=>values[owners.get(name)]!==1)) {
      throw new Error('存档的装配顺序无效。');
    }
  }
  return {values:{...values},active};
}

export function createSession(project, storage=globalThis.localStorage) {
  const key='assembly-workshop:progress:'+project;
  const empty=()=>({values:{},active:'1'});
  let memory=empty(), steps=new Map(), owners=new Map();
  const checkpoint=progress=>({format:'assembly-workshop/1',project,progress});
  function read(){
    try {
      const raw=storage?.getItem(key);
      if(raw)memory=checkpointState(JSON.parse(raw),project,steps,owners);
    }catch{}
    return structuredClone(memory);
  }
  function write(progress){
    memory=structuredClone(progress);
    try{storage?.setItem(key,JSON.stringify(checkpoint(progress)))}catch{}
    return structuredClone(memory);
  }
  function configure(recipe){
    steps=new Map(recipe.chapters.flatMap(chapter=>chapter.steps).map(step=>[step.id,step]));
    owners=new Map([...steps.values()].filter(step=>!step.revisit).flatMap(step=>step.parts.map(name=>[name,step.id])));
  }
  function advance({id,value}){
    const progress=read();
    progress.values[id]=value;
    progress.active=id;
    return write(checkpointState(checkpoint(progress),project,steps,owners));
  }
  return {configure,read,advance,checkpoint:()=>checkpoint(read()),import:payload=>write(checkpointState(payload,project,steps,owners))};
}

export function downloadFile(blob,name){
  const link=document.createElement('a');
  link.href=URL.createObjectURL(blob);
  link.download=name;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}
