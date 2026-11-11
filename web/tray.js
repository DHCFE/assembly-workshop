import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

const boxGeometry=new RoundedBoxGeometry(1,1,1,2,.07);

function woodGrain(){
  const paper=document.createElement('canvas');
  paper.width=512;paper.height=192;
  const brush=paper.getContext('2d');
  brush.fillStyle='#f6e7d0';
  brush.fillRect(0,0,paper.width,paper.height);
  for(let row=0;row<paper.height;row+=2){
    const phase=row*.187;
    brush.strokeStyle=`rgba(121,76,39,${.03+.055*(.5+.5*Math.sin(phase*7))})`;
    brush.lineWidth=.8+(row%4)*.3;
    brush.beginPath();
    for(let x=0;x<=paper.width;x+=8){
      const grain=row+Math.sin(x*.016+phase)*1.8+Math.sin(x*.049-phase)*.7;
      if(x===0)brush.moveTo(x,grain);else brush.lineTo(x,grain);
    }
    brush.stroke();
  }
  const texture=new T.CanvasTexture(paper);
  texture.colorSpace=T.SRGBColorSpace;
  return texture;
}
const grain=woodGrain();
const baseMaterial=new T.MeshStandardMaterial({color:'#bd8c60',map:grain,roughness:.67});
const rimMaterial=new T.MeshStandardMaterial({color:'#e0af80',map:grain,roughness:.63});
const pocketMaterial=new T.MeshStandardMaterial({color:'#a6754c',map:grain,roughness:.84});

function trayShadow(){
  const paper=document.createElement('canvas');
  paper.width=paper.height=128;
  const brush=paper.getContext('2d');
  const fade=brush.createRadialGradient(64,64,16,64,64,64);
  fade.addColorStop(0,'#4b311d64');fade.addColorStop(.57,'#4b311d52');fade.addColorStop(1,'#4b311d00');
  brush.fillStyle=fade;brush.fillRect(0,0,128,128);
  const texture=new T.CanvasTexture(paper);
  texture.colorSpace=T.SRGBColorSpace;
  return new T.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,toneMapped:false});
}
const shadowGeometry=new T.PlaneGeometry(1,1),shadowMaterial=trayShadow();
const extents=(size,axis)=>Math.abs(axis.x)*size.x+Math.abs(axis.y)*size.y;

function makeBox(material,size,center){
  const mesh=new T.Mesh(boxGeometry,material);
  mesh.position.set(...center);
  mesh.scale.set(...size);
  return mesh;
}

