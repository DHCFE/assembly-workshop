import {build} from 'esbuild';
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const output='dist';
await rm(output,{recursive:true,force:true});
await mkdir(`${output}/assets`,{recursive:true});
await cp('site',output,{recursive:true});
await build({entryPoints:['web/workshop.js'],bundle:true,format:'esm',minify:true,
  loader:{'.webp':'dataurl'},legalComments:'linked',outfile:`${output}/assets/workshop.js`});
await mkdir(`${output}/create`,{recursive:true});
await cp('web/photos.html',`${output}/create/index.html`);
for(const [id,latest] of [['wood-village',3],['spiral-mill',null]]){
  const folder=`${output}/play/${id}`;
  const files=latest===null?['scene.glb','index.json']:[...Array.from({length:latest+1},(_,i)=>`r${i}/scene.glb`),`r${latest}/index.json`];
  await mkdir(folder,{recursive:true});
  for(const file of files){await mkdir(dirname(`${folder}/${file}`),{recursive:true});await cp(`examples/${id}/${file}`,`${folder}/${file}`)}
  await cp('web/index.html',`${folder}/index.html`);
  const release={project:id,revision:latest??0,status:'complete',mode:latest===null?'ready':'photo',
    message:'',assets:files.filter(file=>file.endsWith('.glb')),index:files.at(-1),export:false};
  await writeFile(`${folder}/release.json`,JSON.stringify(release));
}
await writeFile(`${output}/.nojekyll`,'');
await cp('licenses',`${output}/licenses`,{recursive:true});
await cp('LICENSE',`${output}/LICENSE`);
console.log('Built the static workshop in dist/.');
