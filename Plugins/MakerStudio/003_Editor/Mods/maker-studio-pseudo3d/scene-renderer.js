import { sceneProjection, terrainCorners, terrainHeight, terrainSurface } from "./scene-geometry.js";
import { transformVertices, modelUnitScale, shade, drawTexturedTriangle } from "./mesh-renderer.js";
import { ScenePainter,clipNear } from './scene-painter.js';
import { modelPivot, rotateModelVertices } from './model-transform.js';
import { streetLightGuide, drawStreetLightGuide } from './street-light-guide.js';
import { animatedAsset, advanceAnimationClock } from './model-animation.js';
import {eventQuad} from './event-preview.js';

const animationClocks = new WeakMap();

const painters = new Map();
export function disposeSceneRenderers() {
  for (const painter of painters.values()) painter.dispose();
  painters.clear();
}

function polygon(ctx, points) {
  ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]);
  for (const p of points.slice(1)) ctx.lineTo(p[0], p[1]);
  ctx.closePath();
}

// Rotation only changes the local model vertices. Cache that work by asset
// object so a scene with many copies of the same model transforms each mesh
// once per angle instead of once per instance and frame.
const transformedModelCache = new WeakMap();
const terrainCache = new WeakMap();
function preparedTerrain(terrain) {
  if (!terrain) return { cells: [], max: 0 };
  let prepared = terrainCache.get(terrain);
  if (prepared) return prepared;
  prepared = { cells: [], max: 0 };
  const step=terrain.heightStep||16;
  for(const [key,cell] of Object.entries(terrain.cells||{})) {
    const [tx,ty]=key.split(',').map(Number), h=terrainCorners(cell).map(n=>n*step);
    prepared.max=Math.max(prepared.max,...h);
    if(!h.some(n=>Math.abs(n)>1e-6)&&!cell.slope&&cell.type!=='overpass')continue;
    const neighbors=[[tx,ty-1,2,3,0,1],[tx+1,ty,0,2,1,3],[tx,ty+1,1,0,3,2],[tx-1,ty,3,1,2,0]];
    const sides=neighbors.map(([nx,ny,a,b,c,d])=>{
      if(cell.type==='overpass')return true;
      const neighbor=terrain.cells?.[`${nx},${ny}`];
      if(neighbor?.type==='overpass')return true;
      const nh=terrainCorners(neighbor).map(n=>n*step);
      return h[c]>nh[a]+1e-6||h[d]>nh[b]+1e-6;
    });
    prepared.cells.push({tx,ty,cell,h,sides,surface:terrainSurface(cell,step)});
  }
  terrainCache.set(terrain,prepared);return prepared;
}

function preparedModel(asset, rotation) {
  let byRotation = transformedModelCache.get(asset);
  if (!byRotation) { byRotation = new Map(); transformedModelCache.set(asset, byRotation); }
  const angle = Number(rotation) || 0;
  const key = Math.round(angle * 1000) / 1000;
  let prepared = byRotation.get(key);
  if (prepared) return prepared;
  const pivot = modelPivot(asset);
  prepared = { pivot, vertices: transformVertices(rotateModelVertices(asset), key, pivot), unit: modelUnitScale(asset) };
  byRotation.set(key, prepared);
  // Avoid retaining every angle from a free-drag session forever.
  if (byRotation.size > 96) byRotation.delete(byRotation.keys().next().value);
  return prepared;
}

