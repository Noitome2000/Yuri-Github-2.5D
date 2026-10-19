export function sceneGesture(button, alt, mode) {
  if (button === 1) return 'pan';
  if (alt && button === 2) return 'dolly';
  if (alt && button === 0) return mode === '2d' ? 'pan' : 'orbit';
  if (button === 2) return mode === '2d' ? 'pan' : 'look';
  return button === 0 ? 'select' : null;
}

export function cameraBasis(camera) {
  const yaw=(camera.mode==='2d'?0:camera.yaw)*Math.PI/180;
  const pitch=(camera.mode==='2d'?90:camera.pitch)*Math.PI/180;
  const c=Math.cos(yaw),s=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  return {right:[c,-s,0],down:[s*sp,c*sp,-cp],back:[s*cp,c*cp,sp]};
}
export function cameraEye(camera) {
  const d=camera.framing.distance/(camera.zoom||1),back=cameraBasis(camera).back;
  return camera.framing.target.map((v,i)=>v+back[i]*d);
}
export function zoomScene(camera, delta) {
  camera.zoom=Math.max(.02,Math.min(100,(camera.zoom||1)*Math.exp(delta)));
}
export function moveSceneCamera(camera, action, dx, dy, viewHeight) {
  if (!camera.framing) return;
  if (action==='dolly') {zoomScene(camera,(dx-dy)*.005);return;}
  if (action==='pan') {
    const basis=cameraBasis(camera),distance=camera.framing.distance/(camera.zoom||1);
    const span=camera.projection==='perspective'&&camera.mode!=='2d'
      ? distance*2*Math.tan(25*Math.PI/180) : camera.framing.span/(camera.zoom||1);
    const units=span/Math.max(1,viewHeight);
    camera.framing.target=camera.framing.target.map((v,i)=>v-units*(dx*basis.right[i]+dy*basis.down[i]));
    return;
  }
  if(action!=='orbit'&&action!=='look')return;
  const eye=action==='look'?cameraEye(camera):null;
  camera.yaw=((camera.yaw-dx*.25)%360+360)%360;
  camera.pitch=Math.max(-89.5,Math.min(89.5,camera.pitch+dy*.25));
  if(eye){const {back}=cameraBasis(camera),distance=camera.framing.distance/(camera.zoom||1);
    camera.framing.target=eye.map((v,i)=>v-back[i]*distance);}
}
export function flySceneCamera(camera, keys, seconds) {
  if(!camera.framing)return;
  const {right,back}=cameraBasis(camera);
  const horizontal=Number(keys.has('d'))-Number(keys.has('a'));
  const forward=Number(keys.has('w'))-Number(keys.has('s'));
  const up=Number(keys.has('e'))-Number(keys.has('q'));
  const delta=right.map((v,i)=>v*horizontal-back[i]*forward+(i===2?up:0));
  const length=Math.hypot(...delta);if(!length)return;
  const speed=Math.max(16,camera.framing.distance/(camera.zoom||1)*.3)*(camera.flySpeed||1)*(keys.has('shift')?4:1);
  camera.framing.target=camera.framing.target.map((v,i)=>v+delta[i]/length*speed*seconds);
}

