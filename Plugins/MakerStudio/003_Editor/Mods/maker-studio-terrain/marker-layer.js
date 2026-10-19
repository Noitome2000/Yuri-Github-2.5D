export const TERRAIN_MARKER_LAYER = -104;
const KEY = 'maker-studio-terrain.marker-layer';

export function normalizeMarkerSettings(raw = {}) {
  return {visible:raw.visible !== false,
    opacity:Number.isFinite(Number(raw.opacity)) ? Math.max(0,Math.min(1,Number(raw.opacity))) : 0.65};
}
export function canEditMarkers(layer, settings) {
  return layer === TERRAIN_MARKER_LAYER && settings.visible && settings.opacity > 0;
}

// A virtual editor layer, never a tile layer in the map or game data.
export function createMarkerLayer(api, {onChange, onSelect, onLeave}) {
  let saved;try { saved=JSON.parse(localStorage.getItem(KEY)||'{}'); } catch { saved={}; }
  let settings=normalizeMarkerSettings(saved||{}),row=null,frame=null,disposed=false;
  const selected=()=>api.editor.activeLayerIndex?.()===TERRAIN_MARKER_LAYER;
  const setSettings=patch=>{
    settings=normalizeMarkerSettings({...settings,...patch});
    try { localStorage.setItem(KEY,JSON.stringify(settings)); } catch {}
    onChange(settings);schedule();
  };
  const select=()=>{api.editor.setActiveLayer(TERRAIN_MARKER_LAYER);onSelect();schedule();};
  function draw(){
    frame=null;if(disposed)return;
    const list=document.querySelector('.layer-panel .layer-list');
    if(!list)return;
    if(!row?.isConnected){
      row=document.createElement('div');row.className='layer-row mst-marker-layer-row';
      row.title='地形标记层：仅在选中且可见时编辑地形标记';row.onclick=select;
      row.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();};
      const eye=document.createElement('button');eye.type='button';eye.className='layer-vis';
      eye.onclick=e=>{e.stopPropagation();setSettings({visible:!settings.visible});};
      const name=document.createElement('span');name.className='layer-name';name.textContent='地形标记';
      const range=document.createElement('input');range.type='range';range.min='0';range.max='100';range.step='1';
      range.setAttribute('aria-label','地形标记不透明度');range.style.cssText='width:64px;margin-left:auto;accent-color:#22d3ee';
      range.onpointerdown=range.onclick=e=>e.stopPropagation();
      range.oninput=e=>{e.stopPropagation();setSettings({opacity:Number(range.value)/100});};
      row.append(eye,name,range);list.prepend(row);
    }
    row.classList.toggle('active',selected());
    const eye=row.children[0],range=row.children[2];
    const label=settings.visible?'●':'○';if(eye.textContent!==label)eye.textContent=label;
    eye.title=settings.visible?'隐藏地形标记':'显示地形标记';
    eye.setAttribute('aria-label',eye.title);eye.setAttribute('aria-pressed',String(settings.visible));
    range.value=String(Math.round(settings.opacity*100));range.title=`不透明度 ${range.value}%`;
  }
  function schedule(){if(!disposed&&frame==null)frame=requestAnimationFrame(draw);}
  const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true});
  const off=api.lifecycle.onLayerChange(()=>{if(disposed)return;if(!selected())onLeave();schedule();});
  schedule();
  return {selected,select,setSettings,get settings(){return settings;},
    editable:()=>canEditMarkers(api.editor.activeLayerIndex?.(),settings),
    dispose(){disposed=true;observer.disconnect();if(frame!=null)cancelAnimationFrame(frame);if(typeof off==='function')off();row?.remove();}};
}
