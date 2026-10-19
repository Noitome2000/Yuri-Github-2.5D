import { TILE_SIZE, DIRECTIONS, CORNERS, EDGE_STYLES, cellKey, emptyTerrain, normalizeTerrain } from "./core.js";
import { connectMapInput, connectMapOverlay, lineCells } from "./editor-input.js";
import { brushValue, brushPreview } from './brush-preview.js';
import { createMarkerLayer } from './marker-layer.js';

const MOD_ID = "cn.noitome.maker-studio-terrain";
const PANEL_ID = "maker-studio-terrain";
const TOOL_ID = "maker-studio-terrain-tool";
const mapPath = (id) => `Data/MakerStudioTerrain/Map${String(id).padStart(3, "0")}.json`;
const ARROWS = { north: "↑", east: "→", south: "↓", west: "←" };
const CORNER_LABELS = { north_west: "↖", north_east: "↗", south_east: "↘", south_west: "↙" };
const STYLE_LABELS = { hard: "硬边", soft: "缓坡", round: "圆润" };

let api = null;
let panelHost = null;
const inspectorHosts = new Set();
let sceneNotifyFrame = null;
let terrain = emptyTerrain(0);
let loadedMap = null;
let dirty = false;
let mode = "height";
let brushHeight = 1;
let slopeDirection = "north";
let cornerDirection = "north_west";
let edgeStyle = "hard";
let painting = false;
let painted = new Set();
let hoverCell = null;
let historyUndo = [];
let historyRedo = [];
let mapWatchTimer = null;
let styleElement = null;
let disconnectInput = null;
let disconnectOverlay = null;
let loadSerial = 0;
let loadingMap = null;
let shape = "brush";
let brushSize = 1;
let strokeStart = null;
let lastCell = null;
let strokeBefore = null;
let overlayVisible = true;
let markerLayer = null;
let sceneInput = false;
let changeTimer = null;
let editRevision = 0;
let pendingSave = null;
const mapHistories=new Map();
let dirtyNotifyFrame = null;
let overlayCache = null;
const overlayChanges = new Set();
let strokeRevision = 0;
let strokeWasDirty = false;

function queueEditorRedraw() {
  disconnectOverlay?.redraw?.();
}

async function readJson(path, fallback) {
  try { return JSON.parse(await api.fs.readProjectFile(path)); } catch { return fallback; }
}

async function load(mapId) {
  if (mapId == null || Number(mapId) === loadedMap || Number(mapId) === loadingMap) return;
  cancelPainting();
  const requested = Number(mapId), serial = ++loadSerial;
  loadingMap = requested;
  if (dirty) await save();
  const data = await readJson(mapPath(requested), null);
  if (serial !== loadSerial) return;
  if(loadedMap!=null)mapHistories.set(loadedMap,{undo:historyUndo,redo:historyRedo});
  loadedMap = requested;
  loadingMap = null;
  terrain = normalizeTerrain(data, loadedMap);
  overlayCache = null; overlayChanges.clear();
  dirty = false;
  painting = false;
  painted.clear();
  historyUndo = mapHistories.get(loadedMap)?.undo || [];
  historyRedo = mapHistories.get(loadedMap)?.redo || [];
  rebuild();
}

async function save() {
  if (pendingSave) { await pendingSave; if (dirty) return save(); return; }
  if (!dirty || loadedMap == null) return;
  const mapId = loadedMap, revision = editRevision;
  terrain.revision = Number(terrain.revision || 0) + 1;
  const text = `${JSON.stringify(terrain, null, 2)}\n`;
  pendingSave = (async () => {
    await api.fs.projectMkdir("Data/MakerStudioTerrain");
    await api.fs.writeProjectFile(mapPath(mapId), text);
    if (loadedMap === mapId && editRevision === revision) dirty = false;
  })();
  try { await pendingSave; } finally { pendingSave = null; }
}

