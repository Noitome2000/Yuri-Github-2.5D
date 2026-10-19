export function createHierarchyView(host,actions){
  const search=document.createElement('input');search.type='search';search.placeholder='搜索物体…';search.className='ms-hierarchy-search';search.setAttribute('aria-label','层级搜索');
  const tree=document.createElement('div');tree.className='ms-hierarchy-tree';tree.setAttribute('role','tree');tree.tabIndex=0;
  host.append(search,tree);
  let state=null,dragIds=[],lastKey='',anchor=null;const collapsed=new Set();
  const button=(text,fn,title)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;if(title)b.title=title;return b;};
  function draw(){
    if(!state)return;tree.replaceChildren();
    const query=search.value.trim().toLowerCase(),nodes=state.nodes,byId=new Map(nodes.map(n=>[n.id,n]));
    const shown=new Set();
    for(const node of nodes)if(!query||node.name.toLowerCase().includes(query)){let n=node;while(n&&!shown.has(n.id)){shown.add(n.id);n=byId.get(n.parentId);}}
    const children=id=>nodes.filter(n=>(n.parentId||'')===id).sort((a,b)=>a.order-b.order);
    if(state.root){
      const root=state.root,row=document.createElement('div');row.className='ms-hierarchy-row ms-hierarchy-root';row.dataset.nodeId=root.id;row.setAttribute('role','treeitem');row.setAttribute('aria-level','1');
      const selected=state.selectedIds.includes(root.id);row.classList.toggle('is-selected',selected);row.setAttribute('aria-selected',String(selected));
      const fold=button('▾',()=>{},'场景根节点');fold.className='ms-tree-fold';fold.disabled=true;
      const label=button(`▣ ${root.name}`,event=>actions.select(root.id,event));label.className='ms-tree-label';label.dataset.instanceId=root.id;label.title='场景主节点';
      row.append(fold,label);tree.append(row);row.oncontextmenu=e=>actions.contextMenu(e,root.id);
    }
    const visit=(parent,depth)=>{for(const node of children(parent)){
      if(!shown.has(node.id))continue;
      const row=document.createElement('div');row.className='ms-hierarchy-row';row.dataset.nodeId=node.id;
      row.style.setProperty('--node-depth',depth);row.setAttribute('role','treeitem');row.setAttribute('aria-level',depth+1);
      const selected=state.selectedIds.includes(node.id);row.classList.toggle('is-selected',selected);row.setAttribute('aria-selected',String(selected));
      row.classList.toggle('is-hidden',!node.editorVisible);row.draggable=!node.locked;
      const hasChildren=children(node.id).length>0,open=query||!collapsed.has(node.id);
      const fold=button(hasChildren?(open?'▾':'▸'):'',()=>{collapsed.has(node.id)?collapsed.delete(node.id):collapsed.add(node.id);draw();},'展开 / 折叠');fold.className='ms-tree-fold';fold.disabled=!hasChildren;
      if(hasChildren)row.setAttribute('aria-expanded',String(!!open));
      const label=button(`${node.group?'▧':'◇'} ${node.name}${node.batch?' [合批]':''}`,event=>{
        const order=[...tree.querySelectorAll('[data-instance-id]')].map(b=>b.dataset.instanceId);
        if(event.shiftKey&&anchor&&order.includes(anchor))actions.selectRange(order.slice(Math.min(order.indexOf(anchor),order.indexOf(node.id)),Math.max(order.indexOf(anchor),order.indexOf(node.id))+1),event);
        else{actions.select(node.id,event);anchor=node.id;}
      });label.className='ms-tree-label';label.dataset.instanceId=node.id;label.title=node.name;label.ondblclick=()=>{actions.select(node.id);actions.focus();};
      const eye=button(node.editorVisible?'◉':'○',()=>actions.flag(node.id,'editorVisible',!node.editorVisible),'编辑器可见');eye.className='ms-tree-eye';
      const lock=button(node.locked?'▣':'▫',()=>actions.flag(node.id,'locked',!node.locked),'锁定');lock.className='ms-tree-lock';
      row.append(fold,label,eye,lock);tree.append(row);
      row.oncontextmenu=e=>actions.contextMenu(e,node.id);
      row.ondragstart=e=>{if(e.target.closest('input')){e.preventDefault();return;}dragIds=selected?state.selectedIds:[node.id];e.dataTransfer.setData('application/x-maker-scene',JSON.stringify(dragIds));e.dataTransfer.effectAllowed='move';row.classList.add('is-dragging');};
      row.ondragend=()=>{dragIds=[];for(const n of tree.children)n.classList.remove('is-drop-child','is-drop-before','is-drop-after','is-dragging');};
      const dropMode=e=>{const r=row.getBoundingClientRect(),p=(e.clientY-r.top)/r.height;return p<.25?'before':p>.75?'after':'child';};
      row.ondragover=e=>{if(!e.dataTransfer.types.includes('application/x-maker-scene'))return;e.preventDefault();e.stopPropagation();for(const n of tree.children)n.classList.remove('is-drop-child','is-drop-before','is-drop-after');row.classList.add('is-drop-'+dropMode(e));};
      row.ondragleave=()=>row.classList.remove('is-drop-child','is-drop-before','is-drop-after');
      row.ondrop=e=>{if(!e.dataTransfer.types.includes('application/x-maker-scene'))return;e.preventDefault();e.stopPropagation();const ids=JSON.parse(e.dataTransfer.getData('application/x-maker-scene')||'[]'),mode=dropMode(e);actions.reparent(ids,mode==='child'?node.id:node.parentId,mode==='child'?null:node.id,mode==='after');collapsed.delete(node.id);draw();};
      if(hasChildren&&open)visit(node.id,depth+1);
    }};
    visit('',state.root?1:0);
    if(!tree.children.length){const empty=document.createElement('div');empty.className='msp3d-empty';empty.textContent=query?'没有匹配物体':'空场景';tree.append(empty);}
  }
  search.oninput=draw;
  tree.oncontextmenu=e=>{if(!e.target.closest('.ms-hierarchy-row'))actions.contextMenu(e);};
  tree.ondragover=e=>{if(e.dataTransfer.types.includes('application/x-maker-scene')){e.preventDefault();e.dataTransfer.dropEffect='move';}};
  tree.ondrop=e=>{if(!e.dataTransfer.types.includes('application/x-maker-scene'))return;e.preventDefault();actions.reparent(JSON.parse(e.dataTransfer.getData('application/x-maker-scene')||'[]'),'');};
  tree.onkeydown=e=>{
    if(e.target.matches('input')||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Enter'].includes(e.key))return;
    e.preventDefault();e.stopPropagation();const rows=[...tree.querySelectorAll('[data-node-id]')],id=state.selectedIds.at(-1),index=rows.findIndex(r=>r.dataset.nodeId===id),node=state.nodes.find(n=>n.id===id);
    if(e.key==='Enter'){actions.focus();return;}
    if(e.key==='ArrowLeft'&&node){if(!collapsed.has(id)&&rows[index]?.getAttribute('aria-expanded')==='true'){collapsed.add(id);draw();return;}if(node.parentId)actions.select(node.parentId);}
    else if(e.key==='ArrowRight'&&node){if(collapsed.has(id)){collapsed.delete(id);draw();return;}const child=state.nodes.filter(n=>n.parentId===id).sort((a,b)=>a.order-b.order)[0];if(child)actions.select(child.id);}
    else{const next=e.key==='Home'?0:e.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,index+(e.key==='ArrowUp'?-1:1)));if(rows[next])actions.select(rows[next].dataset.nodeId);}
    tree.focus();tree.querySelector(`[data-node-id="${CSS.escape(state.selectedIds.at(-1)||'')}"]`)?.scrollIntoView({block:'nearest'});
  };
  return{refresh(next){state=next;const key=JSON.stringify([next.mapId,next.nodes,next.selectedIds]);if(key===lastKey)return;lastKey=key;for(const id of next.selectedIds){let n=next.nodes.find(n=>n.id===id);while(n?.parentId){collapsed.delete(n.parentId);n=next.nodes.find(p=>p.id===n.parentId);}}draw();},
    rename(id){const label=tree.querySelector(`[data-instance-id="${CSS.escape(id)}"]`),node=state?.nodes.find(n=>n.id===id);if(!label||!node)return;
      const input=document.createElement('input');input.value=node.name;input.className='ms-tree-rename';input.setAttribute('aria-label','场景物体名称');label.replaceWith(input);input.focus();input.select();let done=false;
      const finish=commit=>{if(done)return;done=true;const value=input.value.trim();if(commit&&value&&value!==node.name)actions.rename(id,value);draw();};
      input.onkeydown=e=>{if(['Enter','Escape'].includes(e.key)){e.preventDefault();e.stopPropagation();finish(e.key==='Enter');}};input.onblur=()=>finish(true);
    },dispose(){host.replaceChildren();}};
}

