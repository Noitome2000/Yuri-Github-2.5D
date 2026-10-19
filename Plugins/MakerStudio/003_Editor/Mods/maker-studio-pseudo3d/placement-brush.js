import { lineCells } from './editor-input.js';
import { modelPivot, rotateModelVertices } from './model-transform.js';
import { modelUnitScale } from './mesh-renderer.js';

// Ground-plane bounds use the same pivot, scale and yaw as the scene renderer.
// Cache mesh bounds per stroke, not globally: editing an asset cannot leave stale bounds.
function placementBounds(stroke, instance) {
  const asset=stroke.assetById(instance.assetId);
  const w=(instance.footprintW||asset?.footprintW||1)*32;
  const d=(instance.footprintD||asset?.footprintD||1)*32;
  let local=[-w/2,-d/2,w/2,d/2];
  if(asset?.type==='model'&&asset.vertices?.length){
    local=stroke.models.get(asset);
    if(!local){
      const pivot=modelPivot(asset),unit=modelUnitScale(asset);
      local=[Infinity,Infinity,-Infinity,-Infinity];
      for(const v of rotateModelVertices(asset)){
        const x=(v[0]-pivot[0])*unit,y=(v[2]-pivot[2])*unit;
        local[0]=Math.min(local[0],x);local[1]=Math.min(local[1],y);
        local[2]=Math.max(local[2],x);local[3]=Math.max(local[3],y);
      }
      // Flat meshes still need a nonzero placement footprint.
      if(local[2]-local[0]<1e-6){local[0]-=w/2;local[2]+=w/2;}
      if(local[3]-local[1]<1e-6){local[1]-=d/2;local[3]+=d/2;}
      stroke.models.set(asset,local);
    }
  }
  if(stroke.reserveFootprint)local=[Math.min(local[0],-w/2),Math.min(local[1],-d/2),Math.max(local[2],w/2),Math.max(local[3],d/2)];
  const angle=(instance.rotation||0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),scale=instance.scale||1;
  const points=[[local[0],local[1]],[local[2],local[1]],[local[2],local[3]],[local[0],local[3]]].map(([x,y])=>
    [instance.x+w/2+(x*c-y*s)*scale,instance.y+d/2+(x*s+y*c)*scale]);
  return {points,axes:[[c,s],[-s,c]],minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),
    minY:Math.min(...points.map(p=>p[1])),maxY:Math.max(...points.map(p=>p[1]))};
}

function overlaps(a,b){
  const epsilon=1e-6; // Touching edges are valid, including rotated modular pieces.
  if(a.maxX<=b.minX+epsilon||b.maxX<=a.minX+epsilon||a.maxY<=b.minY+epsilon||b.maxY<=a.minY+epsilon)return false;
  for(const [x,y] of [...a.axes,...b.axes]){
    const ap=a.points.map(p=>p[0]*x+p[1]*y),bp=b.points.map(p=>p[0]*x+p[1]*y);
    if(Math.max(...ap)<=Math.min(...bp)+epsilon||Math.max(...bp)<=Math.min(...ap)+epsilon)return false;
  }
  return true;
}

export function canPlaceInStroke(stroke,instance){
  const bounds=placementBounds(stroke,instance);
  return !stroke.occupied.some(other=>overlaps(bounds,other));
}

export function placementKey(instance) {
  return JSON.stringify([instance.assetId,instance.x,instance.y,instance.rotation||0,instance.scale??1]);
}

// A stroke owns temporary stamps until release; saved scenes never contain them.
export function createPlacementStroke(instances,assetById=()=>null,{reserveFootprint=false}={}) {
  const stroke={pending:[],occupied:[],models:new Map(),assetById,last:null,reserveFootprint};
  stroke.occupied=instances.filter(i=>i.visible!==false).map(i=>placementBounds(stroke,i));
  stroke.existing=stroke.occupied.slice();
  return stroke;
}

// Rebuild from the two corners, so shrinking or reversing a rectangle never
// retains stamps from an earlier pointer position. Only release commits it.
export function updatePlacementRectangle(stroke,start,end) {
  if(!start||!end)return false;
  const key=placementKey(start)+':'+end.x+':'+end.y;
  if(stroke.rectangleKey===key)return false;
  stroke.rectangleKey=key;stroke.pending=[];stroke.occupied=stroke.existing.slice();
  const left=Math.min(start.x,end.x),top=Math.min(start.y,end.y);
  const right=Math.max(start.x,end.x),bottom=Math.max(start.y,end.y);
  const bounds=placementBounds(stroke,start);
  const stepX=Math.max(32,Math.ceil((bounds.maxX-bounds.minX-1e-6)/32)*32);
  const stepY=Math.max(32,Math.ceil((bounds.maxY-bounds.minY-1e-6)/32)*32);
  for(let y=top;y<=bottom;y+=stepY)for(let x=left;x<=right;x+=stepX)
    appendPlacementStroke(stroke,{...start,x,y},false);
  stroke.rectangle={left,top,right:right+start.footprintW*32,bottom:bottom+start.footprintD*32,count:stroke.pending.length};
  return true;
}

export function appendPlacementStroke(stroke,instance,snap=true) {
  if(!instance){stroke.last=null;return false;}
  const cell={x:Math.round(instance.x/32),y:Math.round(instance.y/32)};
  const cells=snap?lineCells(stroke.last,cell):[cell];
  let changed=false;
  for(const point of cells){
    const stamp={...instance,...(snap?{x:point.x*32,y:point.y*32}:{})};
    const bounds=placementBounds(stroke,stamp);
    if(stroke.occupied.some(other=>overlaps(bounds,other)))continue;
    stroke.occupied.push(bounds);stamp.id=`__preview_brush_${stroke.pending.length}`;
    stroke.pending.push(stamp);changed=true;
  }
  stroke.last=snap?cell:null;
  return changed;
}