function snapshot() { return JSON.parse(JSON.stringify(terrain)); }
function beginTransaction() {
  if(painting)cancelPainting();
  historyUndo.push(snapshot());
  if (historyUndo.length > 100) historyUndo.shift();
  historyRedo = [];
  window.dispatchEvent(new CustomEvent('mst:historyCommitted',{detail:{mapId:loadedMap}}));
}
function restore(source, destination) {
  const value = source.pop();
  if (!value) return false;
  destination.push(snapshot());
  terrain = normalizeTerrain(value, loadedMap);
  overlayCache = null; overlayChanges.clear();
  markDirty();
  return true;
}
function undoLocal() { return restore(historyUndo, historyRedo); }
function redoLocal() { return restore(historyRedo, historyUndo); }
function undo() {
  if(api.commands?.list().includes('pseudo3d.undo'))api.commands.execute('pseudo3d.undo');
  else undoLocal();
}
function redo() {
  if(api.commands?.list().includes('pseudo3d.redo'))api.commands.execute('pseudo3d.redo');
  else redoLocal();
}

function markDirty(refresh = true) {
  editRevision++;
  dirty = true;
  if(sceneNotifyFrame==null)sceneNotifyFrame=requestAnimationFrame(()=>{sceneNotifyFrame=null;window.dispatchEvent(new CustomEvent('mst:sceneChanged',{detail:{mapId:loadedMap,terrain:snapshot()}}));});
  // Painting updates our own data/cache immediately. Notify the host once
  // when the stroke finishes, avoiding native map-state rebuilds mid-stroke.
  if (!painting && dirtyNotifyFrame == null) {
    dirtyNotifyFrame = requestAnimationFrame(() => {
      dirtyNotifyFrame = null;
      api?.editor.markMapDirty?.(loadedMap, true);
    });
  }
  if (refresh) renderPanel();
  if (!overlayCache || overlayCache.mapId !== loadedMap) overlayCache = null;
  queueEditorRedraw();
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    if (painting) return;
    window.dispatchEvent(new CustomEvent("mst:changed", { detail: { mapId: loadedMap } }));
  }, 150);
}
function rebuild() { renderPanel(); queueEditorRedraw(); }

function eventCell(event) {
  const pointer = api.editor.pointer?.();
  const eventWorldX = Number(event?.worldX);
  const eventWorldY = Number(event?.worldY);
  const tileX = Number(event?.tileX);
  const tileY = Number(event?.tileY);
  const worldX = Number.isFinite(eventWorldX) ? eventWorldX
    : Number.isFinite(tileX) ? tileX * TILE_SIZE
      : Number(pointer?.worldX || 0);
  const worldY = Number.isFinite(eventWorldY) ? eventWorldY
    : Number.isFinite(tileY) ? tileY * TILE_SIZE
      : Number(pointer?.worldY || 0);
  return { x: Math.floor(worldX / TILE_SIZE), y: Math.floor(worldY / TILE_SIZE) };
}

function inBounds(cell) {
  const info = api.map.info?.(loadedMap) || {};
  const width = Number(info.width ?? info.mapWidth ?? 99999);
  const height = Number(info.height ?? info.mapHeight ?? 99999);
  return cell.x >= 0 && cell.y >= 0 && cell.x < width && cell.y < height;
}

function paint(cell, sample = false) {
  if (!inBounds(cell)) return;
  const key = cellKey(cell.x, cell.y);
  if (sample) {
    const current = terrain.cells[key];
    brushHeight = Number(current?.height || 0);
    edgeStyle = current?.style || "hard";
    if (DIRECTIONS.includes(current?.slope)) {
      mode = "slope";
      slopeDirection = current.slope;
    } else if (current?.slope?.startsWith("outer_")) {
      mode = "outer";
      cornerDirection = current.slope.slice(6);
    } else if (current?.slope?.startsWith("inner_")) {
      mode = "inner";
      cornerDirection = current.slope.slice(6);
    } else {
      mode = current?.type === "overpass" ? "overpass" : "height";
    }
    renderPanel();
    return;
  }
  if (painted.has(key)) return;
  painted.add(key);
  if (mode === "erase" || (mode === "height" && brushHeight === 0)) {
    if (!terrain.cells[key]) return;
    delete terrain.cells[key];
  } else {
    const value = brushValue({mode,brushHeight,slopeDirection,cornerDirection,edgeStyle});
    const current = terrain.cells[key];
    if (current && Number(current.height || 0) === value.height &&
        current.slope === value.slope && current.type === value.type &&
        current.style === value.style) return;
    terrain.cells[key] = value;
  }
  overlayChanges.add(key);
  markDirty(false);
}

