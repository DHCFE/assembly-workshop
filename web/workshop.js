import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {createSession,downloadFile,fetchJson} from './session.js';
import interactionRules from '../runtime/interactions.json';
import placementRules from '../runtime/placement.json';
import {createTray} from './tray.js';
import {createLivingModel} from './living-model.js';
import {members,playableRecipe,levelCounts} from './build-levels.js';
import roomImage from './atelier-room.webp';

const ui=Object.fromEntries([...document.querySelectorAll('[id]')].map(node=>[node.id,node]));
const motionQuery=matchMedia('(prefers-reduced-motion: reduce)');
const calm=()=>motionQuery.matches;
const SNAP=.974;
const SOUND_KEY='participatory-3d:sound';

/* ======================= 场景 ======================= */
const scene=new T.Scene();
scene.background=new T.Color('#d3b897');
let room=null;
const lightPreview=new URLSearchParams(location.search).get('quality')==='low'||navigator.hardwareConcurrency<=4;
let renderer;
try{renderer=new T.WebGLRenderer({antialias:!lightPreview})}catch(error){
  ui.loading.setAttribute('data-error','');
  ui.loadingText.classList.remove('sr');
  ui.loadingText.textContent='当前浏览器无法打开 WebGL 2。';
  ui.loadingRetry.hidden=false;
  ui.loadingRetry.textContent='返回场景库';
  ui.loadingRetry.addEventListener('click',()=>location.assign('../../'));
  throw error;
}
renderer.setPixelRatio(Math.min(lightPreview?1:1.5,devicePixelRatio));
renderer.outputColorSpace=T.SRGBColorSpace;
renderer.toneMapping=T.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.06;
renderer.localClippingEnabled=true;
const canvas=renderer.domElement;
ui.viewport.prepend(canvas);
const camera=new T.PerspectiveCamera(36,1,.025,400);
camera.up.set(0,0,1);
const probe=new T.PerspectiveCamera(36,1,.025,400);
probe.up.set(0,0,1);
const controls=new OrbitControls(camera,canvas);
controls.enableDamping=true;
controls.dampingFactor=.12;
controls.autoRotateSpeed=.9;
const ambient=new T.HemisphereLight('#fff5df','#b6a082',2.2);
scene.add(ambient);
const key=new T.DirectionalLight('#ffeccf',2.45);
key.position.set(-8,-12,18);
scene.add(key);
const fill=new T.DirectionalLight('#f0f4ed',.7);
fill.position.set(10,8,9);
scene.add(fill);
const rim=new T.DirectionalLight('#ffdcab',.46);
rim.position.set(4,16,12);
scene.add(rim);
const model=new T.Group();
scene.add(model);
const blocker=new T.Mesh(new T.BoxGeometry(1,1,1),new T.MeshStandardMaterial({color:'#a9825c',roughness:.86}));
blocker.visible=false;
scene.add(blocker);
let floor=null;

const parts=new Map(),owners=new Map(),revisits=new Map();
const clipOps=new Set(['sweep','pour','flow','tread','plant']);
const verbs={lower:'把它落下去',raise:'把它托上来',slide:'推进去',align:'三个方向对准',insert:'嵌进去',
  seat:'扣到底',bridge:'把桥段接上',place:'放到位置上',turn:'绕着轴转过去',hinge:'翻下来合上',
  spread:'铺开',expand:'撑开',stretch:'一端不动，拉开另一端',sweep:'沿线铺过去',pour:'让水落下成形',
  flow:'把水引进来',tread:'一级一级延伸上去',plant:'让它长出来',bend:'掰弯到位',cut:'切掉封石'};
const cnNum=n=>n<=10?'〇一二三四五六七八九十'[n]:n<20?'十'+'〇一二三四五六七八九'[n-10].replace('〇',''):String(n);

const tools={
  drag:{icon:'M5 5h6M5 8h6M5 11h6'},
  crank:{hint:'顺着弧线转动构件',icon:'M4.5 10.5a4.3 4.3 0 0 1 7-4.8M11.5 5.5a4.3 4.3 0 0 1-7 4.8'},
  saw:{hint:'按住锯柄，在两端来回划',icon:'M2 11l8-8 3 3-2 2-2-1-1 3-2-1-1 3-2-1'},
  hold:{hint:'按住阀门让水流动，松手暂停',icon:'M3 5h10M8 5v6M5 11h6M5 3v4M11 3v4'},
  stamp:{hint:'依次点按亮起的位置',icon:'M6 3h4v4l2 2v2H4V9l2-2V3M4 13h8'},
  trace:{hint:'沿着路线描过去，偏离时会停住',icon:'M3 12l3-1 7-7-2-2-7 7-1 3M9 4l2 2'},
};
function interactionFor(step){
  const options=interactionRules[step.op]||['drag'];
  return options.includes(step.interaction)?step.interaction:options[0];
}
const STATIONS=4,SAW_PASSES=4,CRANK_START=-Math.PI*3/4,CRANK_SWEEP=Math.PI*3/2,HOLD_MS=1600;
let tapMotion=null;

let data,sourceRecipe,sourceSteps=[],steps=[],progress,active,chapterIndex=0,preview=true,intro=false,bounds,viewDirection;
let difficulty='hard',difficultyLoaded=false;
let rhythm={time:0,operation:'',chapter:-1,streak:0},impact=null;
let gesture=null,sending=false,confirmed={},finaleDismissed=false;
let record=null,recordUrl,recordStream,tourTimer=0;
let publication=null,pendingVersion=null,session=null;
const loadedAssets=new Set();
const initialMatrix=new T.Matrix4();
const stages=new Map();
const stagedOperations=new Set(placementRules.trayOperations);
const seatedValue=placementRules.seatedValue;
const requiresPart=step=>!step.revisit&&step.placement!=='in_place'&&stagedOperations.has(step.op);
const isSeated=step=>{
  const original=members(step),physical=original.filter(requiresPart);
  return (physical.length?physical:original).every(member=>(confirmed[member.id]??0)>0);
};
const pickingPart=()=>!!active&&!preview&&requiresPart(active)&&!isSeated(active);
const displayTitle=step=>step.title.replace(/\.\d{3}$/,'');
const living=createLivingModel({scene,parts,renderer,key,fill,rim,ambient,
  complete:step=>(confirmed[step.id]??0)>=1,isPreview:()=>preview,calm});

const tray=createTray({
  scene,camera,viewport:ui.viewport,hitLayer:ui.trayPieces,target:ui.placementTarget,label:ui.trayLabel,
  copyStart,calm,wake:render,notify:say,
  read:()=>({active,isSeated,combo:rhythm.streak,tempo:Math.max(.64,1-rhythm.streak*.065),visible:!preview&&stages.has(active?.id),picking:pickingPart()&&!sending}),
  lock(on,picking=false){
    controls.enabled=!on;
    if(picking)clearCue();
    if(on){sfx.unlock();flight=null;settling=false;pendingPose=null;setOrbit(false)}
  },
  seat:async(step,at)=>step.id===active?.id&&pickingPart()&&await commit(seatedValue,at),
});

