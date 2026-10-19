// All positions are map pixels: x/east, y/south, z/up.
export function cameraPoint(x, y, z, yaw, pitch) {
  const a = yaw * Math.PI / 180, b = pitch * Math.PI / 180;
  const right = x * Math.cos(a) - y * Math.sin(a);
  const forward = x * Math.sin(a) + y * Math.cos(a);
  return [right, forward * Math.sin(b) - z * Math.cos(b), forward * Math.cos(b) + z * Math.sin(b)];
}

export function fitCamera(width, height, elevation, viewWidth, viewHeight, yaw, pitch) {
  const points = [];
  for (const x of [0, width]) for (const y of [0, height]) for (const z of [0, elevation]) points.push(cameraPoint(x, y, z, yaw, pitch));
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((viewWidth - 40) / Math.max(1, maxX - minX), (viewHeight - 40) / Math.max(1, maxY - minY));
  return { scale, x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// Frame once on opening/reset. Orbit only rotates about this fixed target;
// it never re-fits the map bounds or changes the camera radius.
export function sceneProjection(camera, mapWidth, mapHeight, elevation, width, height, ratio = 1) {
  const key=`${mapWidth}:${mapHeight}`;
  const fov=50*Math.PI/180;
  if (!camera.framing || camera.framing.key!==key) {
    const fit=fitCamera(mapWidth,mapHeight,elevation,width,height,camera.yaw,camera.pitch);
    const span=height/fit.scale;
    camera.framing={key,target:[mapWidth/2,mapHeight/2,elevation/2],span,
      distance:Math.max(span/(2*Math.tan(fov/2)),Math.hypot(mapWidth,mapHeight,elevation)*.6)};
  }
  const {target,span}=camera.framing, distance=camera.framing.distance/(camera.zoom||1);
  const perspective=camera.mode!=='2d'&&camera.projection==='perspective';
  const yaw=(camera.mode==='2d'?0:camera.yaw)*Math.PI/180;
  const pitch=(camera.mode==='2d'?90:camera.pitch)*Math.PI/180;
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const scale=height/span*(camera.zoom||1)*ratio, focal=height/(2*Math.tan(fov/2))*ratio;
  const near=Math.max(.1,camera.framing.distance/10000);
  const project=(x,y,z=0)=>{
    x-=target[0];y-=target[1];z-=target[2];
    const forward=x*sy+y*cy, right=x*cy-y*sy, vertical=forward*sp-z*cp, depth=forward*cp+z*sp;
    const w=perspective?distance-depth:1;
    const factor=perspective?focal/(Math.abs(w)<1e-8?1e-8:w):scale;
    return [right*factor+width*ratio/2+(camera.panX||0)*ratio,
      vertical*factor+height*ratio/2+(camera.panY||0)*ratio,depth,w,
      perspective?1-2*near/w:-depth/100000];
  };
  return {project,distance,near:perspective?near:0,perspective};
}

export function terrainCorners(cell) {
  const h = Number(cell?.height) || 0;
  const shapes = { north: [1,1,0,0], east: [0,1,0,1], south: [0,0,1,1], west: [1,0,1,0],
    outer_north_west: [1,0,0,0], outer_north_east: [0,1,0,0], outer_south_west: [0,0,1,0], outer_south_east: [0,0,0,1],
    inner_north_west: [0,1,1,1], inner_north_east: [1,0,1,1], inner_south_west: [1,1,0,1], inner_south_east: [1,1,1,0] };
  return (shapes[cell?.slope] || [0,0,0,0]).map(n => n + h);
}

export function terrainHeight(terrain, x, y) {
  const cell = terrain?.cells?.[`${Math.floor(x / 32)},${Math.floor(y / 32)}`];
  const u = ((x % 32) + 32) % 32 / 32, v = ((y % 32) + 32) % 32 / 32;
  return terrainCellHeight(cell,u,v,terrain?.heightStep||16);
}

// ModelVisual.project_model and ModelWalking.build both sample the footprint
// centre, then add the saved terrain-relative offset. Keep old scenes intact.
export function modelBaseHeight(terrain,instance) {
  return terrainHeight(terrain,instance.x+(instance.footprintW||1)*16,
    instance.y+(instance.footprintD||1)*16)+(instance.elevation||0);
}

export function terrainCellHeight(cell,u,v,step=16) {
  const [nw, ne, sw, se] = terrainCorners(cell);
  let level;
  if (/^(outer|inner)_/.test(cell?.slope || "")) {
    const distance = Math.hypot(cell.slope.includes("west") ? u : 1-u, cell.slope.includes("north") ? v : 1-v);
    level = cell.height + (cell.slope.startsWith("outer_") ? Math.max(0,1-distance) : Math.min(1,distance));
  } else level = u >= v ? nw + u*(ne-nw) + v*(se-ne) : nw + v*(sw-nw) + u*(se-sw);
  return level * step;
}

// Shared by the committed terrain and its brush ghost. Curved corner slopes
// need interior samples; four corner heights flatten them into a diagonal.
export function terrainSurface(cell,step=16) {
  const count=/^(outer|inner)_/.test(cell?.slope||'')?8:1;
  const grid=Array.from({length:count+1},(_,y)=>Array.from({length:count+1},(_,x)=>
    [x*32/count,y*32/count,terrainCellHeight(cell,x/count,y/count,step)]));
  const triangles=[];
  for(let y=0;y<count;y++)for(let x=0;x<count;x++){
    const a=grid[y][x],b=grid[y][x+1],c=grid[y+1][x+1],d=grid[y+1][x];
    triangles.push([a,b,c],[a,c,d]);
  }
  return {triangles,edges:[grid[0],grid.map(row=>row[count]),[...grid[count]].reverse(),grid.map(row=>row[0]).reverse()]};
}

// Inverse of sceneProjection in CSS pixels; independent of device pixel ratio.
export function sceneRay(camera,x,y,width,height) {
  if(!camera.framing)return null;
  const yaw=(camera.mode==='2d'?0:camera.yaw)*Math.PI/180,pitch=(camera.mode==='2d'?90:camera.pitch)*Math.PI/180;
  const right=[Math.cos(yaw),-Math.sin(yaw),0],down=[Math.sin(yaw)*Math.sin(pitch),Math.cos(yaw)*Math.sin(pitch),-Math.cos(pitch)],back=[Math.sin(yaw)*Math.cos(pitch),Math.cos(yaw)*Math.cos(pitch),Math.sin(pitch)];
  const distance=camera.framing.distance/(camera.zoom||1),sx=x-width/2-(camera.panX||0),sy=y-height/2-(camera.panY||0);
  const perspective=camera.mode!=='2d'&&camera.projection==='perspective';
  const units=perspective?2*Math.tan(25*Math.PI/180)/height:camera.framing.span/(camera.zoom||1)/height;
  // Orthographic rendering has a fixed +/-100000 depth range, independent
  // of orbit distance. Starting at the perspective eye can put lower-screen
  // rays below the ground after zoom/pan, making visible surfaces unpickable.
  const rayDistance=perspective?distance:100000;
  const origin=camera.framing.target.map((v,i)=>v+back[i]*rayDistance+(perspective?0:(right[i]*sx+down[i]*sy)*units));
  const direction=back.map((v,i)=>-v+(perspective?(right[i]*sx+down[i]*sy)*units:0));
  const length=Math.hypot(...direction);
  return {origin,direction:direction.map(v=>v/length)};
}
// Closest point on the vertical line through a model's pivot. Unlike a ground
// plane intersection, this still works with a level camera and raised models.
export function rayElevation(ray,x,y) {
  if(!ray)return null;
  const [dx,dy,dz]=ray.direction,den=dx*dx+dy*dy;
  if(den<1e-6)return null;
  const t=((x-ray.origin[0])*dx+(y-ray.origin[1])*dy)/den;
  return t<0?null:ray.origin[2]+t*dz;
}
export function rayPlane(ray,z=0) {
  if(!ray||Math.abs(ray.direction[2])<1e-6)return null;
  const t=(z-ray.origin[2])/ray.direction[2];
  return t<0?null:{x:ray.origin[0]+ray.direction[0]*t,y:ray.origin[1]+ray.direction[1]*t,z};
}
export function pickTerrain(ray,terrain,width,height) {
  if(!ray)return null;
  let start=0,end=Infinity;
  let maxZ=0;for(const cell of Object.values(terrain?.cells||{}))maxZ=Math.max(maxZ,(Number(cell.height||0)+1)*(terrain.heightStep||16));
  for(let i=0;i<3;i++){
    const lo=0,hi=[width,height,maxZ+1][i],d=ray.direction[i],o=ray.origin[i];
    if(Math.abs(d)<1e-8){if(o<lo||o>hi)return null;continue;}
    const a=(lo-o)/d,b=(hi-o)/d;start=Math.max(start,Math.min(a,b));end=Math.min(end,Math.max(a,b));
  }
  if(start>end)return null;
  const point=t=>({x:ray.origin[0]+ray.direction[0]*t,y:ray.origin[1]+ray.direction[1]*t,z:ray.origin[2]+ray.direction[2]*t});
  for(let t=start;t<=end+1e-6;t=Math.min(end,t+8)){
    const p=point(t);
    if(p.z<=terrainHeight(terrain,p.x,p.y)+.001){
      let low=Math.max(start,t-8),high=t;
      for(let n=0;n<12;n++){const mid=(low+high)/2,q=point(mid);if(q.z<=terrainHeight(terrain,q.x,q.y))high=mid;else low=mid;}
      return point(high);
    }
    if(t===end)break;
  }
  return null;
}