export function createTray({scene,camera,viewport,hitLayer,target,label,copyStart,read,lock,notify,seat,wake,calm}){
  let current=null,held=null,motion=null;
  const ray=new T.Raycaster();
  const zero=new T.Vector3();
  const identity=new T.Quaternion();
  const rotation=new T.Quaternion(),inverseView=new T.Quaternion();
  const tilt=new T.Euler();
  const offset=new T.Vector3();
  const liftShadow=new T.Mesh(shadowGeometry,shadowMaterial.clone());
  liftShadow.visible=false;
  liftShadow.renderOrder=-1;
  scene.add(liftShadow);

  function point(v){
    const p=v.clone().project(camera);
    return new T.Vector2((p.x+1)*viewport.clientWidth/2,(1-p.y)*viewport.clientHeight/2);
  }

  function projected(box,offset){
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
      const p=point(new T.Vector3(x,y,z).add(offset));
      left=Math.min(left,p.x);right=Math.max(right,p.x);
      top=Math.min(top,p.y);bottom=Math.max(bottom,p.y);
    }
    return {left,top,width:right-left,height:bottom-top};
  }

  function position(element,rect,minSize=0){
    const width=Math.max(minSize,rect.width),height=Math.max(minSize,rect.height);
    element.style.width=width+'px';element.style.height=height+'px';
    element.style.left=(rect.left+(rect.width-width)/2)+'px';
    element.style.top=(rect.top+(rect.height-height)/2)+'px';
  }

  function build(stage,sceneBounds,direction){
    if(current?.key===stage?.key)return;
    if(current)scene.remove(current.group);
    current=null;
    hitLayer.replaceChildren();
    if(!stage)return;
    const group=new T.Group(),board=new T.Group(),size=sceneBounds.getSize(new T.Vector3());
    group.add(board);
    const near=new T.Vector3(direction.x,direction.y,0);
    if(near.lengthSq()<.01)near.set(0,-1,0);
    near.normalize();
    const right=new T.Vector3(-near.y,near.x,0);
    const items=stage.steps.map(step=>{
      const geometry=copyStart(step),box=new T.Box3().setFromObject(geometry,true);
      const center=box.getCenter(new T.Vector3()),dims=box.getSize(new T.Vector3());
      const mesh=new T.Group();
      geometry.position.copy(center).negate();
      mesh.add(geometry);
      group.add(mesh);
      const weight=T.MathUtils.clamp(dims.length()/Math.max(1,size.length()),.05,1);
      return {step,mesh,box,center,dims,weight,slot:new T.Vector3()};
    });
    const spacing=T.MathUtils.clamp(Math.min(size.x,size.y)*.037,.26,.78);
    const widths=items.map(item=>Math.max(spacing*2,extents(item.dims,right)+spacing*1.5));
    const depth=Math.max(spacing*2,...items.map(item=>extents(item.dims,near)+spacing*1.5))+spacing;
    const stageCenter=new T.Vector3();
    for(const item of items)stageCenter.add(item.center);
    stageCenter.multiplyScalar(1/items.length);
    const sum=values=>values.reduce((total,value)=>total+value,0);
    const width=sum(widths)+spacing;
    const sceneCenter=sceneBounds.getCenter(new T.Vector3());
    const offset=extents(size,near)/2+depth/2+spacing*1.9;
    board.position.copy(sceneCenter).addScaledVector(near,offset)
      .addScaledVector(right,stageCenter.clone().sub(sceneCenter).dot(right));
    board.position.z=sceneBounds.min.z;
    board.rotation.z=Math.atan2(right.y,right.x);
    const z=spacing*.54;
    board.add(makeBox(baseMaterial,[width,depth,z],[0,0,-z/2]));
    const edge=spacing*.32;
    for(const side of [-1,1]){
      board.add(makeBox(rimMaterial,[width,edge,edge],[0,side*(depth-edge)/2,edge/2]));
      board.add(makeBox(rimMaterial,[edge,depth,edge],[side*(width-edge)/2,0,edge/2]));
    }
    let offsetX=-sum(widths)/2;
    items.forEach((item,index)=>{
      const cellWidth=widths[index];
      const x=offsetX+cellWidth/2;
      if(index>0)board.add(makeBox(rimMaterial,[edge,depth-edge,edge],[offsetX,0,edge/2]));
      board.add(makeBox(pocketMaterial,[cellWidth-edge,depth-edge*2.4,edge*.33],[x,0,edge*.17]));
      offsetX+=cellWidth;
      const location=board.position.clone().addScaledVector(right,x);
      location.z+=item.dims.z/2+edge*.33;
      item.slot.copy(location);
      item.mesh.position.copy(item.slot);
      const button=document.createElement('button');
      button.type='button';button.className='tray-piece';
      button.dataset.step=item.step.id;
      button.setAttribute('aria-label',item.step.title.replace(/\.\d{3}$/,'')+' · 盒中零件');
      button.addEventListener('pointerdown',event=>pick(event,item));
      button.addEventListener('pointermove',move);
      for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,release);
      button.addEventListener('click',event=>{
        if(event.detail!==0||held||motion||!read().picking)return;
        if(item.step.id===read().active.id)land(item,true);
        else notify('这件留在盒里，先找和轮廓相合的零件。');
      });
      item.button=button;
      hitLayer.append(button);
    });
    scene.add(group);
    group.updateMatrixWorld(true);
    current={key:stage.key,group,items,box:new T.Box3().setFromObject(group),label:stage.label,shadowZ:board.position.z+edge*.35};
    const shadow=new T.Mesh(shadowGeometry,shadowMaterial);
    shadow.scale.set(width*1.18,depth*1.9,1);
    shadow.position.set(width*.023,-depth*.14,-z-.022);
    shadow.renderOrder=-1;
    board.add(shadow);
  }

  function readRay(event){
    const rect=viewport.getBoundingClientRect();
    const p=new T.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
    camera.updateMatrixWorld(true);
    ray.setFromCamera(p,camera);
    return ray.ray;
  }

  function pick(event,item){
    if(event.button!==0||held||!read().picking)return;
    if(motion&&(motion.accepted||motion.item!==item))return;
    event.preventDefault();
    lock(true,true);
    const currentPosition=item.mesh.position.clone();
    const plane=new T.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new T.Vector3()),currentPosition);
    const origin=readRay(event).intersectPlane(plane,new T.Vector3());
    if(!origin){if(!motion)lock(false);return}
    item.button.setPointerCapture(event.pointerId);
    const now=performance.now();
    held={item,id:event.pointerId,plane,offset:currentPosition.clone().sub(origin),position:currentPosition,
      start:now,last:now,x:event.clientX,y:event.clientY,vx:0,vy:0,pitch:0,yaw:0,near:false,from:item.mesh.quaternion.clone()};
    motion=null;
    viewport.setAttribute('data-picking-part','');
    wake();
  }

  function move(event){
    if(held?.id!==event.pointerId)return;
    const world=readRay(event).intersectPlane(held.plane,new T.Vector3());
    if(!world)return;
    const {item}=held;
    held.position.copy(world).add(held.offset);
    const now=performance.now();
    const dt=Math.max(now-held.last,8);
    const dx=event.clientX-held.x,dy=event.clientY-held.y;
    if(Math.abs(dx)+Math.abs(dy)>.3){
      held.vx=dx/dt;held.vy=dy/dt;
      held.pitch=T.MathUtils.clamp(held.vy*.045,-.12,.12);
      held.yaw=T.MathUtils.clamp(held.vx*.055,-.14,.14);
      held.last=now;held.x=event.clientX;held.y=event.clientY;
    }
    const match=item.step.id===read().active.id;
    const marker=point(held.position);
    const goal=point(item.center);
    const region=projected(item.box,zero);
    const tolerance=T.MathUtils.clamp(Math.min(region.width,region.height)*.36,32,70);
    held.near=match&&marker.distanceTo(goal)<=tolerance;
    wake();
  }

  function release(event){
    if(held?.id!==event.pointerId)return;
    if(event.type==='pointerup')move(event);
    const {item}=held;
    let near=held.near;
    if(!near&&event.type==='pointerup'&&item.step.id===read().active.id&&read().combo>0&&item.weight<.38&&performance.now()-held.last<95){
      const marker=point(held.position),goal=point(item.center);
      const projected=marker.clone().add(new T.Vector2(held.vx,held.vy).multiplyScalar(100));
      near=marker.distanceTo(goal)<165&&projected.distanceTo(goal)<43;
    }
    held=null;
    viewport.removeAttribute('data-picking-part');
    if(!near&&event.type==='pointerup')notify(item.step.id===read().active.id?'把零件的中心拖进描边。':'这件留在盒里，先找和轮廓相合的零件。');
    land(item,near&&event.type==='pointerup');
  }

  function land(item,accepted){
    lock(true);
    motion={item,accepted,from:item.mesh.position.clone(),to:accepted?item.center:item.slot,start:performance.now(),
      fromRotation:item.mesh.quaternion.clone(),shadow:liftShadow.visible,duration:(120+item.weight*220)*(accepted?(read().tempo??1):1)};
    wake();
  }

  function paintShadow(item,at,lift){
    liftShadow.visible=lift>.005;
    const spread=1+lift*.27;
    liftShadow.scale.set(Math.max(.3,item.dims.x*1.32)*spread,Math.max(.32,item.dims.y*1.48)*spread,1);
    liftShadow.position.set(at.x+.08*lift,at.y+.1*lift,current.shadowZ);
    liftShadow.material.opacity=.88*lift;
  }

  function lift(now){
    const {item,start,last,position,pitch,yaw,from}=held;
    const progress=T.MathUtils.clamp((now-start)/(calm()?36:155),0,1);
    const raised=1-(1-progress)**3;
    const lean=calm()?0:Math.exp(-Math.max(0,now-last)/95);
    const depth=(calm()?.03:.085-item.weight*.035)*raised;
    // Move toward the camera on the same view ray, keeping the grabbed spot under the pointer.
    item.mesh.position.copy(position).lerp(camera.position,depth);
    if(!calm()){
      const lightness=1-item.weight*.65;
      tilt.set((-.05+pitch*lean)*lightness,(.045+yaw*lean)*lightness,0);
      inverseView.copy(camera.quaternion).invert();
      rotation.setFromEuler(tilt).premultiply(camera.quaternion).multiply(inverseView);
      item.mesh.quaternion.copy(from).slerp(rotation,raised);
    }
    paintShadow(item,position,raised);
    return progress<1||(!calm()&&lean>.015);
  }

  function frame(now){
    if(held)return lift(now);
    if(!motion)return false;
    const t=T.MathUtils.clamp((now-motion.start)/(calm()?35:motion.duration),0,1);
    const {item,from,to,accepted,fromRotation,shadow}=motion;
    const eased=1-(1-t)**3;
    item.mesh.position.lerpVectors(from,to,eased);
    item.mesh.quaternion.copy(fromRotation).slerp(identity,eased);
    if(shadow)paintShadow(item,item.mesh.position,1-eased);
    if(t<1)return true;
    motion=null;
    liftShadow.visible=false;
    lock(false);
    if(accepted)seat(item.step,point(item.center)).then(ok=>{
      if(!ok)item.mesh.position.copy(item.slot);
      wake();
    });
    return false;
  }

  function paint(){
    const {visible,picking,active,isSeated}=read();
    const show=visible&&!!current;
    hitLayer.hidden=!show;
    label.hidden=!show;
    target.hidden=true;
    if(!current)return;
    current.group.visible=show;
    if(!show)return;
    const remaining=current.items.filter(item=>!isSeated(item.step)).length;
    label.textContent='零件盒 '+current.label+' · '+remaining+' 件';
    for(const item of current.items){
      const present=!isSeated(item.step);
      item.mesh.visible=present;
      item.button.hidden=!present||!picking;
      if(present&&picking)position(item.button,projected(item.box,offset.copy(item.mesh.position).sub(item.center)),28);
      if(picking&&item.step.id===active.id){
        target.hidden=false;
        target.toggleAttribute('data-near',held?.near===true);
        position(target,projected(item.box,zero),32);
      }
    }
  }

  return {build,paint,frame,near:()=>held?.near===true,busy:()=>!!held||!!motion,bounds:()=>current?.box};
}
