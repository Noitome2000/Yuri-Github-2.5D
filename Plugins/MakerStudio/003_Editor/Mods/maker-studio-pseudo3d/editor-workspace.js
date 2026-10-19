// Dock contents update independently. The scene canvas survives selection,
// property edits and history changes, retaining its GPU resources and camera.
import {createHierarchyView,hierarchyStyles} from './hierarchy-view.js';
import {createResourceBrowser,resourceBrowserStyles} from './resource-browser.js';
import {createWorkspaceDialogs,workspaceDialogStyles} from './workspace-dialogs.js';
export function createWorkspace(host,actions) {
  const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text)n.textContent=text;return n;};
  const btn=(text,fn)=>{const n=el('button','',text);n.type='button';n.onclick=fn;return n;};
  const root=el('div','msp3d-panel ms-workspace');
  // The host checks this scope BEFORE its window-capture tool shortcuts,
  // which otherwise stopImmediatePropagation and swallow V/B/R/F entirely.
  root.dataset.keybindScope='event-commands';
  // Rebuilding an inspector can move focus to body. The fullscreen modal
  // owns those keys too, until it closes; restore the previous host scope.
  const keyScope=document.body,previousScope=keyScope.getAttribute('data-keybind-scope');
  keyScope.setAttribute('data-keybind-scope','event-commands');
  const dialogs=createWorkspaceDialogs(root);
  host.classList.add('ms-workspace-host');
  const shell=host.closest('.dialog-shell');shell?.classList.add('ms-workspace-fullscreen');
  // Keep compatibility mouse events inside the workspace. Do not prevent their
  // default action: native scrollbars and form controls still need it.
  const isolate=e=>e.stopPropagation();
  for(const name of ['mousedown','mousemove','mouseup','wheel','keydown'])root.addEventListener(name,isolate);
  root.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();});
  const toolbar=el('header','ms-workspace-toolbar'),tools=new Map();
  for(const [id,label]of [['select','选择 V'],['place','放置 B'],['terrain','地形 T']]){
    const b=btn(label,()=>actions.setTool(id));b.dataset.sceneTool=id;tools.set(id,b);toolbar.append(b);
    const key=label.slice(-1);b.title=label;b.setAttribute('aria-keyshortcuts',key);
  }
  const brushes=el('span','ms-placement-brushes'),brushButtons=new Map();
  for(const [id,label]of [['paint','画笔'],['rectangle','矩形']]){
    const b=btn(label,()=>actions.placementBrush(id));b.dataset.placementBrush=id;
    b.setAttribute('aria-label',label+'放置');brushButtons.set(id,b);brushes.append(b);
  }
  toolbar.append(brushes);
  const snap=el('label','ms-snap'),check=el('input');check.type='checkbox';check.checked=true;check.onchange=()=>actions.snap(check.checked);snap.append(check,el('span','','吸附'));
  const return2d=btn('返回 2D',()=>actions.close());return2d.className='ms-return-2d';
  toolbar.append(snap,btn('撤销',()=>actions.history(false)),btn('重做',()=>actions.history(true)),btn('保存全部',()=>actions.save()),return2d);
  const dock=(cls,title)=>{const n=el('section','ms-dock '+cls);n.append(el('h3','',title));return n;};
  const hierarchy=dock('ms-hierarchy','Hierarchy · 层级'),hierarchyBody=el('div','ms-dock-body');hierarchy.append(hierarchyBody);
  const treeHost=el('div','ms-hierarchy-tree-host');hierarchyBody.append(treeHost);const hierarchyView=createHierarchyView(treeHost,actions.hierarchy);
  const scene=dock('ms-scene','Scene · 3D 编辑'),canvas=el('canvas','msp3d-scene-preview');scene.append(actions.controls(),canvas);
  const inspector=dock('ms-inspector','Inspector · 检查器'),inspectorBody=el('div','ms-dock-body');inspector.append(inspectorBody);
  const project=dock('ms-project','Project · 资源库'),projectBar=el('div','ms-project-bar'),search=el('input','msp3d-search');
  project.tabIndex=0;
  project.addEventListener('contextmenu',event=>{if(!event.target.closest('.msp3d-asset,.ms-resource-folder,.ms-resource-tree'))actions.contextMenu(event);});
  search.type='search';search.placeholder='搜索模型或立牌…';search.setAttribute('aria-label','3D 资源搜索');
  const grid=el('div','msp3d-assets'),filters=el('div','ms-project-filters'),category=el('select'),type=el('select');
  category.setAttribute('aria-label','模型分类');type.setAttribute('aria-label','资源类型');
  for(const [value,label] of [['all','全部类型'],['model','3D 模型'],['billboard','图片立牌']]){const o=el('option','',label);o.value=value;type.append(o);}
  const favorites=btn('☆ 只看收藏',()=>{onlyFavorites=!onlyFavorites;favorites.classList.toggle('is-active',onlyFavorites);favorites.setAttribute('aria-pressed',String(onlyFavorites));updateAssets();});
  let onlyFavorites=false;
  const count=el('span','ms-asset-count'),size=el('input');size.type='range';size.min=96;size.max=200;size.value=132;size.setAttribute('aria-label','缩略图大小');
  size.oninput=()=>grid.style.setProperty('--asset-size',`${size.value}px`);
  const enlarge=btn('展开资源库',()=>{const expanded=root.classList.toggle('ms-project-expanded');root.style.setProperty('--project-height',expanded?'48vh':'210px');enlarge.textContent=expanded?'收起资源库':'展开资源库';});
  const view=btn('列表视图',()=>{const list=project.classList.toggle('is-list');view.textContent=list?'缩略图视图':'列表视图';});
  const tree=el('div','ms-resource-tree'),path=el('div','ms-resource-path'),content=el('div','ms-project-content');
  let folderId='';
  const browser=createResourceBrowser(tree,path,actions.folders,(nextCategory,nextFolder)=>{category.value=nextCategory;folderId=nextFolder;actions.folders.location(nextCategory,nextFolder);grid.scrollTop=0;updateAssets();});
  function updateAssets(){const scroll=grid.scrollTop;const n=actions.assets(grid,search.value,{category:category.value,type:type.value,favorites:onlyFavorites,folderId},browser.card);grid.scrollTop=scroll;browser.refresh(category.value,folderId);count.textContent=`${n} 项`;}
  function revealAsset(id,nextCategory,nextFolder){
    search.value='';type.value='all';onlyFavorites=false;
    favorites.classList.remove('is-active');favorites.setAttribute('aria-pressed','false');
    category.value=nextCategory;folderId=nextFolder;
    actions.folders.location(nextCategory,nextFolder);updateAssets();
    browser.reveal(nextCategory,nextFolder);
    const card=[...grid.children].find(node=>node.dataset.assetId===id);
    if(card){card.focus({preventScroll:true});card.scrollIntoView({block:'center',inline:'nearest'});}
  }
  search.oninput=updateAssets;category.onchange=()=>{folderId='';actions.folders.location(category.value,'');updateAssets();};type.onchange=updateAssets;
  filters.append(category,type,favorites,view,size,count);
  projectBar.append(project.querySelector('h3'),search,filters,path,btn('导入 OBJ',actions.importObj),btn('导入立牌',actions.importBillboard),enlarge);
  content.append(tree,grid);project.append(projectBar,content);
  const status=el('footer','ms-status');
  root.append(toolbar,hierarchy,scene,inspector,project,status);host.append(root);
  const releases=[];
  releases.push(()=>{if(keyScope.getAttribute('data-keybind-scope')==='event-commands'){
    if(previousScope==null)keyScope.removeAttribute('data-keybind-scope');else keyScope.setAttribute('data-keybind-scope',previousScope);
  }});
  for(const [id,label,property,axis,sign,min]of [
    ['left','层级宽度','--hierarchy-width','x',1,120],
    ['right','检查器宽度','--inspector-width','x',-1,180],
    ['bottom','资源库高度','--project-height','y',-1,100]
  ]){
    const handle=el('div',`ms-splitter ms-splitter-${id}`);handle.tabIndex=0;
    handle.setAttribute('role','separator');handle.setAttribute('aria-label',label);
    handle.setAttribute('aria-orientation',axis==='x'?'vertical':'horizontal');
    let gesture=null;
    const set=value=>{const limit=axis==='x'?root.clientWidth*.4:root.clientHeight-220;root.style.setProperty(property,`${Math.max(Math.min(min,limit),Math.min(limit,value))}px`);};
    const stop=()=>{if(gesture&&handle.hasPointerCapture?.(gesture.id))handle.releasePointerCapture(gesture.id);gesture=null;};
    handle.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();
      const dock=id==='left'?hierarchy:id==='right'?inspector:project;
      gesture={id:e.pointerId,start:axis==='x'?e.clientX:e.clientY,size:axis==='x'?dock.clientWidth:dock.clientHeight};handle.setPointerCapture(e.pointerId);};
    handle.onpointermove=e=>{if(!gesture||gesture.id!==e.pointerId)return;e.preventDefault();set(gesture.size+sign*((axis==='x'?e.clientX:e.clientY)-gesture.start));};
    handle.onpointerup=stop;handle.onpointercancel=stop;handle.onlostpointercapture=()=>{gesture=null;};
    handle.onkeydown=e=>{const delta={ArrowLeft:-16,ArrowRight:16,ArrowUp:-16,ArrowDown:16}[e.key];if(delta==null)return;e.preventDefault();const dock=id==='left'?hierarchy:id==='right'?inspector:project;set((axis==='x'?dock.clientWidth:dock.clientHeight)+delta*sign);};
    releases.push(stop);root.append(handle);
  }
  // Corner grips also let side docks shorten independently of the scene.
  for(const [id,dock,title]of [['hierarchy',hierarchy,'层级'],['scene',scene,'场景'],['inspector',inspector,'检查器'],['project',project,'资源库']]){
    const grip=el('div','ms-dock-grip');grip.setAttribute('role','separator');grip.setAttribute('aria-label',`调整${title}长宽`);grip.tabIndex=0;
    let gesture=null;
    const resize=(dx,dy,start)=>{
      const available=root.clientHeight-66;
      if(id==='hierarchy'||id==='inspector'){
        root.style.setProperty(`--${id}-width`,`${Math.max(id==='hierarchy'?120:180,Math.min(root.clientWidth*.4,start.w+dx))}px`);
        root.style.setProperty(`--${id}-height`,`${Math.max(120,Math.min(available,start.h+dy))}px`);
      }else{
        if(id==='scene')root.style.setProperty('--inspector-width',`${Math.max(180,Math.min(root.clientWidth*.4,start.right-dx))}px`);
        else root.style.setProperty('--project-width',`${Math.max(180,Math.min(scene.clientWidth,start.w+dx))}px`);
        root.style.setProperty('--project-height',`${Math.max(100,Math.min(available-120,start.project+(id==='scene'?-dy:dy)))}px`);
      }
    };
    const start=()=>({w:dock.clientWidth,h:dock.clientHeight,right:inspector.clientWidth,project:project.clientHeight});
    const stop=()=>{const old=gesture;gesture=null;if(old&&grip.hasPointerCapture?.(old.id))grip.releasePointerCapture(old.id);};
    grip.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();gesture={...start(),id:e.pointerId,x:e.clientX,y:e.clientY};grip.setPointerCapture(e.pointerId);};
    grip.onpointermove=e=>{if(gesture?.id!==e.pointerId)return;e.preventDefault();resize(e.clientX-gesture.x,e.clientY-gesture.y,gesture);};
    grip.onpointerup=stop;grip.onpointercancel=stop;grip.onlostpointercapture=()=>{gesture=null;};
    grip.onkeydown=e=>{const dx={ArrowLeft:-16,ArrowRight:16}[e.key]||0,dy={ArrowUp:-16,ArrowDown:16}[e.key]||0;if(!dx&&!dy)return;e.preventDefault();resize(dx,dy,start());};
    releases.push(stop);dock.append(grip);
  }
  canvas.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('application/x-maker-asset')){e.preventDefault();e.dataTransfer.dropEffect='copy';actions.dragPreview?.(e.dataTransfer.getData('application/x-maker-asset'),e);}});
  canvas.addEventListener('dragleave',()=>actions.dragLeave?.());
  canvas.addEventListener('drop',e=>{e.preventDefault();actions.drop(e.dataTransfer.getData('application/x-maker-asset'),e);});
  let projectKey='',inspectorKey='',mountDispose=null,positionLabel='';
  const position=instance=>{positionLabel=instance?` · (${Math.floor(instance.x/32)}, ${Math.floor(instance.y/32)}) · ${instance.footprintW}×${instance.footprintD}`:'';status.dataset.position=positionLabel;status.textContent=status.dataset.base+positionLabel;};
  function refresh(state){
    check.checked=state.snap!==false;
    brushes.hidden=state.tool!=='place';
    for(const [id,b]of brushButtons){const active=id===(state.placementBrush||'paint');b.classList.toggle('is-active',active);b.setAttribute('aria-pressed',String(active));}
    for(const [id,b]of tools){b.classList.toggle('is-active',id===state.tool);b.setAttribute('aria-pressed',String(id===state.tool));}
    hierarchyView.refresh({mapId:state.mapId,root:state.root,nodes:state.nodes,selectedIds:state.selectedIds});
    const key=state.tool==='terrain'?'terrain':`${state.mapId}:${state.selected}:${state.asset}:${state.folder}:${state.revision}:${state.effectsKey||''}:${state.tool}:${state.tool==='place'?state.placementKey:''}`;
    if(key!==inspectorKey){mountDispose?.();mountDispose=null;inspectorBody.replaceChildren();inspectorKey=key;mountDispose=actions.inspector(inspectorBody);}
    const next=state.assetRevision;
    if(projectKey!==next){projectKey=next;const previous=category.value;category.replaceChildren();
      for(const [value,label] of [['','全部分类'],...state.categories.map(c=>[c,c])]){const o=el('option','',label);o.value=value;category.append(o);}
      const opened=actions.folders.state().library.folders.find(f=>f.id===folderId);
      category.value=opened?.category||(state.categories.includes(previous)?previous:'');updateAssets();}
    if(folderId&&!actions.folders.state().library.folders.some(f=>f.id===folderId)){folderId='';actions.folders.location(category.value,'');updateAssets();}
    for(const card of grid.children)card.classList.toggle('is-active',card.dataset.assetId===state.asset);
    actions.selection?.();
    status.dataset.base=`${state.dirty?'● 未保存':'已保存'} · ${state.instances.length} 个物件 · ${state.tool==='terrain'?'地形':state.tool==='place'?'放置':state.tool==='select'?'选择':state.tool==='move'?'移动':state.tool==='rotate'?'旋转':'缩放'}`;
    status.textContent=status.dataset.base+positionLabel;
  }
  return {canvas,refresh,position,revealAsset,showDialog:dialogs.show,renameNode:hierarchyView.rename,refreshAssets:updateAssets,navigateFolder(nextCategory,nextFolder){category.value=nextCategory;folderId=nextFolder;actions.folders.location(nextCategory,nextFolder);updateAssets();},dispose(){dialogs.dispose();for(const stop of releases)stop();hierarchyView.dispose();mountDispose?.();root.remove();host.classList.remove('ms-workspace-host');shell?.classList.remove('ms-workspace-fullscreen');}};
}

