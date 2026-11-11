import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSession} from '../web/session.js';
import {levelCounts, members, playableRecipe} from '../web/build-levels.js';

const fixture={chapters:[{title:'frame',steps:[{id:'1',parts:['wheel']},{id:'2',parts:['wheel'],revisit:true}]}]};
const read=path=>JSON.parse(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'));
const operations=new Set(read('runtime/placement.json').trayOperations);
const needsTray=step=>!step.revisit&&step.placement!=='in_place'&&operations.has(step.op);

test('portable saves stay scoped to the correct scene',()=>{
  const map=new Map(), storage={getItem:key=>map.get(key),setItem:(key,value)=>map.set(key,value)};
  const player=createSession('mill',storage);
  player.configure(fixture);
  assert.throws(()=>player.advance({id:'2',value:1}),/装配顺序/);
  player.advance({id:'1',value:1});player.advance({id:'2',value:.6});
  const reopened=createSession('mill',storage);reopened.configure(fixture);
  assert.deepEqual(reopened.checkpoint(),player.checkpoint());
  assert.throws(()=>reopened.import({...player.checkpoint(),project:'another'}),/这个建筑/);
  assert.deepEqual(reopened.read().values,{'1':1,'2':.6});
});

test('difficulty and subsequent releases keep every original step and the same IDs',()=>{
  for(const level of ['easy','medium','hard']){
    let previous=[];
    for(let version=0;version<=3;version++){
      const source=read(`examples/wood-village/r${version}/index.json`);
      const tasks=playableRecipe(source,level,needsTray).chapters.flatMap(chapter=>chapter.steps);
      const groups=tasks.map(task=>members(task).map(step=>step.id));
      assert.deepEqual(groups.slice(0,previous.length),previous);
      assert.deepEqual(groups.flat(),source.chapters.flatMap(chapter=>chapter.steps.map(step=>step.id)));
      previous=groups;
      if(version===3)assert.deepEqual(levelCounts(source,needsTray),{hard:427,medium:214,easy:108});
    }
  }
});

test('compressed city preserves each interactive mesh identity',()=>{
  const recipe=read('examples/spiral-mill/index.json');
  const scene=readFileSync(new URL('../examples/spiral-mill/scene.glb',import.meta.url));
  assert.equal(scene.subarray(0,4).toString(),'glTF');
  const gltf=JSON.parse(scene.subarray(20,20+scene.readUInt32LE(12)));
  const actual=new Set(gltf.nodes.map(node=>node.extras?.workshop_id).filter(Boolean));
  const wanted=new Set(recipe.chapters.flatMap(chapter=>chapter.steps.flatMap(step=>step.parts)));
  assert.deepEqual(actual,wanted);
  assert.ok(scene.byteLength<32*1024**2);
});
