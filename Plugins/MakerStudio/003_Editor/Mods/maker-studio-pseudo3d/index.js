import {
  TILE_SIZE, clamp, clone, emptyLibrary, emptyScene, hitTest, normalizeAngle,
  normalizeLibrary, normalizeScene, parseMtl, parseObj, uid
} from "./core.js";
import { drawAssetPreview, MAP_PREVIEW_PITCH, renderModel, disposeModelRenderer } from "./mesh-renderer.js";
import { createThumbnailQueue } from './thumbnail-queue.js';
import { createLibraryCache } from './library-cache.js';
import { connectNativeHistory } from './native-history.js';
import { connectMapInput, connectMapOverlay, lineCells } from "./editor-input.js";
import { createModelLayer } from './model-layer.js';
import { createModelShortcuts } from './model-shortcuts.js';
import { MapSnapshot } from "./map-snapshot.js";
import { terrainHeight, modelBaseHeight, sceneRay, rayPlane, rayElevation, pickTerrain } from './scene-geometry.js';
import { createWorkspace, workspaceStyles } from './editor-workspace.js';
import { createPlacementStroke, appendPlacementStroke, updatePlacementRectangle, canPlaceInStroke } from './placement-brush.js';
import {sceneNodes,sceneNode,branchIds,setSceneParent,nodeFlag,transformBranch,hierarchyFlags} from './scene-hierarchy.js';
import {compactInspector,inspectorStyles} from './inspector-layout.js';
import {normalizeEffects,normalizeLight} from './visual-effects.js';
import {PBS_PATH,EFFECT_PROPERTIES,PBSEffectsSync,readPBS} from './pbs-effects.js';
import { assetCategory, catalogCategories, filterAssets } from './asset-catalog.js';
import { copyAsset, replaceTexture, nativeModelFiles,folderTextureSlots,replaceFolderTextures } from './resource-operations.js';
import {folderById,folderBranch,folderAssets,folderPath,createFolder,uniqueFolderName,moveLibraryItems,copyLibraryItems,pasteLibraryItems} from './resource-folders.js';
import { createResourceMenu, resourceStyles } from './resource-menu.js';
import { runResourceRecycle } from './resource-recycle.js';
import { drawSceneTools, pickToolHandle, pickSceneHit, pickSceneRect } from './scene-tools.js';
import { connectSceneInput } from './scene-input.js';
import { renderScene, disposeSceneRenderers } from "./scene-renderer.js";

const MOD_ID = "cn.noitome.maker-studio-pseudo3d";
const PANEL_ID = "maker-studio-pseudo3d";
const TOOL_ID = "maker-studio-pseudo3d-tool";
const LIB_PATH = "Data/MakerStudioPseudo3D/library.json";
const libraryCache = createLibraryCache(normalizeLibrary);
const mapPath = (id) => `Data/MakerStudioPseudo3D/Map${String(id).padStart(3, "0")}.json`;

let api = null;
let panelHost = null;
let library = emptyLibrary();
let scene = emptyScene(0);
let loadedMap = null;
let activeAsset = null;
let selected = null;
let modelClipboard = null;
let modelShortcuts = null;
let mode = "select";
let dirty = false;
let drag = null;
let mapWatchTimer = null;
let loadingMap = null;
let loadSerial = 0;
let styleElement = null;
let historyUndo = [];
let historyRedo = [];
let resourceRecycleBusy = null;
let placementPreview = null;
let modelLayer = null, disconnectPlacementOverlay = null;
let stroke = null;
let disconnectInput = null;
let disconnectOverlay = null;
let snapshotReader = null;
let mapSnapshot = null;
let previewTerrain = { cells: {}, heightStep: 16 };
let previewRefreshTimer = null;
let previewRefreshSerial = 0;
let previewSnapshotDirty = true;
let previewSnapshotRevision = 0;
let previewMapRevision = 0;
let capturedMapRevision = -1;
let previewRefreshInFlight = false;
let previewFrame = null;
let previewAnimationTimer = null;
let previewDialog = null;
let previewDialogCanvas = null;
let previewDialogObserver = null;
let workspace = null;
let sceneTool = 'select';
let sceneSnap = true;
let continuousPlacement = false;
let placementBrush = 'paint';
let sceneEdit = null;
let sceneGhost = null;
let terrainGhost=null,terrainPreviewSerial=0;
let sceneHandle = null;
let controlSelect = false,hoveredSceneId=null,lastScenePointer=null,hierarchyMenu=null,sceneClipboard=null;
const SCENE_ROOT_ID='__scene_root';
const sceneSelection=new Set();
let draggedAsset = null;
const sceneInputs = new Map();
let previewLastFrameAt = 0;
let assetPreviewObserver = null;
let thumbnailQueue = null;
const thumbnailCache = new Map();
let resourceCards = new WeakMap();
let panelView = null;
const loadedTextureIds = new Set();
const textureDependents = new Map();
let snapshotMessage = "打开地图后显示整图预览";
let assetSearch = "";
let assetType = "all";
let panelTab = "library";
const resourceSelection = new Set();
let resourceClipboard = null;
let resourceMenu = null;
let resourceCategory = '';
let resourceFolder='',activeResourceFolder=null;
const resourceFolderSelection=new Set();
let resourceAnchor = null;
let placementRotation = 0;
let placementScale = 1;
let placementParentId = '';
const camera = { mode: "3d", projection: 'orthographic', yaw: -35, pitch: 55, zoom: 1, panX: 0, panY: 0 };

const modelCache = new Map();
const billboardCache = new Map();
const textureImageCache = new Map();
let assetTextureMapCache = new WeakMap();
let textureRefreshQueued = false;
let editRevision = 0;
let pendingSave = null;
let effectsSync = null, pbsError = '', pbsRefresh = null;
let nativeHistory = null;
const mapHistories = new Map();
let historyRefreshFrame = null;
let strokeRedrawFrame = null;

async function readJson(path, fallback) {
  try { return JSON.parse(await api.fs.readProjectFile(path)); }
  catch { return fallback; }
}

async function readLibraryText() {
  try { return await api.fs.readProjectFile(LIB_PATH); }
  catch (error) {
    // An absent library is normal in a new project. A failed or partial read
    // of an existing library must not replace it with an empty one.
    if (await api.fs.projectExists(LIB_PATH)) throw error;
    return null;
  }
}

async function load(mapId) {
  if(resourceRecycleBusy)await resourceRecycleBusy;
  if (mapId == null) return;
  const requestedMap = Number(mapId);
  if (requestedMap === loadedMap) {
    if (loadingMap != null) { loadSerial++; loadingMap = null; }
    return;
  }
  if (requestedMap === loadingMap) return;
  const serial = ++loadSerial;
  finishSceneEdit();
  pointerUp({button:0});
  loadingMap = requestedMap;
  try {
    while (dirty) await save();
    const [libraryText, rawScene, rawTerrain, pbs] = await Promise.all([
      readLibraryText(), readJson(mapPath(requestedMap), null),
      readJson('Data/MakerStudioTerrain/Map'+String(requestedMap).padStart(3,'0')+'.json',{cells:{},heightStep:16}),
      readPBS(api.fs).then(text=>({text}),error=>({error}))
    ]);
    if (serial !== loadSerial) return;
    const nextLibrary = libraryCache.read(libraryText, library);
    const libraryChanged = nextLibrary !== library;
    if(loadedMap!=null)mapHistories.set(loadedMap,{undo:historyUndo,redo:historyRedo});
    loadedMap = requestedMap;
    loadingMap = null;
    library = nextLibrary;
    scene = normalizeScene(rawScene, loadedMap);
    effectsSync=null;pbsError='';
    try {if(pbs.error)throw pbs.error;effectsSync=new PBSEffectsSync(loadedMap,pbs.text);}
    catch(error){pbsError=String(error.message||error);}
    if (activeAsset && !assetById(activeAsset)) activeAsset = null;
    selected = null;
    resourceSelection.clear();
    resourceFolderSelection.clear();activeResourceFolder=null;resourceFolder='';
    drag = null;
    dirty = false;
    historyUndo = mapHistories.get(loadedMap)?.undo || [];
    historyRedo = mapHistories.get(loadedMap)?.redo || [];
    if (libraryChanged) clearRenderCaches();
    else disposeSceneRenderers();
    mapSnapshot = null;
    camera.framing = null;
    previewSnapshotDirty = true;
    previewSnapshotRevision++;
    previewTerrain = rawTerrain;
    rebuild();
    if(previewDialogCanvas?.isConnected)refreshSceneSnapshot();
  } catch (error) {
    if (serial === loadSerial) loadingMap = null;
    api.log.error("Pseudo 3D map load failed", error);
    api.ui.showToast({ message: `伪 3D 数据读取失败：${error?.message || error}`, level: "error" });
  }
}

async function save() {
  if(resourceRecycleBusy){await resourceRecycleBusy;return;}
  if (pendingSave) { await pendingSave; if (dirty) return save(); return; }
  if (loadedMap == null) return;
  if (!dirty) {await refreshPBSEffects();return;}
  if(pbsRefresh)await pbsRefresh;
  const mapId = loadedMap, revision = editRevision;
  const sync=effectsSync, edits=new Map(sync?.pending);
  if(!sync||pbsError)throw Error(`PBS 尚未成功读取，请刷新后保存：${pbsError}`);
  const libraryChanged = !libraryCache.isCurrent(library);
  if (libraryChanged) library.revision = Number(library.revision || 0) + 1;
  scene.revision = Number(scene.revision || 0) + 1;
  const savedLibrary = libraryChanged ? clone(library) : null;
  const savedEffects={...scene.effects};
  const libraryText = libraryChanged ? `${JSON.stringify(savedLibrary, null, 2)}\n` : null;
  const sceneText = `${JSON.stringify(scene, null, 2)}\n`;
  pendingSave = (async () => {
    const plan=sync.prepare(await readPBS(api.fs),edits);
    if (libraryChanged) await writeNativeModels(savedLibrary);
    await api.fs.projectMkdir("Data/MakerStudioPseudo3D");
    if (libraryChanged) await api.fs.writeProjectFile(LIB_PATH, libraryText);
    if(plan.text!==plan.before) {
      const latest=await readPBS(api.fs);
      if(latest!==plan.before){sync.refresh(latest);throw Error('PBS 在保存期间发生变化，请再次保存以合并最新内容');}
      await api.fs.writeProjectFile(PBS_PATH,plan.text);
    }
    sync.accept(plan,savedEffects);
    await api.fs.writeProjectFile(mapPath(mapId), sceneText);
    if (loadedMap === mapId && editRevision === revision) {
      dirty = false;
      if (libraryChanged) libraryCache.remember(libraryText, library);
    }
  })();
  try { await pendingSave; } finally { pendingSave = null; refreshWorkspace(); }
}

async function refreshPBSEffects() {
  if(loadedMap==null||loadingMap!=null||pendingSave)return;
  if(pbsRefresh)return pbsRefresh;
  const mapId=loadedMap,serial=loadSerial;
  pbsRefresh=(async()=>{
    try {
      const text=await readPBS(api.fs);
      if(mapId!==loadedMap||serial!==loadSerial||!api)return;
      if(effectsSync)effectsSync.refresh(text);else effectsSync=new PBSEffectsSync(mapId,text);
      pbsError='';
    }catch(error){if(mapId===loadedMap&&serial===loadSerial)pbsError=String(error.message||error);}
    finally {if(mapId===loadedMap&&serial===loadSerial&&api)refreshWorkspace();}
  })();
  try {await pbsRefresh;} finally {pbsRefresh=null;}
}
function onPBSFocus(){if(!document.hidden)void refreshPBSEffects();}
function changeSceneEffect(key,value) {
  if(!effectsSync||pbsError)return;
  if(value===effectsSync.effective(scene.effects)[key])return;
  commitHistory({label:'修改场景渲染',external:'effects',key,
    value:{authored:scene.effects[key],override:effectsSync.override(key)}});
  effectsSync.set(key,value,scene.effects[key]);scene.effects={...normalizeEffects(scene.effects),[key]:value};
  markDirty();rebuild();
}
function resolveEffectConflict(key,keepEditor) {
  if(!keepEditor)scene.effects[key]=effectsSync.pending.get(key)?.authored??scene.effects[key];
  effectsSync.resolve(key,keepEditor);
  if(!keepEditor)scene.effects[key]=effectsSync.effective(scene.effects)[key];
  markDirty();refreshWorkspace();
}

function assetById(id) { return library.assets.find((asset) => asset.id === id) || null; }
function instanceById(id) { return scene.instances.find((instance) => instance.id === id) || null; }
function selectedInstance() { return instanceById(selected); }
function selectedSceneNode(){return sceneNode(scene,selected);}
function nodeName(node){return node.name||assetById(node.assetId)?.name||'空物体';}
function selectedSceneIds(){return [...sceneSelection].filter(id=>sceneNode(scene,id));}
function selectionRoots(ids=selectedSceneIds()){
  const set=new Set(ids);return ids.filter(id=>{let n=sceneNode(scene,id);while(n?.parentId){if(set.has(n.parentId))return false;n=sceneNode(scene,n.parentId);}return true;});
}
function chooseSceneNode(id,event={}){
  activeResourceFolder=null;resourceFolderSelection.clear();
  finishSceneEdit(true);
  if(id===SCENE_ROOT_ID){sceneSelection.clear();selected=null;activeAsset=null;if(!controlSelect)sceneTool='select';clearSceneGhost();refreshWorkspace();redrawPreviews();return;}
  if(!id){sceneSelection.clear();selected=null;}
  else if(event.ctrlKey||event.metaKey){sceneSelection.has(id)?sceneSelection.delete(id):sceneSelection.add(id);selected=sceneSelection.has(id)?id:selectedSceneIds().at(-1)||null;}
  else{sceneSelection.clear();if(id)sceneSelection.add(id);selected=id||null;}
  const node=selectedSceneNode();if(node?.assetId)activeAsset=node.assetId;
  if(!controlSelect)sceneTool='select';clearSceneGhost();refreshWorkspace();redrawPreviews();
}
function setSceneNodeFlag(id,field,value){if(!sceneNode(scene,id))return;transact('修改层级状态',()=>sceneNode(scene,id)[field]=value);}
function reparentSceneNodes(ids,parentId='',targetId=null,after=false){
  const roots=selectionRoots(ids);
  if(roots.some(id=>nodeFlag(scene,id,'locked')||branchIds(scene,id).has(parentId))){api.ui.showToast({message:'无法移动锁定物体或建立循环父子关系',level:'info'});return;}
  if(!roots.length)return;
  transact('调整场景层级',()=>{for(const id of after&&targetId?[...roots].reverse():roots)setSceneParent(scene,id,parentId||'',targetId,after);});
}
function sceneCopy(cut=false){
  const roots=selectionRoots();if(!roots.length)return;
  const ids=new Set(roots.flatMap(id=>[...branchIds(scene,id)]));sceneClipboard={cut,roots,nodes:clone(sceneNodes(scene).filter(n=>ids.has(n.id)))};
}
function scenePaste(parentId=''){
  activeResourceFolder=null;resourceFolderSelection.clear();
  if(!sceneClipboard)return;
  if(sceneClipboard.cut){reparentSceneNodes(sceneClipboard.roots,parentId);sceneClipboard=null;return;}
  const copies=clone(sceneClipboard.nodes),remap=new Map(copies.map(n=>[n.id,uid(n.group?'group':'p3d')])),roots=sceneClipboard.roots;
  transact('粘贴场景物体',()=>{
    for(const n of copies){const old=n.id;n.id=remap.get(old);n.parentId=remap.get(n.parentId)||parentId;n.x+=32;n.y+=32;n.order=Date.now();n.name=nodeName(n)+' 副本';(n.group?scene.groups:scene.instances).push(n);}
    sceneSelection.clear();for(const id of roots)sceneSelection.add(remap.get(id));selected=[...sceneSelection].at(-1);
  });
}
function createSceneGroup(parentId='',wrap=false,batch=false){
  const roots=wrap?selectionRoots():[],nodes=roots.map(id=>sceneNode(scene,id));
  if(roots.some(id=>branchIds(scene,id).has(parentId)))parentId='';
  const x=nodes.length?nodes.reduce((s,n)=>s+n.x+n.footprintW*16,0)/nodes.length-16:(camera.framing?.target[0]||16)-16;
  const y=nodes.length?nodes.reduce((s,n)=>s+n.y+n.footprintD*16,0)/nodes.length-16:(camera.framing?.target[1]||16)-16;
  if(roots.some(id=>nodeFlag(scene,id,'locked')))return;
  const group={id:uid('group'),name:batch?'合批组':wrap?'物体组':'空物体',group:true,batch,parentId,x,y,rotation:0,scale:1,footprintW:1,footprintD:1,order:Date.now()};
  transact(wrap?'创建父物体':'创建空物体',()=>{scene.groups.push(group);for(const id of roots)setSceneParent(scene,id,group.id);sceneSelection.clear();sceneSelection.add(group.id);selected=group.id;});
  sceneTool='select';refreshWorkspace();
}
function removeSceneNodes(){
  const roots=selectionRoots().filter(id=>!nodeFlag(scene,id,'locked'));if(!roots.length)return;
  const ids=new Set(roots.flatMap(id=>[...branchIds(scene,id)]));
  transact('删除场景物体',()=>{scene.instances=scene.instances.filter(n=>!ids.has(n.id));scene.groups=scene.groups.filter(n=>!ids.has(n.id));selected=null;sceneSelection.clear();});
}
function openHierarchyMenu(event,id=null){
  if(id===SCENE_ROOT_ID)id=null;
  if(id&&!sceneSelection.has(id))chooseSceneNode(id);
  resourceMenu?.close();const ids=selectedSceneIds(),node=selectedSceneNode(),one=ids.length===1;
  hierarchyMenu?.open(event,[
    {label:'创建空物体',run:()=>createSceneGroup(id||'')},{label:'创建父物体',disabled:!ids.length,run:()=>createSceneGroup(node?.parentId||'',true)},null,
    {label:'创建合批组',disabled:!ids.length||ids.some(id=>nodeFlag(scene,id,'locked')),run:()=>createSceneGroup(node?.parentId||'',true,true)},
    {label:node?.batch?'取消合批（保留层级）':'启用静态合批',disabled:!one||!node?.group||nodeFlag(scene,selected,'locked'),run:()=>setSceneNodeFlag(selected,'batch',!node.batch)},null,
    {label:'重命名  F2',disabled:!one,run:()=>workspace.renameNode(selected)},
    {label:'聚焦  F',disabled:!node,run:focusSceneSelection},
    {label:'选择子物体',disabled:!node,run:()=>{for(const child of branchIds(scene,selected))sceneSelection.add(child);refreshWorkspace();}},null,
    {label:'复制  Ctrl+C',disabled:!ids.length,run:()=>sceneCopy()},
    {label:'剪切  Ctrl+X',disabled:!ids.length,run:()=>sceneCopy(true)},
    {label:'粘贴  Ctrl+V',disabled:!sceneClipboard,run:()=>scenePaste(id||'')},
    {label:'创建副本  Ctrl+D',disabled:!ids.length,run:duplicateSceneSelection},null,
    {label:'移到根层级',disabled:!ids.length,run:()=>reparentSceneNodes(ids,'')},
    {label:node?.locked?'解锁':'锁定',disabled:!ids.length,run:()=>{const value=!node?.locked;transact('修改锁定',()=>{for(const id of ids)sceneNode(scene,id).locked=value;});}},
    {label:node?.editorVisible===false?'显示':'隐藏',disabled:!ids.length,run:()=>{const value=node?.editorVisible===false;transact('修改编辑器可见性',()=>{for(const id of ids)sceneNode(scene,id).editorVisible=value;});}},null,
    {label:'删除  Delete',disabled:!ids.length,run:removeSceneNodes}
  ]);
}