export const hierarchyStyles=`
.ms-hierarchy .ms-dock-body{gap:0;padding:0}.ms-hierarchy-search{margin:5px;width:calc(100% - 10px);box-sizing:border-box;min-height:25px;background:#252525;border:1px solid #444;color:#ddd;padding:3px 6px}
.ms-hierarchy-tree{flex:1;min-height:80px;padding-bottom:36px;outline:none}.ms-hierarchy-row{display:flex;align-items:center;height:24px;padding-left:calc(var(--node-depth)*14px);border:1px solid transparent;box-sizing:border-box}
.ms-hierarchy-row button{padding:1px 3px!important;background:transparent!important;border:0!important;border-radius:0!important;height:22px}.ms-hierarchy-row .ms-tree-label{flex:1;min-width:0;font-size:12px;text-align:left}.ms-tree-fold{width:17px;flex:none}.ms-tree-eye,.ms-tree-lock{width:19px;flex:none;color:#aaa}.ms-hierarchy-row:not(:hover):not(.is-selected) .ms-tree-lock{opacity:.35}.ms-hierarchy-row:hover{background:#393939}.ms-hierarchy-row.is-selected{background:#365c80}.ms-hierarchy-row.is-hidden .ms-tree-label{opacity:.45}.ms-hierarchy-row.is-drop-child{border-color:#73b5ef;background:#34536c}.ms-hierarchy-row.is-drop-before{border-top:2px solid #73b5ef}.ms-hierarchy-row.is-drop-after{border-bottom:2px solid #73b5ef}.ms-tree-rename{width:0;flex:1;min-height:20px;background:#222;color:#eee;border:1px solid #528ac5}.ms-hierarchy-system{display:flex;flex-direction:column;padding:3px 6px;border-bottom:1px solid #222}.ms-hierarchy-system button{background:transparent!important;border:0!important;padding:4px!important}
`;
