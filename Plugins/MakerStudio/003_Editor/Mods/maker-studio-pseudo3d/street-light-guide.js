import {normalizeLight} from './visual-effects.js';
import {terrainHeight} from './scene-geometry.js';

// A selected-light gizmo, in the same map pixels and anchor as the game.
export function streetLightGuide(instance,asset,terrain) {
  const light=normalizeLight(instance.light);
  if(!light.enabled||light.type!=='street'||instance.visible===false||instance.opacity===0)return null;
  const anchorX=instance.x+(instance.footprintW||1)*16;
  const anchorY=instance.y+(instance.footprintD||1)*(asset?.type==='model'?16:32);
  const x=anchorX+light.offsetX,y=anchorY+light.offsetY;
  const base=terrainHeight(terrain,anchorX,anchorY)+(instance.elevation||0),height=Math.max(0,light.height+light.offsetZ),apex=[x,y,base+height];
  const tilt=light.tilt*Math.PI/180,heading=light.heading*Math.PI/180;
  const axis=[Math.sin(heading)*Math.sin(tilt),Math.cos(heading)*Math.sin(tilt),-Math.cos(tilt)];
  const u=[Math.cos(heading),-Math.sin(heading),0];
  const v=[Math.sin(heading)*Math.cos(tilt),Math.cos(heading)*Math.cos(tilt),Math.sin(tilt)];
  const half=light.coneAngle*Math.PI/360;
  const ring=Array.from({length:49},(_,i)=>{
    const angle=i/48*Math.PI*2;
    const ray=axis.map((a,k)=>a*Math.cos(half)+(u[k]*Math.cos(angle)+v[k]*Math.sin(angle))*Math.sin(half));
    const distance=Math.min(light.radius,ray[2]<-1e-6?height/-ray[2]:light.radius);
    return apex.map((a,k)=>a+ray[k]*distance);
  });
  return {light,apex,base:[x,y,base],ring};
}

export function drawStreetLightGuide(ctx,project,guide,ratio=1,near=0) {
  if(!guide)return;
  const {light}=guide,apex=project(...guide.apex),base=project(...guide.base),ring=guide.ring.map(p=>project(...p));
  if([apex,base,...ring].some(p=>p[3]<=near))return;
  ctx.save();ctx.setLineDash([]);ctx.strokeStyle=light.color;ctx.lineWidth=ratio;
  ctx.beginPath();ring.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.stroke();
  for(const i of [0,12,24,36]){ctx.beginPath();ctx.moveTo(...apex.slice(0,2));ctx.lineTo(...ring[i].slice(0,2));ctx.stroke();}
  ctx.setLineDash([3*ratio,4*ratio]);ctx.beginPath();ctx.moveTo(...apex.slice(0,2));ctx.lineTo(...base.slice(0,2));ctx.stroke();
  ctx.setLineDash([]);ctx.fillStyle=light.color;ctx.beginPath();ctx.arc(apex[0],apex[1],3*ratio,0,Math.PI*2);ctx.fill();
  ctx.font=`${11*ratio}px sans-serif`;ctx.fillText(`路灯 · 高 ${light.height}px · 张角 ${light.coneAngle}°`,apex[0]+8*ratio,apex[1]-8*ratio);
  ctx.restore();
}
