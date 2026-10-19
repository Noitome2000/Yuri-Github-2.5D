// Editor pages are previews, not a simulation of game switches/self switches.
export function previewEvent(event) {
  const page=event.pages?.[0], graphic=page?.graphic||event.graphic||{};
  return {id:event.id,name:event.name||`事件 ${event.id}`,x:Number(event.x)||0,y:Number(event.y)||0,
    characterName:graphic.character_name||graphic.characterName||'',
    tileId:Number(graphic.tile_id??graphic.tileId)||0,
    direction:[2,4,6,8].includes(Number(graphic.direction))?Number(graphic.direction):2,
    pattern:Math.max(0,Math.min(3,Number(graphic.pattern)||0)),
    opacity:Math.max(0,Math.min(255,Number(graphic.opacity??255)))/255};
}

export function eventFrame(event,image) {
  const sw=image.width/4,sh=image.height/4;
  return {sw,sh,sx:sw*event.pattern,sy:sh*(event.direction/2-1)};
}

export function eventQuad(event,camera,z) {
  const yaw=(camera.mode==='2d'?0:camera.yaw)*Math.PI/180;
  const pitch=(camera.mode==='2d'?90:camera.pitch)*Math.PI/180;
  const x=event.x*32+16,y=event.y*32+32,h=event.sh||32,w=event.sw||24;
  const right=[Math.cos(yaw),-Math.sin(yaw),0],up=[-Math.sin(yaw)*Math.sin(pitch),-Math.cos(yaw)*Math.sin(pitch),Math.cos(pitch)];
  return [[-w/2,h],[w/2,h],[w/2,0],[-w/2,0]].map(([r,u])=>
    [x+right[0]*r+up[0]*u,y+right[1]*r+up[1]*u,z+up[2]*u]);
}