function pointerDown(event) {
  if (!sceneInput && !markerLayer?.editable()) return;
  if (loadingMap != null || Number(event.mapId) !== loadedMap || event.button !== 0) return;
  const cell = eventCell(event);
  if (event.altKey) { paint(cell, true); return; }
  if (!inBounds(cell)) return;
  cancelPainting();
  strokeBefore = snapshot();
  strokeRevision = editRevision;
  strokeWasDirty = dirty;
  painting = true;
  strokeStart = cell;
  lastCell = cell;
  hoverCell = cell;
  painted.clear();
  if (shape === "brush") paintBrush(cell);
}
function pointerMove(event) {
  if (!sceneInput && !markerLayer?.editable()) { cancelPainting(); return; }
  if (Number(event.mapId) !== loadedMap) return;
  const cell = eventCell(event);
  if (!hoverCell || hoverCell.x !== cell.x || hoverCell.y !== cell.y) {
    hoverCell = cell;
    queueEditorRedraw();
  }
  if (painting && (event.buttons == null || (event.buttons & 1))) {
    if (lastCell?.x === cell.x && lastCell?.y === cell.y) return;
    if (shape === "brush") for (const point of lineCells(lastCell, cell)) paintBrush(point);
    lastCell = cell;
  }
}
function pointerUp(event) {
  if (!sceneInput && !markerLayer?.editable()) { cancelPainting(); return; }
  if (event.button !== 0) return;
  if (painting && shape === "rectangle" && lastCell) {
    const info = api.map.info?.(loadedMap);
    for (let y = Math.max(0, Math.min(strokeStart.y, lastCell.y)); y <= Math.min((info?.height || 1) - 1, Math.max(strokeStart.y, lastCell.y)); y++) {
      for (let x = Math.max(0, Math.min(strokeStart.x, lastCell.x)); x <= Math.min((info?.width || 1) - 1, Math.max(strokeStart.x, lastCell.x)); x++) paint({ x, y });
    }
  }
  cancelPainting();
}

function cancelPainting() {
  const changed = painting && strokeBefore && strokeRevision !== editRevision;
  if (changed) {
    historyUndo.push(strokeBefore);
    if (historyUndo.length > 100) historyUndo.shift();
    historyRedo = [];
    window.dispatchEvent(new CustomEvent('mst:historyCommitted',{detail:{mapId:loadedMap}}));
  }
  painting = false;
  strokeBefore = null;
  strokeStart = null;
  lastCell = null;
  painted.clear();
  if (changed) {
    api?.editor.markMapDirty?.(loadedMap, true);
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = null;
    window.dispatchEvent(new CustomEvent('mst:changed', { detail: { mapId: loadedMap } }));
  }
  rebuild();
}

function discardSceneStroke(){
  if(!painting||!strokeBefore)return;
  const changed=strokeRevision!==editRevision,savedDuringStroke=terrain.revision!==strokeBefore.revision;
  terrain=normalizeTerrain(strokeBefore,loadedMap);painting=false;
  if(changed){editRevision++;dirty=strokeWasDirty||savedDuringStroke;overlayCache=null;overlayChanges.clear();}
  if(changeTimer)clearTimeout(changeTimer);changeTimer=null;
  cancelPainting();queueEditorRedraw();
  if(changed){window.dispatchEvent(new CustomEvent('mst:sceneChanged',{detail:{mapId:loadedMap,terrain:snapshot()}}));window.dispatchEvent(new CustomEvent('mst:changed',{detail:{mapId:loadedMap}}));}
}

function paintBrush(cell) {
  const offset = Math.floor((brushSize - 1) / 2);
  for (let y = 0; y < brushSize; y++) for (let x = 0; x < brushSize; x++) paint({ x: cell.x + x - offset, y: cell.y + y - offset });
}