function snapshot(includeLibrary = false) {
  return { library: includeLibrary ? clone(library) : null, scene: clone(scene),
    activeAsset,resourceFolder,activeResourceFolder,resourceFolderIds:includeLibrary?selectedResourceFolders():null, resourceIds:includeLibrary ? resourceIds() : null };
}
function historyState(){return nativeHistory?.state(loadedMap)||{undo:historyUndo.length,redo:historyRedo.length};}
function queueHistoryRefresh(){
  if(historyRefreshFrame!=null)return;
  historyRefreshFrame=requestAnimationFrame(()=>{historyRefreshFrame=null;if(!api)return;
    const root=panelHost?.querySelector('.msp3d-panel');if(root)refreshPanelFooter(root);
    refreshWorkspace();if(api.commands?.list().includes('terrain.refreshHistory'))api.commands.execute('terrain.refreshHistory');
    scheduleSceneRefresh();
  });
}
function commitHistory(entry){
  historyUndo.push(entry);if(historyUndo.length>100)historyUndo.shift();historyRedo=[];
  const mapId=loadedMap;
  const prepare=async()=>{
    if(loadingMap!=null)throw Error('请等待地图加载完成');
    await load(mapId);
    if(api.commands?.list().includes('terrain.ensureMap'))await api.commands.execute('terrain.ensureMap',mapId);
  };
  nativeHistory?.commit(mapId,entry.label,{
    undo:async()=>{await prepare();return undo();},redo:async()=>{await prepare();return redo();}
  });
}
function transact(label, mutation, includeLibrary = false) {
  commitHistory({ label, value: snapshot(includeLibrary) });
  mutation();
  if (includeLibrary) library = normalizeLibrary(library);
  scene = normalizeScene(scene, loadedMap);
  markDirty();
}

async function restore(entry, target) {
  if(entry.external==='recycle')return restoreResourceHistory(entry,target);
  if(entry.external==='effects') {
    if(!effectsSync||pbsError)throw Error('请先成功刷新 PBS 再撤销特效修改');
    target.push({...entry,value:{authored:scene.effects[entry.key],override:effectsSync.override(entry.key)}});
    effectsSync.set(entry.key,entry.value.override,scene.effects[entry.key]);scene.effects[entry.key]=entry.value.authored;
    markDirty();return;
  }
  if (entry.external === 'terrain') {
    const restored=await api.commands.execute(target === historyRedo ? 'terrain.undoLocal' : 'terrain.redoLocal');
    if(restored===false)throw Error('地形撤销记录不可用');
    target.push(entry);
    api.commands.execute('terrain.refreshHistory');
    return;
  }
  target.push({ label: entry.label, value: snapshot(entry.value.library != null) });
  if (entry.value.library != null) library = normalizeLibrary(entry.value.library);
  if(entry.value.resourceIds){
    resourceSelection.clear();for(const id of entry.value.resourceIds)if(assetById(id))resourceSelection.add(id);
    activeAsset=assetById(entry.value.activeAsset)?.id||resourceIds()[0]||null;
  }
  if(entry.value.resourceFolderIds){resourceFolderSelection.clear();for(const id of entry.value.resourceFolderIds)if(folderById(library,id))resourceFolderSelection.add(id);activeResourceFolder=folderById(library,entry.value.activeResourceFolder)?.id||null;}
  // Effect history is independent: undoing a model move must not restore an
  // old copy of settings refreshed from PBS or edited in the meantime.
  scene = normalizeScene({...entry.value.scene,effects:scene.effects}, loadedMap);
  selected = null;
  if(entry.value.library != null)clearRenderCaches();
  markDirty();
}

async function undo() {
  if(resourceRecycleBusy)return false;
  const entry = historyUndo.pop();
  if (entry) {
    try{return await restore(entry, historyRedo);}
    catch(error){historyUndo.push(entry);throw error;}
  }
  return false;
}

async function redo() {
  if(resourceRecycleBusy)return false;
  const entry = historyRedo.pop();
  if (entry) {
    try{return await restore(entry, historyUndo);}
    catch(error){historyRedo.push(entry);throw error;}
  }
  return false;
}

function markDirty(refresh = true) {
  editRevision++;
  dirty = true;
  if(!refresh && stroke){
    if(strokeRedrawFrame==null)strokeRedrawFrame=requestAnimationFrame(()=>{
      strokeRedrawFrame=null;
      if(stroke&&!stroke.erase)disconnectPlacementOverlay?.redraw?.();
      else {api?.editor.requestRedraw?.();redrawPreviews();}
    });
    return;
  }
  if(api.commands?.list().includes('terrain.refreshHistory'))api.commands.execute('terrain.refreshHistory');
  api.editor.markMapDirty?.(loadedMap, true);
  api.editor.requestRedraw?.();
  if (refresh) rebuild();
  redrawPreviews();
}

function rebuild() {
  if(!workspace)renderPanel();
  refreshWorkspace();
  api?.editor.requestRedraw?.();
}

function clearRenderCaches() {
  textureDependents.clear();
  thumbnailCache.clear();resourceCards=new WeakMap();panelView=null;
  thumbnailQueue?.clear();
  modelCache.clear();
  billboardCache.clear();
  textureImageCache.clear();
  assetTextureMapCache = new WeakMap();
  disposeSceneRenderers();
}

async function writeNativeModels(savedLibrary) {
  for (const asset of savedLibrary.assets) {
    const files = nativeModelFiles(asset, savedLibrary.textures);
    for (const file of files) {
      await api.fs.projectMkdir(file.path.slice(0, file.path.lastIndexOf('/')));
      if (file.text != null) await api.fs.writeProjectFile(file.path, file.text);
      else {
        const call = invoke(), root = api.editor.gameRoot?.();
        if (!call || !root) throw Error('当前宿主不支持纹理文件写入，模型尚未保存。');
        const binary = atob(file.image.split(',')[1]);
        await call('write_binary_file', {path:`${root.replace(/\\/g, '/')}/${file.path}`,
          data:Array.from(binary, c => c.charCodeAt(0))});
      }
    }
  }
}

function worldPointer(event) {
  if (Number.isFinite(event.worldX) && Number.isFinite(event.worldY)) return { x: event.worldX, y: event.worldY };
  const pointer = api.editor.pointer?.();
  if (pointer?.worldX != null) return { x: pointer.worldX, y: pointer.worldY };
  return { x: Number(event.tileX || 0) * TILE_SIZE, y: Number(event.tileY || 0) * TILE_SIZE };
}

function snapped(point, free = false) {
  if (free) return { x: Math.round(point.x), y: Math.round(point.y) };
  return { x: Math.floor(point.x / TILE_SIZE) * TILE_SIZE, y: Math.floor(point.y / TILE_SIZE) * TILE_SIZE };
}

function visibleInstances() {
  const flags=hierarchyFlags(scene),assets=new Set(library.assets.map(a=>a.id));
  return scene.instances.filter((instance) => instance.visible !== false && !flags.get(instance.id)?.hidden&&assets.has(instance.assetId));
}

function pointerDown(event) {
  if(!modelLayer?.editable())return;
  if (loadingMap != null || Number(event.mapId) !== loadedMap) return;
  const point = worldPointer(event);
  const mapInfo = api.map.info?.(loadedMap);
  if (!mapInfo || point.x < 0 || point.y < 0 || point.x >= mapInfo.width * TILE_SIZE || point.y >= mapInfo.height * TILE_SIZE) return;
  const asset = assetById(activeAsset);
  if ((mode === "brush" || mode === "erase") && event.button === 0) {
    stroke = { before: snapshot(), changed: false, erase: mode === "erase", last: null, added: [], addedIds:new Set() };
    if(mode==='erase')updateErasePreview(point);
    paintAt(point, stroke);
    return;
  }
  if (event.button !== 0) return;
  if (mode === "place" && asset) {
    const position = snapped(point, event.altKey);
    const id = uid("p3d");
    transact("放置伪 3D 物件", () => scene.instances.push({
      id, assetId: asset.id, x: position.x, y: position.y,
      rotation: placementRotation, scale: placementScale, opacity: 255,
      footprintW: asset.footprintW, footprintD: asset.footprintD,
      collision: asset.collisionDefault !== false, visible: true, order: Date.now()
    }));
    selected = id;
    placementPreview = { assetId: asset.id, ...position };
    rebuild();
    return;
  }
  const found = hitTest(visibleInstances(), library.assets, point.x, point.y);
  selected = found?.id || null;
  if (found) { activeAsset = found.assetId; panelTab = "instance"; }
  if (found) drag = {
    id: found.id, startX: point.x, startY: point.y,
    objectX: found.x, objectY: found.y, previewX: found.x, previewY: found.y, moved: false
  };
  rebuild();
}

function updateErasePreview(point){
  const cell=snapped(point),info=api.map.info?.(loadedMap);
  const next=info&&cell.x>=0&&cell.y>=0&&cell.x<info.width*TILE_SIZE&&cell.y<info.height*TILE_SIZE?cell:null;
  if(placementPreview?.x===next?.x&&placementPreview?.y===next?.y)return;
  placementPreview=next;
  disconnectPlacementOverlay?.redraw?.();
}

function pointerMove(event) {
  if(!modelLayer?.editable())return;
  if (Number(event.mapId) !== loadedMap) return;
  if(mode==='erase')updateErasePreview(worldPointer(event));
  if (stroke && (event.buttons & 1) !== 0) {
    const point = worldPointer(event), target = { x: Math.floor(point.x / TILE_SIZE), y: Math.floor(point.y / TILE_SIZE) };
    for (const cell of lineCells(stroke.cell, target)) paintAt({ x: cell.x * TILE_SIZE, y: cell.y * TILE_SIZE }, stroke);
    stroke.cell = target;
    return;
  }
  if(mode==='erase')return;
  if (mode === "place" || mode === "brush") {
    const asset = assetById(activeAsset);
    if (!asset) return;
    const position = snapped(worldPointer(event), event.altKey);
    if (!placementPreview || placementPreview.assetId !== asset.id ||
        placementPreview.x !== position.x || placementPreview.y !== position.y) {
      placementPreview = { assetId: asset.id, ...position };
      disconnectPlacementOverlay?.redraw?.();
    }
    return;
  }
  if (!drag || Number(event.mapId) !== loadedMap || (event.buttons & 1) === 0) return;
  const point = worldPointer(event);
  const deltaX = point.x - drag.startX;
  const deltaY = point.y - drag.startY;
  if (!drag.moved && Math.abs(deltaX) < 3 && Math.abs(deltaY) < 3) return;
  const target = snapped({ x: drag.objectX + deltaX, y: drag.objectY + deltaY }, event.altKey);
  if (target.x === drag.previewX && target.y === drag.previewY) return;
  const starting = !drag.moved;
  drag.moved = true;
  drag.previewX = target.x;
  drag.previewY = target.y;
  if (starting) {
    // Remove the original from the static map once. Subsequent motion only
    // paints the moving model, just like the placement preview.
    api.editor.requestRedraw?.();
    disconnectOverlay?.redraw?.();
  }
  disconnectPlacementOverlay?.redraw?.();
}

function pointerUp(event) {
  if (stroke && event.button === 0) {
    const finished = stroke;
    stroke = null;
    if(strokeRedrawFrame!=null)cancelAnimationFrame(strokeRedrawFrame);strokeRedrawFrame=null;
    disconnectPlacementOverlay?.redraw?.();
    if (finished.changed) {
      commitHistory({ label: finished.erase ? "擦除伪 3D 物件" : "绘制伪 3D 物件", value: finished.before });
      markDirty();
    }
    return;
  }
  if (!drag || event.button !== 0) return;
  const finished = drag;
  drag = null;
  if (!finished.moved) return;
  disconnectPlacementOverlay?.redraw?.();
  disconnectOverlay?.redraw?.();
  if (finished.previewX === finished.objectX && finished.previewY === finished.objectY) {
    api.editor.requestRedraw?.();
    return;
  }
  transact("移动伪 3D 物件", () => {
    const instance = instanceById(finished.id);
    if (instance) { instance.x = finished.previewX; instance.y = finished.previewY; }
  });
}

function paintAt(point, currentStroke) {
  const cell = snapped(point);
  const info = api.map.info?.(loadedMap);
  if (!info || cell.x < 0 || cell.y < 0 || cell.x >= info.width * TILE_SIZE || cell.y >= info.height * TILE_SIZE) return;
  currentStroke.cell = { x: cell.x / TILE_SIZE, y: cell.y / TILE_SIZE };
  if (currentStroke.last && currentStroke.last.x === cell.x && currentStroke.last.y === cell.y) return;
  currentStroke.last = cell;
  if (currentStroke.erase) {
    const target = hitTest(visibleInstances(), library.assets, point.x, point.y);
    if (target) {
      scene.instances = scene.instances.filter((instance) => instance.id !== target.id);
      selected = null;
      currentStroke.changed = true;
      markDirty(false);
    }
    return;
  }
  const asset = assetById(activeAsset);
  if (!asset) return;
  currentStroke.occupied ||= new Set(scene.instances.filter(instance=>instance.assetId===asset.id).map(instance=>`${instance.x},${instance.y}`));
  const cellKey=`${cell.x},${cell.y}`;
  if(currentStroke.occupied.has(cellKey))return;
  currentStroke.occupied.add(cellKey);
  scene.instances.push({ id: uid("p3d"), assetId: asset.id, x: cell.x, y: cell.y,
    rotation: placementRotation, scale: placementScale, opacity: 255, footprintW: asset.footprintW,
    footprintD: asset.footprintD, collision: asset.collisionDefault !== false, visible: true, order: Date.now() });
  selected = scene.instances.at(-1).id;
  (currentStroke.added ||= []).push(scene.instances.at(-1));
  (currentStroke.addedIds ||= new Set()).add(selected);
  currentStroke.changed = true;
  markDirty(false);
}

function previewInstance(instance) {
  return drag != null && instance.id != null && drag.id === instance.id
    ? { ...instance, x: drag.previewX, y: drag.previewY }
    : instance;
}

function placementInstance() {
  if(!modelLayer?.editable() || api?.editor.activeTool?.()!==TOOL_ID)return null;
  const asset = assetById(placementPreview?.assetId);
  if (!asset || !["place", "brush"].includes(mode)) return null;
  return {
    id: "__maker_p3d_placement_preview__", assetId: asset.id,
    x: placementPreview.x, y: placementPreview.y,
    rotation: placementRotation, scale: placementScale, opacity: 190,
    footprintW: asset.footprintW, footprintD: asset.footprintD,
    collision: false, visible: true, order: Number.MAX_SAFE_INTEGER
  };
}

function screenMetrics(info) {
  return {
    scale: Number(info.zoom) || Number(info.tileSize) / TILE_SIZE || 1,
    viewportX: Number(info.viewportX) || 0,
    viewportY: Number(info.viewportY) || 0
  };
}

function queueTextureRefresh(textureId) {
  loadedTextureIds.add(textureId);
  if (textureRefreshQueued) return;
  textureRefreshQueued = true;
  requestAnimationFrame(() => {
    textureRefreshQueued = false;
    const affected=new Set([...loadedTextureIds].flatMap(id=>[...(textureDependents.get(id)||[])]));
    loadedTextureIds.clear();
    for(const asset of library.assets)if(affected.has(asset.id))resourceCards.delete(asset);
    for(const cache of [modelCache,thumbnailCache])for(const key of cache.keys())if([...affected].some(id=>key.startsWith(id+':')))cache.delete(key);
    for(const canvas of document.querySelectorAll('.msp3d-preview'))if(affected.has(canvas.__makerAssetId)){
      canvas.__makerThumbnailReady=false;
      if(canvas.__makerThumbnailVisible)queueThumbnail(canvas);
    }
    api?.editor.requestRedraw?.();
    if (workspace) {
      for (const canvas of document.querySelectorAll('.ms-workspace .msp3d-preview')) {
        const r=canvas.getBoundingClientRect(),p=canvas.closest('.msp3d-assets')?.getBoundingClientRect();
        if(p&&r.bottom>=p.top&&r.top<=p.bottom&&affected.has(canvas.__makerAssetId))queueThumbnail(canvas);
      }
      for (const canvas of document.querySelectorAll('.ms-workspace .msp3d-object-preview')) canvas.__makerRedraw?.();
      for(const preview of document.querySelectorAll('.ms-folder-model-previews'))preview.__makerRedraw?.();
      redrawPreviews();
    } else for(const canvas of panelHost?.querySelectorAll('.msp3d-object-preview')||[])canvas.__makerRedraw?.();
  });
}

function textureImages(asset) {
  const cached = assetTextureMapCache.get(asset);
  if (cached) return cached;
  const result = new Map();
  const ids = new Set((asset.faces || []).map((face) => face.texture).filter(Boolean));
  for (const id of ids) {
    if(!textureDependents.has(id))textureDependents.set(id,new Set());
    textureDependents.get(id).add(asset.id);
    const texture = (library.textures || []).find((entry) => entry.id === id);
    if (!texture?.image) continue;
    let entry = textureImageCache.get(id);
    if (!entry) {
      const image = new Image();
      entry = { image, ready: false };
      image.onload = () => {
        entry.ready = true;
        // The per-asset map may already have been returned while the image
        // was loading. Update that same map so later frames see the texture.
        result.set(id, image);
        queueTextureRefresh(id);
      };
      image.onerror = () => { entry.failed = true; };
      image.src = texture.image;
      textureImageCache.set(id, entry);
    }
    result.set(id, entry.image);
  }
  assetTextureMapCache.set(asset, result);
  return result;
}

function modelCanvas(asset, rotation, pitch = MAP_PREVIEW_PITCH, thumbnail = false) {
  const cache=thumbnail?thumbnailCache:modelCache;
  const angle = normalizeAngle(rotation);
  const key = `${asset.id}:${angle}:${asset.pixelHeight}:${pitch}`;
  if (!cache.has(key)) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(key, renderModel(asset, angle, textureImages(asset), pitch));
  }
  const result=cache.get(key);cache.delete(key);cache.set(key,result);return result;
}

function billboardImage(asset) {
  const cached = billboardCache.get(asset.id);
  if (cached) return cached.image;
  const entry = { image: new Image(), ready: false };
  entry.image.onload = () => {
    entry.ready = true;
    api?.editor.requestRedraw?.();
    for(const canvas of document.querySelectorAll('.msp3d-preview'))if(canvas.__makerAssetId===asset.id){canvas.__makerThumbnailReady=false;queueThumbnail(canvas);}
    for(const canvas of document.querySelectorAll('.msp3d-object-preview'))canvas.__makerRedraw?.();
  };
  entry.image.onerror = () => { entry.failed = true; };
  entry.image.src = asset.image;
  billboardCache.set(asset.id, entry);
  return entry.image;
}

function sourceFor(asset, rotation, pitch = MAP_PREVIEW_PITCH, thumbnail = false) {
  return asset.type === "model" ? modelCanvas(asset, rotation, pitch, thumbnail) : billboardImage(asset);
}

function drawInstance(ctx, info, original, opacity = 1) {
  const instance = previewInstance(original);
  const asset = assetById(instance.assetId);
  if (!asset) return;
  const source = sourceFor(asset, instance.rotation);
  if (!source?.width || !source?.height) return;
  const metrics = screenMetrics(info);
  const footprintW = instance.footprintW || asset.footprintW || 1;
  const footprintD = instance.footprintD || asset.footprintD || 1;
  const anchorX = (instance.x + footprintW * TILE_SIZE / 2) * metrics.scale - metrics.viewportX;
  const anchorY = (instance.y + footprintD * TILE_SIZE *
    (asset.type === "model" ? 0.5 : 1)) * metrics.scale - metrics.viewportY;
  const instanceScale = clamp(Number(instance.scale) || 1, 0.1, 8);
  let height = source.height * instanceScale * metrics.scale;
  let width = source.width * instanceScale * metrics.scale;
  let mirror = false;
  if (asset.type === "billboard") {
    height = asset.pixelHeight * instanceScale * metrics.scale;
    width = height * asset.imageWidth / Math.max(1, asset.imageHeight);
    const cosine = Math.cos(Number(instance.rotation || 0) * Math.PI / 180);
    width *= Math.max(Math.abs(cosine), 0.06);
    mirror = cosine < 0;
  }
  ctx.save();
  ctx.globalAlpha *= opacity * clamp(Number(instance.opacity ?? 255), 0, 255) / 255;
  ctx.imageSmoothingEnabled = asset.type === "model";
  ctx.translate(anchorX, anchorY);
  ctx.scale(mirror ? -1 : 1, 1);
  const sourceAnchorX = asset.type === "model" && Number.isFinite(source.makerPivotX)
    ? source.makerPivotX : source.width / 2;
  const sourceAnchorY = asset.type === "model" && Number.isFinite(source.makerPivotY)
    ? source.makerPivotY : source.height;
  ctx.drawImage(source, -sourceAnchorX * width / source.width,
    -sourceAnchorY * height / source.height, width, height);
  ctx.restore();
}

