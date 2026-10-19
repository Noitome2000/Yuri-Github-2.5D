import {catalogCategories} from './asset-catalog.js';
import {folderPath,folderAssets} from './resource-folders.js';

const el=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls||'';if(text!=null)node.textContent=text;return node;};
export function createResourceBrowser(tree,path,actions,navigate){
  const folded=new Set();
  function drop(node,category,folderId){
    node.ondragover=e=>{if(!e.dataTransfer.types.some(type=>['application/x-maker-asset','application/x-maker-resource-items'].includes(type)))return;e.preventDefault();e.stopPropagation();node.classList.add('is-drop-target');e.dataTransfer.dropEffect='move';};
    node.ondragleave=()=>node.classList.remove('is-drop-target');
    node.ondrop=e=>{e.preventDefault();e.stopPropagation();node.classList.remove('is-drop-target');let payload;try{payload=JSON.parse(e.dataTransfer.getData('application/x-maker-resource-items'));}catch{payload={assets:[e.dataTransfer.getData('application/x-maker-asset')].filter(Boolean),folders:[]};}actions.move(payload,category,folderId);};
  }
  function refresh(category,folderId){
    const state=actions.state(),{library}=state;tree.replaceChildren();path.replaceChildren();
    const row=(label,current,depth,open,hasChildren,onFold)=>{const item=el('div','ms-folder-tree-row');item.style.paddingLeft=`${4+depth*12}px`;item.classList.toggle('is-current',current);const arrow=el('button','ms-folder-fold',hasChildren?(open?'▾':'▸'):'');arrow.onclick=e=>{e.stopPropagation();onFold?.();};const button=el('button','ms-folder-name',label);item.append(arrow,button);tree.append(item);return {item,button};};
    const all=row('▣ 全部资源',!category&&!folderId,0,true,false);all.button.onclick=()=>navigate('','');
    const roots=library.folders.filter(f=>!f.parentId);
    for(const name of catalogCategories(library.assets,library.folders)){
      const key='category:'+name,children=roots.filter(f=>f.category===name),open=!folded.has(key);
      const {item,button}=row('▣ '+name,category===name&&!folderId,0,open,!!children.length,()=>{open?folded.add(key):folded.delete(key);refresh(category,folderId);});
      button.onclick=()=>{folded.delete(key);navigate(name,'');};drop(item,name,'');
      item.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();navigate(name,'');actions.menu(e);};
      if(open)for(const child of children)append(child,1);
    }
    function append(folder,depth){
      const children=library.folders.filter(f=>f.parentId===folder.id),open=!folded.has(folder.id);
      const {item,button}=row((folder.kind==='mountain'?'▰ ':'▱ ')+folder.name,folderId===folder.id,depth,open,!!children.length,()=>{open?folded.add(folder.id):folded.delete(folder.id);refresh(category,folderId);});
      item.dataset.folderId=folder.id;item.classList.toggle('is-selected',state.selectedFolders.includes(folder.id));item.classList.toggle('is-cut',state.clipboard?.kind==='cut'&&state.clipboard.folders.some(f=>f.id===folder.id));
      button.onclick=e=>{actions.select(folder.id,e);navigate(folder.category,folder.id);};
      item.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();actions.select(folder.id);actions.menu(e,null,folder.id);};
      item.draggable=true;item.ondragstart=e=>{e.stopPropagation();if(!state.selectedFolders.includes(folder.id))actions.select(folder.id);e.dataTransfer.setData('application/x-maker-resource-items',JSON.stringify({assets:[],folders:actions.state().selectedFolders}));e.dataTransfer.effectAllowed='move';};drop(item,folder.category,folder.id);
      if(open)for(const child of children)append(child,depth+1);
    }
    for(const [id,label] of [['',category||'全部资源'],...folderPath(library,folderId).map(f=>[f.id,f.name])]){const b=el('button','',label);b.onclick=()=>navigate(category,id);path.append(b,el('span','','›'));}
    path.lastElementChild?.remove();
  }
  function card(folder){
    const state=actions.state(),node=el('button','ms-resource-folder');node.type='button';node.dataset.folderId=folder.id;
    node.classList.toggle('is-selected',state.selectedFolders.includes(folder.id));node.classList.toggle('is-cut',state.clipboard?.kind==='cut'&&state.clipboard.folders.some(f=>f.id===folder.id));
    const icon=el('span','ms-folder-icon');icon.innerHTML='<svg viewBox="0 0 64 48" width="58" height="44" aria-hidden="true"><path fill="#ae8b3b" d="M4 7h23l6 6h27v30H4z"/><path fill="#d5b869" d="M4 17h56l-5 26H0z"/>'+(folder.kind==='mountain'?'<path fill="#685d3d" d="m25 34 8-12 10 15H19z"/>':'')+'</svg>';
    node.append(icon,el('strong','',folder.name),el('small','',`${folderAssets(state.library,folder.id).length} 个资源${folder.kind==='mountain'?' · 山体':''}`));
    node.onclick=e=>actions.select(folder.id,e);node.ondblclick=()=>navigate(folder.category,folder.id);
    node.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();actions.menu(e,null,folder.id);};
    node.draggable=true;node.ondragstart=e=>{if(!actions.state().selectedFolders.includes(folder.id))actions.select(folder.id);e.dataTransfer.setData('application/x-maker-resource-items',JSON.stringify({assets:[],folders:actions.state().selectedFolders}));e.dataTransfer.effectAllowed='move';};drop(node,folder.category,folder.id);return node;
  }
  function reveal(category,folderId){
    folded.delete('category:'+category);
    for(const folder of folderPath(actions.state().library,folderId))folded.delete(folder.id);
    refresh(category,folderId);
    tree.querySelector('.is-current')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  return {refresh,card,reveal};
}
export const resourceBrowserStyles=`
.ms-folder-model-previews{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px}.ms-folder-model-previews canvas{width:100%!important;height:75px!important;min-width:0;object-fit:contain}.ms-resource-folder{border:1px solid #474747!important}
.ms-project-content{display:flex;flex:1;min-height:0}.ms-resource-tree{width:155px;min-width:100px;max-width:38%;flex:none;overflow:auto;resize:horizontal;border-right:1px solid #191919;background:#292929;padding:3px 0;overscroll-behavior:contain}.ms-project-content>.msp3d-assets{flex:1;min-width:0}.ms-folder-tree-row{height:24px;display:flex;align-items:center;box-sizing:border-box}.ms-folder-tree-row button{background:transparent!important;border:0!important;padding:2px!important;box-shadow:none!important;color:#bbb}.ms-folder-fold{width:15px;flex:none}.ms-folder-name{overflow:hidden;text-overflow:ellipsis;text-align:left;flex:1;min-width:0}.ms-folder-tree-row:hover{background:#393939}.ms-folder-tree-row.is-current,.ms-folder-tree-row.is-selected{background:#3c5571}.ms-folder-tree-row.is-cut,.ms-resource-folder.is-cut{opacity:.5}.ms-folder-tree-row.is-drop-target,.ms-resource-folder.is-drop-target{outline:2px solid #8bbff1;outline-offset:-2px}.ms-resource-path{display:flex;align-items:center;gap:3px;padding:1px 6px 4px;min-height:22px;overflow:auto;flex:none;white-space:nowrap;background:#2b2b2b}.ms-resource-path button{padding:2px 5px!important;background:transparent!important;border:0!important;color:#c6d7eb}.ms-resource-path span{color:#888}.ms-resource-folder{min-height:125px;background:#353535!important;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;overflow:hidden}.ms-resource-folder.is-selected{outline:2px solid #77aef0;outline-offset:-2px}.ms-folder-icon{font-size:48px;line-height:52px;color:#d6b968}.ms-resource-folder strong{font-size:11px;white-space:normal;overflow-wrap:anywhere}.ms-resource-folder small{color:#aaa;font-size:10px}.ms-project.is-list .ms-resource-folder{min-height:34px;flex-direction:row;justify-content:flex-start;padding:4px!important}.ms-project.is-list .ms-folder-icon{font-size:24px;line-height:24px}.ms-folder-batch-summary{font-size:11px;color:#aaa}.ms-batch-texture-label{display:block;font-size:11px;overflow-wrap:anywhere}.ms-folder-pending{outline:1px solid #d6b968}.ms-folder-texture-actions{display:flex;gap:5px;flex-wrap:wrap}
`;