function activateTool() { api.editor.setTool(TOOL_ID); }
function chooseMode(value) { cancelPainting(); mode = value; activateTool(); renderPanel(); }

function metrics(info) {
  return { scale: Number(info.zoom) || Number(info.tileSize) / TILE_SIZE || 1,
    x: Number(info.viewportX) || 0, y: Number(info.viewportY) || 0 };
}

function drawTerrainCell(ctx, key, cell, m) {
  if (!cell) return;
  const [tx, ty] = key.split(",").map(Number);
  const x = tx * TILE_SIZE * m.scale - m.x;
  const y = ty * TILE_SIZE * m.scale - m.y;
  const size = TILE_SIZE * m.scale;
  if (x + size < 0 || y + size < 0 || x > ctx.canvas.width || y > ctx.canvas.height) return;
  const hue = (205 - Number(cell.height || 0) * 19 + 360) % 360;
  ctx.fillStyle = `hsla(${hue},75%,48%,.34)`;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = cell.type === "overpass" ? "#fbbf24" : cell.slope ? "#f8fafc" : `hsl(${hue},80%,68%)`;
  ctx.lineWidth = cell.slope ? 2 : 1;
  ctx.strokeRect(x + .5, y + .5, Math.max(0, size - 1), Math.max(0, size - 1));
  ctx.fillStyle = "#fff";
  const slopeLabel = ARROWS[cell.slope] || CORNER_LABELS[cell.slope?.replace(/^(outer|inner)_/, "")] || "";
  const typeLabel = cell.type === "overpass" ? "空" : "";
  const styleLabel = cell.style === "round" ? "○" : cell.style === "soft" ? "~" : "";
  ctx.fillText(`${cell.height}${slopeLabel}${typeLabel}${styleLabel}`, x + size / 2, y + size / 2);
}

function drawOverlay(ctx, info) {
  if (Number(info.mapId) !== loadedMap || !overlayVisible || !markerLayer?.settings.visible || markerLayer.settings.opacity<=0) return;
  const m = metrics(info);
  ctx.save();
  ctx.globalAlpha *= markerLayer.settings.opacity;
  // Map-space chunks survive pan. Moving the map must not re-rasterize every
  // terrain label; zoom may rebuild them to keep text readable.
  const cellsPerChunk=8,chunkSize=cellsPerChunk*TILE_SIZE;
  if(!overlayCache||overlayCache.mapId!==loadedMap||overlayCache.zoom!==m.scale)overlayCache={mapId:loadedMap,zoom:m.scale,chunks:new Map()};
  for(const key of overlayChanges){const [x,y]=key.split(',').map(Number);overlayCache.chunks.delete(`${Math.floor(x/cellsPerChunk)},${Math.floor(y/cellsPerChunk)}`);}
  overlayChanges.clear();
  const mapInfo=api.map.info?.(loadedMap)||{};
  const minX=Math.max(0,Math.floor(m.x/m.scale/chunkSize)),minY=Math.max(0,Math.floor(m.y/m.scale/chunkSize));
  const maxX=Math.min(Math.ceil((mapInfo.width||0)/cellsPerChunk)-1,Math.floor((m.x+ctx.canvas.width)/m.scale/chunkSize));
  const maxY=Math.min(Math.ceil((mapInfo.height||0)/cellsPerChunk)-1,Math.floor((m.y+ctx.canvas.height)/m.scale/chunkSize));
  ctx.imageSmoothingEnabled=false;
  for(let cy=minY;cy<=maxY;cy++)for(let cx=minX;cx<=maxX;cx++) {
    const key=`${cx},${cy}`;let chunk=overlayCache.chunks.get(key);
    if(!chunk){
      chunk=document.createElement('canvas');chunk.width=chunk.height=chunkSize;
      const graphics=chunk.getContext('2d');graphics.font=`${Math.max(12,10/m.scale)}px sans-serif`;graphics.textAlign='center';graphics.textBaseline='middle';
      for(let y=cy*cellsPerChunk;y<(cy+1)*cellsPerChunk;y++)for(let x=cx*cellsPerChunk;x<(cx+1)*cellsPerChunk;x++) {
        const tileKey=cellKey(x,y);drawTerrainCell(graphics,tileKey,terrain.cells[tileKey],{scale:1,x:cx*chunkSize,y:cy*chunkSize});
      }
      overlayCache.chunks.set(key,chunk);
    }
    ctx.drawImage(chunk,cx*chunkSize*m.scale-m.x,cy*chunkSize*m.scale-m.y,chunkSize*m.scale,chunkSize*m.scale);
  }
  // Bound residency for very large maps while retaining recently visible chunks.
  if(overlayCache.chunks.size>256)for(const key of overlayCache.chunks.keys()) {
    const [x,y]=key.split(',').map(Number);
    if(x<minX||x>maxX||y<minY||y>maxY)overlayCache.chunks.delete(key);
    if(overlayCache.chunks.size<=192)break;
  }
  if (markerLayer?.editable() && api.editor.activeTool?.() === TOOL_ID && hoverCell && inBounds(hoverCell)) {
    const start = painting && shape === "rectangle" ? strokeStart : hoverCell;
    const x = Math.min(start.x, hoverCell.x) * TILE_SIZE * m.scale - m.x;
    const y = Math.min(start.y, hoverCell.y) * TILE_SIZE * m.scale - m.y;
    const size = TILE_SIZE * m.scale;
    const w = shape === "rectangle" && painting ? Math.abs(start.x - hoverCell.x) + 1 : brushSize;
    const h = shape === "rectangle" && painting ? Math.abs(start.y - hoverCell.y) + 1 : brushSize;
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2;
    const offset = shape === "brush" ? Math.floor((brushSize - 1) / 2) * size : 0;
    ctx.strokeRect(x - offset + 1, y - offset + 1, Math.max(0, size * w - 2), Math.max(0, size * h - 2));
  }
  ctx.restore();
}