function drawGuides(ctx, info) {
  if(!modelLayer?.editable() || api?.editor.activeTool?.()!==TOOL_ID)return;
  const instance = mode==='erase' ? (placementPreview?{...placementPreview,footprintW:1,footprintD:1}:null) : placementInstance() || selectedInstance();
  if (!instance) return;
  const shown = previewInstance(instance);
  const metrics = screenMetrics(info);
  const x = shown.x * metrics.scale - metrics.viewportX;
  const y = shown.y * metrics.scale - metrics.viewportY;
  const width = shown.footprintW * TILE_SIZE * metrics.scale;
  const depth = shown.footprintD * TILE_SIZE * metrics.scale;
  ctx.save();
  ctx.fillStyle = mode==='erase' ? 'rgba(255,90,90,.22)' : "rgba(34,211,238,.12)";
  ctx.strokeStyle = mode==='erase' ? '#ff5a5a' : "#22d3ee";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.fillRect(x, y, width, depth);
  ctx.strokeRect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, depth - 2));
  ctx.restore();
}

function collectScene(info) {
  if (Number(info.mapId) !== loadedMap || modelLayer?.settings.visible===false || modelLayer?.settings.opacity===0) return [];
  const items = visibleInstances().filter(instance=>!stroke?.addedIds?.has(instance.id)&&!(drag?.moved&&drag.id===instance.id)).map((instance) => ({
    id: instance.id,
    sortY: instance.y + instance.footprintD * TILE_SIZE,
    order: Number(instance.order || 0),
    render(ctx, renderInfo) { drawInstance(ctx, renderInfo, instance, modelLayer?.settings.opacity??1); }
  }));
  return items;
}

function renderFallback(ctx, info) {
  if (Number(info.mapId) !== loadedMap || modelLayer?.settings.visible===false || modelLayer?.settings.opacity===0) return;
  const items = visibleInstances().filter(instance=>!stroke?.addedIds?.has(instance.id)&&!(drag?.moved&&drag.id===instance.id)).sort((a, b) => {
    const ay = a.y + a.footprintD * TILE_SIZE;
    const by = b.y + b.footprintD * TILE_SIZE;
    return ay - by || Number(a.order || 0) - Number(b.order || 0);
  });
  for (const instance of items) drawInstance(ctx, info, instance, modelLayer?.settings.opacity??1);
}

function renderPlacementOverlay(ctx,info){
  if(Number(info.mapId)!==loadedMap)return;
  if(modelLayer?.settings.visible!==false)for(const instance of stroke?.added||[])drawInstance(ctx,info,instance,modelLayer?.settings.opacity??1);
  if(drag?.moved&&modelLayer?.settings.visible!==false){
    const instance=instanceById(drag.id);
    if(instance)drawInstance(ctx,info,instance,modelLayer?.settings.opacity??1);
  }
  const preview = placementInstance();
  if (preview) drawInstance(ctx, info, preview, 0.62*(modelLayer?.settings.opacity??1));
  drawGuides(ctx, info);
}

function invoke() {
  return globalThis.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke || null;
}

async function chooseFile(filters) {
  const paths = await api.ui.showFilePicker({ filters, multiple: false });
  return paths?.[0] || null;
}

async function readTextFile(path) {
  const call = invoke();
  if (!call) throw new Error("当前 Maker Studio 无法读取外部文本文件。");
  return call("read_text_file", { path });
}

async function readBinaryFile(path) {
  const call = invoke();
  if (!call) throw new Error("当前 Maker Studio 无法读取外部图片。");
  return new Uint8Array(await call("read_binary_file", { path }));
}

function fileName(path) {
  return String(path).replace(/\\/g, "/").split("/").pop() || "asset";
}

function withoutExtension(name) { return name.replace(/\.[^.]+$/, ""); }
function siblingPath(source, relative) {
  const normalized = String(source).replace(/\\/g, "/");
  const directory = normalized.slice(0, Math.max(0, normalized.lastIndexOf("/") + 1));
  return `${directory}${String(relative).replace(/\\/g, "/")}`;
}

function mimeFor(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function importObj() {
  const startMap=loadedMap;
  try {
    const path = await chooseFile([{ name: "Wavefront OBJ", extensions: ["obj"] }]);
    if (!path) return;
    const text = await readTextFile(path);
    let materials = new Map();
    let mtlPath = '';
    const mtlName = String(text).match(/^\s*mtllib\s+(.+)$/mi)?.[1]?.trim();
    if (mtlName) {
      try { mtlPath=siblingPath(path,mtlName);materials = parseMtl(await readTextFile(mtlPath)); }
      catch { api.log.warn(`未能读取 MTL：${mtlName}`); }
    }
    const mesh = parseObj(text, materials);
    if (mesh.vertices.length > 20000 || mesh.faces.length > 40000) {
      throw new Error("模型过于复杂；上限为 20,000 个顶点和 40,000 个三角面。");
    }
    const textures=[],textureIds=new Map();
    for(const [material,relative] of materials.textures || []){
      try{
        const imagePath=siblingPath(mtlPath,relative), bytes=await readBinaryFile(imagePath);
        if(bytes.length>12*1024*1024)throw Error('图片超过 12 MB');
        const bitmap=await createImageBitmap(new Blob([bytes],{type:mimeFor(imagePath)}));
        const width=bitmap.width,height=bitmap.height;bitmap.close?.();
        if(width>8192||height>8192)throw Error('纹理边长超过 8192');
        const id=uid('texture');textures.push({id,path:'',image:`data:${mimeFor(imagePath)};base64,${bytesToBase64(bytes)}`,width,height});
        textureIds.set(material,id);
      }catch(error){api.ui.showToast({message:`纹理 ${relative} 未导入：${error.message||error}`,level:'warning'});}
    }
    for(const face of mesh.faces)face.texture=textureIds.get(face.material)||'';
    if(startMap!==loadedMap)throw Error('地图已切换，请重新导入模型。');
    const asset = {
      id: uid("asset"), name: withoutExtension(fileName(path)), type: "model",
      footprintW: 1, footprintD: 1, pixelHeight: 96,
      vertices: mesh.vertices, uvs: mesh.uvs, faces: mesh.faces,
      generatedNative:true,sourceObj:`Graphics/MakerStudioPseudo3D/Models/Edited/${uid('mesh')}/model.obj`,
      pivotX: mesh.pivot[0], pivotY: mesh.pivot[1], pivotZ: mesh.pivot[2],
      meshOffsetX: mesh.meshOffset[0], meshOffsetY: mesh.meshOffset[1],
      meshOffsetZ: mesh.meshOffset[2],
      createdAt: new Date().toISOString()
    };
    if(workspace&&(resourceCategory||resourceFolder||activeResourceFolder)){const destination=resourceDestination();asset.category=destination.category;asset.folderId=destination.folderId;}
    transact("导入 OBJ 模型", () => {library.assets.push(asset);library.textures.push(...textures);}, true);
    activeAsset = asset.id;
    if (mode !== "brush") mode = "place";
    rebuild();
    api.ui.showToast({ message: `已导入 ${mesh.vertices.length} 个顶点、${mesh.faces.length} 个三角面`, level: "success" });
  } catch (error) {
    api.ui.showToast({ message: String(error?.message || error), level: "error" });
  }
}

async function importBillboard() {
  try {
    const path = await chooseFile([{ name: "透明立牌图片", extensions: ["png", "jpg", "jpeg"] }]);
    if (!path) return;
    const bytes = await readBinaryFile(path);
    if (bytes.length > 12 * 1024 * 1024) throw new Error("图片不能超过 12 MB。");
    const mime = mimeFor(path);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const asset = {
      id: uid("asset"), name: withoutExtension(fileName(path)), type: "billboard",
      footprintW: 1, footprintD: 1, pixelHeight: clamp(bitmap.height, 16, 768),
      image: `data:${mime};base64,${bytesToBase64(bytes)}`,
      imageWidth: bitmap.width, imageHeight: bitmap.height,
      createdAt: new Date().toISOString()
    };
    bitmap.close?.();
    if(workspace&&(resourceCategory||resourceFolder||activeResourceFolder)){const destination=resourceDestination();asset.category=destination.category;asset.folderId=destination.folderId;}
    transact("导入立牌图片", () => library.assets.push(asset), true);
    activeAsset = asset.id;
    mode = "place";
    rebuild();
    api.ui.showToast({ message: `已导入立牌 ${asset.imageWidth}x${asset.imageHeight}`, level: "success" });
  } catch (error) {
    api.ui.showToast({ message: String(error?.message || error), level: "error" });
  }
}

async function removeAsset(id) {
  await deleteResources([id],[]);
}

function resourceIds() {
  return [...resourceSelection].filter(id => assetById(id));
}

function selectResource(id, event = {}) {
  activeResourceFolder=null;if(!event.ctrlKey&&!event.metaKey)resourceFolderSelection.clear();
  const visible = [...document.querySelectorAll('.ms-project .msp3d-asset')].map(n => n.dataset.assetId);
  if (event.shiftKey && resourceAnchor && visible.includes(resourceAnchor) && visible.includes(id)) {
    const [a, b] = [visible.indexOf(resourceAnchor), visible.indexOf(id)].sort((x, y) => x-y);
    if (!event.ctrlKey && !event.metaKey) resourceSelection.clear();
    for (const value of visible.slice(a, b+1)) resourceSelection.add(value);
  } else if (event.ctrlKey || event.metaKey) {
    if (resourceSelection.has(id)) resourceSelection.delete(id); else resourceSelection.add(id);
    resourceAnchor = id;
  } else { resourceSelection.clear(); resourceSelection.add(id); resourceAnchor = id; }
  activeAsset = resourceSelection.has(id) ? id : resourceIds().at(-1) || null;
}

function updateResourceCards() {
  for (const card of document.querySelectorAll('.msp3d-asset')) {
    card.classList.toggle('is-selected', resourceSelection.has(card.dataset.assetId));
    card.classList.toggle('is-cut', resourceClipboard?.kind === 'cut' && resourceClipboard.ids.includes(card.dataset.assetId));
    card.setAttribute('aria-selected', String(resourceSelection.has(card.dataset.assetId)));
  }
  for(const card of document.querySelectorAll('.ms-project [data-folder-id]')){card.classList.toggle('is-selected',resourceFolderSelection.has(card.dataset.folderId));card.classList.toggle('is-cut',resourceClipboard?.kind==='cut'&&resourceClipboard.folders.some(f=>f.id===card.dataset.folderId));}
}

function selectedResourceFolders(){return [...resourceFolderSelection].filter(id=>folderById(library,id));}
function selectResourceFolder(id,event={}){
  if(!folderById(library,id))return;finishSceneEdit(true);
  if(event.ctrlKey||event.metaKey){resourceFolderSelection.has(id)?resourceFolderSelection.delete(id):resourceFolderSelection.add(id);}else{resourceFolderSelection.clear();resourceSelection.clear();resourceFolderSelection.add(id);}
  activeResourceFolder=resourceFolderSelection.has(id)?id:selectedResourceFolders().at(-1)||null;activeAsset=null;selected=null;setSceneTool('select');updateResourceCards();
}
function resourceLocation(category,folderId){resourceCategory=category;resourceFolder=folderId;if(!folderId){activeResourceFolder=null;resourceFolderSelection.clear();refreshWorkspace();}}
function resourceDestination(){const folder=folderById(library,activeResourceFolder||resourceFolder);return {category:folder?.category||resourceCategory||'未分类',folderId:folder?.id||''};}
async function newResourceFolder(kind='folder'){
  const destination=resourceDestination(),name=await requestResourceText(kind==='mountain'?'新建山体文件夹':'新建文件夹',kind==='mountain'?'新建山体':'新建文件夹');if(!name)return;
  let folder;transact('新建资源文件夹',()=>{folder=createFolder(library,name,destination.category,destination.folderId,kind);},true);selectResourceFolder(folder.id);workspace?.refreshAssets();
}
function moveResourceItems(payload,category,folderId){
  try{const assets=payload.assets||[],folders=payload.folders||[];if(!assets.length&&!folders.length)return;
    // Validate before opening history; a failed cycle does not consume undo.
    if(folders.some(id=>folderBranch(library,id).has(folderId)))throw Error('不能将文件夹移到自身或子文件夹中');
    transact('移动资源',()=>moveLibraryItems(library,assets,folders,category,folderId),true);workspace?.refreshAssets();
  }catch(error){api.ui.showToast({message:error.message,level:'info'});}
}

function resourceCopy(cut = false) {
  const ids = resourceIds(),folders=selectedResourceFolders();
  if (!ids.length&&!folders.length) return;
  resourceClipboard=copyLibraryItems(library,ids,folders,cut);
  updateResourceCards();
}

function resourcePaste() {
  if (!resourceClipboard) return;
  const clipboard=resourceClipboard,destination=resourceDestination();
  if(clipboard.kind==='cut'&&clipboard.roots.some(id=>folderBranch(library,id).has(destination.folderId))){api.ui.showToast({message:'不能粘贴到自身或子文件夹中',level:'info'});return;}
  let added;transact(clipboard.kind==='cut'?'移动资源':'粘贴资源',()=>{added=pasteLibraryItems(library,clipboard,destination.category,destination.folderId);},true);
  if(clipboard.kind==='cut')resourceClipboard=null;
  resourceSelection.clear();resourceFolderSelection.clear();
  for(const id of added.folders)resourceFolderSelection.add(id);
  if(!added.folders.length)for(const id of added.assets)resourceSelection.add(id);
  activeResourceFolder=added.folders[0]||null;activeAsset=activeResourceFolder?null:added.assets[0]||null;selected=null;clearRenderCaches();rebuild();updateResourceCards();
}

function duplicateResources() {
  if(selectedResourceFolders().length){const destination=folderById(library,selectedResourceFolders()[0]);const previous=resourceClipboard;resourceClipboard=copyLibraryItems(library,resourceIds(),selectedResourceFolders());activeResourceFolder=null;resourceFolder=destination.parentId;resourceCategory=destination.category;resourcePaste();resourceClipboard=previous;updateResourceCards();return;}
  const ids = resourceIds();
  if (!ids.length) return;
  const added = [];
  transact('复制资源副本', () => {
    for (const id of ids) { const a = copyAsset(assetById(id), library.assets); library.assets.push(a); added.push(a.id); }
  }, true);
  resourceSelection.clear(); for (const id of added) resourceSelection.add(id);
  activeAsset = added[0]; selected = null; rebuild(); updateResourceCards();
}

function showResourceDialog(options) {
  return workspace?workspace.showDialog(options):api.ui.showCustomDialog(options);
}

function requestResourceText(title, value, label = '名称') {
  return new Promise(resolve => {
    let dialog = null, settled = false;
    const finish = result => { if (settled) return; settled = true; resolve(result); dialog?.close(); };
    dialog = showResourceDialog({title,width:420,height:210,render(host) {
      const form = element('form','ms-resource-text-form'), input = element('input');
      input.value=value;input.setAttribute('aria-label',label);
      const actions=element('div','ms-resource-text-actions');
      actions.append(button('取消',()=>finish(null)),button('确定',()=>finish(input.value.trim())));
      form.append(element('label','',label),input,actions);host.append(form);
      form.onsubmit=e=>{e.preventDefault();finish(input.value.trim());};
      input.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();finish(null);}};
      requestAnimationFrame(()=>{if(input.isConnected){input.focus();input.select();}});
      return ()=>{if(!settled){settled=true;resolve(null);}};
    },onCloseRequest:()=>finish(null)});
  });
}

function confirmResourceAction(options) {
  if(!workspace)return api.ui.showConfirmDialog(options);
  return new Promise(resolve=>{
    let dialog=null,settled=false;
    const finish=value=>{if(settled)return;settled=true;resolve(value);dialog?.close();};
    dialog=showResourceDialog({title:options.title,width:420,height:210,render(host){
      const actions=element('div','ms-resource-text-actions');
      actions.append(button('取消',()=>finish(false)),button('删除',()=>finish(true)));
      host.append(element('div','ms-resource-confirm',options.message),actions);
      return ()=>{if(!settled){settled=true;resolve(false);}};
    },onCloseRequest:()=>finish(false)});
  });
}

async function renameResource() {
  const folders=selectedResourceFolders();if(folders.length===1&&!resourceIds().length){const folder=folderById(library,folders[0]),name=await requestResourceText('重命名文件夹',folder.name);if(name&&folderById(library,folder.id)){transact('重命名资源文件夹',()=>{const current=folderById(library,folder.id);current.name=uniqueFolderName(library,name,current.category,current.parentId,current.id);},true);workspace?.refreshAssets();}return;}
  const ids=resourceIds();if(ids.length!==1)return;
  const asset=assetById(ids[0]), name=await requestResourceText('重命名资源',asset.name);
  if(name && assetById(asset.id))setAssetField(asset.id,'name',name);
}

async function moveResources() {
  const ids=resourceIds(),folders=selectedResourceFolders();if(!ids.length&&!folders.length)return;
  const category=await requestResourceText('移动到分类',resourceCategory||'未分类','分类');
  if(!category)return;
  moveResourceItems({assets:ids,folders},category,'');
}

async function deleteResources(ids=resourceIds(),folders=selectedResourceFolders()) {
  if(resourceRecycleBusy)return;
  const startMap=loadedMap,startRevision=editRevision;
  const folderIds=new Set(folders.flatMap(id=>[...folderBranch(library,id)]));
  ids=[...new Set([...ids,...library.assets.filter(a=>folderIds.has(a.folderId)).map(a=>a.id)])];
  if(!ids.length&&!folderIds.size)return;
  const targets=new Set(ids);
  try {
    if(!api.fs.listProjectDir)throw Error('当前宿主无法检查所有地图引用，未删除资源。');
    const references=[];
    if(scene.instances.some(i=>targets.has(i.assetId)))references.push(`Map${String(loadedMap).padStart(3,'0')}（当前）`);
    for(const filename of await api.fs.listProjectDir('Data/MakerStudioPseudo3D')){
      if(!/^Map\d+\.json$/i.test(filename)||Number(filename.match(/\d+/)[0])===loadedMap)continue;
      const data=JSON.parse(await api.fs.readProjectFile('Data/MakerStudioPseudo3D/'+filename));
      if((data.instances||[]).some(i=>targets.has(i.assetId)))references.push(filename);
    }
    if(references.length){api.ui.showToast({message:`资源仍被地图引用：${references.join('、')}。先删除对应场景物件后再删除资源。`,level:'warning'});return;}
    const ok=await confirmResourceAction({title:'删除资源',message:`将 ${folderIds.size?folderIds.size+' 个文件夹及其中的 ':''}${ids.length} 个资源移入系统回收站？独占模型及贴图一同移入，共享文件保留。Ctrl+Z 可撤销。`,danger:true});
    if(!ok)return;
    if(startMap!==loadedMap||startRevision!==editRevision){api.ui.showToast({message:'资源已变更，请重新选择要删除的资源',level:'info'});return;}
    // Recheck the live scene after the asynchronous confirmation.
    if(scene.instances.some(i=>targets.has(i.assetId)))return;
    await recycleResourceOperation({operation:'delete',ids,folderIds:[...folderIds]},result=>{
      commitHistory({label:'删除资源',external:'recycle',bundle:result.bundle,ids:[...ids],folderIds:[...folderIds],
        activeAsset,activeResourceFolder,resourceIds:resourceIds(),resourceFolderIds:selectedResourceFolders()});
    });
    for(const id of folderIds)resourceFolderSelection.delete(id);
    if(folderIds.has(activeResourceFolder))activeResourceFolder=null;
    for(const id of ids)resourceSelection.delete(id);
    if(targets.has(activeAsset))activeAsset=resourceIds()[0]||null;
    clearRenderCaches();rebuild();
  }catch(error){api.ui.showToast({message:String(error.message||error),level:'error'});}
}

