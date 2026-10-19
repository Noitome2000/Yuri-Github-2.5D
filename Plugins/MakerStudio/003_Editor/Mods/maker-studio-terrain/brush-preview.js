export function brushValue({mode,brushHeight,slopeDirection,cornerDirection,edgeStyle}) {
  if(mode==='erase'||(mode==='height'&&brushHeight===0))return null;
  const value={height:brushHeight};
  if(mode==='slope')value.slope=slopeDirection;
  if(mode==='outer'||mode==='inner')value.slope=`${mode}_${cornerDirection}`;
  if(mode==='overpass')value.type='overpass';
  if(edgeStyle!=='hard')value.style=edgeStyle;
  return value;
}

export function brushPreview(cell,settings,info,start=null) {
  const rectangle=settings.shape==='rectangle',offset=rectangle?0:Math.floor((settings.brushSize-1)/2);
  const anchor=rectangle?(start||cell):cell;
  const left=rectangle?Math.min(anchor.x,cell.x):cell.x-offset;
  const top=rectangle?Math.min(anchor.y,cell.y):cell.y-offset;
  const right=rectangle?Math.max(anchor.x,cell.x):left+settings.brushSize-1;
  const bottom=rectangle?Math.max(anchor.y,cell.y):top+settings.brushSize-1;
  const value=brushValue(settings),cells=[];
  for(let y=Math.max(0,top);y<=Math.min(info.height-1,bottom);y++)
    for(let x=Math.max(0,left);x<=Math.min(info.width-1,right);x++)cells.push({x,y,value});
  return cells;
}