export const workspaceStyles=hierarchyStyles+resourceBrowserStyles+workspaceDialogStyles+`
.ms-instance-actions{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:5px}
.ms-placement-brushes{display:inline-flex;gap:3px;padding-left:4px;border-left:1px solid #555}.ms-placement-brushes[hidden]{display:none}
.ms-workspace.ms-project-expanded{grid-template-rows:38px minmax(150px,1fr) minmax(300px,48%) 28px}
.ms-workspace-toolbar{display:flex;align-items:center;gap:6px}.ms-workspace-toolbar>.ms-return-2d{margin-left:auto}
.ms-project-filters{display:flex;gap:4px;align-items:center;padding:0;flex-wrap:nowrap}.ms-project-filters select{max-width:100px;background:#383838;color:#eee;border:1px solid #555;padding:4px}.ms-project-filters input{width:60px}.ms-asset-count{color:#aaa;white-space:nowrap}
.ms-project .msp3d-assets{grid-template-columns:repeat(auto-fill,minmax(var(--asset-size,132px),1fr))!important}
.ms-project .msp3d-asset{height:auto!important;min-height:125px}.ms-project .msp3d-preview{height:calc(var(--asset-size,132px) * .7)!important}.ms-project .msp3d-asset-meta{flex-direction:column;align-items:flex-start}.ms-project .msp3d-asset-meta strong{white-space:normal;overflow-wrap:anywhere}.ms-project .msp3d-asset-meta small{display:block!important;color:#aaa}
.ms-workspace{--bg-primary:#282828;--bg-secondary:#333;--border:#191919;--text-primary:#ddd;--text-secondary:#aaa;--text-tertiary:#999;--accent:#528ac5;--bg-hover:#444;background:#282828;color:#ddd!important;display:grid!important;grid-template-columns:210px minmax(280px,1fr) 280px;grid-template-rows:38px minmax(200px,1fr) 210px 28px;gap:2px!important;padding:0!important;height:100%;overflow:hidden!important;min-height:480px}
.ms-workspace button{border-radius:2px!important;font-size:12px;white-space:nowrap}.ms-workspace-toolbar{grid-column:1/-1;display:flex;align-items:center;gap:4px;padding:4px 8px;background:#383838;overflow-x:auto}.ms-snap{display:flex;align-items:center;margin:0 8px;white-space:nowrap}
.ms-dock{min-width:0;min-height:0;background:#2d2d2d;display:flex;flex-direction:column;overflow:hidden;border:1px solid #171717}.ms-dock h3{font-size:12px;font-weight:500;background:#383838;margin:0;padding:7px 10px;border-bottom:1px solid #191919;flex:none}.ms-dock-body{overflow:auto;padding:8px;min-height:0}.ms-hierarchy{grid-column:1;grid-row:2/4}.ms-hierarchy .ms-dock-body{display:flex;flex-direction:column;gap:3px}.ms-hierarchy button{text-align:left;overflow:hidden;text-overflow:ellipsis}.ms-map-name{padding:6px 0;color:#aaa}
.ms-scene{grid-column:2;grid-row:2}.ms-scene .msp3d-preview-controls{display:flex;flex-wrap:wrap;gap:3px;padding:4px;background:#303030}.ms-scene .msp3d-scene-preview{flex:1;width:100%;height:0!important;min-height:0!important;border:0;border-radius:0}.ms-scene canvas:focus{outline:1px solid #528ac5;outline-offset:-1px}
.ms-inspector{grid-column:3;grid-row:2/4}.ms-inspector .msp3d-fields{grid-template-columns:1fr}.ms-inspector .msp3d-field{flex-direction:row;align-items:center;justify-content:space-between}.ms-inspector .msp3d-field input{width:115px}.ms-project{grid-column:2;grid-row:3;resize:vertical}.ms-project-bar{display:flex;gap:5px;padding:5px;flex:none}.ms-project-bar input{min-width:60px}.ms-project .msp3d-assets{overflow:auto;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));padding:5px;align-content:start}.ms-status{grid-column:1/-1;background:#222;color:#aaa;padding:5px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}
.ms-workspace .mst-panel{height:auto;padding:0;overflow:visible}.ms-workspace .mst-footer{position:static}.ms-workspace .mst-panel>h3,.ms-workspace .mst-panel>.ms-editor-switch{display:none}
@media(max-width:1000px){.ms-workspace{grid-template-columns:150px minmax(230px,1fr) 220px;grid-template-rows:38px minmax(200px,1fr) 170px 28px}.ms-workspace-toolbar button{padding:3px 5px}.ms-workspace .msp3d-asset-meta{font-size:11px}}
.ms-workspace-fullscreen{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;margin:0!important;transform:none!important;border-radius:0!important}
.ms-workspace-fullscreen>.dialog-shell-header,.ms-workspace-fullscreen>.dialog-shell-resize{display:none!important}
.ms-workspace-host{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;padding:0!important;overflow:hidden!important}
.ms-workspace{--hierarchy-width:210px;--inspector-width:280px;--project-height:210px;grid-template-columns:minmax(100px,var(--hierarchy-width)) 6px minmax(180px,1fr) 6px minmax(150px,var(--inspector-width))!important;grid-template-rows:38px minmax(100px,1fr) 6px minmax(100px,var(--project-height)) 28px!important;gap:0!important;min-height:0!important}
.ms-hierarchy{grid-column:1;grid-row:2/5}.ms-scene{grid-column:3;grid-row:2}.ms-inspector{grid-column:5;grid-row:2/5}.ms-project{grid-column:3;grid-row:4;resize:none}.ms-status{grid-row:5}
.ms-dock-body{flex:1;min-height:0;overscroll-behavior:contain;scrollbar-gutter:stable}.ms-project-filters{flex:none}.ms-project .msp3d-assets{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;grid-auto-rows:max-content}
.ms-splitter{background:#202020;touch-action:none;z-index:3}.ms-splitter:hover,.ms-splitter:focus{background:#528ac5}.ms-splitter-left{grid-column:2;grid-row:2/5;cursor:col-resize}.ms-splitter-right{grid-column:4;grid-row:2/5;cursor:col-resize}.ms-splitter-bottom{grid-column:3;grid-row:3;cursor:row-resize}
.ms-dock{position:relative}.ms-hierarchy{height:min(var(--hierarchy-height,100%),100%);align-self:start}.ms-inspector{height:min(var(--inspector-height,100%),100%);align-self:start}.ms-project{width:min(var(--project-width,100%),100%);justify-self:start}.ms-dock-grip{position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:nwse-resize;touch-action:none;z-index:4;background:repeating-linear-gradient(135deg,transparent 0px,transparent 3px,#666 3px,#666 4px)}
.ms-project-bar{align-items:center;flex-wrap:nowrap;overflow-x:auto;gap:4px;padding:4px;background:#303030}.ms-project-bar>h3{padding:0 4px;background:transparent;border:0;white-space:nowrap}.ms-project-bar>.msp3d-search{width:140px;min-width:90px;flex:1 0 90px;box-sizing:border-box;padding:4px 6px;height:28px}.ms-project-bar button{padding:4px 6px!important;flex-shrink:0}.ms-project-bar>.ms-resource-path{padding:0 4px;min-height:0;max-width:140px;background:transparent}.ms-project-bar input[type=range]{min-width:0}.ms-project-bar .ms-project-filters>*{flex-shrink:0}
`;