// Orthographic scene camera, shared by map surfaces and all model vertices.
// Never fit or rotate each object separately when orbiting the scene.
export function renderScene(canvas, state) {
  const { snapshot, terrain, library, instances, camera, selected, sourceFor, texturesFor } = state;
  let clocks=animationClocks.get(canvas);
  if(!clocks){clocks=new Map();animationClocks.set(canvas,clocks);}
  const liveIds=new Set(instances.map(i=>i.id));
  for(const id of clocks.keys())if(!liveIds.has(id))clocks.delete(id);
  const selectedIds=new Set(state.selectedIds||[selected]);
  const width = Math.max(240, canvas.clientWidth || 420), height = Math.max(180, canvas.clientHeight || 260);
  // GPU batches retain full geometry, textures and resolution during gestures.
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  // Render in physical pixels; textured triangles temporarily reset the transform.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#101a28"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!snapshot) {
    canvas.__sceneProject=null;
    ctx.fillStyle = "#c0d1df"; ctx.font = `${13 * ratio}px sans-serif`;
    ctx.fillText(state.message || "正在读取整张地图…", 20 * ratio, 40 * ratio); return;
  }
  for (const [old, painter] of painters) if (old !== canvas && !old.isConnected) { painter.dispose(); painters.delete(old); }
  if (!painters.has(canvas)) painters.set(canvas, new ScenePainter(drawTexturedTriangle));
  const painter = painters.get(canvas);
  painter.gpu = painter.begin(ctx);
  const assetsById = new Map(library.assets.map(asset => [asset.id, asset]));
  const mapWidth = snapshot.info.width * 32, mapHeight = snapshot.info.height * 32;
  const terrainMesh = preparedTerrain(terrain), maxTerrain = terrainMesh.max;
  let maxObject = 0;
  for (const tile of snapshot.standingTiles || []) maxObject=Math.max(maxObject,(tile.height||32)+(tile.elevation||0));
  for (const instance of instances) {
    const asset = assetsById.get(instance.assetId);
    maxObject = Math.max(maxObject, (asset?.pixelHeight || 0) * (instance.scale || 1)+(instance.elevation||0));
  }
  const projection=sceneProjection(camera,mapWidth,mapHeight,maxTerrain+maxObject,width,height,ratio);
  // The backing buffer rounds each dimension independently at fractional DPI.
  // Match that rounding so CSS pointer rays still invert the drawn projection.
  const scaleX=canvas.width/(width*ratio),scaleY=canvas.height/(height*ratio);
  const project=(...point)=>{const p=projection.project(...point);p[0]*=scaleX;p[1]*=scaleY;return p;};
  canvas.__sceneProject=project;painter.near=projection.near;
  const ground = [[0,0], [mapWidth,0], [mapWidth,mapHeight], [0,mapHeight]].map(p => project(...p));
  painter.quad(ground,snapshot.canvas,[[0,1],[1,1],[1,0],[0,0]]);
  const faces = [];
  const add = (points, draw) => faces.push({ depth: points.reduce((n,p)=>n+p[2],0)/points.length, draw });
  canvas.__sceneEvents=[];
  for(const event of snapshot.events||[]) {
    const z=terrainHeight(terrain,event.x*32+16,event.y*32+16);
    const points=eventQuad(event,camera,z).map(p=>project(...p));
    canvas.__sceneEvents.push({id:event.id,points});
    add(points,()=>{
      if(event.image){const {sx,sy,sw,sh,image}=event;
        const uv=[[sx,sy],[sx+sw,sy],[sx+sw,sy+sh],[sx,sy+sh]].map(([u,v])=>[u/image.width,1-v/image.height]);
        painter.quad(points,image,uv,event.opacity);
      } else {
        // Empty/unsupported graphics still have a visible editor event marker.
        for(const ids of [[0,1,2],[0,2,3]])painter.triangle(ids.map(i=>points[i]),null,null,'#e7b84b',0.6);
      }
    });
  }
  for (const tile of snapshot.standingTiles || []) {
    const image = tile.image;
    if (!image || !tile.sw || !tile.sh) continue;
    const x0 = Number(tile.worldX ?? tile.x * 32), x1 = x0 + (tile.width || 32);
    const y = Number(tile.worldY ?? tile.y * 32) + 32;
    const z = terrainHeight(terrain, (x0 + x1) / 2, y - .001) + (tile.elevation || 0);
    const h = Number(tile.height) || 32;
    const points = [project(x0, y, z + h), project(x1, y, z + h), project(x1, y, z), project(x0, y, z)];
    add(points, () => {
      const angle = -(tile.rotation || 0) * Math.PI / 180;
      const uv = [[0,0],[1,0],[1,1],[0,1]].map(([u,v]) => {
        const x=u-.5,y=v-.5;
        u=x*Math.cos(angle)-y*Math.sin(angle)+.5; v=x*Math.sin(angle)+y*Math.cos(angle)+.5;
        if(tile.flipH)u=1-u;if(tile.flipV)v=1-v;
        return [(tile.sx+u*tile.sw)/image.width,1-(tile.sy+v*tile.sh)/image.height];
      });
      painter.quad(points,image,uv,tile.opacity ?? 1);
    });
  }
  for (const {tx,ty,cell,h,sides,surface} of terrainMesh.cells) {
    if (tx >= snapshot.info.width || ty >= snapshot.info.height) continue;
    const x=tx*32, y=ty*32;
    // The ground bitmap already contains all flat map tiles. Do not redraw
    // every flat terrain cell as two textured triangles; only elevated,
    // sloped, or overpass cells need a separate surface and side faces.
    const elevated = h.some(value => Math.abs(value) > 1e-6) || cell.slope || cell.type === "overpass";
    if (!elevated) continue;
    for (let i=0;i<4;i++) {
      if (!sides[i]) continue;
      const edge=surface.edges[i];
      for(let j=1;j<edge.length;j++){
        const [a,b]=[edge[j-1],edge[j]],bottom=p=>project(x+p[0],y+p[1],cell.type==='overpass'?Math.max(0,p[2]-4):0);
        const side=[bottom(a),bottom(b),project(x+b[0],y+b[1],b[2]),project(x+a[0],y+a[1],a[2])];
        add(side, () => { for (const ids of [[0,1,2],[0,2,3]]) painter.triangle(ids.map(j=>side[j]),null,null,["#384856","#4a5e6e","#607386","#415365"][i]); });
      }
    }
    for (const triangle of surface.triangles) {
      const points=triangle.map(p=>project(x+p[0],y+p[1],p[2]));
      add(points,()=>{
        const uv=triangle.map(p=>[(x+p[0])/mapWidth,1-(y+p[1])/mapHeight]);
        painter.triangle(points,snapshot.canvas,uv);
      });
    }
  }
  const bounds = [];
  canvas.__sceneHits=[];
  canvas.__sceneTriangles=[];
  for (const instance of instances) {
    const asset = assetsById.get(instance.assetId);
    if (!asset || instance.visible === false) continue;
    const x=instance.x+(instance.footprintW || 1)*16;
    const y=instance.y+(instance.footprintD || 1)*(asset.type === "model" ? 16 : 32);
    const z=terrainHeight(terrain,x,y)+(instance.elevation||0), opacity=(instance.opacity ?? 255)/255;
    let points=[];
    const pickPoints=[];
    const pickTriangle=tri=>{
      if(instance.id.startsWith('__preview'))return;
      const clipped=projection.near>0&&tri.some(p=>p[3]<projection.near)?clipNear(tri,null,projection.near).map(v=>v.p):tri;
      if(clipped.some(p=>p[3]<projection.near)||clipped.length<3)return;
      pickPoints.push(...clipped);
      for(let i=1;i<clipped.length-1;i++)canvas.__sceneTriangles.push({id:instance.id,points:[clipped[0],clipped[i],clipped[i+1]]});
    };
    if (asset.type === "model") {
      let pose=asset;
      if(asset.animation && instance.walkable!==true){
        let clock=clocks.get(instance.id);
        if(!clock||clock.asset!==asset){clock={asset,seconds:0,last:null};clocks.set(instance.id,clock);}
        const elapsed=advanceAnimationClock(clock,instance,state.animationTime??performance.now()/1000);
        pose=animatedAsset(asset,{...instance,animationSpeed:1},elapsed);
      }
      const prepared = preparedModel(pose, instance.rotation);
      const pivot = prepared.pivot, vertices = prepared.vertices;
      const unit=prepared.unit*(instance.scale||1);
      points=vertices.map(v=>project(x+(v[0]-pivot[0])*unit,y+(v[2]-pivot[2])*unit,z+(v[1]-pivot[1])*unit));
      const textures=texturesFor(asset);
      for (const face of asset.faces) {
        const ids=[face.a,face.b,face.c], tri=ids.map(i=>points[i]);
        if (tri.some(p=>!p)) continue;
        pickTriangle(tri);
        add(tri,()=>{
          const image=textures.get(face.texture), uvs=ids.map(i=>asset.uvs?.[i]);
          // Keep model materials visible while orbiting. The old interactive
          // fast path replaced every textured face with a gray solid, which
          // made the preview appear broken during normal pointer movement.
          if (image && uvs.every(Boolean)) painter.triangle(tri,image,uvs,'#ffffff',opacity);
          else painter.triangle(tri,null,null,shade(face.color,...ids.map(i=>vertices[i])),opacity);
        });
      }
    } else {
      const image=sourceFor(asset,0);
      if (!image?.naturalWidth) continue;
      const h=asset.pixelHeight*(instance.scale||1), w=h*asset.imageWidth/asset.imageHeight;
      const r=instance.rotation*Math.PI/180, dx=Math.cos(r)*w/2, dy=Math.sin(r)*w/2;
      points=[project(x-dx,y-dy,z+h),project(x+dx,y+dy,z+h),project(x+dx,y+dy,z),project(x-dx,y-dy,z)];
      for(const ids of [[0,1,2],[0,2,3]])pickTriangle(ids.map(i=>points[i]));
      add(points,()=>{
        painter.quad(points,image,[[0,1],[1,1],[1,0],[0,0]],opacity);
      });
    }
    if (selectedIds.has(instance.id) && pickPoints.length) bounds.push(pickPoints);
    const visiblePoints=pickPoints;
    if(visiblePoints.length&&!instance.id.startsWith('__preview')){const xs=visiblePoints.map(p=>p[0]),ys=visiblePoints.map(p=>p[1]);
      canvas.__sceneHits.push({id:instance.id,left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys),depth:Math.max(...visiblePoints.map(p=>p[2]))});}
  }
  faces.sort((a,b)=>a.depth-b.depth);
  for (const face of faces) face.draw();
  painter.end();
  for(const instance of instances)if(selectedIds.has(instance.id))
    drawStreetLightGuide(ctx,project,streetLightGuide(instance,assetsById.get(instance.assetId),terrain),ratio,projection.near);
  canvas.dataset.renderer = painter.gpu ? 'webgl' : 'canvas2d';
  canvas.dataset.projection = projection.perspective ? 'perspective' : 'orthographic';
  canvas.dataset.distance = String(projection.distance);
  if(ground.every(p=>p[3]>projection.near)){ctx.strokeStyle="#7392ac";ctx.lineWidth=ratio;polygon(ctx,ground);ctx.stroke();}
  for (const points of bounds) {
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    ctx.strokeStyle="#38d6df";ctx.setLineDash([5*ratio,4*ratio]);
    ctx.strokeRect(Math.min(...xs)-3,Math.min(...ys)-3,Math.max(...xs)-Math.min(...xs)+6,Math.max(...ys)-Math.min(...ys)+6);
  }
  ctx.setLineDash([]);ctx.fillStyle="#bacbd8";ctx.font=`${11*ratio}px sans-serif`;
  ctx.fillText(`${snapshot.info.width} × ${snapshot.info.height} 格 · ${instances.filter(i=>!i.id.startsWith('__preview')).length} 个物件`,12*ratio,canvas.height-12*ratio);
}