/* ======================= 声音（Web Audio 现场合成，无外部文件） ======================= */
const sfx=(()=>{
  let ctx=null,master=null,bus=null,dest=null,noise=null;
  let pulseTimer=0,nextPulse=0,pulse=0,tempo=68,targetTempo=68,lastPlacement=0;
  let on=true;
  try{on=localStorage.getItem(SOUND_KEY)!=='0'}catch{}
  const scale=[0,2,4,7,9];
  const note=i=>392*Math.pow(2,(scale[i%5]+12*(Math.floor(i/5)%3))/12);
  function context(){
    if(!ctx){
      const AC=window.AudioContext||window.webkitAudioContext;
      if(!AC)return null;
      ctx=new AC();
      master=ctx.createGain();
      master.gain.value=on?.6:0;
      bus=ctx.createDynamicsCompressor();
      master.connect(bus);
      bus.connect(ctx.destination);
      noise=ctx.createBuffer(1,ctx.sampleRate*.25,ctx.sampleRate);
      const d=noise.getChannelData(0);
      for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2);
    }
    if(ctx.state==='suspended')ctx.resume().then(music).catch(()=>{});
    else music();
    return ctx;
  }
  function voice(type,freq,start,dur,gain,to){
    const osc=ctx.createOscillator(),g=ctx.createGain();
    osc.type=type;
    osc.frequency.setValueAtTime(freq,start);
    if(to)osc.frequency.exponentialRampToValueAtTime(to,start+dur);
    g.gain.setValueAtTime(0,start);
    g.gain.linearRampToValueAtTime(gain,start+.005);
    g.gain.exponentialRampToValueAtTime(.0001,start+dur);
    osc.connect(g);g.connect(master);
    osc.start(start);osc.stop(start+dur+.02);
  }
  function knock(start,gain,cutoff){
    const src=ctx.createBufferSource(),f=ctx.createBiquadFilter(),g=ctx.createGain();
    src.buffer=noise;f.type='lowpass';f.frequency.value=cutoff;
    g.gain.value=gain;
    src.connect(f);f.connect(g);g.connect(master);
    src.start(start);
  }
  function music(){
    if(pulseTimer||!on||!ctx||ctx.state!=='running'||document.hidden)return;
    nextPulse=Math.max(nextPulse,ctx.currentTime+.035);
    scheduleMusic();
  }
  function scheduleMusic(){
    pulseTimer=0;
    if(!on||ctx.state!=='running'||document.hidden)return;
    const melody=[0,2,4,2,1,3,4,1];
    while(nextPulse<ctx.currentTime+.14){
      nextPulse=Math.max(nextPulse,ctx.currentTime+.025);
      const position=pulse++%melody.length,f=note(melody[position])/2;
      voice('sine',f,nextPulse,.8,.017);
      voice('triangle',f*2,nextPulse,.26,.005);
      if(position%2===0)knock(nextPulse,.017,950);
      const desired=ctx.currentTime-lastPlacement<6?targetTempo:68;
      tempo+=(desired-tempo)*.3;
      nextPulse+=60/tempo;
    }
    pulseTimer=setTimeout(scheduleMusic,90);
  }
  addEventListener('visibilitychange',()=>{
    clearTimeout(pulseTimer);pulseTimer=0;
    if(!document.hidden&&ctx)music();
  });
  const live=()=>on&&ctx&&ctx.state==='running';
  return {
    get on(){return on},
    set(value){
      on=value;
      try{localStorage.setItem(SOUND_KEY,value?'1':'0')}catch{}
      if(value)context();
      else{clearTimeout(pulseTimer);pulseTimer=0}
      if(master)master.gain.value=value?.6:0;
    },
    unlock(){if(on)context()},
    tick(p){if(!live())return;voice('triangle',780+760*p,ctx.currentTime,.035,.045)},
    ready(){if(!live())return;const t=ctx.currentTime;voice('sine',1760,t,.09,.05);voice('sine',2640,t+.03,.07,.025)},
    place(i,weight=.3,combo=0){
      if(!live())return;
      targetTempo=Math.max(55,68+combo*9-weight*12);lastPlacement=ctx.currentTime;
      const t=ctx.currentTime,f=note(i)*Math.min(1.22,1+combo*.035);
      knock(t,.27+weight*.45,1500-weight*900);
      voice('sine',230-weight*140,t,.09+weight*.18,.22+weight*.32,60);
      voice('sine',f,t+.02,.55+weight*.5,.11);
      voice('sine',f*2.01,t+.02,.25,.025);
    },
    area(i){
      if(!live())return;
      const t=ctx.currentTime+.12;
      [0,1,2,4].forEach((k,j)=>{const f=note(i+k);voice('sine',f,t+j*.09,1.5,.09);voice('triangle',f/2,t+j*.09,.8,.03)});
    },
    finale(){
      if(!live())return;
      const t=ctx.currentTime+.1;
      [0,2,4,5,7,9,10].forEach((k,j)=>voice('sine',note(k),t+j*.11,2.2,.08));
    },
    stream(){
      if(!context())return null;
      if(!dest){dest=ctx.createMediaStreamDestination();bus.connect(dest)}
      return dest.stream;
    },
  };
})();

/* ======================= 帧循环：有东西在动才渲染 ======================= */
let raf=0,dirty=false,flight=null,settling=false,orbiting=false,pendingDraft=null;
const glows=[];
function render(){dirty=true;wake()}
function wake(){if(!raf)raf=requestAnimationFrame(tick)}
function tick(now){
  raf=0;
  const trayWasMoving=tray.busy();
  let more=tray.frame(now);
  if(trayWasMoving)dirty=true;
  if(living.frame(now)){more=true;dirty=true}
  if(impact){
    if(now-impact.start>240)impact=null;
    else{more=true;dirty=true}
  }
  if(gesture?.tool==='hold'&&gesture.last<SNAP){
    if(gesture.holdStarted!==null)moveTool(Math.min(1,gesture.base+(now-gesture.holdStarted)/HOLD_MS));
    more=gesture.holdStarted!==null;
  }
  if(tapMotion){
    const t=T.MathUtils.clamp((now-tapMotion.start)/180,0,1);
    if(t<1){applyDraft(T.MathUtils.lerp(tapMotion.from,tapMotion.to,1-(1-t)**3));more=true}
    else{
      const {to}=tapMotion;
      tapMotion=null;
      commit(to);
    }
  }
  if(flight)more=stepFlight(now)||more;
  if(glows.length)more=stepGlows(now)||more;
  if(orbiting||settling){
    const moved=controls.update();
    settling=settling&&moved;
    more=more||orbiting||settling;
  }
  if(pendingDraft!==null){const p=pendingDraft;pendingDraft=null;applyDraft(p)}
  if(dirty){dirty=false;paint()}
  if(more)wake();
}

/* ======================= 镜头：礼让玩家 ======================= */
// 玩家正在旋转/缩放，或刚停手 1.1 秒内，自动镜头一律排队；玩家自己摆好的角度若能看清下一件，就不再飞。
let cameraHeld=false,lastCameraTouch=-1e9,manualView=false,pendingPose=null,pendingTimer=0;
controls.addEventListener('change',render);
controls.addEventListener('start',()=>{
  cameraHeld=true;lastCameraTouch=performance.now();manualView=true;
  flight=null;settling=false;setOrbit(false);
});
controls.addEventListener('end',()=>{cameraHeld=false;lastCameraTouch=performance.now();settling=true;wake()});
const cameraBusy=()=>cameraHeld||performance.now()-lastCameraTouch<1100;

function poseFor(box,direction){
  const center=box.getCenter(new T.Vector3());
  probe.fov=camera.fov;probe.aspect=camera.aspect;probe.updateProjectionMatrix();
  probe.position.copy(center).addScaledVector(direction,20);
  probe.lookAt(center);
  const rotation=probe.quaternion.clone().invert();
  const halfFov=Math.tan(camera.fov*Math.PI/360);
  const vertical=halfFov*.92;
  const horizontal=halfFov*camera.aspect*.95;
  let distance=3.5;
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
    const corner=new T.Vector3(x,y,z).sub(center).applyQuaternion(rotation);
    distance=Math.max(distance,corner.z+Math.abs(corner.x)/horizontal,corner.z+Math.abs(corner.y)/vertical);
  }
  return {target:center,position:center.clone().addScaledVector(direction,distance)};
}
function pathPixels(step,pose){
  probe.position.copy(pose.position);probe.lookAt(pose.target);probe.updateMatrixWorld();
  const w=ui.viewport.clientWidth,h=ui.viewport.clientHeight;
  let length=0,last=null;
  for(const point of step.handles){
    const p=new T.Vector3(...point).project(probe);
    const s=new T.Vector2((p.x+1)*w/2,(1-p.y)*h/2);
    if(last)length+=s.distanceTo(last);
    last=s;
  }
  return length;
}
const currentDirection=()=>camera.position.clone().sub(controls.target).normalize();
function localBox(step){
  const [lo,hi]=step.bounds.map(v=>new T.Vector3(...v));
  const box=new T.Box3(lo,hi);
  for(const point of step.handles)box.expandByPoint(new T.Vector3(...point));
  return box.expandByScalar(.9);
}
function stepPose(step,base){
  const box=localBox(step);
  const need=T.MathUtils.clamp(Math.min(ui.viewport.clientWidth,ui.viewport.clientHeight)*.14,40,90);
  const pose=poseFor(box,base),length=pathPixels(step,pose);
  if(length>=need)return pose;
  const z=new T.Vector3(0,0,1);
  let best=pose,bestLength=length;
  for(const deg of [20,-20,35,-35]){
    const candidate=poseFor(box,base.clone().applyAxisAngle(z,deg*Math.PI/180));
    const l=pathPixels(step,candidate);
    if(l>bestLength){best=candidate;bestLength=l}
  }
  return bestLength>=Math.max(length*1.6,length+20)?best:pose;
}
// 当前镜头下，这一件的整条轨迹都在画面里吗？
function reachable(step){
  const w=ui.viewport.clientWidth,h=ui.viewport.clientHeight,m=Math.min(56,w*.08);
  let raw=0,last=null;
  for(const point of step.handles){
    const p=new T.Vector3(...point).project(camera);
    if(p.z>1)return false;
    const s=new T.Vector2((p.x+1)*w/2,(1-p.y)*h/2);
    if(s.x<m||s.x>w-m||s.y<m||s.y>h-m)return false;
    if(last)raw+=s.distanceTo(last);
    last=s;
  }
  return raw>=8;
}

const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
function flyTo(pose,duration=760){
  fittedAspect=camera.aspect;
  pendingPose=null;
  setOrbit(false);
  settling=false;
  if(calm()||!duration){
    flight=null;
    camera.position.copy(pose.position);
    controls.target.copy(pose.target);
    controls.update();
    render();
    return;
  }
  const fromTarget=controls.target.clone();
  const fromOffset=camera.position.clone().sub(fromTarget);
  const toOffset=pose.position.clone().sub(pose.target);
  const travel=fromTarget.distanceTo(pose.target)+Math.abs(fromOffset.length()-toOffset.length())
    +fromOffset.clone().normalize().angleTo(toOffset.clone().normalize())*toOffset.length();
  flight={start:performance.now(),duration:T.MathUtils.clamp(duration*(.55+travel/40),380,1150),
    fromTarget,toTarget:pose.target.clone(),
    toDir:new T.Quaternion().setFromUnitVectors(fromOffset.clone().normalize(),toOffset.clone().normalize()),
    fromOffset,fromLength:fromOffset.length(),toLength:toOffset.length()};
  wake();
}
function stepFlight(now){
  const f=flight,t=Math.min(1,(now-f.start)/f.duration),k=ease(t);
  const q=new T.Quaternion().slerp(f.toDir,k);
  const length=f.fromLength*Math.pow(f.toLength/f.fromLength,k);
  controls.target.lerpVectors(f.fromTarget,f.toTarget,k);
  camera.position.copy(controls.target).add(f.fromOffset.clone().normalize().applyQuaternion(q).multiplyScalar(length));
  camera.lookAt(controls.target);
  if(t>=1){flight=null;controls.update()}
  render();
  return !!flight;
}
function landFlight(){if(flight)stepFlight(flight.start+flight.duration)}
// polite=true：自动接续发起的镜头，要等玩家停手
function aimAt(pose,polite){
  clearTimeout(pendingTimer);
  if(polite&&cameraBusy()){
    pendingPose=pose;
    const retry=()=>{
      if(!pendingPose)return;
      if(cameraBusy()){pendingTimer=setTimeout(retry,250);return}
      if(manualView&&active&&!preview&&reachable(active)){pendingPose=null;return}
      manualView=false;
      flyTo(pendingPose);
    };
    pendingTimer=setTimeout(retry,250);
    return;
  }
  manualView=false;
  flyTo(pose);
}
function setOrbit(on){
  orbiting=on;
  controls.autoRotate=on;
  ui.orbit.setAttribute('aria-pressed',String(on));
  if(on){flight=null;wake()}
}