async function recycleResourceOperation(request,complete){
  const title=request.operation==='restore'?'正在从系统回收站恢复':'正在移入系统回收站';
  const progress=(workspace?.showDialog||api.ui.showCustomDialog)({title,width:420,height:120,
    render(host){host.append(element('p','ms-resource-confirm','正在处理模型文件…'));},onCloseRequest(){}});
  try{
    finishSceneEdit();clearSceneGhost();await save();
    let release;resourceRecycleBusy=new Promise(resolve=>{release=resolve;});
    try{
      const changed=await runResourceRecycle(api,invoke(),request);
      library=normalizeLibrary(changed.library);editRevision++;dirty=false;
      complete(changed.result);
      clearRenderCaches();rebuild();
    }finally{const pending=release;resourceRecycleBusy=null;pending();}
  }finally{progress?.close();}
}
async function restoreResourceHistory(entry,target){
  const undoing=target===historyRedo;
  try{
    await recycleResourceOperation(undoing?{operation:'restore',bundle:entry.bundle}:{operation:'delete',ids:entry.ids,folderIds:entry.folderIds},result=>{
      if(!undoing)entry.bundle=result.bundle;
      target.push(entry);
      resourceSelection.clear();resourceFolderSelection.clear();
      if(undoing){for(const id of entry.resourceIds)if(assetById(id))resourceSelection.add(id);for(const id of entry.resourceFolderIds)if(folderById(library,id))resourceFolderSelection.add(id);}
      activeAsset=undoing&&assetById(entry.activeAsset)?entry.activeAsset:null;
      activeResourceFolder=undoing&&folderById(library,entry.activeResourceFolder)?entry.activeResourceFolder:null;
    });
  }catch(error){
    // Keep the failed entry so emptying the Recycle Bin or a transient file
    // conflict cannot silently consume unrelated history.
    (undoing?historyUndo:historyRedo).push(entry);refreshWorkspace();
    api.ui.showToast({message:`回收站操作失败：${error.message||error}`,level:'error'});
    return false;
  }
}

function dissolveResourceFolders(){
  const ids=selectedResourceFolders();if(!ids.length)return;
  transact('解散资源文件夹',()=>{
    for(const id of [...ids].sort((a,b)=>folderPath(library,b).length-folderPath(library,a).length)){
      const folder=folderById(library,id);if(!folder)continue;
      for(const child of library.folders)if(child.parentId===id){child.parentId=folder.parentId;child.name=uniqueFolderName(library,child.name,folder.category,folder.parentId,child.id);}
      for(const asset of library.assets)if(asset.folderId===id)asset.folderId=folder.parentId;
      library.folders=library.folders.filter(f=>f.id!==id);
    }
  },true);resourceFolderSelection.clear();activeResourceFolder=null;rebuild();
}

function resourceMenuEntries() {
  const ids=resourceIds(),folders=selectedResourceFolders(),has=!!(ids.length+folders.length),one=ids.length+folders.length===1,a=ids.length===1?assetById(ids[0]):null,folder=folders.length===1?folderById(library,folders[0]):null;
  return [
    {label:'新建文件夹  Ctrl+Shift+N',run:()=>newResourceFolder()},
    {label:'新建山体文件夹',run:()=>newResourceFolder('mountain')},null,
    {label:'复制  Ctrl+C',disabled:!has,run:()=>resourceCopy()},
    {label:'剪切  Ctrl+X',disabled:!has,run:()=>resourceCopy(true)},
    {label:'粘贴  Ctrl+V',disabled:!resourceClipboard,run:resourcePaste},
    {label:'创建副本  Ctrl+D',disabled:!has,run:duplicateResources},
    null,{label:'重命名  F2',disabled:!one,run:renameResource},
    {label:'移动到分类…',disabled:!has,run:moveResources},
    ...(folder?[{label:'打开文件夹',run:()=>workspace?.navigateFolder(folder.category,folder.id)},
      {label:folder.kind==='mountain'?'批量纹理…':'设为山体文件夹',run:()=>{if(folder.kind!=='mountain')transact('设置山体文件夹',()=>folderById(library,folder.id).kind='mountain',true);activeResourceFolder=folder.id;activeAsset=null;selected=null;refreshWorkspace();}},
      {label:'解散文件夹',run:dissolveResourceFolders}]:[]),
    ...(folder?.kind==='mountain'?[{label:'设为普通文件夹',run:()=>transact('设置普通文件夹',()=>folderById(library,folder.id).kind='folder',true)}]:[]),
    {label:a?.favorite?'取消收藏':'收藏资源',disabled:!ids.length,run:()=>{
      const favorite=!a?.favorite;transact('收藏资源',()=>{for(const id of ids)assetById(id).favorite=favorite;},true);
    }},
    {label:'属性',disabled:!one,run:()=>{selected=null;activeAsset=ids[0]||null;activeResourceFolder=folders[0]||null;sceneTool='select';refreshWorkspace();}},
    null,{label:'删除  Delete',disabled:!has,run:()=>deleteResources()},
    null,{label:'导入 OBJ…',run:importObj},{label:'导入立牌…',run:importBillboard}
  ];
}

function openResourceMenu(event, id = null,folderId=null) {
  hierarchyMenu?.close();
  if(folderId){if(!resourceFolderSelection.has(folderId))selectResourceFolder(folderId);else {activeResourceFolder=folderId;activeAsset=null;selected=null;refreshWorkspace();}}
  if(id && !resourceSelection.has(id)){selectResource(id);sceneTool='select';refreshWorkspace();}
  updateResourceCards();resourceMenu?.open(event,resourceMenuEntries());
}

function resourceShortcut(event) {
  if(!event.target?.closest?.('.ms-project,.ms-resource-menu[data-menu-kind="resource"]'))return false;
  if(event.target.closest('input,textarea,select,[contenteditable="true"]'))return false;
  const key=event.key.toLowerCase(), ctrl=event.ctrlKey||event.metaKey;
  if(ctrl&&event.shiftKey&&key==='n')newResourceFolder();
  else if(ctrl&&key==='c')resourceCopy();
  else if(ctrl&&key==='x')resourceCopy(true);
  else if(ctrl&&key==='v')resourcePaste();
  else if(ctrl&&key==='d')duplicateResources();
  else if(ctrl&&key==='a'){
    resourceSelection.clear();resourceFolderSelection.clear();for(const card of document.querySelectorAll('.ms-project .msp3d-asset'))resourceSelection.add(card.dataset.assetId);for(const card of document.querySelectorAll('.ms-project .ms-resource-folder'))resourceFolderSelection.add(card.dataset.folderId);updateResourceCards();
  }else if(key==='f2')renameResource();
  else if(key==='delete')deleteResources();
  else if(key==='escape'){resourceClipboard=resourceClipboard?.kind==='cut'?null:resourceClipboard;resourceMenu?.close();updateResourceCards();}
  else return false;
  return true;
}

function removeSelected() {
  if(workspace){removeSceneNodes();return;}
  if (!selectedInstance() || nodeFlag(scene,selected,'locked')) return;
  transact("删除伪 3D 物件", () => {
    scene.instances = scene.instances.filter((instance) => instance.id !== selected);
  });
  selected = null;
  rebuild();
}

function copyModel(cut = false) {
  pointerUp({button:0});
  const instance = selectedInstance();
  if (!instance || (cut && nodeFlag(scene,instance.id,'locked'))) return;
  modelClipboard = {mapId:loadedMap,instance:clone(instance)};
  if (cut) removeSelected();
}

function pasteModel() {
  if (!modelClipboard || loadingMap != null || Number(api.editor.activeMapId()) !== loadedMap) return;
  const source = modelClipboard.instance;
  if (!assetById(source.assetId)) return;
  const info = api.map.info?.(loadedMap);
  if (!info) return;
  pointerUp({button:0});
  const pointer = api.editor.pointer?.();
  const position = snapped(Number.isFinite(pointer?.worldX) && Number.isFinite(pointer?.worldY)
    ? {x:pointer.worldX,y:pointer.worldY} : {x:source.x+TILE_SIZE,y:source.y+TILE_SIZE});
  position.x = clamp(position.x,0,Math.max(0,(info.width-source.footprintW)*TILE_SIZE));
  position.y = clamp(position.y,0,Math.max(0,(info.height-source.footprintD)*TILE_SIZE));
  const parentId = modelClipboard.mapId === loadedMap && sceneNode(scene,source.parentId) &&
    !nodeFlag(scene,source.parentId,'locked') ? source.parentId : '';
  const instance = {...clone(source),...position,id:uid('p3d'),parentId,order:Date.now()};
  mode = 'select';placementPreview = null;drag = null;
  transact('粘贴伪 3D 物件',()=>{
    scene.instances.push(instance);selected=instance.id;activeAsset=instance.assetId;panelTab='instance';
  });
  disconnectPlacementOverlay?.redraw?.();
}

function setAssetField(assetId, field, value) {
  const current = assetById(assetId);
  if (!current || current[field] === value) return;
  transact("修改伪 3D 资源", () => {
    const asset = assetById(assetId);
    asset[field] = value;
    if(['pivotX','pivotY','pivotZ','rotationX','rotationY','rotationZ','pixelHeight','footprintW','footprintD'].includes(field)){asset.meshGroup='';asset.rotationGroup='';asset.variantRotation=0;}
    if(field==='category'&&folderById(library,asset.folderId)?.category!==value)asset.folderId='';
    if (field === "footprintW" || field === "footprintD") {
      for (const instance of scene.instances) {
        if (instance.assetId === assetId) instance[field] = value;
      }
    }
  }, true);
  clearRenderCaches();
  rebuild();
}

function setInstanceField(id, field, value) {
  const current = sceneNode(scene,id);
  if (!current || current[field] === value) return;
  if(workspace&&nodeFlag(scene,id,'locked')&&!['name','locked','editorVisible'].includes(field))return;
  transact("修改伪 3D 物件", () => {
    if(['x','y','rotation','scale','elevation'].includes(field)){
      const roots=(workspace&&sceneSelection.has(id)?selectionRoots():[id]).filter(root=>!nodeFlag(scene,root,'locked')),ids=new Set(roots.flatMap(root=>[...branchIds(scene,root)]));
      const originals=clone(sceneNodes(scene).filter(n=>ids.has(n.id)));transformBranch(scene,id,originals,{...current,[field]:value});
    }
    else sceneNode(scene,id)[field]=value;
  });
}

function element(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, handler, className = "", title = "") {
  const node = element("button", className, label);
  node.type = "button";
  node.title = title;
  node.addEventListener("click", handler);
  return node;
}

function numberField(label, value, min, max, step, onChange) {
  const row = element("label", "msp3d-field");
  row.append(element("span", "", label));
  const input = element("input");
  input.type = "number";
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.addEventListener("change", () => onChange(clamp(Number(input.value), Number(input.min), Number(input.max))));
  row.append(input);
  return row;
}

function checkboxField(label, checked, onChange) {
  const row = element("label", "msp3d-check");
  const input = element("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  row.append(input, element("span", "", label));
  return row;
}

function queueThumbnail(canvas){
  thumbnailQueue ||= createThumbnailQueue();
  thumbnailQueue.enqueue(canvas,()=>{if(canvas.__makerThumbnailVisible!==false&&!canvas.__makerThumbnailReady)canvas.__makerRenderThumbnail?.();});
}

function assetCard(asset) {
  const card = button("", event => {
    if(workspace){finishSceneEdit(true);selectResource(asset.id,event);setSceneTool(continuousPlacement&&sceneTool==='place'?'place':'select');updateResourceCards();return;}
    activeAsset = asset.id;
    if (mode !== "brush") mode = "place";
    placementPreview = null;
    modelLayer.select();
    rebuild();
  }, `msp3d-asset${activeAsset === asset.id ? " is-active" : ""}`, `放置 ${asset.name}`);
  const canvas = element("canvas", "msp3d-preview");
  // Paint the card immediately with a cheap placeholder. Heavy OBJ raster
  // generation is deferred until this card enters the visible panel area.
  drawAssetPreview(canvas, asset, null, null);
  const renderThumbnail = () => {
    if (!canvas.isConnected) return;
    const source = sourceFor(asset, asset.modular ? 45 : 0, 55, true);
    drawAssetPreview(canvas, asset, asset.type === "model" ? source : null,
      asset.type === "billboard" ? source : null);
    canvas.__makerThumbnailReady=true;
  };
  canvas.__makerAssetId=asset.id;
  canvas.__makerRenderThumbnail = renderThumbnail;
  if (typeof IntersectionObserver === "function") {
    assetPreviewObserver ||= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        entry.target.__makerThumbnailVisible=entry.isIntersecting;
        if (entry.isIntersecting)queueThumbnail(entry.target);
      }
    }, { rootMargin: "240px" });
    assetPreviewObserver.observe(canvas);
  } else {
    queueThumbnail(canvas);
  }
  const meta = element("div", "msp3d-asset-meta");
  meta.append(element("strong", "", `${asset.favorite ? '★ ' : ''}${asset.name}`), element("small", "", assetCategory(asset)));
  if(asset.modular)meta.append(element('small','',`${asset.footprintW}×${asset.footprintD} 格 · 高 ${Math.round(asset.pixelHeight/32*100)/100} 格`));
  card.append(canvas, meta);
  card.dataset.assetId=asset.id;
  card.classList.toggle('is-selected',resourceSelection.has(asset.id));
  card.classList.toggle('is-cut',resourceClipboard?.kind==='cut'&&resourceClipboard.ids.includes(asset.id));
  card.setAttribute('aria-selected',String(resourceSelection.has(asset.id)));
  card.addEventListener('contextmenu',event=>openResourceMenu(event,asset.id));
  card.draggable=true;
  card.addEventListener('dragstart',event=>{
    draggedAsset=asset.id;
    if(workspace)placementParentId=selectedSceneNode()?.id||'';
    if(!resourceSelection.has(asset.id))selectResource(asset.id);
    event.dataTransfer.setData('application/x-maker-asset',asset.id);
    event.dataTransfer.setData('application/x-maker-resource-items',JSON.stringify({assets:resourceIds(),folders:selectedResourceFolders()}));
    event.dataTransfer.effectAllowed='copyMove';
    // Keep the native drag image focused on the model itself.  The resource
    // card contains labels and controls, which made placement previews read
    // like a large tooltip instead of a piece being placed on the map.
    const dragImage=document.createElement('canvas');
    dragImage.className='msp3d-drag-model-preview';
    dragImage.style.cssText='position:fixed;left:-10000px;top:-10000px;pointer-events:none';
    const source=sourceFor(asset,asset.modular?45:0,55);
    drawAssetPreview(dragImage,asset,asset.type==='model'?source:null,asset.type==='billboard'?source:null);
    document.body.append(dragImage);
    event.dataTransfer.setDragImage(dragImage,68,46);
    card.__makerDragImage=dragImage;
  });
  card.addEventListener('dragend',()=>{draggedAsset=null;clearSceneGhost();card.__makerDragImage?.remove();card.__makerDragImage=null;});
  return card;
}

function renderAssetProperties(root, asset) {
  const section = element("section", "msp3d-section");
  const heading = element("div", "msp3d-section-heading");
  heading.append(element("strong", "", "资源属性"), button("删除", () => removeAsset(asset.id), "danger"));
  section.append(heading);
  const name = element("input");
  name.type = "text";
  name.value = asset.name;
  name.addEventListener("change", () => setAssetField(asset.id, "name", name.value.trim() || asset.name));
  const nameRow = element("label", "msp3d-field wide");
  nameRow.append(element("span", "", "名称"), name);
  section.append(nameRow);
  if(asset.type==='billboard')section.append(checkboxField('微风摆动',asset.wind===true,value=>setAssetField(asset.id,'wind',value)));
  const categoryRow=element('label','msp3d-field wide'),category=element('input'),choices=element('datalist');
  choices.id=`category-${asset.id}`;category.setAttribute('list',choices.id);category.value=assetCategory(asset);category.setAttribute('aria-label','资源分类');
  for(const c of catalogCategories(library.assets)){const option=element('option');option.value=c;choices.append(option);}
  category.onchange=()=>setAssetField(asset.id,'category',category.value.trim() || '未分类');
  categoryRow.append(element('span','','分类'),category,choices);section.append(categoryRow);
  const tagsRow=element('label','msp3d-field wide'),tags=element('input');tags.value=(asset.tags||[]).join('，');tags.placeholder='用逗号分隔';tags.setAttribute('aria-label','资源标签');
  tags.onchange=()=>setAssetField(asset.id,'tags',tags.value.split(/[,，]/).map(t=>t.trim()).filter(Boolean));
  tagsRow.append(element('span','','标签'),tags);section.append(tagsRow,checkboxField('收藏资源',asset.favorite,checked=>setAssetField(asset.id,'favorite',checked)));
  const grid = element("div", "msp3d-fields");
  grid.append(
    numberField("占地宽", asset.footprintW, 1, 32, 1, (value) => setAssetField(asset.id, "footprintW", Math.round(value))),
    numberField("占地深", asset.footprintD, 1, 32, 1, (value) => setAssetField(asset.id, "footprintD", Math.round(value))),
    numberField("显示高度", asset.pixelHeight, asset.modular ? 1 : 16, 768, 1, (value) => setAssetField(asset.id, "pixelHeight", Math.round(value)))
  );
  if (asset.type === "model") {
    grid.append(
      numberField("偏移量 X", asset.pivotX || 0, -10000, 10000, 0.01,
        (value) => setAssetField(asset.id, "pivotX", value)),
      numberField("偏移量 Y", asset.pivotY || 0, -10000, 10000, 0.01,
        (value) => setAssetField(asset.id, "pivotY", value)),
      numberField("偏移量 Z", asset.pivotZ || 0, -10000, 10000, 0.01,
        (value) => setAssetField(asset.id, "pivotZ", value)),
      ...['X', 'Y', 'Z'].map(axis => {
        const field = numberField(`旋转 ${axis}`, asset[`rotation${axis}`] || 0, -360, 360, 1,
          value => setAssetField(asset.id, `rotation${axis}`, value));
        field.title = '模型默认旋转角度（度）；Y 为竖直轴，放置角度在此基础上叠加';
        return field;
      })
    );
  }
  section.append(grid);
  root.append(section);
  if(asset.type==='model')renderTextureProperties(root,asset);
}

function showTextureImage(texture) {
  if(!texture?.image)return;
  let dialog=null;
  dialog=showResourceDialog({title:'纹理预览',width:600,height:600,render(host){
    const image=element('img');image.src=texture.image;image.alt='纹理预览';
    image.style.cssText='width:100%;height:90%;object-fit:contain;image-rendering:pixelated;background:repeating-conic-gradient(#444 0% 25%,#666 0% 50%) 50% / 16px 16px';
    host.append(image,element('div','',`${texture.width} × ${texture.height} · ${textureLabel(texture)}`));
    return ()=>{};
  },onCloseRequest:()=>dialog?.close()});
}

function textureLabel(texture){
  if(texture.name)return texture.name;
  if(!texture.path)return texture.id;
  const parts=texture.path.replaceAll('\\','/').split('/'),file=parts.pop();let family=parts.pop();if(family==='textures')family=parts.pop();
  return `${family?.replace(/^convex_/,'')||''}/${file}`;
}

function applyResourceTexture(assetId, slot, textureId, variant = false, imported = null) {
  const asset=assetById(assetId);if(!asset||(!imported&&!library.textures.some(t=>t.id===textureId)))return;
  const retainSelection=!variant&&selectedInstance()?.assetId===assetId?selected:null;
  if(!variant && slot===textureId)return;
  let nextId=assetId;
  transact(variant?'创建纹理变体':'替换模型纹理',()=>{
    if(imported)library.textures.push(imported);
    const source=variant?copyAsset(asset,library.assets):asset;
    const next=replaceTexture(source,slot,textureId);nextId=next.id;
    if(variant)library.assets.push(next);
    else library.assets[library.assets.findIndex(a=>a.id===assetId)]=next;
  },true);
  activeAsset=nextId;selected=retainSelection;resourceSelection.clear();resourceSelection.add(nextId);
  clearRenderCaches();rebuild();updateResourceCards();
}

async function importResourceTexture(assetId, slot, variant) {
  const startMap=loadedMap;
  try{
    const texture=await readResourceTexture();if(!texture)return;
    if(startMap!==loadedMap||!assetById(assetId))throw Error('地图或资源已切换，请重新选择资源导入纹理。');
    applyResourceTexture(assetId,slot,texture.id,variant,texture);
  }catch(error){api.ui.showToast({message:String(error.message||error),level:'error'});}
}

