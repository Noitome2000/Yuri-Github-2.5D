import {terrainSurface} from './scene-geometry.js';

function segmentDistance(x,y,a,b) {
  const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;
  const t=den?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/den)):0;
  return Math.hypot(x-a[0]-dx*t,y-a[1]-dy*t);
}

export function pickToolHandle(handles,x,y) {
  let best=null,distance=Infinity;
  for(const h of handles||[]){
    if(h.kind==='plane'){
      if(Math.abs(x-h.point[0])<h.size&&Math.abs(y-h.point[1])<h.size)return h;
      continue;
    }
    for(let i=1;i<h.points.length;i++){
      const d=segmentDistance(x,y,h.points[i-1],h.points[i]);
      if(d<h.size&&d<distance){best=h;distance=d;}
    }
  }
  return best;
}

export function pickSceneHit(canvas,x,y,preferred=null) {
  const candidates=new Set((canvas.__sceneHits||[]).filter(h=>x>=h.left&&x<=h.right&&y>=h.top&&y<=h.bottom).map(h=>h.id));
  const matches=[];
  for(const entry of canvas.__sceneTriangles||[]){
    if(!candidates.has(entry.id))continue;
    const [a,b,c]=entry.points,den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
    if(Math.abs(den)<1e-8)continue;
    const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den;
    const v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den,w=1-u-v;
    if(Math.min(u,v,w)<-1e-6)continue;
    const depth=canvas.dataset.projection==='perspective'?-1/(u/a[3]+v/b[3]+w/c[3]):u*a[2]+v*b[2]+w*c[2];
    matches.push({id:entry.id,depth});
  }
  if(preferred&&matches.some(h=>h.id===preferred))return matches.find(h=>h.id===preferred);
  return matches.sort((a,b)=>b.depth-a.depth)[0]||null;
}

// Test the rendered, near-clipped triangles, not just their bounding boxes.
// The separating-axis test also covers triangles enclosing the whole marquee.
export function pickSceneRect(canvas,rect) {
  const {left,right,top,bottom}=rect,box=[[left,top],[right,top],[right,bottom],[left,bottom]];
  const candidates=new Set((canvas.__sceneHits||[]).filter(h=>h.right>=left&&h.left<=right&&h.bottom>=top&&h.top<=bottom).map(h=>h.id));
  const found=new Set();
  for(const {id,points} of canvas.__sceneTriangles||[]){
    if(!candidates.has(id)||found.has(id))continue;
    const axes=[[1,0],[0,1],...points.map((p,i)=>{const q=points[(i+1)%3];return [p[1]-q[1],q[0]-p[0]];})];
    if(axes.every(([x,y])=>{
      const a=points.map(p=>p[0]*x+p[1]*y),b=box.map(p=>p[0]*x+p[1]*y);
      return Math.max(...a)>=Math.min(...b)&&Math.max(...b)>=Math.min(...a);
    }))found.add(id);
  }
  return [...found];
}