let refitTimer=0,fittedAspect=0;
function fitRoom(w,h){
  if(!room||!w||!h)return;
  const imageRatio=room.image.width/room.image.height;
  const viewportRatio=w/h;
  const portrait=viewportRatio<.72;
  const width=Math.min(1,Math.max(viewportRatio/imageRatio,portrait?.43:.91));
  const height=Math.min(1,imageRatio/viewportRatio);
  room.repeat.set(width,height);
  room.offset.set((1-width)*(portrait?.045:.5),(1-height)*.5);
  room.updateMatrix();
}
async function loadRoom(){
  try{
    room=await new T.TextureLoader().loadAsync(roomImage);
    room.colorSpace=T.SRGBColorSpace;
    room.minFilter=T.LinearFilter;
    scene.background=room;
    fitRoom(ui.viewport.clientWidth,ui.viewport.clientHeight);
    render();
  }catch(error){console.warn('Could not load the workshop room.',error)}
}
function resize(){
  const w=ui.viewport.clientWidth,h=ui.viewport.clientHeight;
  if(!w||!h)return;
  camera.aspect=w/h;
  camera.updateProjectionMatrix();
  renderer.setSize(w,h,false);
  fitRoom(w,h);
  render();
  clearTimeout(refitTimer);
  if(bounds&&fittedAspect&&Math.abs(Math.log(camera.aspect/fittedAspect))>.18)refitTimer=setTimeout(()=>{
    if(gesture||tray.busy()||orbiting||cameraBusy())return;
    fittedAspect=camera.aspect;
    const direction=currentDirection();
    flyTo(preview?tabletopPose(bounds,direction):constructionPose(active,direction),420);
  },220);
  if(!fittedAspect&&bounds)fittedAspect=camera.aspect;
}
new ResizeObserver(resize).observe(ui.viewport);

function screen(position){
  const p=new T.Vector3(...position).project(camera);
  return new T.Vector2((p.x+1)*ui.viewport.clientWidth/2,(1-p.y)*ui.viewport.clientHeight/2);
}

/* ======================= 拖动轨迹（屏幕空间） ======================= */
// 轨迹太短时以起点为中心放大成一条够长的拉线：每一件都要真的拉一段，而不是点一下。
const minTravel=()=>T.MathUtils.clamp(Math.min(ui.viewport.clientWidth,ui.viewport.clientHeight)*.24,90,170);
function screenPath(step,fixedK){
  const pts=step.handles.map(screen);
  let raw=0;
  for(let i=1;i<pts.length;i++)raw+=pts[i].distanceTo(pts[i-1]);
  const origin=pts[0];
  let k=fixedK??(raw>.5?T.MathUtils.clamp(minTravel()/raw,1,5):1);
  if(fixedK===undefined&&k>1){
    const w=ui.viewport.clientWidth,h=ui.viewport.clientHeight,margin=36;
    for(const p of pts){
      const dx=p.x-origin.x,dy=p.y-origin.y;
      if(dx>0)k=Math.min(k,(w-margin-origin.x)/dx);
      if(dx<0)k=Math.min(k,(margin-origin.x)/dx);
      if(dy>0)k=Math.min(k,(h-margin-origin.y)/dy);
      if(dy<0)k=Math.min(k,(margin-origin.y)/dy);
    }
    k=Math.max(1,k);
  }
  return {raw,k,points:k===1?pts:pts.map(q=>origin.clone().add(q.clone().sub(origin).multiplyScalar(k)))};
}
function pointAt(path,p){
  const k=p*(path.length-1),i=Math.min(path.length-2,Math.floor(k));
  return path[i].clone().lerp(path[i+1],k-i);
}

function toolGuide(step){
  const tool=interactionFor(step),guide=screenPath(step);
  if(!['crank','saw','stamp'].includes(tool))return {...guide,tool};
  const w=ui.viewport.clientWidth,h=ui.viewport.clientHeight;
  const radius=T.MathUtils.clamp(Math.min(w,h)*.11,46,88);
  const center=pointAt(guide.points,.5);
  center.x=T.MathUtils.clamp(center.x,radius+37,w-radius-37);
  center.y=T.MathUtils.clamp(center.y,radius+65,h-radius-85);
  if(tool==='crank'){
    const points=Array.from({length:49},(_,index)=>{
      const angle=CRANK_START+CRANK_SWEEP*index/48;
      return center.clone().add(new T.Vector2(Math.cos(angle),Math.sin(angle)).multiplyScalar(radius));
    });
    return {...guide,tool,points,center,radius};
  }
  const along=guide.points.at(-1).clone().sub(guide.points[0]);
  if(along.length()<8)along.set(1,0);
  along.normalize().multiplyScalar(radius);
  if(tool==='saw')return {...guide,tool,points:[center.clone().sub(along),center.clone().add(along)]};
  const points=Array.from({length:STATIONS},(_,index)=>center.clone().addScaledVector(along,2*index/(STATIONS-1)-1));
  return {...guide,tool,points};
}

function toolPosition(guide,p){
  if(guide.tool==='hold')return guide.points[0];
  if(guide.tool==='saw')return pointAt(guide.points,gesture?.position??0);
  if(guide.tool==='stamp')return guide.points[Math.min(STATIONS-1,Math.floor((tapMotion?.from??p)*STATIONS+.001))];
  return pointAt(guide.points,p);
}
function nearest(path,lengths,point,previous,reach){
  const n=path.length-1;
  const k0=previous*n,i0=Math.min(n-1,Math.floor(k0));
  const from=lengths[i0]+(lengths[i0+1]-lengths[i0])*(k0-i0);
  const lo=from-reach,hi=from+reach;
  let answer=previous,distance=Infinity;
  for(let i=0;i<n;i++){
    const a=lengths[i],b=lengths[i+1];
    if(b<lo||a>hi||b-a<.001)continue;
    const segment=path[i+1].clone().sub(path[i]);
    const to=point.clone().sub(path[i]);
    const t=T.MathUtils.clamp(segment.dot(to)/segment.lengthSq(),Math.max(0,(lo-a)/(b-a)),Math.min(1,(hi-a)/(b-a)));
    const d=to.addScaledVector(segment,-t).lengthSq();
    if(d<distance){distance=d;answer=(i+t)/n}
  }
  return answer;
}