function renderTextureProperties(root, asset) {
  const section=element('section','msp3d-section');section.append(element('strong','','材质'));
  if(!asset.uvs.length)section.append(element('div','msp3d-help','缺少 UV'));
  const slots=[...new Set(asset.faces.map(f=>f.texture||''))];
  for(const [index,slot] of slots.entries()){
    const row=element('div','ms-texture-row'),current=library.textures.find(t=>t.id===slot),image=element('img'),info=element('small'),picker=element('select');
    image.alt='纹理缩略图';
    row.append(element('strong','',`材质 ${index}`));
    const blank=element('option','','选择已有纹理…');blank.value='';picker.append(blank);
    for(const t of library.textures){const option=element('option','',`${textureLabel(t)} · ${t.width}×${t.height}`);option.value=t.id;picker.append(option);}
    picker.value=slot;picker.setAttribute('aria-label','替换纹理选择');
    const preview=()=>{const t=library.textures.find(t=>t.id===picker.value);image.hidden=!t?.image;if(t?.image)image.src=t.image;else image.removeAttribute('src');info.textContent=t?`${t.width} × ${t.height} · ${asset.faces.filter(f=>(f.texture||'')===slot).length} 个面`:'选择 PNG/JPG 纹理';};
    picker.onchange=preview;image.onclick=()=>showTextureImage(library.textures.find(t=>t.id===picker.value));
    const actions=element('div','ms-texture-actions');
    actions.append(button('应用',()=>applyResourceTexture(asset.id,slot,picker.value),'','更新此资源的材质'),
      button('创建变体',()=>applyResourceTexture(asset.id,slot,picker.value,true),'','复制模型并应用所选纹理'),
      button('选择文件…',()=>importResourceTexture(asset.id,slot,false),'','从 PNG 或 JPG 文件替换纹理'));
    const inputRow=element('label','ms-texture-input');inputRow.append(element('span','','主纹理'),picker);
    if(!asset.uvs.length)for(const b of actions.children)b.disabled=true;
    row.append(image,info,inputRow,actions);section.append(row);preview();
  }
  root.append(section);
}

function renderFolderInspector(root,folder){
  const section=element('section','msp3d-section');section.append(element('strong','',folder.kind==='mountain'?'山体文件夹':'文件夹'));
  const name=element('input');name.value=folder.name;name.setAttribute('aria-label','文件夹名称');name.onchange=()=>{if(!name.value.trim())return;transact('重命名资源文件夹',()=>{const current=folderById(library,folder.id);current.name=uniqueFolderName(library,name.value.trim(),current.category,current.parentId,current.id);},true);};
  const row=element('label','msp3d-field');row.append(element('span','','名称'),name);section.append(row,element('small','ms-folder-batch-summary',`${folderAssets(library,folder.id).length} 个资源 · ${folder.category}`));
  const actions=element('div','ms-folder-texture-actions');actions.append(button('打开',()=>workspace?.navigateFolder(folder.category,folder.id)),button('新建文件夹',()=>newResourceFolder()),button('重命名',renameResource));
  section.append(actions);root.append(section);if(folder.kind!=='mountain')return;
  const models=folderAssets(library,folder.id).filter(a=>a.type==='model'),slots=folderTextureSlots(library,folder.id),pending={},imports=[],stagedImages=new Map(),controls=[];
  const batch=element('section','msp3d-section'),summary=element('small','ms-folder-batch-summary'),batchActions=element('div','ms-folder-texture-actions');batch.append(element('strong','','山体纹理'),summary,batchActions);root.append(batch);
  const previews=element('div','ms-folder-model-previews'),samples=models.slice(0,3).map(asset=>{const canvas=element('canvas','msp3d-preview');canvas.title=asset.name;previews.append(canvas);return {asset,canvas};});batch.append(previews);
  const paint=()=>{for(const {asset,canvas} of samples){const next={...asset,faces:asset.faces.map(f=>({...f,texture:Object.hasOwn(pending,f.texture||'')?pending[f.texture||'']:f.texture}))},textures=textureImages(next);for(const [id,img] of stagedImages)textures.set(id,img);drawAssetPreview(canvas,next,renderModel(next,45,textures,55));}};
  previews.__makerRedraw=paint;
  const update=()=>{const affected=models.filter(a=>a.faces.some(f=>Object.hasOwn(pending,f.texture||'')&&pending[f.texture||'']!==(f.texture||''))).length;summary.textContent=`${models.length} 个模型 · ${slots.length} 张纹理${affected?' · 将更新 '+affected+' 个模型':''}`;apply.disabled=!affected;paint();};
  const commit=(variant=false)=>{
    if(!folderById(library,folder.id))return;
    const replacements=Object.fromEntries(Object.entries(pending).filter(([source,target])=>source!==target));if(!variant&&!Object.keys(replacements).length)return;
    let nextFolder=folder.id,changed=[];
    transact(variant?'创建山体变体':'批量替换山体纹理',()=>{
      for(const texture of imports)if(Object.values(replacements).includes(texture.id)&&!library.textures.some(t=>t.id===texture.id))library.textures.push(texture);
      if(variant){const added=pasteLibraryItems(library,copyLibraryItems(library,[],[folder.id]),folder.category,folder.parentId);nextFolder=added.folders[0];}
      changed=replaceFolderTextures(library,nextFolder,replacements);
    },true);
    activeResourceFolder=nextFolder;resourceFolderSelection.clear();resourceFolderSelection.add(nextFolder);clearRenderCaches();rebuild();updateResourceCards();api.ui.showToast({message:variant?'已创建山体变体':`已更新 ${changed.length} 个模型`,level:'info'});
  };
  const apply=button('应用全部',()=>commit());apply.dataset.folderTextureApply='';batchActions.append(apply,button('创建山体变体',()=>commit(true)));
  for(const [index,slot] of slots.entries()){
    const row=element('div','ms-texture-row'),image=element('img'),info=element('small'),picker=element('select'),current=library.textures.find(t=>t.id===slot.id);row.dataset.folderTexture=slot.id;
    row.append(element('strong','',`材质 ${index}`));image.alt='山体纹理预览';picker.setAttribute('aria-label',`山体纹理 ${index}`);
    if(!slot.id){const blank=element('option','','无纹理');blank.value='';picker.append(blank);}
    for(const t of library.textures){const option=element('option','',`${textureLabel(t)} · ${t.width}×${t.height}`);option.value=t.id;picker.append(option);}picker.value=slot.id;
    const preview=()=>{const texture=[...library.textures,...imports].find(t=>t.id===picker.value);image.hidden=!texture?.image;if(texture?.image)image.src=texture.image;else image.removeAttribute('src');info.textContent=`${fileName(current?.path||slot.id)||'无纹理'} · ${slot.assetIds.length} 个模型`;row.classList.toggle('ms-folder-pending',picker.value!==slot.id);};
    const choose=textureId=>{const texture=imports.find(t=>t.id===textureId);if(texture&&![...picker.options].some(o=>o.value===textureId)){const option=element('option','',texture.label||`${texture.width}×${texture.height}`);option.value=textureId;picker.append(option);}picker.value=textureId;for(const source of slot.ids){if(textureId===slot.id)delete pending[source];else pending[source]=textureId;}preview();};controls.push(choose);
    picker.onchange=()=>{if(!picker.value&&slot.id)return;choose(picker.value);update();};image.onclick=()=>showTextureImage([...library.textures,...imports].find(t=>t.id===picker.value));
    const field=element('label','ms-texture-input');field.append(element('span','','主纹理'),picker);
    const actions=element('div','ms-texture-actions');actions.append(button('选择文件…',async()=>{const map=loadedMap;try{const texture=await readResourceTexture();if(!texture)return;if(map!==loadedMap||!folderById(library,folder.id)||!row.isConnected)return;imports.push(texture);const img=new Image();img.onload=paint;img.src=texture.image;stagedImages.set(texture.id,img);choose(texture.id);update();}catch(error){api.ui.showToast({message:error.message,level:'error'});}}),button('用于全部',()=>{if(!picker.value)return;for(const choose of controls)choose(picker.value);update();},'','预览所有材质使用这张纹理'));
    row.append(image,info,field,actions);batch.append(row);preview();
  }
  update();
}

async function readResourceTexture(){
  const path=await chooseFile([{name:'纹理图片',extensions:['png','jpg','jpeg']}]);if(!path)return null;
  const bytes=await readBinaryFile(path);if(bytes.length>12*1024*1024)throw Error('纹理不能超过 12 MB。');
  const bitmap=await createImageBitmap(new Blob([bytes],{type:mimeFor(path)})),width=bitmap.width,height=bitmap.height;bitmap.close?.();if(width>8192||height>8192)throw Error('纹理边长不能超过 8192 像素。');
  return {id:uid('texture'),path:'',width,height,image:`data:${mimeFor(path)};base64,${bytesToBase64(bytes)}`,name:fileName(path),label:fileName(path)};
}

function renderInstanceProperties(root, instance) {
  const asset = assetById(instance.assetId);
  const section = element("section", "msp3d-section");
  section.dataset.sceneInstance=instance.id;
  const transformField=(key,...args)=>{const row=numberField(...args);row.querySelector('input').dataset.sceneTransform=key;return row;};
  const heading = element("div", "msp3d-section-heading");
  heading.append(element("strong", "", `已选：${nodeName(instance)}`), button("删除", removeSelected, "danger"));
  section.append(heading);
  const grid = element("div", "msp3d-fields");
  const nameRow=element('label','msp3d-field'),nameInput=element('input');nameInput.value=nodeName(instance);nameInput.setAttribute('aria-label','场景名称');nameInput.onchange=()=>setInstanceField(instance.id,'name',nameInput.value.trim()||nodeName(instance));nameRow.append(element('span','','名称'),nameInput);section.append(nameRow);
  grid.append(
    transformField('x',"地图 X", instance.x / TILE_SIZE, 0, 9999, 0.5, value => setInstanceField(instance.id, "x", value * TILE_SIZE)),
    transformField('y',"地图 Y", instance.y / TILE_SIZE, 0, 9999, 0.5, value => setInstanceField(instance.id, "y", value * TILE_SIZE)),
    transformField('rotation',"旋转角度", instance.rotation, 0, 359, 15, (value) => setInstanceField(instance.id, "rotation", normalizeAngle(value))),
    transformField('scale',"缩放", instance.scale, 0.1, 8, 0.1, (value) => setInstanceField(instance.id, "scale", value))
  );
  if(!instance.group)grid.append(numberField("透明度", instance.opacity, 0, 255, 1, (value) => setInstanceField(instance.id, "opacity", Math.round(value))));
  section.append(grid);
  if(instance.group){
    section.append(checkboxField('静态模型合批',instance.batch===true,value=>setSceneNodeFlag(instance.id,'batch',value)));
    section.append(element('p','','保存后重新进入地图生效。模型和静态图片立牌按同一深度、地面高度和小区域分别合批，仍可单独编辑。风动、光源及半透明物体保持独立；转动游戏相机时立牌自动恢复独立绘制。'));
  }
  if(!instance.group)section.append(checkboxField("启用占地碰撞", instance.collision, (value) => setInstanceField(instance.id, "collision", value)),
    checkboxField("游戏中可见", instance.visible, (value) => setInstanceField(instance.id, "visible", value)));
  if(!instance.group && asset?.type==='model') {
    const ground=modelBaseHeight(previewTerrain,{...instance,elevation:0});
    section.append(transformField('height','模型高度',ground+(instance.elevation||0),ground-2048,ground+2048,8,value=>{
      const current=sceneNode(scene,instance.id);if(!current)return;
      setInstanceField(instance.id,'elevation',clamp(value-modelBaseHeight(previewTerrain,{...current,elevation:0}),-2048,2048));
    }));
    section.append(checkboxField('允许在模型上行走',instance.walkable===true,value=>setInstanceField(instance.id,'walkable',value)));
    const field=checkboxField('允许播放动画',!!asset.animation&&instance.animationEnabled!==false,value=>setInstanceField(instance.id,'animationEnabled',value));
    field.querySelector('input').disabled=!asset.animation;
    if(asset.animation)section.append(numberField('动画速度（倍）',instance.animationSpeed??1,0.1,4,0.1,value=>setInstanceField(instance.id,'animationSpeed',Math.max(0.1,Math.min(4,value)))));
    section.append(field);
  }
  if(asset?.type==='billboard'){
    section.append(checkboxField('微风摆动',instance.wind??asset.wind,value=>setInstanceField(instance.id,'wind',value)),
      button('使用资源的微风设置',()=>setInstanceField(instance.id,'wind',null)));
  }
  if(!instance.group){
    const light=normalizeLight(instance.light),change=(key,value)=>setInstanceField(instance.id,'light',{...light,[key]:value});
    section.append(checkboxField('作为动态光源',light.enabled,value=>change('enabled',value)));
    if(light.enabled){
      const typeRow=element('label','msp3d-field'),type=element('select');
      for(const [value,label] of [['point','点光源'],['street','路灯（向下锥形）']]){const o=element('option','',label);o.value=value;type.append(o);}
      type.value=light.type;type.onchange=()=>change('type',type.value);typeRow.append(element('span','','光源类型'),type);section.append(typeRow);
      const row=element('label','msp3d-field'),color=element('input');color.type='color';color.value=light.color;
      color.onchange=()=>change('color',color.value);row.append(element('span','','灯光颜色'),color);section.append(row);
      for(const [key,label,min,max,step] of [['radius','照明半径',8,640,8],['height','灯光高度',0,512,8],['intensity','灯光强度',0,3,.05],['breath','呼吸幅度',0,.5,.01],['period','呼吸周期（秒）',.5,30,.5]])
        section.append(numberField(label,light[key],min,max,step,value=>change(key,value)));
      for(const [key,label] of [['offsetX','灯头 X 微调（右为正）'],['offsetY','灯头 Y 微调（地图下为正）'],['offsetZ','灯头高度微调']])
        section.append(numberField(label,light[key],-256,256,1,value=>change(key,value)));
      if(light.type==='street'){
        for(const [key,label,min,max] of [['tilt','照射前倾角（0 为垂直）',-75,75],['heading','前倾方向（0 下 / 90 右）',-360,360]])
          section.append(numberField(label,light[key],min,max,1,value=>change(key,value)));
        for(const [key,label,min,max,step] of [['coneAngle','光柱张角（度）',10,140,1],['softness','边缘柔和度',.01,1,.05],['beam','光柱透明度（0 为隐藏）',0,1,.01]])
          section.append(numberField(label,light[key],min,max,step,value=>change(key,value)));
        section.append(element('small','','高度相对脚下地面，单位为像素。照明半径从灯头计算，需大于高度才能照到地面。光柱透明度不影响表面照明。'));
      }
    }
  }
  const turns = element("div", "msp3d-turns");
  turns.append(
    button("↶ 15°", () => setInstanceField(instance.id, "rotation", normalizeAngle(instance.rotation - 15))),
    button("↷ 15°", () => setInstanceField(instance.id, "rotation", normalizeAngle(instance.rotation + 15)))
  );
  section.append(turns);
  root.append(section);
}

function syncSceneInspector() {
  for(const section of document.querySelectorAll('[data-scene-instance]')){
    const node=sceneNode(scene,section.dataset.sceneInstance);if(!node)continue;
    const instance=previewInstance(node);
    for(const input of section.querySelectorAll('input[data-scene-transform]')){
      if(input===document.activeElement)continue;
      const key=input.dataset.sceneTransform;
      const value=key==='height'?modelBaseHeight(previewTerrain,instance):['x','y'].includes(key)?instance[key]/TILE_SIZE:instance[key];
      const text=String(Number(value.toFixed(3)));if(input.value!==text)input.value=text;
      if(key==='height'){
        const ground=modelBaseHeight(previewTerrain,{...instance,elevation:0});
        input.min=String(ground-2048);input.max=String(ground+2048);
      }
    }
  }
}

function redrawPreviews() {
  if(previewAnimationTimer!=null){clearTimeout(previewAnimationTimer);previewAnimationTimer=null;}
  if (previewFrame != null) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = null;
    const now = performance.now();
    // Coalesce high-frequency input, retaining a pending frame when throttled.
    if (camera.interacting && now - previewLastFrameAt < 16) { redrawPreviews(); return; }
    previewLastFrameAt = now;
    syncSceneInspector();
    // A modal preview leaves the small panel canvas mounted underneath it.
    // Rendering both scenes on every pointer move doubles the work while the
    // hidden canvas cannot be seen.
    const canvases = previewDialogCanvas?.isConnected
      ? [previewDialogCanvas]
      : [...document.querySelectorAll('.msp3d-scene-preview')];
    for (const canvas of canvases) if (canvas.isConnected) drawScenePreview(canvas);
    if(api && !document.hidden && canvases.some(c=>c.isConnected) &&
      visibleInstances().some(i=>i.animationEnabled!==false && assetById(i.assetId)?.animation)) {
      previewAnimationTimer=setTimeout(()=>{previewAnimationTimer=null;redrawPreviews();},66);
    }
  });
}

async function refreshSceneSnapshot() {
  if (!api || loadedMap == null || !snapshotReader || previewRefreshInFlight) return;
  previewRefreshInFlight = true;
  const serial = ++previewRefreshSerial, mapId = loadedMap, revision = previewSnapshotRevision, mapRevision = previewMapRevision;
  try {
    const liveTerrain = api.commands?.list().includes('terrain.snapshot')
      ? await api.commands.execute('terrain.snapshot', mapId) : null;
    const terrainData = liveTerrain || await readJson('Data/MakerStudioTerrain/Map' + String(mapId).padStart(3, '0') + '.json', { cells: {}, heightStep: 16 });
    const snapshot = !mapSnapshot || capturedMapRevision !== mapRevision
      ? await snapshotReader.capture(mapId) : mapSnapshot;
    if (serial !== previewRefreshSerial || mapId !== loadedMap || !api) return;
    previewTerrain = terrainData;
    mapSnapshot = snapshot;
    capturedMapRevision = mapRevision;
    previewSnapshotDirty = revision !== previewSnapshotRevision;
    snapshotMessage = snapshot ? '' : '当前地图尚未就绪';
    redrawPreviews();
  } catch (error) {
    if(mapId!==loadedMap||!api)return;
    snapshotMessage = '地图预览读取失败：' + (error.message || error);
    previewSnapshotDirty=revision!==previewSnapshotRevision;
    api?.log.warn?.(snapshotMessage);
    redrawPreviews();
  } finally {
    previewRefreshInFlight = false;
    const previewVisible = previewDialogCanvas?.isConnected || document.querySelector('.msp3d-scene-preview');
    if (previewSnapshotDirty && previewVisible && !previewRefreshTimer) {
      previewRefreshTimer = setTimeout(() => { previewRefreshTimer = null; refreshSceneSnapshot(); }, 150);
    }
  }
}

function scheduleSceneRefresh(event) {
  if (event?.detail?.mapId != null && Number(event.detail.mapId) !== loadedMap) return;
  previewSnapshotDirty = true;
  previewSnapshotRevision++;
  if (event?.type !== 'mst:changed') previewMapRevision++;
  if (!previewDialogCanvas?.isConnected && !document.querySelector('.msp3d-scene-preview')) return;
  if (previewRefreshTimer) clearTimeout(previewRefreshTimer);
  previewRefreshTimer = setTimeout(() => { previewRefreshTimer = null; refreshSceneSnapshot(); }, 150);
}

function drawScenePreview(canvas) {
  const instances=visibleInstances().map(previewInstance);
  const ghost=canvas===previewDialogCanvas?sceneGhost:null;
  if(canvas===previewDialogCanvas&&sceneEdit?.brush)instances.push(...sceneEdit.brush.pending);
  if(ghost&&!sceneEdit?.rectangle&&(!sceneEdit?.brush||canPlaceInStroke(sceneEdit.brush,ghost.instance)))instances.push(ghost.instance);
  renderScene(canvas, { snapshot: mapSnapshot, terrain: previewTerrain, library,
    instances, selected, selectedIds:selectedSceneIds(), camera,
    sourceFor, texturesFor: textureImages, interactive: camera.interacting, message: snapshotMessage });
  const flags=hierarchyFlags(scene);canvas.__sceneHits=(canvas.__sceneHits||[]).filter(hit=>!flags.get(hit.id)?.locked);
  const movePreview=sceneEdit?.tool==='move'&&sceneEdit.changed?{instance:selectedSceneNode()}:null;
  if(canvas===previewDialogCanvas)drawSceneTools(canvas,{tool:sceneEdit?.selectionTool||effectiveSceneTool(),instance:selectedSceneNode(),ghost:ghost||movePreview,terrainGhost:effectiveSceneTool()==='terrain'?terrainGhost:null,hoveredId:hoveredSceneId,
    activeAxis:sceneEdit?.axis||sceneHandle,rotationDelta:sceneEdit?.tool==='rotate'&&sceneEdit.changed?sceneEdit.angleDelta:null,marquee:sceneEdit?.rect,
    placementRect:sceneEdit?.brush?.rectangle,
    heightAt:(x,y)=>terrainHeight(previewTerrain,x,y)});
}

