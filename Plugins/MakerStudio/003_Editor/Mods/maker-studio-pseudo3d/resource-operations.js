import { clone, uid } from './core.js';
import {folderAssets} from './resource-folders.js';

export function folderTextureSlots(library,folderId){
  const models=folderAssets(library,folderId).filter(a=>a.type==='model'),slots=new Map();
  const textures=new Map(library.textures.map(t=>[t.id,t]));
  for(const model of models)for(const slot of new Set(model.faces.map(f=>f.texture||''))){const key=textures.get(slot)?.image||slot;if(!slots.has(key))slots.set(key,{id:slot,ids:[],assetIds:[],faces:0});const entry=slots.get(key);if(!entry.ids.includes(slot))entry.ids.push(slot);if(!entry.assetIds.includes(model.id))entry.assetIds.push(model.id);entry.faces+=model.faces.filter(f=>(f.texture||'')===slot).length;}
  return [...slots.values()];
}
export function replaceFolderTextures(library,folderId,replacements){
  const models=folderAssets(library,folderId).filter(a=>a.type==='model'),known=new Set(library.textures.map(t=>t.id)),changed=[];
  for(const [source,target] of Object.entries(replacements))if(source!==target&&!known.has(target))throw Error('替换纹理不存在');
  for(const model of models){
    if(!model.faces.some(f=>Object.hasOwn(replacements,f.texture||'')&&replacements[f.texture||'']!==(f.texture||'')))continue;
    // Match against original slots once, so A→B and B→C never cascade.
    const next=replaceTexture(model,'\u0000','');
    for(let i=0;i<next.faces.length;i++){const slot=model.faces[i].texture||'';if(Object.hasOwn(replacements,slot))next.faces[i].texture=replacements[slot];}
    library.assets[library.assets.findIndex(a=>a.id===model.id)]=next;changed.push(model.id);
  }
  return changed;
}

export function copyAsset(asset, assets, category = null) {
  const result = clone(asset);
  result.id = uid('asset');
  const base = asset.name + ' 副本';
  let name = base, i = 2;
  while (assets.some(a => a.name === name)) name = `${base} ${i++}`;
  result.name = name;
  result.meshGroup = '';
  result.rotationGroup='';result.variantRotation=0;
  result.favorite = false;
  result.createdAt = new Date().toISOString();
  if (category) result.category = category;
  return result;
}

export function replaceTexture(asset, slot, textureId) {
  const result = clone(asset);
  for (const face of result.faces) if ((face.texture || '') === slot) face.texture = textureId;
  // Each edit has an immutable native file path, so undo and other variants
  // never point at an overwritten OBJ/MTL. The actual files are emitted on save.
  result.generatedNative = true;
  result.sourceObj = `Graphics/MakerStudioPseudo3D/Models/Edited/${uid('mesh')}/model.obj`;
  return result;
}


export function nativeModelFiles(asset, textures) {
  if (asset.type !== 'model' || !asset.generatedNative) return [];
  const directory = asset.sourceObj.slice(0, asset.sourceObj.lastIndexOf('/'));
  if (!/^Graphics\/MakerStudioPseudo3D\/Models\/Edited\/[a-zA-Z0-9_-]+$/.test(directory)) throw Error('模型输出目录无效');
  const slots = new Map(), files = [], mtl = [];
  for (const face of asset.faces) {
    const key = `${face.texture || ''}:${face.color || '#ffffff'}`;
    if (slots.has(key)) continue;
    const name = `material_${slots.size}`;
    slots.set(key, name);
    const texture = textures.find(t => t.id === face.texture);
    const color = face.color || '#ffffff';
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i+2), 16)/255);
    mtl.push(`newmtl ${name}`, `Kd ${rgb.join(' ')}`);
    if (face.texture) {
      if (!texture?.image?.match(/^data:image\/(png|jpeg);base64,/)) throw Error('纹理数据缺失或格式不支持');
      const extension = texture.image.startsWith('data:image/jpeg') ? 'jpg' : 'png';
      const filename = `${name}.${extension}`;
      mtl.push(`map_Kd ${filename}`);
      files.push({ path: `${directory}/${filename}`, image: texture.image });
    }
    mtl.push('');
  }
  const offsets = [asset.meshOffsetX || 0, asset.meshOffsetY || 0, asset.meshOffsetZ || 0];
  const lines = ['# Edited model; canonical library mesh and UVs', 'mtllib model.mtl'];
  lines.push(...asset.vertices.map(v => `v ${v.map((n, i) => n - offsets[i]).join(' ')}`));
  lines.push(...asset.vertices.map((v, i) => `vt ${(asset.uvs[i] || [0, 0]).join(' ')}`));
  for (const face of asset.faces) {
    lines.push(`usemtl ${slots.get(`${face.texture || ''}:${face.color || '#ffffff'}`)}`);
    lines.push('f '+['a', 'b', 'c'].map(k => `${face[k]+1}/${face[k]+1}`).join(' '));
  }
  files.push({ path: `${directory}/model.mtl`, text: mtl.join('\n')+'\n' },
    { path: asset.sourceObj, text: lines.join('\n')+'\n' });
  return files;
}