function el(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function button(label, handler, active = false, title = "") {
  const node = el("button", active ? "active" : "", label);
  node.type = "button";
  node.title = title;
  node.addEventListener("click", handler);
  return node;
}

function renderPanel() {
  window.dispatchEvent(new CustomEvent('mst:brushChanged'));
  if(panelHost)renderInspector(panelHost);
  for(const host of inspectorHosts)if(host.isConnected)renderInspector(host);
}
function renderInspector(host) {
  host.replaceChildren();
  const inScene=!!host.closest('.ms-workspace');
  const root = el("div", "mst-panel");
  root.append(el("h3", "", "Inspector · 地形"));
  const switcher=el('div','mst-segments ms-editor-switch');
  switcher.append(button('3D 编辑器',()=>api.commands.execute('pseudo3d.openScene')),
    button('物件图层',()=>api.ui.openPanel('object-canvas')));
  root.append(switcher,el('span','mst-label','绘制工具'));
  const drawing = el("div", "mst-segments");
  drawing.append(button("画笔", () => { shape = "brush"; activateTool(); renderPanel(); }, shape === "brush"),
    button("矩形", () => { shape = "rectangle"; activateTool(); renderPanel(); }, shape === "rectangle"),
    button(markerLayer?.settings.visible ? "隐藏高程" : "显示高程", () => markerLayer?.setSettings({visible:!markerLayer.settings.visible})));
  root.append(drawing);
  if(!host.closest?.('.ms-workspace'))root.append(
    el('p','mst-help','2D 界面仅在选中地形标记层且该层可见时编辑。图层行可隐藏标记、调节不透明度。'));
  const sizes = el("div", "mst-styles");
  for (const size of [1, 2, 3]) sizes.append(button(`${size} × ${size}`, () => { brushSize = size; activateTool(); renderPanel(); }, brushSize === size));
  if (shape === "brush") root.append(sizes);
  const modes = el("div", "mst-segments");
  modes.append(
    button("平台", () => chooseMode("height"), mode === "height"),
    button("直坡", () => chooseMode("slope"), mode === "slope"),
    button("外角坡", () => chooseMode("outer"), mode === "outer"),
    button("内角坡", () => chooseMode("inner"), mode === "inner"),
    button("镂空", () => chooseMode("overpass"), mode === "overpass"),
    button("清除", () => chooseMode("erase"), mode === "erase")
  );
  root.append(modes);

  const level = el("label", "mst-field");
  level.append(el("span", "", "高度等级"));
  const levelInput = el("input");
  levelInput.type = "number"; levelInput.min = "0"; levelInput.max = "32"; levelInput.step = "1";
  levelInput.value = String(brushHeight);
  levelInput.addEventListener('input',()=>{brushHeight=Math.max(0,Math.min(32,Math.round(Number(levelInput.value)||0)));window.dispatchEvent(new CustomEvent('mst:brushChanged'));});
  levelInput.addEventListener("change", () => { brushHeight = Math.max(0, Math.min(32, Math.round(Number(levelInput.value) || 0))); renderPanel(); });
  level.append(levelInput);
  root.append(level);
  const levels = el("div", "mst-directions");
  for (const height of [0, 1, 2, 3]) levels.append(button(`${height} 级`, () => { brushHeight = height; activateTool(); renderPanel(); }, brushHeight === height));
  root.append(levels);

  const step = el("label", "mst-field");
  step.append(el("span", "", "每级高度（像素）"));
  const stepInput = el("input");
  stepInput.type = "number"; stepInput.min = "4"; stepInput.max = "64"; stepInput.step = "1";
  stepInput.value = String(terrain.heightStep);
  stepInput.disabled = !inScene && !markerLayer?.editable();
  stepInput.addEventListener("change", () => {
    if(!inScene && !markerLayer?.editable())return;
    beginTransaction();
    terrain.heightStep = Math.max(4, Math.min(64, Math.round(Number(stepInput.value) || 16)));
    markDirty();
  });
  step.append(stepInput);
  root.append(step);

  if (mode !== "erase") {
    root.append(el("span", "mst-label", "平台边缘"));
    const styles = el("div", "mst-styles");
    for (const style of EDGE_STYLES) styles.append(button(STYLE_LABELS[style], () => {
      edgeStyle = style; renderPanel();
    }, edgeStyle === style));
    root.append(styles);
  }

  if (mode === "slope") {
    root.append(el("span", "mst-label", "上坡方向"));
    const directions = el("div", "mst-directions");
    for (const direction of DIRECTIONS) directions.append(button(ARROWS[direction], () => {
      slopeDirection = direction; renderPanel();
    }, slopeDirection === direction, `${ARROWS[direction]} 方向升高一级`));
    root.append(directions);
  }

  if (mode === "outer" || mode === "inner") {
    root.append(el("span", "mst-label", mode === "outer" ? "升高的外角" : "降低的内角"));
    const corners = el("div", "mst-directions");
    for (const direction of CORNERS) corners.append(button(CORNER_LABELS[direction], () => {
      cornerDirection = direction; renderPanel();
    }, cornerDirection === direction));
    root.append(corners);
  }

  const tips = el("div", "mst-help");
  tips.textContent = mode === "overpass"
    ? "镂空平台保留下层通道；从相同高度的平台进入上层，从平地进入下层。"
    : mode === "outer" || mode === "inner"
      ? "角坡用于衔接转角；方向按钮表示外角高点或内角缺口。"
      : mode === "slope"
        ? "箭头方向比当前高度高一级。"
        : inScene ? "黄色轮廓显示本次绘制范围；高度和笔刷设置会实时更新预览。" : "按 Alt 点击可吸取格子的完整地形设置。";
  root.append(tips);
  root.append(el("div", "mst-help", inScene ? "左键拖动绘制 · Ctrl 临时选择 · Alt＋左键环绕 · 一笔一次撤销。" : "左键拖动绘制 · Alt 点击吸取 · 一笔一次撤销。先在原生图块工具铺材质，再在这里设置高程。"));
  if(!inScene)root.append(button("打开 3D 编辑器", () => {
    if (api.commands?.list().includes("pseudo3d.openScene")) api.commands.execute("pseudo3d.openScene");
    else api.ui.showToast({ message: "请先启用伪 3D 立牌与模型插件。", level: "info" });
  }));
  const footer = el("div", "mst-footer");
  footer.append(el("span", "", `${Object.keys(terrain.cells).length} 个高程格`),
    button("撤销", undo, false), button("重做", redo, false));
  const historyButtons=footer.querySelectorAll('button');
  historyButtons[0].disabled = !historyUndo.length;
  historyButtons[1].disabled = !historyRedo.length;
  if(api.commands?.list().includes('pseudo3d.historyState')){
    Promise.resolve(api.commands.execute('pseudo3d.historyState')).then(shared=>{
      if(!footer.isConnected||!shared)return;
      historyButtons[0].disabled=!shared.undo;historyButtons[1].disabled=!shared.redo;
    });
  }
  root.append(footer);
  host.append(root);
}

function installStyles() {
  styleElement = el("style");
  styleElement.textContent = `
    .mst-panel{--accent:#528ac5;--border:#262626;--bg-primary:#282828;--bg-secondary:#353535;background:#282828}.mst-panel button,.mst-panel input,.mst-help{border-radius:2px!important}.mst-label{border-top:1px solid #444;padding-top:8px}.mst-panel h3{background:#383838;padding:8px;margin:-12px -12px 0!important}.mst-help{border:0!important;padding:5px 0!important}
    .mst-panel{height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:12px;color:var(--text-primary);font-size:12px;overflow:auto}.mst-panel h3{margin:0;font-size:14px}
    .mst-panel button,.mst-panel input{font:inherit}.mst-panel button{min-height:30px;border:1px solid var(--border);border-radius:5px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer}.mst-panel button.active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 24%,var(--bg-secondary))}.mst-panel button:disabled{opacity:.35}
    .mst-segments{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.mst-field{display:flex;align-items:center;justify-content:space-between;gap:8px}.mst-field input{width:84px;box-sizing:border-box;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);padding:6px}.mst-label{color:var(--text-secondary)}
    .mst-styles{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}
    .mst-directions{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.mst-directions button{font-size:18px}.mst-help{padding:9px;border:1px solid var(--border);border-radius:6px;color:var(--text-tertiary);line-height:1.5}.mst-footer{display:flex;align-items:center;gap:5px;margin-top:auto;padding-top:10px;border-top:1px solid var(--border)}.mst-footer span{flex:1;color:var(--text-tertiary)}.mst-footer button{min-height:26px;padding:2px 7px}
    .ms-workspace .mst-field input{background:#202020;border:1px solid #555;color:#fff;min-height:28px;padding:4px 6px}
  `;
  document.head.append(styleElement);
}

function onKeyDown(event) {
  if(event.target?.closest?.('.ms-workspace'))return;

  if (api?.editor.activeTool?.() !== TOOL_ID || event.target?.closest?.("input,textarea,select,[contenteditable='true']")) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "z") { event.preventDefault(); event.stopImmediatePropagation(); cancelPainting(); event.shiftKey ? redo() : undo(); }
  else if ((event.ctrlKey || event.metaKey) && key === "y") { event.preventDefault(); event.stopImmediatePropagation(); cancelPainting(); redo(); }
}