function wireSceneCanvas(canvas) {
  for(const [old,dispose] of sceneInputs)if(!old.isConnected){dispose();sceneInputs.delete(old);}
  sceneInputs.set(canvas,connectSceneInput(canvas,camera,{redraw:redrawPreviews,focus:focusSceneSelection,
    editStart:event=>workspace&&canvas===previewDialogCanvas?startSceneEdit(canvas,event):false,
    editMove:event=>moveSceneEdit(canvas,event),editEnd:cancel=>finishSceneEdit(cancel),
    wheel:event=>workspace&&canvas===previewDialogCanvas?sceneWheel(event):false,
    hover:event=>{
      if(!workspace||canvas!==previewDialogCanvas)return;
      lastScenePointer=event;
      if(event.ctrlKey&&!controlSelect)setControlSelect(true);
      if(effectiveSceneTool()==='terrain'){updateTerrainGhost(canvas,event);canvas.style.cursor='crosshair';return;}
      if(sceneTool==='place'&&!controlSelect){updateSceneGhost(canvas,event);return;}
      const r=canvas.getBoundingClientRect(),axis=pickToolHandle(canvas.__toolHandles,(event.clientX-r.left)*canvas.width/r.width,(event.clientY-r.top)*canvas.height/r.height)?.axis||null;
      const hit=controlSelect?pickSceneHit(canvas,(event.clientX-r.left)*canvas.width/r.width,(event.clientY-r.top)*canvas.height/r.height)?.id||null:null;
      if(hit!==hoveredSceneId){hoveredSceneId=hit;redrawPreviews();}
      canvas.style.cursor=axis?'grab':'default';
      if(axis!==sceneHandle){sceneHandle=axis;redrawPreviews();}
    },
    leave:()=>{sceneHandle=null;hoveredSceneId=null;lastScenePointer=null;clearTerrainGhost();clearSceneGhost();redrawPreviews();},
    contextMenu:event=>{
      const rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/rect.width,y=(event.clientY-rect.top)*canvas.height/rect.height;
      const hit=pickSceneHit(canvas,x,y);
      if(hit)openHierarchyMenu(event,hit.id);
    },
    shortcut:sceneShortcut,
    select(event){
      const rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/rect.width,y=(event.clientY-rect.top)*canvas.height/rect.height;
      const hit=pickSceneHit(canvas,x,y);
      chooseSceneNode(hit?.id||null,event);
    }}));
}

function focusSceneSelection() {
  const instance=selectedSceneNode();
  if(instance&&camera.framing){
    const ids=branchIds(scene,instance.id),members=sceneNodes(scene).filter(n=>ids.has(n.id));
    const left=Math.min(...members.map(n=>n.x)),right=Math.max(...members.map(n=>n.x+n.footprintW*32));
    const top=Math.min(...members.map(n=>n.y)),bottom=Math.max(...members.map(n=>n.y+n.footprintD*32));
    const x=(left+right)/2,y=(top+bottom)/2;
    const low=Math.min(...members.map(n=>modelBaseHeight(previewTerrain,n)));
    const high=Math.max(...members.map(n=>modelBaseHeight(previewTerrain,n)+(assetById(n.assetId)?.pixelHeight||32)*n.scale));
    const radius=Math.max(high-low,right-left,bottom-top,32);
    camera.framing={...camera.framing,target:[x,y,(low+high)/2],distance:radius*2.5,span:radius*2.2};
  }else camera.framing=null;
  Object.assign(camera,{zoom:1,panX:0,panY:0});redrawPreviews();
}

function resetSceneCamera() {
  Object.assign(camera, { yaw: -35, pitch: 55, zoom: 1, panX: 0, panY: 0, framing: null }); redrawPreviews();
}

function sceneControls() {
  const controls = element('div', 'msp3d-preview-controls');
  const sync=()=>{
    for(const btn of document.querySelectorAll('.msp3d-preview-controls button[data-camera-field]')) {
      const active=camera[btn.dataset.cameraField]===btn.dataset.cameraValue;
      btn.classList.toggle('is-active',active);btn.setAttribute('aria-pressed',String(active));
    }
  };
  for (const value of ['2d','3d']) {
    const btn=button(value.toUpperCase(), () => {
    camera.mode = value;
    sync();redrawPreviews();
    }, camera.mode === value ? 'is-active' : '');
    btn.dataset.cameraField='mode';btn.dataset.cameraValue=value;controls.append(btn);
  }
  for(const [label,value] of [['正交','orthographic'],['透视','perspective']]) {
    const btn=button(label,()=>{camera.projection=value;camera.mode='3d';sync();redrawPreviews();},camera.projection===value?'is-active':'');
    btn.dataset.cameraField='projection';btn.dataset.cameraValue=value;controls.append(btn);
  }
  controls.append(button('适应全图', resetSceneCamera), button('刷新地图', () => {
    previewMapRevision++; previewSnapshotRevision++; previewSnapshotDirty = true;
    refreshSceneSnapshot();
  }));
  return controls;
}

function effectiveSceneTool(){return controlSelect?'select':sceneTool;}

function refreshWorkspace(){
  const flags=hierarchyFlags(scene);
  if(!selected)sceneSelection.clear();else if(!sceneSelection.has(selected)){sceneSelection.clear();sceneSelection.add(selected);}
  workspace?.refresh({tool:effectiveSceneTool(),mapId:loadedMap,selected,asset:activeAsset,revision:editRevision,dirty,
    effectsKey:JSON.stringify([effectsSync?.effective(scene.effects),effectsSync?.conflicts(),pbsError]),
    snap:sceneSnap,continuous:continuousPlacement,placementBrush,placementKey:`${placementRotation}:${placementScale}`,
    assetRevision:library,categories:catalogCategories(library.assets,library.folders),folder:activeResourceFolder,
    root:{id:SCENE_ROOT_ID,name:`场景 ${loadedMap==null?'':loadedMap}`.trim()},
    nodes:sceneNodes(scene).map(n=>({...n,name:nodeName(n),editorVisible:!flags.get(n.id)?.hidden,locked:!!flags.get(n.id)?.locked})),selectedIds:selected?selectedSceneIds():[SCENE_ROOT_ID],
    instances:scene.instances.map(i=>({...i,name:assetById(i.assetId)?.name||'缺失资源'}))});
}
function workspaceAssets(grid,query,filters={},folderCard){
  assetPreviewObserver?.disconnect();
  grid.replaceChildren();
  const nested=filters.folderId?folderAssets(library,filters.folderId):filters.category&&!query?library.assets.filter(a=>!a.folderId):library.assets;
  const matches=filterAssets(nested,{query,...filters});
  resourceCategory=filters.category||'';
  resourceFolder=filters.folderId||'';
  const folders=library.folders.filter(f=>f.parentId===resourceFolder&&(!resourceCategory||f.category===resourceCategory)&&(!query||f.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))&&!filters.favorites);
  if(folderCard)for(const folder of folders)grid.append(folderCard(folder));
  for(const asset of matches)grid.append(assetCard(asset));
  if(!matches.length&&!folders.length)grid.append(element('div','msp3d-empty','没有匹配的资源'));
  return matches.length+folders.length;
}
function revealSceneResource(assetId){
  const asset=assetById(assetId);if(!asset||!workspace)return;
  selectResource(asset.id);
  refreshWorkspace();
  workspace.revealAsset(asset.id,assetCategory(asset),asset.folderId||'');
}
function workspaceInspector(host){
  if(sceneTool==='terrain'&&!controlSelect){
    if(api.commands.list().includes('terrain.mountInspector')){
      let disposed=false,release=null;
      const mount=element('div');host.append(mount);
      Promise.resolve(api.commands.execute('terrain.mountInspector',mount)).then(fn=>{release=fn;if(disposed&&typeof release==='function')release();})
        .catch(error=>{if(!disposed)mount.textContent=`地形检查器加载失败：${error.message||error}`;});
      return ()=>{disposed=true;if(typeof release==='function')release();mount.remove();};
    }
    host.append(element('div','msp3d-help','请启用高低地形与斜坡插件。'));return;
  }
  const folder=folderById(library,activeResourceFolder);
  if(folder){renderFolderInspector(host,folder);compactInspector(host);return;}
  const instance=selectedSceneNode(),asset=assetById(activeAsset);
  if(sceneTool==='place'&&!controlSelect&&asset){
    const placement=element('section','msp3d-section'),fields=element('div','msp3d-fields');
    placement.append(element('strong','','放置'));
    fields.append(numberField('角度',placementRotation,0,359,15,value=>setPlacementTransform(value,placementScale)),
      numberField('缩放',placementScale,.1,8,.1,value=>setPlacementTransform(placementRotation,value)));
    placement.append(fields);host.append(placement);
  }
  if(instance){
    renderInstanceProperties(host,instance);
    const actions=element('div','ms-instance-actions'),model=assetById(instance.assetId);
    actions.append(button('复制物件 Ctrl+D',duplicateSceneSelection));
    if(instance.assetId){
      const reveal=button('在资源库查看',()=>revealSceneResource(instance.assetId),'ms-reveal-resource',model?'定位并选中此物件的资源':'资源已缺失');
      reveal.disabled=!model;actions.append(reveal);
    }
    host.append(actions);
    if(model?.type==='model')renderTextureProperties(host,model);
  }else if(asset){renderAssetInspector(host,asset);renderAssetProperties(host,asset);}
  else renderSceneEffects(host);
  compactInspector(host);
  if(instance&&nodeFlag(scene,instance.id,'locked'))for(const input of host.querySelectorAll('input:not([aria-label="场景名称"]),select,button:not(.ms-inspector-header-actions button):not(.ms-reveal-resource)'))input.disabled=true;
}
function renderSceneEffects(host){
  const section=element('section','msp3d-section'),fx=effectsSync?.effective(scene.effects)||normalizeEffects(scene.effects);
  section.append(element('strong','','场景渲染'));
  section.append(button('刷新 PBS',refreshPBSEffects));
  if(pbsError)section.append(element('small','',`PBS 读取失败：${pbsError}`));
  for(const key of effectsSync?.conflicts()||[]) {
    const conflict=element('div','msp3d-section');conflict.dataset.pbsConflict=key;
    conflict.append(element('small','',`${EFFECT_PROPERTIES[key]} 在两边都被修改，请选择：`),
      button('保留编辑器',()=>resolveEffectConflict(key,true)),button('采用 PBS',()=>resolveEffectConflict(key,false)));
    section.append(conflict);
  }
  const change=changeSceneEffect;
  const row=element('label','msp3d-field'),select=element('select');
  select.setAttribute('aria-label','画面风格');
  for(const [value,label] of [['none','原画'],['cartoon','明快卡通'],['hd2d','HD2D']]){const o=element('option','',label);o.value=value;select.append(o);}
  select.value=fx.preset;select.onchange=()=>change('preset',select.value);row.append(element('span','','画面风格'),select);section.append(row);
  section.append(checkboxField('动态场景照明',fx.lighting,value=>change('lighting',value)));
  for(const [key,label,min,max,step] of [['ambient','环境亮度',.1,1.5,.05],['maxLights','可见灯光上限',1,8,1],['strength','风格强度',0,1,.05],['bloom','泛光强度',0,.5,.01],['dof','景深强度',0,1,.05]])
    section.append(numberField(label,fx[key],min,max,step,value=>change(key,value)));
  if(pbsError||!effectsSync)for(const input of section.querySelectorAll('input,select'))input.disabled=true;
  section.append(element('small','','与 PBS/map_3d.txt 同步；保存只写回修改项。未设置项继承 Default 或场景值。画面效果需重启游戏查看。'));
  host.append(section);
}
async function saveWorkspace(){
  try{await save();if(api.commands.list().includes('terrain.save'))await api.commands.execute('terrain.save');
    if(api.commands.list().includes('object-canvas.save'))await api.commands.execute('object-canvas.save');
    refreshWorkspace();api.ui.showToast({message:'2.5D 场景、地形和物件数据已保存',level:'info'});
  }catch(error){api.ui.showToast({message:`保存失败：${error.message||error}`,level:'error'});}
}
function sceneHistory(redoHistory){
  finishSceneEdit();
  if(api.commands.list().includes('terrain.finishStroke'))api.commands.execute('terrain.finishStroke');
  pointerUp({button:0});
  return nativeHistory ? (redoHistory?nativeHistory.redo(loadedMap):nativeHistory.undo(loadedMap)) : (redoHistory?redo():undo());
}
function onTerrainHistory(event){
  if(Number(event.detail?.mapId)!==loadedMap)return;
  commitHistory({label:'地形绘制',external:'terrain'});
}
function sceneShortcut(event){
  if(event.isComposing)return false;
  const key=event.key.toLowerCase(),ctrl=event.ctrlKey||event.metaKey;
  if(key==='f2'){workspace?.renameNode(selected);return true;}
  if(ctrl&&key==='a'){activeResourceFolder=null;resourceFolderSelection.clear();sceneSelection.clear();for(const n of sceneNodes(scene))sceneSelection.add(n.id);selected=sceneNodes(scene).at(-1)?.id||null;refreshWorkspace();redrawPreviews();return true;}
  if(ctrl&&['c','x','v'].includes(key)){key==='v'?scenePaste():sceneCopy(key==='x');return true;}
  if(ctrl&&key==='s'){saveWorkspace();return true;}
  if(ctrl&&['z','y'].includes(key)){sceneHistory(key==='y'||event.shiftKey);return true;}
  if(ctrl&&key==='d'){duplicateSceneSelection();return true;}
  if(key==='delete'||key==='backspace'){removeSelected();return true;}
  if(!ctrl&&key==='f'){focusSceneSelection();return true;}
  if(!ctrl&&!event.altKey&&key==='c'){if(!event.repeat)toggleContinuousPlacement();return true;}
  if(!ctrl&&!event.altKey&&sceneTool==='place'&&['[',']'].includes(key)){
    setPlacementTransform(placementRotation+(key===']'?90:-90),placementScale);return true;
  }
  if(key==='escape'){finishSceneEdit(true);clearSceneGhost();setSceneTool('select');return true;}
  const tool={v:'select',r:'scale',b:'place',t:'terrain'}[key];
  if(!ctrl&&!event.altKey&&tool){setSceneTool(tool);return true;}
  return false;
}

function setSceneTool(value){
  clearTerrainGhost();
  if(value==='place'&&sceneTool!=='place')placementParentId=selectedSceneNode()?.id||'';
  finishSceneEdit();sceneTool=['move','rotate'].includes(value)?'select':value;sceneHandle=null;
  if(sceneTool==='place')continuousPlacement=true;
  if(value!=='place')clearSceneGhost();
  else selected=null;
  refreshWorkspace();redrawPreviews();
  if(sceneTool==='terrain')refreshTerrainGhost();
  else if(sceneTool==='place'&&lastScenePointer&&previewDialogCanvas)updateSceneGhost(previewDialogCanvas,lastScenePointer);
}

function sceneWheel(event){
  if(!event.altKey)return false;
  const delta=-Math.sign(event.deltaY)*(event.shiftKey?1:15);
  // The brush can retain a selected stamp after placing it. Its next preview
  // takes priority, so scrolling never rotates that already committed stamp.
  const placementAsset=draggedAsset||activeAsset;
  if((draggedAsset||effectiveSceneTool()==='place')&&!controlSelect&&assetById(placementAsset)){
    if(event.deltaY){
      setPlacementTransform(placementRotation+delta,placementScale);
      updateSceneGhost(previewDialogCanvas,event,placementAsset);
    }
    return true;
  }
  if(!selectedSceneNode())return false;
  const roots=selectionRoots().filter(id=>!nodeFlag(scene,id,'locked'));
  if(!roots.length||!event.deltaY)return true;
  transact('滚轮旋转',()=>{
    for(const id of roots){
      const ids=branchIds(scene,id),originals=clone(sceneNodes(scene).filter(n=>ids.has(n.id))),root=sceneNode(scene,id);
      transformBranch(scene,id,originals,{...root,rotation:normalizeAngle(root.rotation+delta)});
    }
  });
  refreshWorkspace();redrawPreviews();return true;
}

function toggleContinuousPlacement(value){
  finishSceneEdit(true);continuousPlacement=!continuousPlacement;
  if(typeof value==='boolean')continuousPlacement=value;
  if(continuousPlacement)setSceneTool('place');else{refreshWorkspace();redrawPreviews();}
}

function setPlacementTransform(rotation,scale){
  const ghost=sceneGhost;finishSceneEdit(true);
  placementRotation=normalizeAngle(rotation);placementScale=clamp(scale,.1,8);
  if(ghost)sceneGhost={...ghost,instance:{...ghost.instance,rotation:placementRotation,scale:placementScale}};
  refreshWorkspace();redrawPreviews();
}

function clearSceneGhost(){if(!sceneGhost)return;sceneGhost=null;workspace?.position(null);redrawPreviews();}

