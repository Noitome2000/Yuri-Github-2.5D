import { assetCategory } from './asset-catalog.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const id=()=>`folder_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
export const folderById=(library,id)=>library.folders.find(f=>f.id===id)||null;

export function normalizeFolders(library, raw = []) {
  const used=new Set();
  library.folders=(Array.isArray(raw)?raw:[]).filter(f=>f&&f.id&&!used.has(String(f.id))&&used.add(String(f.id))).map(f=>({
    id:String(f.id),name:String(f.name||'新建文件夹'),category:String(f.category||'未分类'),parentId:String(f.parentId||''),
    kind:f.kind==='mountain'?'mountain':'folder',mountainType:String(f.mountainType||'')
  }));
  for(const folder of library.folders){
    const seen=new Set([folder.id]);let current=folder;
    while(current.parentId){const parent=folderById(library,current.parentId);if(!parent||seen.has(parent.id)){current.parentId='';break;}seen.add(parent.id);current=parent;}
  }
  for(const folder of library.folders){let root=folder;while(root.parentId)root=folderById(library,root.parentId);folder.category=root.category;}
  for(const asset of library.assets){const folder=folderById(library,asset.folderId);if(folder)asset.category=folder.category;else asset.folderId='';}
  return library;
}

export function folderBranch(library, rootId) {
  const result=new Set();if(!folderById(library,rootId))return result;
  const pending=[rootId];while(pending.length){const next=pending.pop();if(result.has(next))continue;result.add(next);for(const f of library.folders)if(f.parentId===next)pending.push(f.id);}
  return result;
}
export function folderAssets(library,rootId){const ids=folderBranch(library,rootId);return library.assets.filter(a=>ids.has(a.folderId));}
export function folderPath(library,rootId){const result=[];let current=folderById(library,rootId);const seen=new Set();while(current&&!seen.has(current.id)){seen.add(current.id);result.unshift(current);current=folderById(library,current.parentId);}return result;}
export function uniqueFolderName(library,name,category,parentId='',except=''){
  const siblings=library.folders.filter(f=>f.category===category&&f.parentId===parentId&&f.id!==except);let next=name,index=2;while(siblings.some(f=>f.name===next))next=`${name} ${index++}`;return next;
}
export function createFolder(library,name,category,parentId='',kind='folder'){
  const parent=folderById(library,parentId);if(parentId&&!parent)throw Error('目标文件夹不存在');
  const folder={id:id(),name:uniqueFolderName(library,name,parent?.category||category,parentId),category:parent?.category||category,parentId,kind,mountainType:''};library.folders.push(folder);return folder;
}
export function moveLibraryItems(library,assetIds,folderIds,category,parentId=''){
  const parent=folderById(library,parentId);if(parentId&&!parent)throw Error('目标文件夹不存在');category=parent?.category||category;
  const selected=new Set(folderIds),roots=folderIds.filter(f=>!folderPath(library,f).slice(0,-1).some(p=>selected.has(p.id)));
  if(roots.some(root=>folderBranch(library,root).has(parentId)))throw Error('不能将文件夹移到自身或子文件夹中');
  const branches=new Set(roots.flatMap(root=>[...folderBranch(library,root)]));
  for(const root of roots){const folder=folderById(library,root);if(!folder)continue;folder.name=uniqueFolderName(library,folder.name,category,parentId,folder.id);folder.parentId=parentId;}
  for(const folder of library.folders)if(branches.has(folder.id))folder.category=category;
  for(const asset of library.assets){if(branches.has(asset.folderId))asset.category=category;else if(assetIds.includes(asset.id)){asset.category=category;asset.folderId=parentId;}}
}
export function copyLibraryItems(library,assetIds,folderIds,cut=false){
  const selected=new Set(folderIds),roots=folderIds.filter(f=>!folderPath(library,f).slice(0,-1).some(p=>selected.has(p.id)));
  const branches=new Set(roots.flatMap(root=>[...folderBranch(library,root)]));
  const assets=library.assets.filter(a=>assetIds.includes(a.id)||branches.has(a.folderId));
  const textureIds=new Set(assets.flatMap(a=>(a.faces||[]).map(f=>f.texture).filter(Boolean)));
  return copy({kind:cut?'cut':'copy',ids:assets.map(a=>a.id),roots,folders:library.folders.filter(f=>branches.has(f.id)),assets,textures:library.textures.filter(t=>textureIds.has(t.id))});
}
export function pasteLibraryItems(library,clipboard,category,parentId=''){
  const parent=folderById(library,parentId);if(parentId&&!parent)throw Error('目标文件夹不存在');category=parent?.category||category;
  if(clipboard.kind==='cut'){moveLibraryItems(library,clipboard.ids,clipboard.roots,category,parentId);return {assets:clipboard.ids.filter(id=>library.assets.some(a=>a.id===id)),folders:clipboard.roots.filter(id=>folderById(library,id))};}
  const folderMap=new Map(clipboard.folders.map(f=>[f.id,id()])),textureMap=new Map(),meshMap=new Map(),added=[];
  for(const texture of clipboard.textures){const same=library.textures.find(t=>t.id===texture.id);if(same?.image===texture.image){textureMap.set(texture.id,same.id);continue;}const next={...copy(texture),id:same?`texture_${id()}`:texture.id};library.textures.push(next);textureMap.set(texture.id,next.id);}
  const folders=copy(clipboard.folders).map(f=>({...f,id:folderMap.get(f.id),parentId:folderMap.get(f.parentId)||parentId,category}));
  for(const f of folders){f.name=uniqueFolderName(library,f.name+(clipboard.roots.includes([...folderMap].find(([,next])=>next===f.id)[0])?' 副本':''),category,f.parentId);library.folders.push(f);}
  for(const source of clipboard.assets){
    const asset=copy(source);asset.id=`asset_${id()}`;asset.folderId=folderMap.get(source.folderId)||parentId;asset.category=category;asset.favorite=false;asset.createdAt=new Date().toISOString();
    let name=source.name+' 副本',n=2;while(library.assets.some(a=>a.name===name))name=`${source.name} 副本 ${n++}`;asset.name=name;
    if(source.meshGroup&&folderMap.has(source.folderId)){if(!meshMap.has(source.meshGroup))meshMap.set(source.meshGroup,`mesh_${id()}`);asset.meshGroup=meshMap.get(source.meshGroup);}else asset.meshGroup='';
    if(source.rotationGroup&&folderMap.has(source.folderId)){const key='rotation:'+source.rotationGroup;if(!meshMap.has(key))meshMap.set(key,`rotated_${id()}`);asset.rotationGroup=meshMap.get(key);}else {asset.rotationGroup='';asset.variantRotation=0;}
    for(const face of asset.faces||[])if(face.texture)face.texture=textureMap.get(face.texture)||face.texture;
    library.assets.push(asset);added.push(asset.id);
  }
  return {assets:added,folders:clipboard.roots.map(root=>folderMap.get(root))};
}