/* ======================= 构件轮廓与加工引导 ======================= */
const ghostMaterial=new T.MeshStandardMaterial({color:'#eee4a5',emissive:'#a88a3c',emissiveIntensity:.38,
  roughness:1,transparent:true,opacity:.26,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
const ghostCold=new T.Color('#e8dea2'),ghostWarm=new T.Color('#fff1b9');
let ghost=null;
function paint(){
  const placing=pickingPart();
  const show=!!active&&!preview&&!intro&&!placing&&(!done(active)||!!gesture||!!tapMotion||sending);
  const p=active?value(active):0;
  const snapping=show&&(!!gesture||sending)&&p>=SNAP;
  if(ghost){
    const near=placing&&tray.near();
    ghost.visible=show||placing;
    ghostMaterial.opacity=placing?(near?.6:.38):.14+.24*p;
    ghostMaterial.emissiveIntensity=near?.82:.38;
    ghostMaterial.color.copy(ghostCold).lerp(ghostWarm,near||snapping?1:p>.85?(p-.85)/.15*.6:0);
  }
  camera.updateMatrixWorld(true);
  tray.paint();
  living.apply();
  const shaking=impact&&!calm()&&!gesture&&!tray.busy();
  if(shaking){
    const t=(performance.now()-impact.start)/240;
    const amount=impact.strength*(1-t)**2;
    camera.setViewOffset(ui.viewport.clientWidth,ui.viewport.clientHeight,Math.sin(t*24)*amount,Math.cos(t*31)*amount,ui.viewport.clientWidth,ui.viewport.clientHeight);
  }
  renderer.render(scene,camera);
  if(shaking)camera.clearViewOffset();
  ui.knob.hidden=!show;
  ui.guide.toggleAttribute('hidden',!show);
  if(!show)return;
  const g=gesture?.guide??toolGuide(active);
  const tool=g.tool;
  ui.guide.dataset.tool=ui.knob.dataset.tool=tool;
  const path=g.points,n=path.length-1;
  const pos=toolPosition(g,p);
  const at=pointAt(path,p),cut=Math.floor(p*n);
  const ahead=tool==='saw'||tool==='stamp'?path:[at,...path.slice(cut+1)];
  const behind=[...path.slice(0,cut+1),at];
  const end=path.at(-1);
  ui.path.setAttribute('points',ahead.map(v=>v.x+','+v.y).join(' '));
  ui.trail.setAttribute('points',behind.map(v=>v.x+','+v.y).join(' '));
  ui.socket.setAttribute('cx',end.x);ui.socket.setAttribute('cy',end.y);
  ui.pivot.toggleAttribute('hidden',tool!=='crank');
  if(tool==='crank'){
    ui.pivot.setAttribute('cx',g.center.x);
    ui.pivot.setAttribute('cy',g.center.y);
  }
  ui.stations.toggleAttribute('hidden',tool!=='stamp'&&tool!=='saw');
  if(tool==='stamp'||tool==='saw'){
    const marks=ui.stations.children;
    for(let i=0;i<marks.length;i++){
      const mark=marks[i],point=path[i];
      mark.toggleAttribute('hidden',!point);
      if(!point)continue;
      mark.setAttribute('cx',point.x);mark.setAttribute('cy',point.y);
      mark.toggleAttribute('data-done',tool==='stamp'&&i<Math.floor(p*STATIONS+.001));
      mark.toggleAttribute('data-target',tool==='saw'?i===(gesture?.direction===-1?0:1):point===pos);
    }
  }
  ui.guide.toggleAttribute('data-near',!!gesture&&p>=.85);
  ui.guide.toggleAttribute('data-snap',snapping);
  ui.knob.style.transform=`translate(${pos.x}px,${pos.y}px)`;
  ui.knob.toggleAttribute('data-snap',snapping);
  ui.knob.toggleAttribute('data-busy',sending||!!tapMotion);
  ui.toolIcon.setAttribute('d',tools[tool].icon);
  ui.knob.setAttribute('aria-valuenow',String(Math.round(p*100)));
  ui.knob.setAttribute('aria-valuetext',Math.round(p*100)+'%');
}

/* ======================= 构件 ======================= */
function sample(series,p){
  const k=p*(series.length-1),i=Math.min(series.length-2,Math.floor(k));
  return [series[i],series[i+1],k-i];
}
function frame(step,p){
  const [a,b,t]=sample(step.frames,p);
  const location=new T.Vector3(...a.slice(0,3)).lerp(new T.Vector3(...b.slice(0,3)),t);
  const rotation=new T.Quaternion(...a.slice(3,7)).slerp(new T.Quaternion(...b.slice(3,7)),t);
  const scale=new T.Vector3(...a.slice(7)).lerp(new T.Vector3(...b.slice(7)),t);
  return new T.Matrix4().compose(location,rotation,scale);
}
const value=step=>{
  return Math.min(...members(step).map(member=>{
    const p=progress?.values[member.id]??0;
    return p===seatedValue?0:p;
  }));
};
const done=step=>value(step)>=1;
const installed=step=>step.parts.every(name=>value(owners.get(name))>=1);

function applyPart(part,step,p){
  const {node,baseline}=part;
  node.matrix.copy(p>=1&&!step.assemblyOffset?baseline:initialMatrix.copy(frame(step,p)).multiply(baseline));
  node.matrixWorldNeedsUpdate=true;
  const clipped=p<1&&clipOps.has(step.op);
  if(clipped){
    const axis=step.axis,[lo,hi]=step.bounds;
    const direction=step.reverse?1:-1;
    const boundary=step.reverse?T.MathUtils.lerp(hi[axis],lo[axis],p):T.MathUtils.lerp(lo[axis],hi[axis],p);
    part.plane.normal.setComponent(axis,direction);
    part.plane.constant=-direction*boundary;
  }
  for(const item of part.meshes){
    if(item.clipped!==clipped){item.clipped=clipped;item.mesh.material=clipped?item.clip:item.base}
    if(item.mesh.morphTargetInfluences?.length)item.mesh.morphTargetInfluences[0]=step.op==='bend'?1-p:0;
  }
}
function draw(){
  const current=active?members(active):[];
  for(const [name,part] of parts){
    let step=owners.get(name);
    for(const revisit of revisits.get(name)||[]){
      if(preview||((current.includes(revisit)||value(revisit)>0)&&installed(revisit)))step=revisit;
    }
    const p=preview?1:value(step);
    part.node.visible=preview||p>0||current.includes(step)&&!pickingPart();
    if(part.node.visible)applyPart(part,step,p);
  }
  const showCut=!preview&&active?.op==='cut'&&value(active)<1;
  blocker.visible=showCut;
  if(showCut){
    const {blank,axis}=active,p=value(active);
    blocker.position.set(...blank.center);
    blocker.position.setComponent(axis,blank.center[axis]+blank.size[axis]*p/2);
    blocker.scale.set(...blank.size);
    blocker.scale.setComponent(axis,blank.size[axis]*(1-p));
  }
  render();
}

// 蓝色虚影：这一件最终该在的位置。共享几何，不复制网格。
function copyPart(step,start){
  const group=new T.Group();
  const constituent=members(step);
  const partial=!!step.members&&constituent.some(member=>(confirmed[member.id]??0)<1);
  for(const name of step.parts){
    const owner=constituent.find(member=>member.parts.includes(name))||step;
    if(partial&&(confirmed[owner.id]??0)>=1)continue;
    const transform=start?frame(owner,0):owner.assemblyOffset?frame(owner,1):null;
    const part=parts.get(name);
    if(!part)continue;
    const copy=part.node.clone(true);
    copy.matrixAutoUpdate=false;
    copy.matrix.copy(part.baseline);
    if(transform)copy.matrix.premultiply(transform);
    copy.visible=true;
    let meshIndex=0;
    copy.traverse(node=>{
      node.visible=true;
      if(!node.isMesh)return;
      node.material=part.meshes[meshIndex++].base;
      if(node.morphTargetInfluences)node.morphTargetInfluences.fill(start&&owner.op==='bend'?1:0);
    });
    group.add(copy);
  }
  return group;
}
function copyStart(step){return copyPart(step,true)}

function setGhost(step){
  if(ghost){model.remove(ghost);ghost=null}
  if(!step||preview||done(step)||step.op==='cut')return;
  ghost=copyPart(step,pickingPart());
  ghost.traverse(node=>{
    if(!node.isMesh)return;
    node.material=Array.isArray(node.material)?node.material.map(()=>ghostMaterial):ghostMaterial;
    node.renderOrder=3;
  });
  model.add(ghost);
}

function syncTray(){tray.build(stages.get(active?.id),bounds,viewDirection)}
function tabletopPose(box,direction){
  const pose=poseFor(box,direction);
  const shift=Math.max(0,.76-camera.aspect)*.72;
  if(shift){
    const distance=pose.position.distanceTo(pose.target);
    const lift=new T.Vector3(0,0,1).projectOnPlane(direction).normalize()
      .multiplyScalar(distance*Math.tan(camera.fov*Math.PI/360)*shift);
    pose.target.add(lift);pose.position.add(lift);
  }
  return pose;
}
function constructionPose(step,direction){
  const trayBox=tray.bounds();
  if(!trayBox)return stepPose(step,direction);
  const frame=localBox(step).union(trayBox);
  for(const previous of steps){
    if(previous.revisit||!isSeated(previous))continue;
    frame.expandByPoint(new T.Vector3(...previous.bounds[0]));
    frame.expandByPoint(new T.Vector3(...previous.bounds[1]));
  }
  return tabletopPose(frame,direction);
}

// A soft contact shadow anchors the miniature to the photographed tabletop.
function buildFloor(){
  const size=bounds.getSize(new T.Vector3()),center=bounds.getCenter(new T.Vector3());
  const radius=Math.hypot(size.x,size.y)*.92;
  if(!floor){
    const paper=document.createElement('canvas');
    paper.width=paper.height=256;
    const c=paper.getContext('2d'),g=c.createRadialGradient(128,128,0,128,128,128);
    g.addColorStop(0,'rgba(67,43,25,.46)');
    g.addColorStop(.48,'rgba(67,43,25,.33)');
    g.addColorStop(.76,'rgba(67,43,25,.13)');
    g.addColorStop(1,'rgba(67,43,25,0)');
    c.fillStyle=g;c.fillRect(0,0,256,256);
    const texture=new T.CanvasTexture(paper);
    texture.colorSpace=T.SRGBColorSpace;
    floor=new T.Mesh(new T.CircleGeometry(1,72),new T.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false}));
    floor.renderOrder=-1;
    scene.add(floor);
  }
  floor.scale.set(Math.min(radius,size.x*.72),Math.min(radius,size.y*.73),1);
  floor.position.set(center.x,center.y-.1,bounds.min.z-.025);
}