// Unity Scene navigation. Listeners belong to the preview, never the map editor.
export function connectSceneInput(canvas,camera,{redraw,select,focus,editStart,editMove,editEnd,shortcut,hover,leave,contextMenu,wheel}) {
  let gesture=null,frame=null,last=0,wheelTimer=null;
  const keys=new Set(),listeners=[];
  const on=(name,fn,options,target=canvas)=>{target.addEventListener(name,fn,options);listeners.push([target,name,fn,options]);};
  // Host shortcuts can stop propagation before an event reaches the canvas.
  // Capture at the window, but only own keys whose focus is this scene.
  const keyboardTarget=canvas.ownerDocument.defaultView;
  canvas.tabIndex=0;
  const stop=(cancel=false)=>{
    const ended=gesture;gesture=null;
    canvas.__sceneGesture=null;
    if(ended?.action==='edit')editEnd?.(cancel);
    if(ended&&canvas.hasPointerCapture?.(ended.id))canvas.releasePointerCapture(ended.id);
    keys.clear();camera.interacting=false;
    if(frame!=null)cancelAnimationFrame(frame);frame=null;
    if(wheelTimer!=null)clearTimeout(wheelTimer);wheelTimer=null;
    canvas.style.cursor='grab';redraw();
  };
  const tick=now=>{
    frame=null;
    if(!canvas.isConnected||gesture?.action!=='look'){stop();return;}
    const seconds=Math.min(.05,(now-last)/1000);last=now;
    if(keys.size){flySceneCamera(camera,keys,seconds);redraw();}
    frame=requestAnimationFrame(tick);
  };
  on('pointerdown',event=>{
    if(gesture)return;
    let action=event.button===0&&keys.has(' ')?'pan':sceneGesture(event.button,event.altKey,camera.mode);if(!action)return;
    event.preventDefault();event.stopPropagation();canvas.focus({preventScroll:true});
    if(action!=='select')leave?.();
    if(action==='select'&&editStart?.(event))action='edit';
    canvas.setPointerCapture(event.pointerId);
    gesture={id:event.pointerId,action,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,button:event.button,
      contextClick:event.button===2&&!event.altKey};
    canvas.__sceneGesture=action;
    camera.interacting=action!=='select';canvas.style.cursor=action==='select'?'default':'grabbing';
    if(action==='look'){last=performance.now();frame=requestAnimationFrame(tick);}
  });
  on('pointermove',event=>{
    if(!gesture){hover?.(event);return;}
    if(gesture.id!==event.pointerId)return;event.preventDefault();event.stopPropagation();
    if(Math.hypot(event.clientX-gesture.startX,event.clientY-gesture.startY)>=4)gesture.contextClick=false;
    if(gesture.action==='edit'){editMove?.(event);return;}
    moveSceneCamera(camera,gesture.action,event.clientX-gesture.x,event.clientY-gesture.y,canvas.clientHeight);
    gesture.x=event.clientX;gesture.y=event.clientY;
    if(gesture.action!=='select')redraw();
  });
  on('pointerup',event=>{
    if(!gesture||gesture.id!==event.pointerId||gesture.button!==event.button)return;
    event.stopPropagation();
    if(gesture.action==='edit')editMove?.(event);
    if(gesture.action==='select'&&Math.hypot(event.clientX-gesture.startX,event.clientY-gesture.startY)<4)select?.(event);
    const contextClick=gesture.contextClick&&!event.altKey&&Math.hypot(event.clientX-gesture.startX,event.clientY-gesture.startY)<4;
    stop();
    if(contextClick)contextMenu?.(event);
  });
  for(const name of ['pointercancel','lostpointercapture','blur'])on(name,()=>stop(true));
  on('pointerleave',()=>{if(!gesture)leave?.();});
  on('keydown',event=>{
    if(event.target!==canvas||event.isComposing)return;
    const key=event.key.toLowerCase();
    if(key==='escape'){event.preventDefault();event.stopPropagation();stop(true);leave?.();shortcut?.(event);return;}
    if(key===' '){event.preventDefault();event.stopPropagation();keys.add(key);return;}
    if(key==='f'&&!gesture){event.preventDefault();event.stopPropagation();focus?.();return;}
    if(gesture?.action==='look'&&['w','a','s','d','q','e','shift'].includes(key)){
      gesture.contextClick=false;
      event.preventDefault();event.stopPropagation();keys.add(key);
    }else if(!gesture&&shortcut?.(event)){event.preventDefault();event.stopPropagation();}
  },true,keyboardTarget);
  on('keyup',event=>{if(event.target===canvas&&keys.delete(event.key.toLowerCase())){event.preventDefault();event.stopPropagation();}},true,keyboardTarget);
  on('wheel',event=>{
    event.preventDefault();event.stopPropagation();
    if(!gesture&&wheel?.(event))return;
    if(gesture)gesture.contextClick=false;
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?canvas.clientHeight:1);
    if(gesture?.action==='look')camera.flySpeed=Math.max(.05,Math.min(20,(camera.flySpeed||1)*Math.exp(-delta*.0015)));
    else zoomScene(camera,-delta*.0015);
    camera.interacting=true;redraw();
    if(wheelTimer!=null)clearTimeout(wheelTimer);
    wheelTimer=setTimeout(()=>{wheelTimer=null;if(!gesture){camera.interacting=false;redraw();}},120);
  },{passive:false});
  // Browser contextmenu may fire on press or release. Only a completed right
  // click above opens our menu; camera gestures and cancelled presses never do.
  on('contextmenu',event=>{event.preventDefault();event.stopPropagation();});
  return ()=>{stop(true);for(const [target,name,fn,options]of listeners)target.removeEventListener(name,fn,options);};
}
