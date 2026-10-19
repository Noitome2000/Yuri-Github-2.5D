export const sceneNodes=scene=>[...(scene.groups||[]),...scene.instances];
export const sceneNode=(scene,id)=>sceneNodes(scene).find(n=>n.id===id)||null;

export function repairHierarchy(scene){
  const nodes=sceneNodes(scene),ids=new Map(nodes.map(n=>[n.id,n]));
  for(const node of nodes){
    const seen=new Set([node.id]);let next=node.parentId;
    while(next){
      if(!ids.has(next)||seen.has(next)){node.parentId='';break;}
      seen.add(next);next=ids.get(next).parentId;
    }
  }
  return scene;
}

export function branchIds(scene,id){
  const result=new Set(),pending=[id],nodes=sceneNodes(scene);
  while(pending.length){const current=pending.pop();if(result.has(current))continue;result.add(current);for(const n of nodes)if(n.parentId===current)pending.push(n.id);}
  return result;
}

export function setSceneParent(scene,id,parentId='',targetId=null,after=false){
  const node=sceneNode(scene,id),parent=parentId&&sceneNode(scene,parentId);
  if(!node||parentId&&(!parent||branchIds(scene,id).has(parentId)))return false;
  node.parentId=parentId;
  const siblings=sceneNodes(scene).filter(n=>n.parentId===parentId&&n.id!==id).sort((a,b)=>a.order-b.order);
  let index=targetId?siblings.findIndex(n=>n.id===targetId)+(after?1:0):siblings.length;
  if(index<0)index=siblings.length;
  siblings.splice(index,0,node);siblings.forEach((n,i)=>n.order=(i+1)*1024);
  return true;
}

export function nodeFlag(scene,id,flag){
  const seen=new Set();let node=sceneNode(scene,id);
  while(node&&!seen.has(node.id)){if(flag==='locked'?node.locked:node.editorVisible===false)return true;seen.add(node.id);node=sceneNode(scene,node.parentId);}
  return false;
}

export function hierarchyFlags(scene){
  const nodes=sceneNodes(scene),lookup=new Map(nodes.map(n=>[n.id,n])),flags=new Map();
  for(const start of nodes){
    const path=[],seen=new Set();let node=start;
    while(node&&!flags.has(node.id)&&!seen.has(node.id)){seen.add(node.id);path.push(node);node=lookup.get(node.parentId);}
    let parent=node?flags.get(node.id)||{}:{};
    for(const item of path.reverse()){parent={locked:!!item.locked||!!parent.locked,hidden:item.editorVisible===false||!!parent.hidden};flags.set(item.id,parent);}
  }
  return flags;
}

export function transformBranch(scene,id,originals,target){
  const root=originals.find(n=>n.id===id);if(!root)return;
  const angle=(target.rotation-root.rotation)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),scale=target.scale/root.scale;
  const ox=root.x+(root.footprintW||1)*16,oy=root.y+(root.footprintD||1)*16;
  const tx=target.x+(root.footprintW||1)*16,ty=target.y+(root.footprintD||1)*16;
  for(const original of originals){
    const node=sceneNode(scene,original.id);if(!node)continue;
    if(original.id===id){Object.assign(node,target);continue;}
    const dx=original.x+(original.footprintW||1)*16-ox,dy=original.y+(original.footprintD||1)*16-oy;
    Object.assign(node,{x:tx+(dx*cos-dy*sin)*scale-(original.footprintW||1)*16,
      y:ty+(dx*sin+dy*cos)*scale-(original.footprintD||1)*16,
      elevation:(original.elevation||0)+(target.elevation||0)-(root.elevation||0),
      rotation:((original.rotation+target.rotation-root.rotation)%360+360)%360,scale:original.scale*scale});
  }
}