export function drawSceneTools(canvas,{tool,instance,ghost,terrainGhost,heightAt,activeAxis,rotationDelta,hoveredId,marquee,placementRect}) {
  canvas.__toolHandles=[];
  const project=canvas.__sceneProject;if(!project)return;
  const ratio=canvas.width/Math.max(1,canvas.clientWidth),ctx=canvas.getContext('2d');
  ctx.save();ctx.setTransform(1,0,0,1,0,0);
  const path=(points,close=false)=>{ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));if(close)ctx.closePath();};
  canvas.dataset.hoveredInstance=hoveredId||'';
  if(hoveredId){
    const mask=canvas.__hoverMask||(canvas.__hoverMask=document.createElement('canvas'));
    const outline=canvas.__hoverOutline||(canvas.__hoverOutline=document.createElement('canvas'));
    for(const c of [mask,outline]){if(c.width!==canvas.width)c.width=canvas.width;if(c.height!==canvas.height)c.height=canvas.height;}
    const m=mask.getContext('2d');m.clearRect(0,0,mask.width,mask.height);m.fillStyle='#fff';m.strokeStyle='#fff';m.lineWidth=ratio;
    for(const tri of canvas.__sceneTriangles||[])if(tri.id===hoveredId){m.beginPath();tri.points.forEach((p,i)=>i?m.lineTo(p[0],p[1]):m.moveTo(p[0],p[1]));m.closePath();m.fill();m.stroke();}
    const o=outline.getContext('2d');o.clearRect(0,0,outline.width,outline.height);o.globalCompositeOperation='source-over';
    for(const [dx,dy] of [[-2,0],[2,0],[0,-2],[0,2],[-1,-1],[1,-1],[-1,1],[1,1]])o.drawImage(mask,dx*ratio,dy*ratio);
    o.globalCompositeOperation='destination-out';o.drawImage(mask,0,0);o.globalCompositeOperation='source-in';o.fillStyle='#ffc45b';o.fillRect(0,0,outline.width,outline.height);o.globalCompositeOperation='source-over';ctx.drawImage(outline,0,0);
  }
  if(terrainGhost){
    const erase=terrainGhost.cells[0]?.value==null,outline=erase?'#ff9a70':'#ffda62';
    const shapes=new Map(),footprint=new Set(terrainGhost.cells.map(c=>`${c.x},${c.y}`));
    for(const cell of terrainGhost.cells){
      const x=cell.x*32,y=cell.y*32;
      const key=JSON.stringify(cell.value);let surface=shapes.get(key);
      if(!surface){surface=terrainSurface(cell.value,terrainGhost.heightStep);shapes.set(key,surface);}
      const top=p=>project(x+p[0],y+p[1],p[2]+.5);
      const base=p=>project(x+p[0],y+p[1],heightAt(x+Math.max(.01,Math.min(31.99,p[0])),y+Math.max(.01,Math.min(31.99,p[1])))+.5);
      ctx.fillStyle=erase?'#ff785060':'#ffc94d60';
      for(const triangle of surface.triangles){const points=triangle.map(top);if(points.every(p=>p[3]>0)){path(points,true);ctx.fill();}}
      for(let side=0;side<4;side++){
        const edge=surface.edges[side],points=edge.map(top),ground=edge.map(base);
        const [dx,dy]=[[0,-1],[1,0],[0,1],[-1,0]][side],outer=!footprint.has(`${cell.x+dx},${cell.y+dy}`);
        if(outer){
          ctx.fillStyle=erase?'#ff785025':'#ffbf4035';
          const lower=cell.value?.type==='overpass'?edge.map(p=>project(x+p[0],y+p[1],Math.max(0,p[2]-4)+.5)):ground;
          for(let j=1;j<edge.length;j++){const face=[lower[j-1],lower[j],points[j],points[j-1]];if(face.every(p=>p[3]>0)){path(face,true);ctx.fill();}}
          ctx.strokeStyle=outline;ctx.lineWidth=ratio;ctx.setLineDash([4*ratio,3*ratio]);
          if(ground.every(p=>p[3]>0)){path(ground);ctx.stroke();}ctx.setLineDash([]);
          if(points[0][3]>0&&ground[0][3]>0){path([points[0],ground[0]]);ctx.stroke();}
        }
        if(points.every(p=>p[3]>0)){
          ctx.strokeStyle=outer?outline:erase?'#ff9a7060':'#ffda6260';ctx.lineWidth=(outer?2:1)*ratio;path(points);ctx.stroke();
        }
      }
    }
    const first=terrainGhost.cells[0];
    if(first){
      const xs=terrainGhost.cells.map(c=>c.x),ys=terrainGhost.cells.map(c=>c.y);
      const label=`${Math.min(...xs)}, ${Math.min(...ys)} · ${Math.max(...xs)-Math.min(...xs)+1}×${Math.max(...ys)-Math.min(...ys)+1} · ${erase?'清除':`${first.value.height} 级`}`;
      const p=project(first.x*32,first.y*32,(first.value?.height||0)*terrainGhost.heightStep+.5);
      if(p[3]>0){
        ctx.font=`${12*ratio}px sans-serif`;const width=ctx.measureText(label).width+12*ratio;
        const tx=Math.max(8*ratio,Math.min(canvas.width-width-8*ratio,p[0]+10*ratio)),ty=Math.max(24*ratio,Math.min(canvas.height-12*ratio,p[1]-12*ratio));
        ctx.fillStyle='#202020ee';ctx.fillRect(tx-5*ratio,ty-16*ratio,width,22*ratio);ctx.fillStyle=outline;ctx.fillText(label,tx,ty);
      }
    }
  }
  if(placementRect){
    const {left,top,right,bottom,count}=placementRect;
    const points=[[left,top],[right,top],[right,bottom],[left,bottom]].map(([x,y])=>project(x,y,heightAt(x,y)+.5));
    if(points.every(p=>p[3]>0)){
      ctx.strokeStyle='#ffd163';ctx.lineWidth=2*ratio;path(points,true);ctx.stroke();
      const label=`${Math.round((right-left)/32)}×${Math.round((bottom-top)/32)} · ${count} 个`;
      ctx.font=`${12*ratio}px sans-serif`;const width=ctx.measureText(label).width+12*ratio;
      const tx=Math.max(6*ratio,Math.min(canvas.width-width,points[0][0])),ty=Math.max(24*ratio,Math.min(canvas.height-8*ratio,points[0][1]-10*ratio));
      ctx.fillStyle='#202020ee';ctx.fillRect(tx-5*ratio,ty-16*ratio,width,22*ratio);ctx.fillStyle='#ffdb83';ctx.fillText(label,tx,ty);
    }
  }
  if(ghost&&!placementRect){
    const i=ghost.instance,x=i.x,y=i.y,w=i.footprintW*32,d=i.footprintD*32;
    const footprint=[[x,y],[x+w,y],[x+w,y+d],[x,y+d]].map(([a,b])=>project(a,b,heightAt(a,b)+.3));
    if(footprint.every(p=>p[3]>0)){
      ctx.fillStyle='#ffc94d35';ctx.strokeStyle='#ffd163';ctx.lineWidth=2*ratio;path(footprint,true);ctx.fill();ctx.stroke();
      // RMXP-style cell outlines make the full occupied area visible.
      ctx.lineWidth=ratio;ctx.strokeStyle='#ffd163aa';
      for(let a=32;a<w;a+=32) {path([project(x+a,y,heightAt(x+a,y)+.3),project(x+a,y+d,heightAt(x+a,y+d)+.3)]);ctx.stroke();}
      for(let b=32;b<d;b+=32) {path([project(x,y+b,heightAt(x,y+b)+.3),project(x+w,y+b,heightAt(x+w,y+b)+.3)]);ctx.stroke();}
      const p=project(x,y,heightAt(x,y)+.5),text=`${Math.floor(x/32)}, ${Math.floor(y/32)}  ·  ${i.footprintW}×${i.footprintD}`;
      ctx.font=`${12*ratio}px sans-serif`;const width=ctx.measureText(text).width+12*ratio;
      const tx=Math.max(4*ratio,Math.min(canvas.width-width-4*ratio,p[0]+10*ratio));
      const ty=Math.max(20*ratio,Math.min(canvas.height-8*ratio,p[1]-10*ratio));
      ctx.fillStyle='#202020ee';ctx.fillRect(tx-5*ratio,ty-16*ratio,width,22*ratio);ctx.fillStyle='#ffdb83';ctx.fillText(text,tx,ty);
    }
  }
  if(instance&&!marquee&&['select','move','rotate','scale'].includes(tool)){
    const x=instance.x+instance.footprintW*16,y=instance.y+instance.footprintD*16,z=heightAt(x,y)+(instance.elevation||0)+.5;
    const origin=project(x,y,z);
    if(origin[3]>0){
      const handle=(axis,points,color,extra={})=>{
        ctx.strokeStyle='#111a';ctx.lineWidth=6*ratio;path(points);ctx.stroke();
        ctx.strokeStyle=activeAxis===axis?'#ffe066':color;ctx.lineWidth=3*ratio;path(points);ctx.stroke();
        canvas.__toolHandles.push({axis,points,size:9*ratio,...extra});
      };
      if(tool==='move'||tool==='select'){
        for(const [axis,delta,color,label]of [['elevation',[0,0,32],'#24884f','Y'],['x',[32,0,0],'#e96464','X'],['y',[0,32,0],'#649bff','Z']]){
          const p=project(x+delta[0],y+delta[1],z+delta[2]),dx=p[0]-origin[0],dy=p[1]-origin[1],length=Math.hypot(dx,dy);if(p[3]<=0||length<.01)continue;
          const end=[origin[0]+dx/length*68*ratio,origin[1]+dy/length*68*ratio];
          handle(axis,[origin,end],color);ctx.fillStyle=activeAxis===axis?'#ffe066':color;
          const ux=dx/length,uy=dy/length;
          path([end,[end[0]-ux*13*ratio-uy*5*ratio,end[1]-uy*13*ratio+ux*5*ratio],
            [end[0]-ux*13*ratio+uy*5*ratio,end[1]-uy*13*ratio-ux*5*ratio]],true);ctx.fill();
          ctx.font=`bold ${11*ratio}px sans-serif`;ctx.fillText(label,end[0]+5*ratio,end[1]-5*ratio);
        }
        ctx.fillStyle=activeAxis==='plane'?'#ffe066':'#eac65f';ctx.fillRect(origin[0]-5*ratio,origin[1]-5*ratio,10*ratio,10*ratio);
        canvas.__toolHandles.unshift({axis:'plane',kind:'plane',point:origin,size:9*ratio});
      }
      if(tool==='rotate'||tool==='select'){
        const px=project(x+32,y,z),py=project(x,y+32,z);
        const projectedRadius=Math.max(Math.hypot(px[0]-origin[0],px[1]-origin[1]),Math.hypot(py[0]-origin[0],py[1]-origin[1]),.01);
        const radius=32*(tool==='select'?88:64)*ratio/projectedRadius;
        const points=Array.from({length:65},(_,i)=>{const a=i/64*Math.PI*2;return project(x+Math.cos(a)*radius,y+Math.sin(a)*radius,z);});
        if(points.every(p=>p[3]>0))handle('rotation',points,'#79d88a',{world:true});
        const p=points[8],q=points[9],dx=q[0]-p[0],dy=q[1]-p[1],length=Math.hypot(dx,dy)||1;
        ctx.fillStyle=activeAxis==='rotation'?'#ffe066':'#79d88a';
        path([q,[q[0]-dx/length*12*ratio-dy/length*5*ratio,q[1]-dy/length*12*ratio+dx/length*5*ratio],
          [q[0]-dx/length*12*ratio+dy/length*5*ratio,q[1]-dy/length*12*ratio-dx/length*5*ratio]],true);ctx.fill();
        ctx.font=`bold ${11*ratio}px sans-serif`;ctx.fillText('Y',points[0][0]+7*ratio,points[0][1]);
        if(rotationDelta!=null){
          ctx.fillStyle='#202020ee';ctx.fillRect(origin[0]+10*ratio,origin[1]-28*ratio,72*ratio,22*ratio);
          ctx.fillStyle='#ffe066';ctx.fillText(`${Math.round(instance.rotation)}°`,origin[0]+16*ratio,origin[1]-13*ratio);
          path([origin,points[0]]);ctx.strokeStyle='#79d888';ctx.lineWidth=ratio;ctx.stroke();
        }
      }else if(tool==='scale'){
        const end=[origin[0]+48*ratio,origin[1]-48*ratio];handle('scale',[origin,end],'#eeeeee');
        ctx.fillStyle='#eeeeee';ctx.fillRect(end[0]-5*ratio,end[1]-5*ratio,10*ratio,10*ratio);
      }
    }
  }
  if(marquee){
    ctx.fillStyle='#528ac530';ctx.strokeStyle='#91c9ff';ctx.lineWidth=ratio;
    const {left,top,right,bottom}=marquee;
    ctx.fillRect(left,top,right-left,bottom-top);ctx.strokeRect(left,top,right-left,bottom-top);
  }
  ctx.restore();
}
