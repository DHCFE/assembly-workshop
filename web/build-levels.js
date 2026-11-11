const factors={hard:1,medium:2,easy:4};
export const members=step=>step.members||[step];

export function playableRecipe(recipe,level,needsTray){
  const factor=factors[level]||1;
  if(factor===1)return recipe;
  let sourceCount=0,groupCount=0;
  const chapters=recipe.chapters.map(chapter=>{
    const runs=[];
    for(const step of chapter.steps){
      const separate=step.revisit||step.op==='cut';
      const kind=separate?'single:'+step.id:level==='easy'?'unit':needsTray(step)?'tray':'onsite';
      const last=runs.at(-1);
      if(last?.kind===kind)last.steps.push(step);
      else runs.push({kind,steps:[step],count:1});
    }
    sourceCount+=chapter.steps.length;
    const desired=Math.min(chapter.steps.length,Math.max(runs.length,Math.ceil(sourceCount/factor)-groupCount));
    for(let count=runs.length;count<desired;count++){
      const available=runs.filter(run=>run.count<run.steps.length);
      available.sort((a,b)=>b.steps.length/b.count-a.steps.length/a.count);
      available[0].count++;
    }
    const tasks=[];
    for(const run of runs){
      for(let i=0;i<run.count;i++){
        const from=Math.floor(i*run.steps.length/run.count);
        const to=Math.floor((i+1)*run.steps.length/run.count);
        const group=run.steps.slice(from,to);
        if(group.length===1){tasks.push(group[0]);continue}
        const lo=[0,1,2].map(axis=>Math.min(...group.map(step=>step.bounds[0][axis])));
        const hi=[0,1,2].map(axis=>Math.max(...group.map(step=>step.bounds[1][axis])));
        tasks.push({...group[0],members:group,parts:[...new Set(group.flatMap(step=>step.parts))],bounds:[lo,hi],
          title:chapter.title+' · '+(tasks.length+1),originalCount:group.length});
      }
    }
    groupCount+=tasks.length;
    return {...chapter,steps:tasks};
  });
  return {...recipe,chapters};
}

export function levelCounts(recipe,needsTray){
  return Object.fromEntries(Object.keys(factors).map(level=>[level,
    playableRecipe(recipe,level,needsTray).chapters.reduce((count,chapter)=>count+chapter.steps.length,0)]));
}