function updateSceneGhost(canvas,event,id=activeAsset){
  const point=sceneGround(canvas,event),asset=assetById(id);
  if(!point||!asset){clearSceneGhost();return null;}
  const rectangle=sceneTool==='place'&&placementBrush==='rectangle';
  const position=snapped(point,!rectangle&&(!sceneSnap||event.ctrlKey||event.metaKey)),info=api.map.info(loadedMap);
  position.x=clamp(position.x,0,Math.max(0,(info.width-asset.footprintW)*32));
  position.y=clamp(position.y,0,Math.max(0,(info.height-asset.footprintD)*32));
  const instance={id:'__preview_placement',assetId:id,parentId:placementParentId,...position,rotation:placementRotation,
    scale:placementScale,opacity:160,footprintW:asset.footprintW,footprintD:asset.footprintD,collision:false,visible:true};
  const changed=!sceneGhost||JSON.stringify(sceneGhost.instance)!==JSON.stringify(instance);
  sceneGhost={instance,point};workspace?.position(instance);
  if(changed)redrawPreviews();
  return sceneGhost;
}
function duplicateSceneSelection(){
  if(workspace){sceneCopy();scenePaste(selectedSceneNode()?.parentId||'');return;}
  const instance=selectedInstance();if(!instance)return;
  const copy={...clone(instance),id:uid('p3d'),x:instance.x+32,y:instance.y+32,order:Date.now()};
  transact('复制场景物件',()=>{scene.instances.push(copy);selected=copy.id;});
}
function clearTerrainGhost(){terrainPreviewSerial++;terrainGhost=null;}
async function updateTerrainGhost(canvas,event){
  const serial=++terrainPreviewSerial;
  if(!workspace||effectiveSceneTool()!=='terrain')return;
  const point=sceneGround(canvas,event);
  if(!point||!api.commands.list().includes('terrain.scenePreview')){terrainGhost=null;redrawPreviews();return;}
  try{
    const preview=await api.commands.execute('terrain.scenePreview',{mapId:loadedMap,worldX:point.x,worldY:point.y});
    if(serial!==terrainPreviewSerial||!workspace||effectiveSceneTool()!=='terrain')return;
    terrainGhost=preview;redrawPreviews();
  }catch{if(serial===terrainPreviewSerial){terrainGhost=null;redrawPreviews();}}
}
function refreshTerrainGhost(){if(lastScenePointer&&previewDialogCanvas?.isConnected)updateTerrainGhost(previewDialogCanvas,lastScenePointer);}
function eventRay(canvas,event){
  const r=canvas.getBoundingClientRect();return sceneRay(camera,event.clientX-r.left,event.clientY-r.top,r.width,r.height);
}
function sceneGround(canvas,event){
  const info=api.map.info?.(loadedMap);if(!info)return null;
  return pickTerrain(eventRay(canvas,event),sceneEdit?.terrain?sceneEdit.surface:previewTerrain,info.width*32,info.height*32);
}
function placeSceneAsset(canvas,event){
  const ghost=updateSceneGhost(canvas,event),asset=ghost&&assetById(ghost.instance.assetId);if(!asset)return;
  const instance={...ghost.instance,id:uid('p3d'),opacity:255,collision:asset.collisionDefault!==false,order:Date.now()};
  transact('放置场景物件',()=>{scene.instances.push(instance);selected=instance.id;});
  clearSceneGhost();
  // A resource drop is a single placement, independent of the active tool.
  // The brush retains its existing mode and continuous-placement setting.
  refreshWorkspace();redrawPreviews();
}
function startSceneEdit(canvas,event){
  if(event.ctrlKey)setControlSelect(true);
  const tool=effectiveSceneTool();
  if(tool==='select'){
    const r=canvas.getBoundingClientRect();
    const x=(event.clientX-r.left)*canvas.width/r.width,y=(event.clientY-r.top)*canvas.height/r.height;
    if(!pickSceneHit(canvas,x,y)&&!pickToolHandle(canvas.__toolHandles,x,y)){
      sceneEdit={marquee:true,x:event.clientX,y:event.clientY,beforeIds:selectedSceneIds(),beforeSelected:selected,
        additive:!!(event.ctrlKey||event.metaKey||event.shiftKey),rect:null};
      return true;
    }
  }
  if(tool==='place'){
    const rectangle=placementBrush==='rectangle',ghost=rectangle?updateSceneGhost(canvas,event):null;
    sceneEdit={placement:true,event,rectangle,rectangleStart:ghost?{...ghost.instance}:null,
      brush:continuousPlacement||rectangle?createPlacementStroke(visibleInstances(),assetById,{reserveFootprint:rectangle}):null};
    moveSceneEdit(canvas,event);return true;
  }
  if(tool==='terrain'){
    const point=sceneGround(canvas,event);if(!point||!api.commands.list().includes('terrain.sceneStroke'))return true;
    sceneEdit={terrain:true,surface:previewTerrain};api.commands.execute('terrain.sceneStroke','down',{mapId:loadedMap,worldX:point.x,worldY:point.y,button:0,buttons:1});lastScenePointer=event;updateTerrainGhost(canvas,event);return true;
  }
  const r=canvas.getBoundingClientRect(),x=(event.clientX-r.left)*canvas.width/r.width,y=(event.clientY-r.top)*canvas.height/r.height;
  // Gizmos are drawn over meshes; hit testing must use that same priority,
  // including when a large model covers every axis and the rotation ring.
  const directHit=pickSceneHit(canvas,x,y,selected);
  const handle=pickToolHandle(canvas.__toolHandles,x,y);
  // Keep the selected object when overlapping bounds would pick its neighbour.
  const hit=handle&&selected?{id:selected}:directHit;
  activeResourceFolder=null;resourceFolderSelection.clear();
  if(!hit){selected=null;refreshWorkspace();redrawPreviews();return true;}
  const toggleSelection=!!directHit&&!handle&&(event.ctrlKey||event.metaKey),wasSelected=sceneSelection.has(hit.id);
  selected=hit.id;const instance=selectedSceneNode();if(!instance||nodeFlag(scene,instance.id,'locked'))return true;if(instance.assetId)activeAsset=instance.assetId;
  if(!sceneSelection.has(selected)){if(!toggleSelection)sceneSelection.clear();sceneSelection.add(selected);}
  const editIds=new Set(selectionRoots().filter(id=>!nodeFlag(scene,id,'locked')).flatMap(id=>[...branchIds(scene,id)]));
  const cx=instance.x+instance.footprintW*16,cy=instance.y+instance.footprintD*16;
  const z=terrainHeight(previewTerrain,cx,cy)+(instance.elevation||0)+.5,point=rayPlane(eventRay(canvas,event),z),origin=canvas.__sceneProject?.(cx,cy,z);
  sceneEdit={id:selected,tool:handle?.axis==='rotation'?'rotate':tool==='select'?'move':tool,selectionTool:tool,
    deselectOnClick:toggleSelection&&wasSelected,axis:handle?.axis,worldRing:handle?.world,origin,
    startElevation:handle?.axis==='elevation'?rayElevation(eventRay(canvas,event),cx,cy):null,
    lastAngle:point?Math.atan2(point.y-cy,point.x-cx):null,angleDelta:0,
    original:clone(instance),originals:clone(sceneNodes(scene).filter(n=>editIds.has(n.id))),before:snapshot(),point,z,x:event.clientX,y:event.clientY,changed:false};
  refreshWorkspace();redrawPreviews();return true;
}
function moveSceneEdit(canvas,event){
  const edit=sceneEdit;if(!edit)return;
  if(edit.marquee){
    if(!edit.rect&&Math.hypot(event.clientX-edit.x,event.clientY-edit.y)<4)return;
    const r=canvas.getBoundingClientRect(),px=x=>clamp((x-r.left)*canvas.width/r.width,0,canvas.width),py=y=>clamp((y-r.top)*canvas.height/r.height,0,canvas.height);
    edit.rect={left:Math.min(px(edit.x),px(event.clientX)),right:Math.max(px(edit.x),px(event.clientX)),
      top:Math.min(py(edit.y),py(event.clientY)),bottom:Math.max(py(edit.y),py(event.clientY))};
    sceneSelection.clear();if(edit.additive)for(const id of edit.beforeIds)sceneSelection.add(id);
    for(const id of pickSceneRect(canvas,edit.rect))sceneSelection.add(id);
    selected=selectedSceneIds().at(-1)||null;activeResourceFolder=null;resourceFolderSelection.clear();
    refreshWorkspace();redrawPreviews();return;
  }
  if(edit.placement){
    edit.event=event;const ghost=updateSceneGhost(canvas,event);
    if(edit.rectangle){
      if(!edit.rectangleStart&&ghost)edit.rectangleStart={...ghost.instance};
      if(updatePlacementRectangle(edit.brush,edit.rectangleStart,ghost?.instance))redrawPreviews();
    }else if(edit.brush&&appendPlacementStroke(edit.brush,ghost?.instance,sceneSnap&&!event.ctrlKey&&!event.metaKey))redrawPreviews();
    return;
  }
  if(edit.terrain){const point=sceneGround(canvas,event);if(point)api.commands.execute('terrain.sceneStroke','move',{mapId:loadedMap,worldX:point.x,worldY:point.y,button:0,buttons:1});lastScenePointer=event;updateTerrainGhost(canvas,event);return;}
  const instance=sceneNode(scene,edit.id);if(!instance)return;
  const dx=event.clientX-edit.x,dy=event.clientY-edit.y;
  if(Math.hypot(dx,dy)<3&&!edit.changed)return;
  const snap=sceneSnap;
  if(edit.tool==='move'){
    if(edit.axis==='elevation'){
      const height=rayElevation(eventRay(canvas,event),edit.original.x+edit.original.footprintW*16,edit.original.y+edit.original.footprintD*16);
      if(height==null||edit.startElevation==null)return;
      const initial=edit.original.elevation||0,value=initial+height-edit.startElevation;
      const delta=(snap?Math.round(value/8)*8:Math.round(value))-initial;
      const heights=edit.originals.map(n=>n.elevation||0);
      instance.elevation=initial+clamp(delta,-2048-Math.min(...heights),2048-Math.max(...heights));
    }else{
      const point=rayPlane(eventRay(canvas,event),edit.z);if(!point||!edit.point)return;
      const pos=snapped({x:edit.original.x+(edit.axis==='y'?0:point.x-edit.point.x),y:edit.original.y+(edit.axis==='x'?0:point.y-edit.point.y)},!snap),info=api.map.info(loadedMap);
      instance.x=edit.axis==='y'?edit.original.x:clamp(pos.x,0,Math.max(0,(info.width-instance.footprintW)*32));
      instance.y=edit.axis==='x'?edit.original.y:clamp(pos.y,0,Math.max(0,(info.height-instance.footprintD)*32));
    }
  }else if(edit.tool==='rotate'){
    let delta=dx;
    if(edit.axis==='rotation'&&edit.origin){
      const point=edit.worldRing?rayPlane(eventRay(canvas,event),edit.z):null;
      if(point&&edit.lastAngle!=null){
        const angle=Math.atan2(point.y-edit.original.y-edit.original.footprintD*16,point.x-edit.original.x-edit.original.footprintW*16);
        edit.angleDelta+=((angle-edit.lastAngle)*180/Math.PI+540)%360-180;edit.lastAngle=angle;delta=edit.angleDelta;
      }else{
      const r=canvas.getBoundingClientRect(),ratio=canvas.width/r.width;
      const initial=Math.atan2((edit.y-r.top)*ratio-edit.origin[1],(edit.x-r.left)*ratio-edit.origin[0]);
      const current=Math.atan2((event.clientY-r.top)*ratio-edit.origin[1],(event.clientX-r.left)*ratio-edit.origin[0]);
      delta=((current-initial)*180/Math.PI+540)%360-180;
      }
    }
    instance.rotation=normalizeAngle(snap?Math.round((edit.original.rotation+delta)/15)*15:edit.original.rotation+delta);
  }
  else {const value=edit.original.scale*Math.exp((dx-dy)*.008);instance.scale=clamp(snap?Math.round(value*10)/10:value,.1,8);}
  edit.changed=['x','y','rotation','scale','elevation'].some(key=>(instance[key]??0)!==(edit.original[key]??0));
  transformBranch(scene,edit.id,edit.originals,{...instance});
  if(edit.tool==='move')workspace?.position(instance);
  redrawPreviews();
}
function finishSceneEdit(cancel=false){
  const edit=sceneEdit;sceneEdit=null;if(!edit)return;
  workspace?.position(null);
  if(edit.marquee){
    if(cancel){sceneSelection.clear();for(const id of edit.beforeIds)sceneSelection.add(id);selected=edit.beforeSelected;}
    else if(!edit.rect&&!edit.additive){sceneSelection.clear();selected=null;activeResourceFolder=null;resourceFolderSelection.clear();}
    refreshWorkspace();redrawPreviews();return;
  }
  if(edit.placement){
    if(edit.brush){
      if(!cancel&&edit.brush.pending.length){
        const instances=edit.brush.pending.map(stamp=>({...stamp,id:uid('p3d'),opacity:255,
          collision:assetById(stamp.assetId)?.collisionDefault!==false,order:Date.now()}));
        transact(edit.rectangle?'矩形放置':'连续放置',()=>{scene.instances.push(...instances);selected=null;});
      }
      clearSceneGhost();redrawPreviews();
    }else if(!cancel&&edit.event)placeSceneAsset(previewDialogCanvas,edit.event);else clearSceneGhost();
    return;
  }
  if(edit.terrain){Promise.resolve(api?.commands.execute('terrain.sceneStroke',cancel?'cancel':'up',{button:0})).then(refreshTerrainGhost);return;}
  if(cancel){for(const original of edit.originals||[edit.original]){const instance=sceneNode(scene,original.id);if(instance)Object.assign(instance,original);}refreshWorkspace();redrawPreviews();return;}
  if(edit.changed){commitHistory({label:'场景变换',value:edit.before});markDirty();}
  else if(edit.deselectOnClick){sceneSelection.delete(edit.id);selected=selectedSceneIds().at(-1)||null;refreshWorkspace();redrawPreviews();}
}

function openScenePreview() {
  if (previewDialog) return;
  if (!api.ui.showCustomDialog) { api.ui.openPanel(PANEL_ID); return; }
  previewDialog = api.ui.showCustomDialog({ title: '2.5D Studio · 3D 场景编辑器',
    width: window.innerWidth, height: window.innerHeight,
    render(host) {
      workspace=createWorkspace(host,{
        hierarchy:{select:chooseSceneNode,selectRange(ids,event){activeResourceFolder=null;resourceFolderSelection.clear();if(!event.ctrlKey)sceneSelection.clear();for(const id of ids)sceneSelection.add(id);selected=ids.at(-1);refreshWorkspace();redrawPreviews();},
          flag:setSceneNodeFlag,rename:(id,value)=>setInstanceField(id,'name',value),focus:focusSceneSelection,contextMenu:openHierarchyMenu,reparent:reparentSceneNodes},
        controls:sceneControls,focus:focusSceneSelection,importObj,importBillboard,
        setTool:setSceneTool,snap(value){sceneSnap=value;},continuous:toggleContinuousPlacement,
        placementBrush(value){finishSceneEdit(true);placementBrush=value==='rectangle'?'rectangle':'paint';clearSceneGhost();refreshWorkspace();redrawPreviews();},
        history:sceneHistory,save:saveWorkspace,close(){previewDialog?.close();},
        layers(){previewDialog?.close();api.ui.openPanel('object-canvas');},
        select(id){chooseSceneNode(id);},
        inspector:workspaceInspector,assets:workspaceAssets,
        folders:{state:()=>({library,selectedFolders:selectedResourceFolders(),clipboard:resourceClipboard}),select:selectResourceFolder,menu:openResourceMenu,location:resourceLocation,move:moveResourceItems},
        contextMenu:openResourceMenu,selection:updateResourceCards,
        dragPreview(id,event){if(controlSelect||event.ctrlKey){clearSceneGhost();return;}const value=id||draggedAsset;if(value)updateSceneGhost(previewDialogCanvas,event,value);},
        dragLeave:clearSceneGhost,
        drop(id,event){if(controlSelect||event.ctrlKey||!assetById(id)){clearSceneGhost();draggedAsset=null;return;}activeAsset=id;placeSceneAsset(previewDialogCanvas,event);draggedAsset=null;}
      });
      resourceMenu=createResourceMenu(host.querySelector('.ms-workspace'));
      hierarchyMenu=createResourceMenu(host.querySelector('.ms-workspace'),'hierarchy');
      const canvas = workspace.canvas;
      previewDialogCanvas = canvas;
      wireSceneCanvas(canvas);
      refreshWorkspace();
      previewDialogObserver = new ResizeObserver(redrawPreviews); previewDialogObserver.observe(canvas);
      if (previewSnapshotDirty || !mapSnapshot) refreshSceneSnapshot();
      redrawPreviews();
      return () => { resourceMenu?.dispose();resourceMenu=null;hierarchyMenu?.dispose();hierarchyMenu=null;controlSelect=false;hoveredSceneId=null;finishSceneEdit();sceneInputs.get(canvas)?.();sceneInputs.delete(canvas);workspace?.dispose();workspace=null;renderPanel();previewDialogObserver?.disconnect(); previewDialogObserver = null; previewDialogCanvas = null; previewDialog = null; disposeSceneRenderers(); };
    }, onCloseRequest: () => { previewDialog?.close(); previewDialog = null; }
  });
}

function previewSection(root) {
  const section = element('section', 'msp3d-section msp3d-preview-section');
  const heading = element('div', 'msp3d-section-heading');
  heading.append(element('strong', '', '整图场景'), button('放大预览', openScenePreview));
  const canvas = element('canvas', 'msp3d-scene-preview'); wireSceneCanvas(canvas);
  section.append(heading, sceneControls(), canvas); root.append(section);
  if (previewSnapshotDirty || !mapSnapshot) refreshSceneSnapshot();
  requestAnimationFrame(() => { if (canvas.isConnected) drawScenePreview(canvas); });
}

function chooseMode(value) {
  pointerUp({ button: 0 }); mode = value; placementPreview = null;
  modelLayer.select(); rebuild();
}

function renderAssetGrid(grid) {
  assetPreviewObserver?.disconnect();
  grid.replaceChildren();
  const query = assetSearch.trim().toLocaleLowerCase();
  const assets = filterAssets(library.assets,{query,type:assetType});
  const fragment=document.createDocumentFragment();
  for (const asset of assets) {
    let card=resourceCards.get(asset);
    if(!card){card=assetCard(asset);resourceCards.set(asset,card);}
    card.classList.toggle('is-active',activeAsset===asset.id);
    const canvas=card.querySelector('.msp3d-preview');
    if(canvas)assetPreviewObserver?.observe(canvas);
    fragment.append(card);
  }
  grid.append(fragment);
  if (!assets.length) grid.append(element('div', 'msp3d-empty', library.assets.length ? '没有匹配的资源' : '导入 OBJ 模型或透明图片，然后点击资源开始放置。'));
}

function refreshPanelSelection(root){
  for(const card of root.querySelectorAll('.msp3d-asset'))card.classList.toggle('is-active',card.dataset.assetId===activeAsset);
  const label=root.querySelector('.msp3d-current-resource'),asset=assetById(activeAsset);
  const text=asset?'当前资源：'+asset.name+' · Alt 自由放置 · Q/E 旋转':'选择资源后，可单次放置或拖动画笔连续铺设。';
  if(label&&label.textContent!==text)label.textContent=text;
}

function refreshPanelFooter(root){
  const footer=root.querySelector('.msp3d-footer');if(!footer)return;
  const text=loadedMap == null ? '未打开地图' : '地图 ' + String(loadedMap).padStart(3,'0') + ' · ' + scene.instances.length + ' 物件' + (dirty ? ' · 未保存' : '');
  const label=footer.querySelector('span');if(label.textContent!==text)label.textContent=text;
  const buttons=footer.querySelectorAll('button');buttons[0].disabled=!historyState().undo;buttons[1].disabled=!historyState().redo;
}

function renderPanel() {
  if (!panelHost) return;
  const viewKey=[panelTab,mode,!!activeAsset,placementRotation,placementScale,assetSearch,assetType].join('|');
  if(panelTab==='library'&&panelView?.root.isConnected&&panelView.library===library&&panelView.key===viewKey){refreshPanelSelection(panelView.root);refreshPanelFooter(panelView.root);return;}
  for(const canvas of panelHost.querySelectorAll('.msp3d-scene-preview')){sceneInputs.get(canvas)?.();sceneInputs.delete(canvas);}
  assetPreviewObserver?.disconnect();
  const old = panelHost.querySelector('.msp3d-panel');
  const scroll = old?.scrollTop || 0;
  panelHost.replaceChildren();
  const root = element('div', 'msp3d-panel');
  const toolbar = element('div', 'msp3d-toolbar');
  toolbar.append(button('3D 编辑器', openScenePreview, 'primary'), button('地形工具', () => {
    api.editor.setTool('maker-studio-terrain-tool'); api.ui.openPanel('maker-studio-terrain');
  }), button('保存', async () => { await save(); rebuild(); }));
  const modes = element('div', 'msp3d-modes');
  for (const [label, value] of [['选择','select'],['放置','place'],['画笔','brush'],['擦除','erase']]) {
    const btn = button(label, () => chooseMode(value), mode === value ? 'is-active' : '');
    btn.disabled = ['place','brush'].includes(value) && !assetById(activeAsset); modes.append(btn);
  }
  root.append(element('strong','','2D · 物件编辑'),toolbar, modes);
  const current = assetById(activeAsset);
  root.append(element('div', 'msp3d-help msp3d-current-resource', current ? '当前资源：' + current.name + ' · Alt 自由放置 · Q/E 旋转' : '选择资源后，可单次放置或拖动画笔连续铺设。'));
  if (['place','brush'].includes(mode) && current) {
    const fields = element('div', 'msp3d-fields');
    fields.append(numberField('放置角度', placementRotation, 0, 359, 15, value => { placementRotation = value; rebuild(); }),
      numberField('放置缩放', placementScale, .1, 8, .1, value => { placementScale = value; rebuild(); }));
    root.append(fields);
  }
  const tabs = element('div', 'msp3d-tabs');
  for (const [label, value] of [['Project 资源','library'],['Hierarchy 层级','instance'],['Inspector 属性','asset']]) {
    tabs.append(button(label, () => { panelTab = value; renderPanel(); }, panelTab === value ? 'is-active' : ''));
  }
  root.append(tabs);
  if (panelTab === 'library') {
    const search = element('input','msp3d-search'); search.type = 'search'; search.placeholder = '按名称搜索资源…'; search.value = assetSearch;
    search.setAttribute('aria-label','搜索资源');
    const filters = element('div','msp3d-preview-controls');
    for (const [label,value] of [['全部','all'],['模型','model'],['立牌','billboard']]) filters.append(button(label, () => { assetType = value; renderPanel(); }, assetType === value ? 'is-active' : ''));
    const grid=element('div','msp3d-assets');
    search.addEventListener('input', () => { assetSearch = search.value; renderAssetGrid(grid); });
    const imports = element('div','msp3d-toolbar'); imports.append(button('导入 OBJ',importObj),button('导入立牌',importBillboard));
    root.append(search,filters,imports,grid); renderAssetGrid(grid);
  } else if (panelTab === 'asset') {
    if (current) { renderAssetInspector(root,current); renderAssetProperties(root,current); }
    else root.append(element('div','msp3d-empty','先在资源库中选择一项资源。'));
  } else if (panelTab === 'instance') {
    const instance=selectedInstance();
    if (instance) renderInstanceProperties(root,instance);
    else root.append(element('div','msp3d-help','点击地图上的物件或下方列表，即可编辑位置、旋转和缩放。'));
    const list=element('div','msp3d-instance-list');
    for (const item of scene.instances) {
      const asset=assetById(item.assetId);
      list.append(button((asset?.name || '缺失资源') + ' · (' + item.x/32 + ', ' + item.y/32 + ')', () => {
        modelLayer.select();selected=item.id;activeAsset=item.assetId;mode='select';rebuild();
      }, selected === item.id ? 'is-active' : ''));
    }
    root.append(list);
  } else root.append(button('打开独立 3D 编辑器',openScenePreview));
  const footer=element('div','msp3d-footer');
  footer.append(element('span','',loadedMap == null ? '未打开地图' : '地图 ' + String(loadedMap).padStart(3,'0') + ' · ' + scene.instances.length + ' 物件' + (dirty ? ' · 未保存' : '')),
    button('撤销',()=>sceneHistory(false)),button('重做',()=>sceneHistory(true)));
  footer.querySelectorAll('button')[0].disabled=!historyState().undo;
  footer.querySelectorAll('button')[1].disabled=!historyState().redo;
  root.append(footer);panelHost.append(root);root.scrollTop=scroll;
  panelView={root,library,key:viewKey};
}

