// Serialized settings shared by resource, scene and instance inspectors.
const number=(v,d,min,max)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):d;
export function normalizeLight(raw={}) {
  const r=raw&&typeof raw==='object'?raw:{};
  return {enabled:r.enabled===true,type:r.type==='street'?'street':'point',
    coneAngle:number(r.coneAngle,50,10,140),softness:number(r.softness,0.35,0.01,1),beam:number(r.beam,0.22,0,1),
    color:/^#[0-9a-f]{6}$/i.test(r.color)?r.color:'#ffe0a0',
    radius:number(r.radius,128,8,640),height:number(r.height,48,0,512),
    offsetX:number(r.offsetX,0,-256,256),offsetY:number(r.offsetY,0,-256,256),offsetZ:number(r.offsetZ,0,-256,256),
    tilt:number(r.tilt,0,-75,75),heading:number(r.heading,0,-360,360),
    intensity:number(r.intensity,0.8,0,3),breath:number(r.breath,0.08,0,0.5),period:number(r.period,3.5,0.5,30)};
}
export function normalizeEffects(raw={}) {
  const r=raw&&typeof raw==='object'?raw:{};
  return {preset:['none','cartoon','hd2d'].includes(r.preset)?r.preset:'none',
    lighting:r.lighting===true,ambient:number(r.ambient,1.0,0.1,1.5),
    maxLights:Math.round(number(r.maxLights,8,1,8)),strength:number(r.strength,0.65,0,1),
    bloom:number(r.bloom,0.12,0,0.5),dof:number(r.dof,0.3,0,1)};
}