/* ======================= 落位回馈 ======================= */
const glowColor=new T.Color('#ffc56b');
function glow(step){
  const materials=[];
  for(const name of step.parts)for(const item of parts.get(name)?.meshes||[]){
    for(const m of [item.base,item.clip].flat())if(m?.emissive&&!m.userData.glowing)materials.push(m);
  }
  if(!materials.length)return;
  for(const m of materials){
    m.userData.glowing=true;
    m.userData.emissive??=m.emissive.clone();
    m.userData.emissiveIntensity??=m.emissiveIntensity;
  }
  glows.push({materials,start:performance.now(),duration:calm()?600:1050});
  wake();
}
function stepGlows(now){
  for(let i=glows.length-1;i>=0;i--){
    const g=glows[i],t=Math.min(1,(now-g.start)/g.duration);
    const k=calm()?(t<1?.3:0):Math.sin(Math.PI*Math.min(1,t*1.2))*(1-t*.4)*.42;
    for(const m of g.materials){
      m.emissive.copy(m.userData.emissive).lerp(glowColor,k);
      m.emissiveIntensity=k>0?Math.max(1,m.userData.emissiveIntensity):m.userData.emissiveIntensity;
      if(t>=1){m.emissive.copy(m.userData.emissive);m.emissiveIntensity=m.userData.emissiveIntensity;m.userData.glowing=false}
    }
    if(t>=1)glows.splice(i,1);
  }
  render();
  return glows.length>0;
}
function restart(node,className){
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}
let stampTimer=0;
function stampAt(at){
  if(!at)return;
  ui.stamp.style.left=at.x+'px';ui.stamp.style.top=at.y+'px';
  restart(ui.stamp,'go');
  clearTimeout(stampTimer);
  stampTimer=setTimeout(()=>ui.stamp.classList.remove('go'),810);
}
let bannerTimer=0;
function banner(kicker,title,sub=''){
  ui.bannerKicker.textContent=kicker;
  ui.bannerTitle.textContent=title;
  ui.bannerSub.textContent=sub;
  ui.banner.hidden=false;
  restart(ui.banner,'show');
  clearTimeout(bannerTimer);
  bannerTimer=setTimeout(()=>{ui.banner.hidden=true},2400);
}
let tickerTimer=0;
let cueTimer=0;
function clearCue(){clearTimeout(cueTimer);ui.cue.hidden=true}
function cue(kind){
  const icons={error:'#i-close',done:'#i-check'};
  ui.cue.dataset.kind=kind;
  ui.cueIcon.setAttribute('href',icons[kind]);
  ui.cue.hidden=false;
  restart(ui.cue,'show');
  clearTimeout(cueTimer);
  cueTimer=setTimeout(clearCue,1200);
}
function say(message='',error=false){
  ui.ticker.textContent=message;
  ui.ticker.toggleAttribute('data-error',error);
  if(error)cue('error');
  clearTimeout(tickerTimer);
  if(message&&!error)tickerTimer=setTimeout(()=>{ui.ticker.textContent=''},4200);
}

/* ======================= 区域谱：每一区一行刻度，每一步一格 ======================= */
const tickOf=new Map();
function buildScore(){
  tickOf.clear();
  ui.areas.replaceChildren(...data.chapters.map((ch,i)=>{
    const item=document.createElement('li');
    item.className='area';
    const head=document.createElement('button');
    head.type='button';
    head.className='area-head';
    const num=document.createElement('span');num.className='area-num';num.textContent=String(i+1).padStart(2,'0');
    const name=document.createElement('span');name.className='area-name';name.textContent=ch.title;
    const count=document.createElement('span');count.className='area-count';
    head.append(num,name,count);
    head.addEventListener('click',()=>{pickArea(i);closeScore()});
    const ticks=document.createElement('div');
    ticks.className='ticks';
    for(const step of ch.steps){
      const b=document.createElement('button');
      b.type='button';
      b.className='tick';
      b.title=displayTitle(step);
      b.setAttribute('aria-label','第 '+(steps.indexOf(step)+1)+' 步：'+displayTitle(step));
      b.addEventListener('click',()=>{select(step);closeScore()});
      tickOf.set(step.id,b);
      ticks.append(b);
    }
    item.append(head,ticks);
    return item;
  }));
}
function refreshScore(){
  const items=ui.areas.children;
  let finished=0;
  data.chapters.forEach((ch,i)=>{
    const k=ch.steps.filter(done).length,full=k===ch.steps.length;
    if(full)finished++;
    const item=items[i];
    if(!item)return;
    item.toggleAttribute('data-current',i===chapterIndex&&!preview);
    item.toggleAttribute('data-done',full);
    item.querySelector('.area-count').textContent=full?'成':k+'/'+ch.steps.length;
    for(const step of ch.steps){
      const b=tickOf.get(step.id),v=value(step);
      b.toggleAttribute('data-done',v>=1);
      b.style.setProperty('--p',v>0&&v<1?v:0);
      const current=step===active&&!preview;
      b.toggleAttribute('data-current',current);
      if(current)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');
      b.disabled=!!step.revisit&&!installed(step);
    }
  });
  ui.areaTally.textContent=finished+' / '+data.chapters.length;
}
function scrollScore(){
  const item=ui.areas.children[chapterIndex];
  if(!item||ui.score.matches(':hover'))return;
  const box=ui.areas.getBoundingClientRect(),r=item.getBoundingClientRect();
  const d=r.top<box.top?r.top-box.top-8:r.bottom>box.bottom?r.bottom-box.bottom+8:0;
  if(d)ui.areas.scrollBy({top:d,behavior:calm()?'auto':'smooth'});
}
function openScore(){
  ui.score.setAttribute('data-open','');ui.scoreOpen.setAttribute('aria-expanded','true');
  const item=ui.areas.children[chapterIndex];
  if(item)ui.areas.scrollTop=Math.max(0,item.offsetTop-ui.areas.offsetTop-10);
}
function closeScore(){ui.score.removeAttribute('data-open');ui.scoreOpen.setAttribute('aria-expanded','false')}

/* ======================= 文字与状态 ======================= */
function nextStep(){
  const i=steps.indexOf(active);
  return [...steps.slice(i+1),...steps.slice(0,i)].find(step=>!done(step)&&(!step.revisit||installed(step)));
}
const chapterCount=ch=>ch.steps.filter(done).length;
const placedTotal=()=>steps.filter(done).length;

function paintPlaque(chapter){
  const segments=Math.min(6,chapter.steps.length);
  const filled=Math.floor(chapterCount(chapter)*segments/chapter.steps.length);
  if(ui.chapterDots.children.length!==segments){
    ui.chapterDots.replaceChildren(...Array.from({length:segments},()=>document.createElement('i')));
  }
  [...ui.chapterDots.children].forEach((dot,i)=>{
    dot.toggleAttribute('data-done',i<filled);
    dot.toggleAttribute('data-active',i===filled);
  });
  ui.scoreOpen.setAttribute('aria-label',`${chapter.title} · ${chapterCount(chapter)} / ${chapter.steps.length} · 施工区域`);
}

function updateUI(){
  const placed=placedTotal(),ch=data.chapters[chapterIndex];
  ui.count.textContent=String(placed);
  ui.countTotal.textContent='/ '+steps.length+' 步';
  ui.tally.setAttribute('aria-valuenow',String(placed));
  ui.tally.setAttribute('aria-valuemax',String(steps.length));
  ui.preview.setAttribute('aria-pressed',String(preview&&!intro));
  ui.previewText.textContent=preview&&!intro?'回到搭建':'成品';
  ui.preview.setAttribute('aria-label',preview&&!intro?'回到搭建':'预览成品');
  ui.previewIcon.setAttribute('href',preview&&!intro?'#i-turn':'#i-check');
  ui.intro.hidden=!intro;
  ui.introText.textContent=steps.length+' 步 · '+data.chapters.length+' 个区域 · '+parts.size+' 个原始构件';
  ui.start.setAttribute('aria-label',placed?'接着搭':'开始搭建');
  ui.scoreOpenText.textContent='第 '+(chapterIndex+1)+' 区';
  if(preview){
    ui.areaName.textContent=intro?'成品':'成品预览';
    ui.stepTitle.textContent=data.title;
  }else{
    ui.areaName.textContent='第'+cnNum(chapterIndex+1)+'区 · '+ch.title;
    ui.stepTitle.textContent=displayTitle(active);
  }
  const tool=interactionFor(active),hint=tools[tool].hint||verbs[active.op]||'拖到终点';
  const toolHint=tool==='hold'&&active.op==='plant'?'按住让植被生长，松手暂停':hint;
  ui.knob.setAttribute('aria-label',displayTitle(active)+'：'+toolHint);
  const p=value(active),next=nextStep();
  let caption='',sub='';
  if(preview)caption=intro?'这是它建成的样子':'拖动旋转，滚轮缩放';
  else if(pickingPart())caption='从盒里选零件，拖进轮廓';
  else if(!done(active)){
    caption=toolHint;
    if(p>0)sub='已完成 '+Math.round(p*100)+'%';
    else if(tool==='drag'&&placed<3)sub='抓住构件，拖到目标轮廓';
  }else if(next)caption='到位';
  else if(publication?.status==='building'){caption='下一区正在制作';sub='做好会自动接上，你可以先转着看看'}
  else if(publication?.status==='stopped')caption='已发布的部分全部完成';
  else caption='全部建成';
  ui.caption.textContent=caption;
  ui.captionSub.textContent=sub;
  paintPlaque(ch);
  ui.viewport.toggleAttribute('data-waiting',!preview&&done(active)&&!next&&publication?.status==='building');
  refreshScore();
  ui.finale.hidden=!(publication?.status==='complete'&&placed===steps.length&&!finaleDismissed&&!intro);
}

/* ======================= 选择与自动接续 ======================= */
let advanceTimer=0;
function select(step,{auto=false}={}){
  if(gesture||tray.busy()||tapMotion||sending||!step)return false;
  if(step.revisit&&!installed(step)){say('先装好这一步要用到的构件。');return false}
  clearKeyboardDraft(true);
  clearTimeout(advanceTimer);advanceTimer=0;
  clearTimeout(pendingTimer);pendingPose=null;
  if(!auto)ui.stamp.classList.remove('go');
  const previous=preview?-1:chapterIndex;
  active=step;
  chapterIndex=data.chapters.findIndex(ch=>ch.steps.includes(step));
  preview=false;intro=false;
  syncTray();
  setGhost(step);
  updateUI();
  draw();
  const sameArea=previous===chapterIndex;
  if(previous!==chapterIndex)scrollScore();
  if(auto&&manualView&&!pickingPart()&&reachable(step)){/* 玩家自己的角度已经看得清，不动镜头 */}
  else{
    landFlight();
    const base=sameArea||manualView?currentDirection():viewDirection;
    aimAt(constructionPose(step,base),auto);
  }
  if(!calm())restart(ui.knob,'enter');
  say();
  return true;
}
function pickArea(i){
  const ch=data.chapters[i];
  select(ch.steps.find(step=>!done(step)&&(!step.revisit||installed(step)))||ch.steps[0]);
}
function scheduleAdvance(delay){
  clearTimeout(advanceTimer);
  advanceTimer=setTimeout(advance,calm()?Math.min(delay,260):delay);
}
function advance(){
  advanceTimer=0;
  if(gesture||sending||preview||!done(active))return;
  const next=nextStep();
  if(!next){updateUI();return}
  const keyboard=document.activeElement===ui.knob||knobHadFocus;
  knobHadFocus=false;
  select(next,{auto:true});
  if(keyboard)requestAnimationFrame(()=>ui.knob.focus({preventScroll:true}));
}