function renderAssetInspector(root, asset) {
  const section=element('section','msp3d-section');
  const canvas=element('canvas','msp3d-object-preview');canvas.width=400;canvas.height=210;
  let angle=asset.modular?45:0, previous=null;
  let drawPending=false;
  const label=element('span','','查看角度 0°');
  const draw=()=>{
    const ctx=canvas.getContext('2d');ctx.fillStyle='#101a28';ctx.fillRect(0,0,400,210);
    // A free drag can generate dozens of distinct angles per frame. Reuse a
    // nearby model raster while dragging; the label still reports the exact
    // view angle and the next discrete step is rendered on demand.
    const renderAngle=asset.type==='model' ? Math.round(angle/4)*4 : angle;
    const source=sourceFor(asset,renderAngle,55);if(!source?.width)return;
    const factor=Math.min(360/source.width,155/source.height,2);
    const cosine=Math.cos(angle*Math.PI/180);
    const anchorX=200+(source.makerPivotX-source.width/2)*factor;
    const anchorY=25+source.makerPivotY*factor;
    ctx.save();ctx.translate(200,175);
    if(asset.type==='model')ctx.drawImage(source,-source.width*factor/2,25-175,source.width*factor,source.height*factor);
    else {const height=asset.pixelHeight*factor,width=height*asset.imageWidth/asset.imageHeight;ctx.scale(cosine,1);ctx.drawImage(source,-width/2,-height,width,height);}
    ctx.restore();const ax=asset.type==='model'?anchorX:200,ay=asset.type==='model'?anchorY:175;
    ctx.strokeStyle='#38d6df';ctx.beginPath();ctx.moveTo(ax-8,ay);ctx.lineTo(ax+8,ay);ctx.moveTo(ax,ay-8);ctx.lineTo(ax,ay+8);ctx.stroke();
    label.textContent='查看角度 '+Math.round(angle)+'°';
  };
  const scheduleDraw=()=>{
    if(drawPending)return;
    drawPending=true;
    requestAnimationFrame(()=>{drawPending=false;draw();});
  };
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;previous=e.clientX;canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(previous==null)return;angle=normalizeAngle(angle-(e.clientX-previous));previous=e.clientX;scheduleDraw();});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{previous=null;});
  const controls=element('div','msp3d-turns');controls.append(button('↶ 15°',()=>{angle=normalizeAngle(angle-15);draw();}),label,button('↷ 15°',()=>{angle=normalizeAngle(angle+15);draw();}));
  canvas.title='拖动旋转预览';section.append(canvas,controls);
  canvas.__makerRedraw=draw;
  root.append(section);draw();
}

function installStyles() {
  if (styleElement) return;
  styleElement = element("style");
  styleElement.textContent = `
    ${workspaceStyles}
    ${resourceStyles}
    ${inspectorStyles}
    .msp3d-field select{box-sizing:border-box;width:100%;min-height:30px;padding:4px 8px;border:1px solid #777;border-radius:4px;background:#252525!important;color:#f5f5f5!important;color-scheme:dark;font:inherit;opacity:1}
    .msp3d-field select option{background:#252525;color:#f5f5f5}
    .msp3d-field select:focus-visible{outline:2px solid #81baff;outline-offset:2px}
    .msp3d-panel{--accent:#528ac5;--bg-primary:#282828;--bg-secondary:#333;--border:#202020;background:#282828;box-sizing:border-box}.msp3d-panel *{box-sizing:border-box}.msp3d-toolbar{position:sticky;top:-10px;z-index:2;background:var(--bg-primary,#17202a);padding:6px 0}
    .msp3d-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;border-bottom:1px solid var(--border);padding-bottom:8px}.msp3d-tabs button{padding:4px!important;font-size:11px}
    .msp3d-panel button.is-active{border-color:var(--accent,#38d6df);background:color-mix(in srgb,var(--accent,#38d6df) 20%,var(--bg-secondary,#1c2937))}
    .msp3d-search{width:100%;padding:8px;border:1px solid var(--border,#405263);background:var(--bg-primary,#101a28);color:var(--text-primary,#e2e8ef);border-radius:5px}
    .msp3d-help{color:var(--text-secondary,#bacbd8);line-height:1.6;padding:4px 0}.msp3d-instance-list{display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto}.msp3d-instance-list button{text-align:left}
    .msp3d-object-preview{width:100%;height:210px;object-fit:contain;cursor:grab;touch-action:none;background:#101a28}.msp3d-scene-preview{touch-action:none}
    .msp3d-scene-window{height:100%;min-height:300px;overflow:hidden!important}.msp3d-scene-window .msp3d-scene-preview{flex:1;min-height:220px;height:auto!important}.msp3d-scene-window .msp3d-preview-controls{flex:none}
    .msp3d-panel{height:100%;display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;color:var(--text-primary);font-size:12px}
    .msp3d-toolbar,.msp3d-modes,.msp3d-section-heading,.msp3d-turns,.msp3d-footer{display:flex;align-items:center;gap:6px}.msp3d-toolbar button{flex:1}
    .msp3d-panel button{min-height:28px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);padding:4px 8px;cursor:pointer}.msp3d-panel button:hover:not(:disabled){background:var(--bg-hover)}.msp3d-panel button:disabled{opacity:.4;cursor:default}
    .msp3d-panel button.primary,.msp3d-modes button.is-active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 22%,var(--bg-secondary));color:var(--text-primary)}.msp3d-panel button.danger{color:var(--danger,#ef4444)}
    .msp3d-modes{display:grid;grid-template-columns:repeat(4,1fr)}.msp3d-section{display:flex;flex-direction:column;gap:7px;padding:8px 0;border-top:1px solid var(--border)}.msp3d-section-heading{justify-content:space-between;min-height:28px}.msp3d-section-heading small{color:var(--text-tertiary)}
    .msp3d-preview-controls{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.msp3d-preview-controls button.is-active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 22%,var(--bg-secondary))}.msp3d-scene-preview{display:block;width:100%;height:250px;border:1px solid var(--border);border-radius:5px;background:#0b1020;cursor:grab}
    .msp3d-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(136px,1fr));gap:6px}.msp3d-asset{height:126px!important;padding:0!important;overflow:hidden;display:flex!important;flex-direction:column;align-items:stretch;text-align:left}.msp3d-asset.is-active{outline:2px solid var(--accent);outline-offset:-2px}.msp3d-preview{width:100%!important;height:92px!important;object-fit:contain;flex:none}.msp3d-asset-meta{display:flex;justify-content:space-between;align-items:center;gap:4px;padding:4px 6px;min-width:0}.msp3d-asset-meta strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.msp3d-asset-meta small{color:var(--text-tertiary);white-space:nowrap}
    .msp3d-empty{grid-column:1/-1;min-height:72px;display:flex;align-items:center;color:var(--text-tertiary);line-height:1.5}.msp3d-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.msp3d-field{display:flex;flex-direction:column;gap:3px;color:var(--text-secondary)}.msp3d-field.wide{width:100%}.msp3d-field input{box-sizing:border-box;width:100%;height:28px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);padding:3px 6px}.msp3d-check{display:flex;align-items:center;gap:6px;min-height:26px}.msp3d-check input{accent-color:var(--accent)}
    .msp3d-turns button{flex:1}.msp3d-footer{position:sticky;bottom:-10px;margin-top:auto;padding:8px 0 10px;background:var(--bg-primary);border-top:1px solid var(--border)}.msp3d-footer span{flex:1;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.msp3d-footer button{min-height:24px;padding:2px 6px}
  `;
  document.head.append(styleElement);
}

function onKeyDown(event) {
  // The native shortcut dispatcher may already have called our registered action.
  if(event.defaultPrevented)return;
  if(event.target?.closest?.('.ms-workspace-dialog'))return;
  if(event.target?.closest?.('.ms-resource-menu')&&['Escape','ArrowDown','ArrowUp','Home','End','Tab'].includes(event.key))return;
  const textInput=event.target?.closest?.("input,textarea,select,[contenteditable]:not([contenteditable='false'])");
  if(workspace){
    if(event.key==='Control'&&!textInput)setControlSelect(true);
    if(textInput||event.isComposing)return;
    // Let the canvas finish/cancel navigation and in-progress pointer edits.
    if(previewDialogCanvas?.__sceneGesture)return;
    if(resourceShortcut(event)){event.preventDefault();event.stopImmediatePropagation();return;}
    // Own mode keys before deferring camera keys to the canvas listener.
    // Native V/B tool handlers can otherwise consume them between listeners.
    if(!event.isComposing&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&['v','b','t'].includes(event.key.toLowerCase())){
      sceneShortcut(event);event.preventDefault();event.stopImmediatePropagation();return;
    }
    if(event.target?.closest?.('.msp3d-scene-preview') && !(event.ctrlKey||event.metaKey))return;
    if(sceneShortcut(event)){event.preventDefault();event.stopImmediatePropagation();}
    return;
  }
  if(event.target?.closest?.('.msp3d-scene-preview'))return;
  if (!modelLayer?.editable()) return;
  if (loadingMap != null || Number(api.editor.activeMapId()) !== loadedMap) return;
  if (textInput || event.isComposing || event.altKey) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && ['c','x','v'].includes(key)) {
    event.preventDefault();event.stopImmediatePropagation();
    if (!event.repeat) key === 'v' ? pasteModel() : copyModel(key === 'x');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.stopImmediatePropagation();
    sceneHistory(event.shiftKey);
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    event.stopImmediatePropagation();
    sceneHistory(true);
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    event.stopImmediatePropagation();
    pointerUp({button:0});removeSelected();
  } else if (event.key === "Escape") {
    pointerUp({ button: 0 });
    mode = "select";
    placementPreview = null;
    drag = null;
    rebuild();
  } else if (modelLayer?.editable() && !event.ctrlKey && !event.metaKey && ["q", "e"].includes(event.key.toLowerCase())) {
    event.preventDefault(); event.stopImmediatePropagation();
    const delta = event.key.toLowerCase() === "q" ? -15 : 15;
    if (mode === "select" && selectedInstance()) setInstanceField(selected, "rotation", normalizeAngle(selectedInstance().rotation + delta));
    else { placementRotation = normalizeAngle(placementRotation + delta); rebuild(); }
  }
}

function setControlSelect(value){
  if(value===controlSelect)return;
  if(value){if(sceneEdit?.placement||sceneEdit?.terrain)finishSceneEdit(true);clearSceneGhost();}
  controlSelect=value;sceneHandle=null;hoveredSceneId=null;
  if(value&&lastScenePointer&&previewDialogCanvas){const r=previewDialogCanvas.getBoundingClientRect();hoveredSceneId=pickSceneHit(previewDialogCanvas,(lastScenePointer.clientX-r.left)*previewDialogCanvas.width/r.width,(lastScenePointer.clientY-r.top)*previewDialogCanvas.height/r.height)?.id||null;}
  refreshWorkspace();redrawPreviews();
}
function onControlRelease(event){if(event.key==='Control')setControlSelect(false);}
function onWindowBlur(){setControlSelect(false);}

async function activate(ctx) {
  api = ctx;
  loadedMap = null;
  snapshotReader = new MapSnapshot(ctx);
  installStyles();
  ctx.ui.registerPanel({
    id: PANEL_ID, title: "2.5D Studio", icon: "box", defaultPosition: "right", showInMenu: true,
    render(host) {
      panelHost = host;
      renderPanel();
      return () => { if (panelHost === host) panelHost = null; };
    }
  });
  disconnectInput = connectMapInput(ctx, {
    id: TOOL_ID, label: "伪 3D", icon: "box",
    onActivate() { ctx.ui.openPanel(PANEL_ID); load(ctx.editor.activeMapId()); },
    onDeactivate() { pointerUp({ button: 0 }); placementPreview = null; },
    onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerUp
  }, {isolate:true,focusCanvas:true,isActive:()=>!!modelLayer?.editable()});
  if (typeof ctx.ui.registerSceneProvider === "function") {
    ctx.ui.registerSceneProvider({ id: `${MOD_ID}.scene`, collect: collectScene });
  } else {
    ctx.ui.registerOverlay({ id: `${MOD_ID}.fallback`, stage: "afterTiles", render: renderFallback });
  }
  disconnectOverlay = typeof ctx.ui.registerSceneProvider==='function' ? ()=>{} : connectMapOverlay(ctx, renderFallback,{independent:true});
  disconnectPlacementOverlay = connectMapOverlay(ctx,renderPlacementOverlay,{independent:true});
  const leaveModelLayer=()=>{disconnectInput?.finish?.();pointerUp({button:0});placementPreview=null;selected=null;disconnectPlacementOverlay?.redraw?.();};
  modelLayer=createModelLayer(ctx,{
    onSelect(){ctx.editor.setTool(TOOL_ID);ctx.ui.openPanel(PANEL_ID);modelShortcuts?.sync();disconnectPlacementOverlay?.redraw?.();},
    onLeave(){leaveModelLayer();modelShortcuts?.sync();if(ctx.editor.activeTool?.()===TOOL_ID)ctx.editor.setTool('brush');},
    onChange(){leaveModelLayer();modelShortcuts?.sync();ctx.editor.requestRedraw?.();disconnectOverlay?.redraw?.();}
  });
  const modelAction=action=>()=>{
    if(workspace||loadingMap!=null||Number(ctx.editor.activeMapId())!==loadedMap)return;
    pointerUp({button:0});action();
  };
  modelShortcuts=createModelShortcuts(ctx,()=>!!modelLayer?.editable(),{
    'Ctrl+C':modelAction(()=>copyModel()),'Ctrl+X':modelAction(()=>copyModel(true)),
    'Ctrl+V':modelAction(pasteModel),'Delete':modelAction(removeSelected),'Backspace':modelAction(removeSelected),
    'Ctrl+Z':modelAction(()=>sceneHistory(false)),'Ctrl+Shift+Z':modelAction(()=>sceneHistory(true)),
    'Ctrl+Y':modelAction(()=>sceneHistory(true))
  });
  modelShortcuts.sync();
  ctx.menu.registerMenuItem({
    menu: "Tools", label: "伪 3D 立牌与模型", icon: "box",
    handler: () => modelLayer.select()
  });
  ctx.ui.registerToolbarButton?.({
    id: `${MOD_ID}.toolbar`, icon: "box", tooltip: "伪 3D 立牌与模型",
    handler: () => modelLayer.select(),
    isActive: () => ctx.editor.activeTool?.() === TOOL_ID
  });
  ctx.lifecycle.onMapLoad((mapId) => load(mapId));
  ctx.commands?.register("pseudo3d.openScene", openScenePreview);
  ctx.commands?.register('pseudo3d.undo',()=>sceneHistory(false));
  ctx.commands?.register('pseudo3d.redo',()=>sceneHistory(true));
  ctx.commands?.register('pseudo3d.historyState',()=>historyState());
  ctx.commands?.register('pseudo3d.refreshPBS',refreshPBSEffects);
  window.addEventListener('mst:historyCommitted',onTerrainHistory);
  ctx.bus.on("save.before", save);
  ctx.lifecycle.onSave?.(save);
  ctx.bus.on("map.changed", scheduleSceneRefresh);
  ctx.bus.on("events.changed", scheduleSceneRefresh);
  ctx.bus.on("event.changed", scheduleSceneRefresh);
  ctx.bus.on("save.after", scheduleSceneRefresh);
  window.addEventListener("mst:changed", scheduleSceneRefresh);
  window.addEventListener('mst:sceneChanged',onSceneTerrainChanged);
  window.addEventListener('mst:brushChanged',refreshTerrainGhost);
  window.addEventListener("mso:previewChanged", scheduleSceneRefresh);
  document.addEventListener('visibilitychange',redrawPreviews);
  document.addEventListener('visibilitychange',onPBSFocus);
  window.addEventListener('focus',onPBSFocus);
  // Native tile tools finish their stroke on mouseup; refresh unsaved map data then.
  window.addEventListener("mouseup", onMapMouseUp, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener('keyup',onControlRelease,true);window.addEventListener('blur',onWindowBlur);
  mapWatchTimer = setInterval(() => {
    const mapId = ctx.editor.activeMapId();
    if (mapId != null && mapId !== loadedMap) load(mapId);
  }, 250);
  try { nativeHistory=await connectNativeHistory(ctx,queueHistoryRefresh); }
  catch(error){ctx.log.warn('统一撤销未连接：'+error.message);ctx.ui.showToast({message:'统一撤销未连接：'+error.message,level:'error'});}
  await load(ctx.editor.activeMapId());
  ctx.log.info("Maker Studio Pseudo 3D 2.3.6 activated.");
}

function onMapMouseUp(event) {
  if (!event.target?.closest?.("canvas.map-canvas")) return;
  const active = api?.editor.activeTool?.();
  if (active === TOOL_ID || active === "maker-studio-terrain-tool") return;
  scheduleSceneRefresh();
}

function onSceneTerrainChanged(event){
  if(event.detail?.mapId!==loadedMap)return;
  previewTerrain=event.detail.terrain;redrawPreviews();
}

async function deactivate() {
  if(resourceRecycleBusy)await resourceRecycleBusy;
  finishSceneEdit();pointerUp({button:0});
  while(dirty)await save();
  modelLayer?.dispose();modelLayer=null;
  modelShortcuts?.dispose();modelShortcuts=null;
  modelClipboard=null;
  disconnectPlacementOverlay?.();disconnectPlacementOverlay=null;
  nativeHistory?.dispose();nativeHistory=null;mapHistories.clear();
  if(historyRefreshFrame!=null)cancelAnimationFrame(historyRefreshFrame);historyRefreshFrame=null;
  if(strokeRedrawFrame!=null)cancelAnimationFrame(strokeRedrawFrame);strokeRedrawFrame=null;
  if(resourceRecycleBusy)await resourceRecycleBusy;
  resourceMenu?.dispose();resourceMenu=null;resourceSelection.clear();resourceFolderSelection.clear();activeResourceFolder=null;resourceFolder='';resourceClipboard=null;
  window.removeEventListener('mst:historyCommitted',onTerrainHistory);
  for(const dispose of sceneInputs.values())dispose();sceneInputs.clear();
  disposeModelRenderer();
  disposeSceneRenderers();
  disconnectInput?.(); disconnectInput = null;
  disconnectOverlay?.(); disconnectOverlay = null;
  previewDialog?.close(); previewDialog = null;
  previewDialogObserver?.disconnect(); previewDialogObserver = null;
  previewRefreshSerial++;
  if (previewRefreshTimer) clearTimeout(previewRefreshTimer);
  if (previewFrame != null) cancelAnimationFrame(previewFrame);
  if (previewAnimationTimer != null) clearTimeout(previewAnimationTimer);
  previewAnimationTimer=null;
  assetPreviewObserver?.disconnect();
  previewRefreshTimer = null; previewFrame = null; camera.interacting = false; assetPreviewObserver = null; previewSnapshotDirty = true; previewSnapshotRevision++; previewRefreshInFlight = false;
  window.removeEventListener("mst:changed", scheduleSceneRefresh);
  window.removeEventListener('mst:sceneChanged',onSceneTerrainChanged);
  window.removeEventListener("mso:previewChanged", scheduleSceneRefresh);
  document.removeEventListener('visibilitychange',redrawPreviews);
  document.removeEventListener('visibilitychange',onPBSFocus);
  window.removeEventListener('focus',onPBSFocus);
  window.removeEventListener("mouseup", onMapMouseUp, true);
  await snapshotReader?.dispose(); snapshotReader = null;
  loadSerial += 1;
  loadingMap = null;
  if (dirty) await save();
  if (mapWatchTimer) clearInterval(mapWatchTimer);
  mapWatchTimer = null;
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener('mst:brushChanged',refreshTerrainGhost);clearTerrainGhost();
  window.removeEventListener('keyup',onControlRelease,true);window.removeEventListener('blur',onWindowBlur);
  clearRenderCaches();
  libraryCache.clear();
  styleElement?.remove();
  styleElement = null;
  panelHost = null;
  historyUndo=[];historyRedo=[];loadedMap=null;
  effectsSync=null;pbsError='';
  api = null;
}

// Older Maker Studio loaders detect export lists, but not async function exports.
export { activate, deactivate };
