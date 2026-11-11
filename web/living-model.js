import * as T from 'three';

export function createLivingModel({scene,parts,renderer,key,fill,rim,ambient,complete,isPreview,calm}){
  let definitions=[],lamps=[],last=0,angle=0,flow=0,dusk=0;
  const transform=new T.Matrix4(),rotation=new T.Matrix4(),before=new T.Matrix4(),after=new T.Matrix4();
  const day={key:key.intensity,fill:fill.intensity,rim:rim.intensity,ambient:ambient.intensity,exposure:renderer.toneMappingExposure};

  function configure(recipe,steps){
    for(const lamp of lamps)scene.remove(lamp);
    lamps=[];
    definitions=(recipe.effects||[]).map(effect=>({...effect,trigger:steps.find(step=>step.title===effect.after)}));
    for(const effect of definitions){
      if(effect.kind!=='night')continue;
      for(const position of effect.positions||[]){
        const lamp=new T.PointLight('#ffd09a',0,2.7,2);
        lamp.position.set(...position);lamps.push(lamp);scene.add(lamp);
      }
    }
  }

  const enabled=effect=>isPreview()||effect.trigger&&complete(effect.trigger);

  function frame(now){
    const dt=Math.min(.05,last?(now-last)/1000:0);
    last=now;
    if(document.hidden)return false;
    const night=definitions.some(effect=>effect.kind==='night'&&enabled(effect))?1:0;
    dusk=T.MathUtils.damp(dusk,night,calm()?14:.9,dt);
    if(!calm()){
      angle+=dt*.32;
      flow=(flow+dt*.22)%1;
    }
    return Math.abs(dusk-night)>.002||definitions.some(effect=>effect.kind!=='night'&&enabled(effect)&&!calm());
  }

  function apply(){
    for(const effect of definitions){
      if(!enabled(effect))continue;
      if(effect.kind==='wheel'){
        const pivot=new T.Vector3(...effect.pivot),axis=new T.Vector3().setComponent(effect.axis??1,1);
        before.makeTranslation(pivot);after.makeTranslation(pivot.clone().negate());
        rotation.makeRotationAxis(axis,angle*(effect.speed??.32)/.32);
        transform.copy(before).multiply(rotation).multiply(after);
        for(const name of effect.parts){
          const part=parts.get(name);if(!part)continue;
          part.node.matrix.copy(transform).multiply(part.baseline);
          part.node.matrixWorldNeedsUpdate=true;
        }
      }
      if(effect.kind==='water'){
        for(const name of effect.parts){
          const part=parts.get(name);if(!part)continue;
          for(const entry of part.meshes)for(const material of [entry.base,entry.clip].flat()){
            if(material.map){material.map.wrapS=material.map.wrapT=T.RepeatWrapping;material.map.offset.y=-flow;material.map.updateMatrix()}
          }
        }
      }
    }
    scene.backgroundIntensity=1-dusk*.66;
    key.intensity=day.key*(1-dusk*.67);
    fill.intensity=day.fill*(1-dusk*.63);
    rim.intensity=day.rim*(1+dusk*.3);
    ambient.intensity=day.ambient*(1-dusk*.53);
    renderer.toneMappingExposure=day.exposure*(1-dusk*.08);
    for(const lamp of lamps)lamp.intensity=dusk*9;
    for(const effect of definitions){
      if(effect.kind!=='night')continue;
      for(const name of effect.parts){
        const part=parts.get(name);if(!part)continue;
        for(const entry of part.meshes)for(const material of [entry.base,entry.clip].flat()){
          if(material.emissive?.getHex())material.emissiveIntensity=.1+dusk*2.2;
        }
      }
    }
  }

  return {configure,frame,apply};
}
