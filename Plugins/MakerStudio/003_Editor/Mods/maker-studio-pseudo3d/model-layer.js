export const MODEL_LAYER = -105;
const KEY = 'maker-studio-pseudo3d.model-layer';

export function normalizeModelLayerSettings(raw = {}) {
  return {visible:raw.visible !== false,
    opacity:Number.isFinite(Number(raw.opacity)) ? Math.max(0,Math.min(1,Number(raw.opacity))) : 1};
}
export function canEditModels(layer, settings) {
  return layer === MODEL_LAYER && settings.visible && settings.opacity > 0;
}

// A virtual editor layer, never a tile layer in the map or game data.
export function createModelLayer(api, {onChange, onSelect, onLeave}) {
  let saved;try { saved=JSON.parse(localStorage.getItem(KEY)||'{}'); } catch { saved={}; }
  let settings=normalizeModelLayerSettings(saved||{}),row=null,frame=null,disposed=false;
  const selected=()=>api.editor.activeLayerIndex?.()===MODEL_LAYER;
  let wasSelected=selected();
  function syncSelection(){
    const current=selected(),left=wasSelected&&!current;
    wasSelected=current;
    if(left)onLeave();
  }
  const setSettings=patch=>{
    settings=normalizeModelLayerSettings({...settings,...patch});
    try { localStorage.setItem(KEY,JSON.stringify(settings)); } catch {}
    onChange(settings);schedule();
  };
  const select=()=>{api.editor.setActiveLayer(MODEL_LAYER);wasSelected=selected();onSelect();schedule();};
  function draw(){
    frame=null;if(disposed)return;
    syncSelection();
    const list=document.querySelector('.layer-panel .layer-list');
    if(!list)return;
    if(!row?.isConnected){
      row=document.createElement('div');row.className='layer-row msp3d-model-layer-row';
      row.title='模型层：仅在选中且可见时编辑模型';row.onclick=select;
      row.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();};
      const eye=document.createElement('button');eye.type='button';eye.className='layer-vis';
      eye.onclick=e=>{e.stopPropagation();setSettings({visible:!settings.visible});};
      const name=document.createElement('span');name.className='layer-name';name.textContent='模型';
      const range=document.createElement('input');range.type='range';range.min='0';range.max='100';range.step='1';
      range.setAttribute('aria-label','模型不透明度');range.style.cssText='width:64px;margin-left:auto;accent-color:#22d3ee';
      range.onpointerdown=range.onclick=e=>e.stopPropagation();
      range.oninput=e=>{e.stopPropagation();setSettings({opacity:Number(range.value)/100});};
      row.append(eye,name,range);list.prepend(row);
    }
    if(row.classList.contains('active')!==selected())row.classList.toggle('active',selected());
    const eye=row.children[0],range=row.children[2];
    const label=settings.visible?'●':'○';if(eye.textContent!==label)eye.textContent=label;
    eye.title=settings.visible?'隐藏模型':'显示模型';
    eye.setAttribute('aria-label',eye.title);eye.setAttribute('aria-pressed',String(settings.visible));
    range.value=String(Math.round(settings.opacity*100));range.title=`不透明度 ${range.value}%`;
  }
  function schedule(){if(!disposed&&frame==null)frame=requestAnimationFrame(draw);}
  // SDK setActiveLayer updates the store directly in some hosts and emits no
  // lifecycle event. Observe native row activation as well as bus notifications.
  const observer=new MutationObserver(()=>{syncSelection();schedule();});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  const off=api.lifecycle.onLayerChange(()=>{if(disposed)return;syncSelection();schedule();});
  schedule();
  return {selected,select,setSettings,get settings(){return settings;},
    editable:()=>canEditModels(api.editor.activeLayerIndex?.(),settings),
    dispose(){disposed=true;observer.disconnect();if(frame!=null)cancelAnimationFrame(frame);if(typeof off==='function')off();else off?.dispose?.();row?.remove();}};
}