/* ======================= 手势与提交 ======================= */
function applyDraft(p){
  for(const member of members(active)){
    if((confirmed[member.id]??0)<1)progress.values[member.id]=p;
  }
  draw();
}
function draft(p){pendingDraft=p;wake()}
function flushDraft(){if(pendingDraft!==null){const p=pendingDraft;pendingDraft=null;applyDraft(p)}}

let knobHadFocus=false;
function weightOf(step){
  if(!bounds)return .3;
  const size=new T.Vector3(...step.bounds[1]).sub(new T.Vector3(...step.bounds[0]));
  return T.MathUtils.clamp(size.length()/Math.max(1,bounds.getSize(new T.Vector3()).length()),.05,1);
}
async function commit(p,seatAt=null){
  if(sending)return false;
  flushDraft();
  const target=active,before=members(target).every(member=>(confirmed[member.id]??0)>=1);
  const chapter=data.chapters.find(ch=>ch.steps.includes(target));
  const chapterBefore=chapter.steps.filter(step=>members(step).every(member=>(confirmed[member.id]??0)>=1)).length;
  const guide=toolGuide(target);
  const end=guide.tool==='hold'?guide.points[0]:guide.points.at(-1);
  const final=p>=SNAP?1:requiresPart(target)?Math.max(seatedValue,p):p;
  knobHadFocus=document.activeElement===ui.knob;
  sending=true;
  applyDraft(final);
  try{
    const updates=members(target).filter(member=>seatAt?requiresPart(member)&&!(confirmed[member.id]>0):(confirmed[member.id]??0)<1);
    for(const member of updates)progress=session.advance({id:member.id,value:final});
    confirmed={...progress.values};
    sending=false;
    if(seatAt)setGhost(target);
    else if(value(target)>=1)setGhost(null);
    updateUI();
    draw();
    if(seatAt){
      const weight=weightOf(target);
      stampAt(seatAt);sfx.place(placedTotal(),weight,rhythm.streak);say();
      if(weight>.43){impact={start:performance.now(),strength:Math.min(1.7,weight*2.1)};wake()}
      if(!reachable(target))aimAt(stepPose(target,currentDirection()),true);
    }else if(value(target)>=1&&!before)celebrate(target,chapter,chapterBefore,end);
    return true;
  }catch(error){
    sending=false;
    try{progress=session.read();confirmed={...progress.values};updateUI();draw()}catch{}
    say(error.message,true);
    return false;
  }finally{sending=false;render()}
}

function celebrate(step,chapter,chapterBefore,end){
  const placed=placedTotal();
  const now=performance.now();
  const repeating=now-rhythm.time<6500&&rhythm.operation===step.op&&rhythm.chapter===chapterIndex;
  rhythm={time:now,operation:step.op,chapter:chapterIndex,streak:repeating?Math.min(6,rhythm.streak+1):0};
  glow(step);
  stampAt(end);
  navigator.vibrate?.(14);
  sfx.place(placed-1,weightOf(step),rhythm.streak);
  restart(ui.count,'bump');
  if(placed===steps.length&&publication?.status==='complete'){
    finaleDismissed=false;
    sfx.finale();
    updateUI();
    ui.finaleText.textContent=steps.length+' 步 · '+data.chapters.length+' 个区域，全部由你装上。';
    if(!cameraBusy())setTimeout(()=>{if(!cameraBusy()&&!gesture){flyTo(poseFor(bounds,viewDirection));setTimeout(()=>{if(!cameraBusy())setOrbit(true)},calm()?0:1200)}},700);
    requestAnimationFrame(()=>ui.finaleSave.focus({preventScroll:true}));
    return;
  }
  const k=chapterCount(chapter);
  if(k===chapter.steps.length&&chapterBefore<k){
    const i=data.chapters.indexOf(chapter),next=nextStep();
    sfx.area(placed);
    banner('第'+cnNum(i+1)+'区 完成',chapter.title,next?'下一件：'+next.title:'');
    scheduleAdvance(850);
  }else scheduleAdvance(Math.max(190,540-rhythm.streak*75));
}

function moveTool(p){
  gesture.last=p;
  const notch=Math.floor(p*12);
  if(notch!==gesture.notch){gesture.notch=notch;sfx.tick(p)}
  const armed=p>=SNAP;
  if(armed&&!gesture.armed){sfx.ready();navigator.vibrate?.(6)}
  gesture.armed=armed;
  draft(p);
}

function moveSaw(point){
  const {guide}=gesture,[start,end]=guide.points;
  const line=end.clone().sub(start),offset=point.clone().sub(start);
  const fraction=offset.dot(line)/line.lengthSq();
  if(offset.addScaledVector(line,-fraction).length()>39)return;
  const position=T.MathUtils.clamp(fraction,0,1);
  gesture.position=position;
  const travel=gesture.direction===1?position:1-position;
  gesture.furthest=Math.max(gesture.furthest,travel);
  if(travel>=.94){
    gesture.base=Math.min(1,gesture.base+1/SAW_PASSES);
    gesture.furthest=0;
    gesture.direction*=-1;
    sfx.ready();
  }
  moveTool(Math.min(1,gesture.base+gesture.furthest/SAW_PASSES));
}

function moveCrank(point){
  const {center,radius}=gesture.guide;
  const arm=point.clone().sub(center);
  if(Math.abs(arm.length()-radius)>radius*.55)return;
  const angle=Math.atan2(arm.y,arm.x);
  const delta=angle-gesture.angle;
  gesture.angle=angle;
  const turn=Math.atan2(Math.sin(delta),Math.cos(delta));
  if(Math.abs(turn)>.85)return;
  moveTool(T.MathUtils.clamp(gesture.last+turn/CRANK_SWEEP,0,1));
}

function canShape(event){
  return event.button===0&&!gesture&&!tray.busy()&&!tapMotion&&!sending&&active&&!preview&&!pickingPart()&&!done(active);
}

function beginTool(event,grip,direct=false){
  if(!canShape(event))return;
  sfx.unlock();
  clearKeyboardDraft(false);
  clearTimeout(advanceTimer);
  flight=null;
  pendingPose=null;
  setOrbit(false);
  const g=toolGuide(active);
  if(g.raw<3&&(g.tool==='drag'||g.tool==='trace')){
    const pose=stepPose(active,currentDirection());
    if(pose.position.distanceTo(camera.position)>.05){manualView=false;flyTo(pose);say('换个角度再拉。')}
    else say('这个角度看不清轨迹，转一下视角。');
    return;
  }
  event.preventDefault();
  grip.setPointerCapture(event.pointerId);
  controls.enabled=false;
  const lengths=[0];
  for(let i=1;i<g.points.length;i++)lengths.push(lengths[i-1]+g.points[i].distanceTo(g.points[i-1]));
  const p=value(active),anchor=toolPosition(g,p);
  gesture={id:event.pointerId,x:event.clientX,y:event.clientY,tool:g.tool,guide:g,path:g.points,lengths,anchor,
    pointer:anchor.clone(),last:p,base:p,notch:Math.floor(p*12),armed:p>=SNAP};
  if(g.tool==='hold')gesture.holdStarted=performance.now();
  if(g.tool==='saw')Object.assign(gesture,{direction:1,position:0,furthest:0});
  if(g.tool==='crank')gesture.angle=CRANK_START+CRANK_SWEEP*p;
  ui.viewport.setAttribute('data-dragging','');
  ui.viewport.toggleAttribute('data-direct',direct);
  render();
}