async function activate(ctx) {
  api = ctx;
  loadedMap = null;
  installStyles();
  markerLayer=createMarkerLayer(ctx,{
    onSelect(){cancelPainting();hoverCell=null;ctx.editor.setTool(TOOL_ID);ctx.ui.openPanel(PANEL_ID);queueEditorRedraw();renderPanel();},
    onLeave(){cancelPainting();hoverCell=null;queueEditorRedraw();renderPanel();},
    onChange(){cancelPainting();hoverCell=null;queueEditorRedraw();renderPanel();}
  });
  ctx.ui.registerPanel({ id: PANEL_ID, title: "高低地形", icon: "mountain", defaultPosition: "right",
    render(host) { panelHost = host; renderPanel(); return () => { if (panelHost === host) panelHost = null; }; } });
  disconnectInput = connectMapInput(ctx, { id: TOOL_ID, label: "地形", icon: "mountain",
    onActivate() { ctx.ui.openPanel(PANEL_ID); load(ctx.editor.activeMapId()); },
    onDeactivate: cancelPainting,
    onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerUp }, { isolate: true });
  ctx.commands?.register("terrain.snapshot", (mapId) => Number(mapId) === loadedMap ? snapshot() : null);
  ctx.commands?.register('terrain.mountInspector',host=>{inspectorHosts.add(host);renderInspector(host);return ()=>inspectorHosts.delete(host);});
  ctx.commands?.register('terrain.save',save);
  ctx.commands?.register('terrain.ensureMap',mapId=>{if(loadingMap!=null)throw Error('地形仍在加载');return load(mapId);});
  ctx.commands?.register('terrain.undo',()=>{cancelPainting();undo();});
  ctx.commands?.register('terrain.redo',()=>{cancelPainting();redo();});
  ctx.commands?.register('terrain.undoLocal',undoLocal);
  ctx.commands?.register('terrain.redoLocal',redoLocal);
  ctx.commands?.register('terrain.finishStroke',()=>{if(painting)cancelPainting();});
  ctx.commands?.register('terrain.refreshHistory',renderPanel);
  ctx.commands?.register('terrain.sceneStroke',(phase,event)=>{
    sceneInput=true;
    try { if(phase==='down')pointerDown(event);else if(phase==='move')pointerMove(event);else if(phase==='cancel')discardSceneStroke();else pointerUp(event); }
    finally { sceneInput=false; }
    if(sceneNotifyFrame==null)sceneNotifyFrame=requestAnimationFrame(()=>{sceneNotifyFrame=null;window.dispatchEvent(new CustomEvent('mst:sceneChanged',{detail:{mapId:loadedMap,terrain:snapshot()}}));});
  });
  ctx.commands?.register('terrain.scenePreview',event=>{
    if(loadingMap!=null||Number(event.mapId)!==loadedMap)return null;
    const info=api.map.info?.(loadedMap);if(!info)return null;
    return {heightStep:terrain.heightStep||16,cells:brushPreview(eventCell(event),
      {mode,brushHeight,slopeDirection,cornerDirection,edgeStyle,shape,brushSize},info,painting?strokeStart:null)};
  });
  disconnectOverlay = connectMapOverlay(ctx, drawOverlay, { independent: true, event: 'mst:redraw' });
  ctx.menu.registerMenuItem({ menu: "Tools", label: "高低地形与斜坡", icon: "mountain",
    handler: () => { ctx.ui.openPanel(PANEL_ID); ctx.editor.setTool(TOOL_ID); } });
  ctx.ui.registerToolbarButton?.({ id: `${MOD_ID}.toolbar`, icon: "mountain", tooltip: "高低地形与斜坡",
    handler: () => { ctx.ui.openPanel(PANEL_ID); ctx.editor.setTool(TOOL_ID); },
    isActive: () => ctx.editor.activeTool?.() === TOOL_ID });
  ctx.lifecycle.onMapLoad((mapId) => load(mapId));
  ctx.bus.on("save.before", save);
  window.addEventListener("keydown", onKeyDown, true);
  mapWatchTimer = setInterval(() => load(ctx.editor.activeMapId()), 250);
  await load(ctx.editor.activeMapId());
  ctx.log.info("高低地形与斜坡 2.3.0 已加载");
}

async function deactivate() {
  markerLayer?.dispose();markerLayer=null;
  inspectorHosts.clear();if(sceneNotifyFrame!=null)cancelAnimationFrame(sceneNotifyFrame);sceneNotifyFrame=null;
  disconnectInput?.(); disconnectInput = null;
  disconnectOverlay?.(); disconnectOverlay = null;
  loadSerial++;
  loadingMap = null;
  if (dirtyNotifyFrame != null) cancelAnimationFrame(dirtyNotifyFrame);
  dirtyNotifyFrame = null;
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = null;
  if (dirty) await save();
  if (mapWatchTimer) clearInterval(mapWatchTimer);
  mapWatchTimer = null;
  window.removeEventListener("keydown", onKeyDown, true);
  styleElement?.remove();
  styleElement = null;
  panelHost = null;
  mapHistories.clear();historyUndo=[];historyRedo=[];loadedMap=null;
  api = null;
}

// Older Maker Studio loaders detect export lists, but not async function exports.
export { activate, deactivate };