// Imported families share a source palette. Keep corners together with straight
// pieces, rather than dividing a construction kit by geometry shape.
export function organizeMountainFolders(library){
  for(const asset of library.assets){
    if(asset.folderId||asset.type!=='model')continue;
    const mountain=asset.modular||/山|岩|mountain|cliff|cave|rock|hill/i.test(assetCategory(asset));if(!mountain)continue;
    const texture=library.textures.find(t=>t.id===asset.faces?.find(f=>f.texture)?.texture);
    const source=`${texture?.path||''} ${asset.sourceObj||''}`;
    let family='',name='';
    if(asset.id.startsWith('nitro_cliff_piece_')){family='map05_05';name='草地岩壁 · map05_05';}
    else {const match=source.match(/convex_(map\d+_\d+|winter\d+_\d+|m_dun\d+_\d+_\d+)\//);if(match){family=match[1].startsWith('m_dun0701_')?'m_dun0701':match[1];name=(family==='m_dun0701'?'洞窟岩壁':family.startsWith('winter')?'冬季岩壁':'岩壁')+' · '+family;}else{family=asset.id;name=asset.name;}}
    const category=asset.category&&!['山体拼接块','山体与岩石'].includes(asset.category)?asset.category:'山体与岩石';asset.category=category;
    let folder=library.folders.find(f=>f.mountainType===family&&f.category===category);
    if(!folder){folder=createFolder(library,name,category,'','mountain');folder.mountainType=family;}
    asset.folderId=folder.id;
  }
  return library;
}

// The original grass-wall source contains straight and concave pieces at three
// visible construction heights. Keep shape families together, then retain the
// height split below each shape so a complete family can be batch-edited.
export function organizeMountainSubfolders(library){
  const roots=library.folders.filter(f=>f.kind==='mountain'&&f.mountainType==='map05_05');
  for(const root of roots){
    const shapeDefs=[['straight','直段岩壁','直段'],['concave','凹角岩壁','凹角'],['convex','凸角岩壁','凸角']];
    const profiles=[['tall','三格高岩壁'],['low','一格低岩壁'],['cap','顶部薄边']];
    const sourceAssets=()=>library.assets.filter(asset=>asset.folderId===root.id||library.folders.some(folder=>folder.parentId===root.id&&folder.id===asset.folderId));
    const classifyShape=asset=>{
      const name=String(asset.name||'');
      if(name.includes('凹角'))return 'concave';
      if(name.includes('凸角'))return 'convex';
      return 'straight';
    };
    const classifyHeight=asset=>{const height=Number(asset.pixelHeight)||0;return height>=80?'tall':height===32?'low':'cap';};
    for(const [shape,shapeLabel,shapeToken] of shapeDefs){
      const shapeAssets=sourceAssets().filter(asset=>asset.type==='model'&&asset.modular&&asset.sourceObj&&classifyShape(asset)===shape);
      if(!shapeAssets.length)continue;
      let shapeFolder=library.folders.find(folder=>folder.mountainType===`map05_05:${shape}`&&folder.parentId===root.id);
      if(!shapeFolder){shapeFolder=createFolder(library,shapeLabel,root.category,root.id,'mountain');shapeFolder.mountainType=`map05_05:${shape}`;}
      for(const [profile,label] of profiles){
        const grouped=shapeAssets.filter(asset=>classifyHeight(asset)===profile);
        if(!grouped.length)continue;
        const type=shape==='straight'&&profile==='cap'?'map05_05:cap':`map05_05:${shape}:${profile}`;
        let folder=library.folders.find(candidate=>candidate.mountainType===type&&candidate.parentId===shapeFolder.id);
        if(!folder){folder=createFolder(library,label,root.category,shapeFolder.id,'mountain');folder.mountainType=type;}
        for(const asset of grouped)asset.folderId=folder.id;
      }
    }
    // Remove the old height-only folders after their assets have moved. This
    // prevents the same shape from appearing in multiple top-level branches.
    const oldChildren=library.folders.filter(folder=>folder.parentId===root.id&&!/^map05_05:(straight|concave|convex)$/.test(folder.mountainType||''));
    library.folders=library.folders.filter(folder=>!oldChildren.includes(folder));
  }
  library.mountainGroupingVersion=2;
  return library;
}