const surfaceRay=new T.Raycaster();
const surfacePointer=new T.Vector2();
function grabSurface(event){
  if(!canShape(event)||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey)return;
  const tool=interactionFor(active);
  if(tool!=='drag')return;
  const rect=canvas.getBoundingClientRect();
  surfacePointer.set((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
  surfaceRay.setFromCamera(surfacePointer,camera);
  const meshes=active.parts.flatMap(name=>{
    const part=parts.get(name);
    return part?.node.visible?part.meshes.map(entry=>entry.mesh):[];
  });
  if(!surfaceRay.intersectObjects(meshes,false).length)return;
  event.stopImmediatePropagation();
  beginTool(event,canvas,true);
}

function moveGesture(event){
  if(gesture?.id!==event.pointerId)return;
  const moves=event.getCoalescedEvents?.()||[];
  const {path,lengths,anchor,x,y,tool}=gesture;
  for(const move of moves.length?moves:[event]){
    const point=anchor.clone().add(new T.Vector2(move.clientX-x,move.clientY-y));
    if(tool==='crank'){moveCrank(point);continue}
    if(tool==='saw'){moveSaw(point);continue}
    if(tool==='stamp')continue;
    if(tool==='hold'){
      if(point.distanceTo(anchor)>60&&gesture.holdStarted!==null){
        gesture.base=gesture.last;
        gesture.holdStarted=null;
      }else if(point.distanceTo(anchor)<=60&&gesture.holdStarted===null){
        gesture.holdStarted=performance.now();
        wake();
      }
      continue;
    }
    const reach=point.distanceTo(gesture.pointer)*1.5+18;
    gesture.pointer=point;
    const p=nearest(path,lengths,point,gesture.last,reach);
    if(tool==='trace'&&(p<gesture.last||pointAt(path,p).distanceTo(point)>25))continue;
    moveTool(p);
  }
}

function finishGesture(event){
  if(gesture?.id!==event.pointerId)return;
  const {type}=event;
  const {tool,last,x,y}=gesture;
  gesture=null;
  controls.enabled=true;
  ui.viewport.removeAttribute('data-dragging');
  ui.viewport.removeAttribute('data-direct');
  if(tool==='stamp'){
    if(type!=='pointerup'||Math.hypot(event.clientX-x,event.clientY-y)>22){render();return}
    const to=Math.min(1,(Math.floor(last*STATIONS+.001)+1)/STATIONS);
    sfx.tick(to);
    tapMotion={from:last,to,start:performance.now()};
    wake();
    return;
  }
  const p=type==='pointerup'?last:Math.min(last,SNAP-.001);
  pendingDraft=p;
  commit(p);
}

ui.knob.addEventListener('pointerdown',event=>beginTool(event,ui.knob));
canvas.addEventListener('pointerdown',grabSurface,true);
for(const grip of [ui.knob,canvas]){
  grip.addEventListener('pointermove',moveGesture);
  for(const type of ['pointerup','pointercancel','lostpointercapture'])grip.addEventListener(type,finishGesture);
}
// 键盘：方向键推进，松开 0.45 秒后记下；推到底即到位
let keyTimer=0;
let keyboardStep=null;
function clearKeyboardDraft(restore){
  clearTimeout(keyTimer);
  if(restore&&keyboardStep){
    for(const member of members(keyboardStep)){
      const id=member.id;
      if(id in confirmed)progress.values[id]=confirmed[id];
      else delete progress.values[id];
    }
  }
  keyboardStep=null;
}
ui.knob.addEventListener('keydown',event=>{
  if(!active||preview||gesture||tray.busy()||tapMotion||sending||pickingPart()||done(active))return;
  const delta={ArrowRight:.04,ArrowUp:.04,ArrowLeft:-.04,ArrowDown:-.04,PageUp:.2,PageDown:-.2,End:1,Home:-1}[event.key];
  if(!delta)return;
  event.preventDefault();
  sfx.unlock();
  clearTimeout(advanceTimer);
  const p=T.MathUtils.clamp(value(active)+delta,0,1);
  applyDraft(p);
  sfx.tick(p);
  updateCaptionDuringKeys(p);
  clearTimeout(keyTimer);
  keyboardStep=active;
  if(p>=SNAP){
    clearKeyboardDraft(false);
    commit(p);
  }else keyTimer=setTimeout(()=>{
    clearKeyboardDraft(false);
    commit(p);
  },450);
});
function updateCaptionDuringKeys(p){ui.caption.textContent=p>=SNAP?'到底了':Math.round(p*100)+'%'}

function paintLevels(){
  if(!sourceRecipe)return;
  const totals=levelCounts(sourceRecipe,requiresPart);
  for(const level of ['easy','medium','hard']){
    const button=ui['level'+level];
    button.setAttribute('aria-pressed',String(level===difficulty));
    button.querySelector('.level-count').textContent=totals[level];
    button.querySelector('.level-ratio').textContent=Math.round(totals[level]/totals.hard*100)+'%';
  }
  ui.levelNote.textContent=publication?.status==='building'?'当前已发布步骤，后续区域会继续加入。':'完整模型 · 每档保留全部构件细节';
}
ui.levelOpen.addEventListener('click',()=>{
  if(gesture||tray.busy()||sending||tapMotion)return;
  paintLevels();ui.levelPanel.hidden=false;
});
ui.levelClose.addEventListener('click',()=>{ui.levelPanel.hidden=true;ui.levelOpen.focus({preventScroll:true})});
for(const level of ['easy','medium','hard'])ui['level'+level].addEventListener('click',()=>{
  if(gesture||tray.busy()||sending||tapMotion)return;
  clearKeyboardDraft(true);
  difficulty=level;
  try{localStorage.setItem('participatory-3d:level:'+sourceRecipe.title,level)}catch{}
  configureRecipe(sourceRecipe);
  ui.levelPanel.hidden=true;
  select(done(active)?nextStep()||active:active);
});

/* ======================= 工具栏 ======================= */
ui.start.addEventListener('click',()=>{
  sfx.unlock();
  intro=false;
  const first=done(active)?nextStep()||active:active;
  select(first);
  requestAnimationFrame(()=>ui.knob.focus({preventScroll:true}));
});
ui.focus.addEventListener('click',()=>{
  if(!active||gesture||tray.busy()||preview)return;
  manualView=false;
  const direction=currentDirection();
  flyTo(pickingPart()?constructionPose(active,direction):stepPose(active,direction));
});
ui.whole.addEventListener('click',()=>{if(bounds&&!gesture&&!tray.busy())flyTo(tabletopPose(bounds,currentDirection()))});
ui.orbit.addEventListener('click',()=>{if(!gesture&&!tray.busy())setOrbit(!orbiting)});
ui.preview.addEventListener('click',()=>{
  if(!active||gesture||tray.busy()||tapMotion||sending)return;
  if(preview){
    if(intro)ui.start.click();
    else select(done(active)?nextStep()||active:active);
    return;
  }
  clearKeyboardDraft(true);
  clearTimeout(advanceTimer);
  clearTimeout(pendingTimer);pendingPose=null;
  preview=true;
  setGhost(null);
  updateUI();
  draw();
  flyTo(tabletopPose(bounds,currentDirection()));
});
function paintSound(){
  ui.sound.setAttribute('aria-pressed',String(sfx.on));
  ui.sound.setAttribute('aria-label',sfx.on?'声音：开':'声音：关');
}
ui.sound.addEventListener('click',()=>{sfx.set(!sfx.on);paintSound();if(sfx.on)sfx.ready()});
ui.scoreOpen.addEventListener('click',()=>ui.score.hasAttribute('data-open')?closeScore():openScore());
ui.scoreClose.addEventListener('click',closeScore);
ui.finaleClose.addEventListener('click',()=>{finaleDismissed=true;ui.finale.hidden=true});
ui.finaleSave.addEventListener('click',()=>ui.save.click());
ui.finaleTour.addEventListener('click',()=>{
  finaleDismissed=true;ui.finale.hidden=true;
  preview=true;setGhost(null);updateUI();draw();
  flyTo(poseFor(bounds,viewDirection));
  if(!record&&!ui.record.disabled)startRecording();
  setTimeout(()=>setOrbit(true),calm()?0:900);
  clearTimeout(tourTimer);
  tourTimer=setTimeout(()=>{setOrbit(false);if(record?.state==='recording'){ui.record.disabled=true;record.stop()}},14000);
});
ui.movieClose.addEventListener('click',()=>{ui.movie.hidden=true});
addEventListener('keydown',event=>{
  if(event.metaKey||event.ctrlKey||event.altKey||gesture)return;
  if(event.key==='Escape'){closeScore();ui.levelPanel.hidden=true;return}
  if(event.target.closest?.('input,select,textarea'))return;
  if(event.key==='f'||event.key==='F')ui.focus.click();
  if(event.key==='m'||event.key==='M')ui.sound.click();
});
// 首次任何按键/按下都解锁音频（浏览器要求用户手势）
addEventListener('pointerdown',()=>sfx.unlock(),{once:true,capture:true});

/* ======================= 存档与录像 ======================= */
ui.save.addEventListener('click',()=>{
  if(!session||sending||gesture||tray.busy()||tapMotion)return;
  ui.exportBlend.hidden=!publication.export;
  ui.savePanel.showModal();
});
ui.saveClose.addEventListener('click',()=>ui.savePanel.close());
ui.downloadCheckpoint.addEventListener('click',()=>{
  downloadFile(new Blob([JSON.stringify(session.checkpoint(),null,2)],{type:'application/json'}),data.title+'.assembly.json');
  ui.savePanel.close();
});
ui.importCheckpoint.addEventListener('change',async()=>{
  const file=ui.importCheckpoint.files[0];
  if(!file)return;
  try{
    if(file.size>1048576)throw new Error('存档文件过大。');
    session.import(JSON.parse(await file.text()));
    location.reload();
  }catch(error){ui.saveStatus.textContent=error.message;ui.importCheckpoint.value=''}
});
ui.exportBlend.addEventListener('click',async()=>{
  ui.exportBlend.disabled=true;
  ui.saveStatus.textContent='正在导出 Blender 工程…';
  try{
    const response=await fetch('export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(session.checkpoint())});
    if(!response.ok)throw new Error((await response.json()).error||'导出失败。');
    downloadFile(await response.blob(),data.title+'.blend');
    ui.saveStatus.textContent='Blender 工程已导出。';
  }catch(error){ui.saveStatus.textContent=error.message}
  finally{ui.exportBlend.disabled=false}
});
ui.fullscreen.hidden=!document.documentElement.requestFullscreen;
ui.fullscreen.addEventListener('click',()=>{
  const operation=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
  operation.catch(()=>{});
});

function startRecording(){
  const video=canvas.captureStream(30);
  const audio=sfx.on?sfx.stream():null;
  const tracks=[...video.getVideoTracks(),...(audio?audio.getAudioTracks():[])];
  const withAudio=tracks.length>1;
  const pick=list=>list.find(mime=>MediaRecorder.isTypeSupported(mime));
  let type=withAudio?pick(['video/mp4;codecs=avc1.42001f,mp4a.40.2','video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus']):null;
  let stream=new MediaStream(withAudio&&type?tracks:video.getVideoTracks());
  if(!type)type=pick(['video/mp4;codecs=avc1.42001f','video/mp4','video/webm;codecs=vp8','video/webm']);
  try{record=new MediaRecorder(stream,type?{mimeType:type,videoBitsPerSecond:5000000}:{})}
  catch{
    stream=new MediaStream(video.getVideoTracks());
    type=pick(['video/mp4;codecs=avc1.42001f','video/mp4','video/webm;codecs=vp8','video/webm']);
    record=new MediaRecorder(stream,type?{mimeType:type,videoBitsPerSecond:5000000}:{});
  }
  recordStream=video;
  const mime=(record.mimeType||type||'video/webm').split(';')[0];
  const chunks=[];
  record.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};
  record.onstop=async()=>{
    recordStream.getTracks().forEach(track=>track.stop());
    record=null;
    ui.record.removeAttribute('data-recording');
    ui.recordText.textContent='录像';
    const movie=new Blob(chunks,{type:mime});
    if(recordUrl)URL.revokeObjectURL(recordUrl);
    recordUrl=URL.createObjectURL(movie);
    ui.movie.hidden=false;
    ui.player.src=ui.download.href=recordUrl;
    ui.download.download=data.title+'-搭建录像.'+mime.split('/')[1];
    say('录像可下载');
    ui.record.disabled=false;
  };
  record.start(900);
  ui.record.dataset.recording='';
  ui.recordText.textContent='停止';
  render();
}
ui.record.addEventListener('click',()=>{
  sfx.unlock();
  if(record){if(record.state==='recording'){clearTimeout(tourTimer);ui.record.disabled=true;record.stop()}return}
  try{startRecording()}catch(error){say(error.message,true)}
});

/* ======================= 数据：发布、热加载 ======================= */
function configureRecipe(recipe){
  const activeId=active?.id||progress.active;
  sourceRecipe=recipe;
  session.configure(recipe);
  sourceSteps=recipe.chapters.flatMap(ch=>ch.steps);
  if(!difficultyLoaded){
    try{const saved=localStorage.getItem('participatory-3d:level:'+recipe.title);if(['easy','medium','hard'].includes(saved))difficulty=saved}catch{}
    difficultyLoaded=true;
  }
  data=playableRecipe(recipe,difficulty,requiresPart);
  steps=data.chapters.flatMap(ch=>ch.steps);
  stages.clear();
  data.chapters.forEach((chapter,index)=>{
    const tangible=chapter.steps.filter(requiresPart);
    for(let from=0;from<tangible.length;from+=placementRules.maxParts){
      const group=tangible.slice(from,from+placementRules.maxParts);
      const batch=from/placementRules.maxParts+1;
      const stage={key:difficulty+'/'+index+'/'+batch,label:batch+'/'+Math.ceil(tangible.length/placementRules.maxParts),steps:group};
      for(const step of group)stages.set(step.id,stage);
    }
  });
  owners.clear();
  revisits.clear();
  for(const step of sourceSteps)for(const name of step.parts){
    if(step.revisit){
      if(!revisits.has(name))revisits.set(name,[]);
      revisits.get(name).push(step);
    }else owners.set(name,step);
  }
  active=steps.find(step=>members(step).some(member=>member.id===activeId))||steps[0];
  chapterIndex=data.chapters.findIndex(ch=>ch.steps.includes(active));
  ui.title.textContent=data.title;
  document.title=data.title+' · 参与建模';
  living.configure(recipe,sourceSteps);
  paintLevels();
  buildScore();
}
function attachAsset(asset){
  scene.add(asset.scene);
  asset.scene.updateMatrixWorld(true);
  const targets=[];
  asset.scene.traverse(node=>{if(node.userData.workshop_id)targets.push(node)});
  for(const node of targets){
    const name=node.userData.workshop_id;
    model.attach(node);
    node.updateMatrix();
    node.matrixAutoUpdate=false;
    const plane=new T.Plane();
    const meshes=[];
    node.traverse(mesh=>{
      if(!mesh.isMesh)return;
      const own=material=>material.clone();
      const clipMaterial=material=>{const copy=material.clone();copy.clippingPlanes=[plane];return copy};
      const base=Array.isArray(mesh.material)?mesh.material.map(own):own(mesh.material);
      mesh.material=base;
      meshes.push({mesh,base,clip:Array.isArray(base)?base.map(clipMaterial):clipMaterial(base)});
    });
    parts.set(name,{node,plane,meshes,baseline:node.matrix.clone()});
  }
  scene.remove(asset.scene);
}
function verifyAssets(){
  if(parts.size!==owners.size||[...owners.keys()].some(name=>!parts.has(name)))throw new Error('模型预览的构件与步骤配方不一致。');
}
function showPublication(){
  ui.release.hidden=publication?.mode!=='photo'||publication.status==='complete';
  ui.phaseStatus.hidden=ui.release.hidden;
  if(!ui.release.hidden){
    ui.phaseStatus.textContent=publication.status==='stopped'?'继续生成':'后续区域制作中';
    ui.release.dataset.state=publication.status;
    ui.release.textContent=publication.message;
  }
}
function loadVersion(release){
  const path=release.index;
  const waiting=release.assets.filter(url=>!loadedAssets.has(url));
  const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const load=url=>loader.loadAsync(url,event=>{
    if(!ui.loading.hidden&&event.total){
      const ratio=event.loaded/event.total;
      ui.loadingFill.style.transform=`scaleX(${ratio})`;
      ui.loadingText.textContent=Math.round(ratio*100)+'%';
    }
  });
  return Promise.all([fetchJson(path),Promise.all(waiting.map(load)),waiting]);
}
async function pollReleases(){
  if(publication?.mode!=='photo')return;
  try{
    const next=await fetchJson('release.json');
    if(next.revision>publication.revision){
      if(pendingVersion?.revision!==next.revision)pendingVersion={revision:next.revision,payload:await loadVersion(next)};
      if(gesture||tray.busy()||tapMotion||sending)return;
      const [recipe,assets,urls]=pendingVersion.payload;
      pendingVersion=null;
      const waiting=!preview&&done(active)&&!nextStep();
      for(let i=0;i<assets.length;i++){attachAsset(assets[i]);loadedAssets.add(urls[i])}
      configureRecipe(recipe);
      verifyAssets();
      bounds.makeEmpty();
      for(const part of parts.values())bounds.union(new T.Box3().setFromObject(part.node));
      buildFloor();
      publication=next;
      showPublication();
      syncTray();
      setGhost(preview?null:active);
      updateUI();
      draw();
      banner('新区域开放',data.chapters.at(-1).title,waiting?'马上接上':'');
      if(waiting)scheduleAdvance(1200);
    }else if(next.status!==publication.status||next.message!==publication.message){
      publication=next;
      showPublication();
      updateUI();
    }
  }catch{
    say('正在重新连接分段制作。',true);
  }finally{
    if(publication.status==='building')setTimeout(pollReleases,950);
  }
}

async function init(){
  paintSound();
  const roomReady=loadRoom();
  publication=await fetchJson('release.json');
  session=createSession(publication.project);
  const [recipe,assets,urls]=await loadVersion(publication);
  session.configure(recipe);
  progress=session.read();
  confirmed={...progress.values};
  configureRecipe(recipe);
  for(let i=0;i<assets.length;i++){attachAsset(assets[i]);loadedAssets.add(urls[i])}
  verifyAssets();
  bounds=new T.Box3().setFromObject(model);
  viewDirection=new T.Vector3(...(data.view||[5,-30,18])).sub(bounds.getCenter(new T.Vector3())).normalize();
  buildFloor();
  intro=publication.mode!=='photo'&&Object.keys(progress.values).length===0;
  preview=intro;
  // 回来时直接停在下一件没做完的构件上（只选中，不安装）
  if(!preview&&done(active)){
    const next=nextStep();
    if(next){active=next;chapterIndex=data.chapters.findIndex(ch=>ch.steps.includes(next))}
  }
  if(!preview)syncTray();
  showPublication();
  finaleDismissed=publication.status==='complete'&&steps.every(done);
  ui.start.disabled=ui.save.disabled=false;
  ui.record.disabled=typeof MediaRecorder==='undefined'||typeof canvas.captureStream!=='function';
  setGhost(preview?null:active);
  updateUI();
  draw();
  scrollScore();
  const wide=poseFor(bounds,viewDirection);
  wide.position.addScaledVector(viewDirection,calm()?0:wide.position.distanceTo(wide.target)*.3);
  flyTo(wide,0);
  await roomReady;
  paint();
  ui.loading.classList.add('out');
  setTimeout(()=>{ui.loading.hidden=true},calm()?0:500);
  flyTo(preview?tabletopPose(bounds,viewDirection):constructionPose(active,viewDirection),1200);
  if(!Object.keys(progress.values).length)ui.levelPanel.hidden=false;
  if(publication.status==='building')setTimeout(pollReleases,950);
}
addEventListener('visibilitychange',()=>{if(!document.hidden)render()});
resize();
init().catch(error=>{ui.loading.setAttribute('data-error','');ui.loadingText.classList.remove('sr');ui.loadingText.textContent=error.message;ui.loadingRetry.hidden=false;say(error.message,true)});
ui.loadingRetry.addEventListener('click',()=>location.reload());
