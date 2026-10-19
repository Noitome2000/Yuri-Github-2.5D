// Native tile/event records and plugin records share the same per-map stacks.
// Do not invent tile writes to obtain a history entry.
export function installNativeHistory(store, onChange=()=>{}, onError=console.error) {
  const original={undo:store.getState().undo,redo:store.getState().redo};
  const owned=new Set();let busy=false;
  const run=async(direction,mapId)=>{
    if(busy)return false;
    const from=direction==='undo'?'undoStack':'redoStack',to=direction==='undo'?'redoStack':'undoStack';
    const entry=store.getState().maps[mapId]?.[from]?.at(-1);
    if(!owned.has(entry))return original[direction](mapId);
    busy=true;
    try{
      if(await entry.makerAction[direction]()===false)return false;
      store.setState(state=>{
        const map=state.maps[mapId];
        if(map?.[from].at(-1)!==entry)throw Error('撤销期间地图历史发生变化');
        return {maps:{...state.maps,[mapId]:{...map,[from]:map[from].slice(0,-1),[to]:[...map[to],entry]}}};
      });
      onChange();return true;
    }catch(error){onError(error);return false;}finally{busy=false;}
  };
  const undo=id=>run('undo',id),redo=id=>run('redo',id);
  store.setState({undo,redo});
  let stacks=new Map();
  const unsubscribe=store.subscribe?.(()=>{
    const maps=store.getState().maps;
    const changed=Object.keys(maps).length!==stacks.size||Object.entries(maps).some(([id,m])=>stacks.get(id)?.[0]!==m.undoStack||stacks.get(id)?.[1]!==m.redoStack||stacks.get(id)?.[2]!==m.mapData?.events);
    if(!changed)return;
    stacks=new Map(Object.entries(maps).map(([id,m])=>[id,[m.undoStack,m.redoStack,m.mapData?.events]]));
    const retained=new Set(Object.values(maps).flatMap(m=>[...m.undoStack,...m.redoStack]));
    for(const entry of owned)if(!retained.has(entry))owned.delete(entry);
    onChange();
  });
  return {
    commit(mapId,label,action){
      if(!store.getState().maps[mapId])throw Error('地图尚未加载，无法记录撤销');
      const entry={label,makerAction:action};owned.add(entry);
      store.getState().commitStroke(mapId,entry);
    },undo,redo,
    state(mapId){const m=store.getState().maps[mapId];return {undo:m?.undoStack.length||0,redo:m?.redoStack.length||0};},
    dispose(){
      unsubscribe?.();
      store.setState(state=>({maps:Object.fromEntries(Object.entries(state.maps).map(([id,m])=>[id,{...m,
        undoStack:m.undoStack.filter(e=>!owned.has(e)),redoStack:m.redoStack.filter(e=>!owned.has(e))}])),
        ...(state.undo===undo?{undo:original.undo}:{}),...(state.redo===redo?{redo:original.redo}:{})}));
      owned.clear();
    }
  };
}

export async function connectNativeHistory(ctx,onChange){
  const main=[...document.scripts].map(s=>s.src).find(src=>/\/assets\/index-[^/]+\.js(?:\?|$)/.test(src));
  if(!main)throw Error('找不到宿主入口脚本');
  const source=await fetch(main).then(r=>r.text());
  const file=source.match(/editor-store-[A-Za-z0-9_-]+\.js/)?.[0];
  if(!file)throw Error('找不到宿主地图存储');
  const module=await import(new URL(file,main).href);
  const store=Object.values(module).find(v=>v?.getState&&v?.setState&&v.getState().maps&&typeof v.getState().commitStroke==='function'&&typeof v.getState().undo==='function');
  if(!store)throw Error('宿主缺少可兼容的撤销接口');
  return installNativeHistory(store,onChange,error=>ctx.ui.showToast({message:`撤销失败：${error.message||error}`,level:'error'}));
}
