// Read the open map through the SDK so unsaved tile edits appear in the preview.
// Tile priority is draw order, not elevation. Adjacent upright rows share the
// actual bottom of their column; an isolated priority-5 tile still touches ground.
import {previewEvent,eventFrame} from './event-preview.js';
export function standingAnchors(records) {
  const columns = new Map(), anchors = new Map();
  for (const tile of records) if (tile.standing) {
    const key = `${tile.mapId ?? ''}:${tile.x}`;
    if (!columns.has(key)) columns.set(key,[]);
    columns.get(key).push(tile);
  }
  for (const column of columns.values()) {
    column.sort((a,b)=>b.y-a.y);
    const rows = new Map();
    for (const tile of column) {
      if (!rows.has(tile.y)) rows.set(tile.y,[]);
      rows.get(tile.y).push(tile);
    }
    for (const tile of column) {
      // Overlaps may put the next source row on another map layer. Without
      // source identity, retain the legacy same-layer-only behaviour.
      const below=(rows.get(tile.y+1)||[]).filter(other=>tile.sourceKey==null ?
        tile.layer===other.layer : tile.sourceKey===other.sourceKey &&
        tile.sourceColumn===other.sourceColumn && tile.sourceRow+1===other.sourceRow);
      const sameLayer=below.filter(other=>other.layer===tile.layer);
      const candidates=new Set((sameLayer.length?sameLayer:below).map(other=>anchors.get(other)));
      anchors.set(tile,candidates.size===1?candidates.values().next().value:tile.y);
    }
  }
  return anchors;
}

function compactTileAtlas() {
  const cache = new WeakMap(); let page = null, index = 1024;
  return (image,sx,sy,rotation,flipH,flipV) => {
    let entries = cache.get(image);
    if (!entries) {entries=new Map();cache.set(image,entries);}
    const key=[sx,sy,rotation,flipH,flipV].join(':');
    if(entries.has(key))return entries.get(key);
    if(index===1024){page=document.createElement('canvas');page.width=page.height=1024;index=0;}
    const x=(index%32)*32,y=Math.floor(index/32)*32;index++;
    const ctx=page.getContext('2d');ctx.save();ctx.beginPath();ctx.rect(x,y,32,32);ctx.clip();
    ctx.imageSmoothingEnabled=false;ctx.translate(x+16,y+16);ctx.rotate(rotation*Math.PI/180);
    ctx.scale(flipH?-1:1,flipV?-1:1);ctx.drawImage(image,sx,sy,32,32,-16,-16,32,32);ctx.restore();
    const result={image:page,sx:x,sy:y,sw:32,sh:32};entries.set(key,result);return result;
  };
}

export class MapSnapshot {
  constructor(api) { this.api = api; this.images = new Map(); this.disposed = false; }
  async image(key, load) {
    if (!this.images.has(key)) this.images.set(key, (async () => {
      try { return await load(); } catch (error) { this.api.log.warn?.(`预览材质读取失败：${key}`, String(error)); return null; }
    })());
    return this.images.get(key);
  }
  async tileset(id) {
    return this.image(`tileset:${id}`, async () => {
      const url = await this.api.tileset?.getImageBlobUrl(id);
      if (!url) return null;
      return createImageBitmap(await (await fetch(url)).blob());
    });
  }
  async autotile(name) {
    if (!name) return null;
    return this.image(`auto:${name}`, async () => {
      const invoke = globalThis.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
      if (!invoke) return null;
      const bytes = await invoke("get_autotile_atlas", { gameRoot: this.api.editor.gameRoot(), autotileName: name });
      return createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    });
  }
  async capture(mapId) {
    const info = this.api.map.info?.(mapId);
    if (!info) return null;
    const layers = this.api.map.layers?.(mapId) || [0,1,2].map(index => ({ index, visible: true, opacity: 1 }));
    const records = [], resources = new Map();
    const tileSetIds = new Set([info.tilesetId]);
    const autoNames = new Set();
    for (const layer of layers) {
      if (layer.visible === false || layer.kind === "shadow" || layer.index < 0) continue;
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        const data = {
          ...(this.api.map.readTileData?.(mapId, layer.index, x, y) || {}),
          ...(this.api.map.getNativeTileProperties?.(mapId, layer.index, x, y) || {})
        };
        const tileId = data.tileId ?? data.tile_id ?? this.api.map.readTile?.(mapId, layer.index, x, y) ?? 0;
        const autoName = data.autotileName ?? data.autotile_name;
        if (!tileId && !autoName) continue;
        const tilesetId = data.tilesetId ?? data.tileset_id ?? info.tilesetId;
        tileSetIds.add(tilesetId);
        if (autoName) autoNames.add(autoName);
        const tileData = { ...data, autotile_name: autoName };
        const priority = Number(tileData.priority ?? tileData.priority_type ?? tileData.physics?.priority ??
          this.api.tileset?.getTileProperties?.(tilesetId, tileId)?.priority ?? 0);
        records.push({ x, y, layer: layer.index, tileId, tilesetId, priority, data: tileData, opacity: layer.opacity ?? 1,
          standing: tileData.standing ?? tileData.isStanding ?? (priority > 0) });
      }
    }
    for (const id of tileSetIds) {
      const tileset = this.api.tileset?.info(id);
      for (const name of tileset?.autotileNames || []) if (name) autoNames.add(name);
      resources.set(id, { info: tileset, image: await this.tileset(id) });
    }
    const autos = new Map(await Promise.all([...autoNames].map(async name => [name, await this.autotile(name)])));
    if (this.disposed) return null;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 4096 / Math.max(info.width * 32, info.height * 32));
    canvas.width = Math.ceil(info.width * 32 * scale);
    canvas.height = Math.ceil(info.height * 32 * scale);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#263444"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    let missing = 0;
    const standingTiles = [];
    for (const tile of records) {
      const columns=Math.max(1,Math.floor((resources.get(tile.tilesetId)?.image?.width||256)/32));
      tile.sourceKey=tile.tileId>=384&&!tile.data.autotile_name?`tileset:${tile.tilesetId}`:`auto:${tile.x},${tile.y}`;
      tile.sourceColumn=(tile.tileId-384)%columns;tile.sourceRow=Math.floor((tile.tileId-384)/columns);
    }
    const anchors=standingAnchors(records), pack=compactTileAtlas();
    for (const record of records) {
      const { x, y, tileId, tilesetId, data, opacity, standing } = record;
      const resource = resources.get(tilesetId);
      const autoName = data.autotile_name || (tileId < 384 ? resource?.info?.autotileNames?.[Math.floor(tileId / 48) - 1] : null);
      const image = autoName ? autos.get(autoName) : resource?.image;
      if (!image) { missing++; continue; }
      const columns = Math.max(1, Math.floor(image.width / 32));
      const index = autoName ? tileId % 48 : tileId - 384;
      if (index < 0) continue;
      const sx = index % columns * 32, sy = Math.floor(index / columns) * 32;
      const size = 32 * scale;
      const alpha = opacity * (data.opacity ?? 255) / 255;
      const rotation = Number(data.rotation) || 0;
      const flipH = data.flip_h || data.flipH;
      const flipV = data.flip_v || data.flipV;
      if (standing) {
        const bottom=anchors.get(record)??y;
        standingTiles.push({ ...pack(image,sx,sy,rotation,flipH,flipV),
          x, y, opacity: alpha,
          worldY: bottom * 32,
          elevation: (bottom-y) * 32,
          height: Math.max(32, Number(data.pixelHeight || 32)) });
        continue;
      }
      // The common case is an opaque, unrotated tile. Avoid save/restore,
      // matrix changes, and a second compositing pass for every tile.
      if (rotation === 0 && !flipH && !flipV && alpha === 1) {
        ctx.drawImage(image, sx, sy, 32, 32, x * size, y * size, size, size);
      } else {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate((x + .5) * size, (y + .5) * size);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(image, sx, sy, 32, 32, -size / 2, -size / 2, size, size);
        ctx.restore();
      }
    }
    // Include tile-based object layers via their existing plugin API.
    if (this.api.commands?.list().includes("object-canvas.renderPreview")) {
      const objectPreview = await this.api.commands.execute("object-canvas.renderPreview", {
        canvas, mapId, scale, tilesetId: info.tilesetId, standingTiles
      });
      if (objectPreview?.standingTiles && objectPreview.standingTiles !== standingTiles) {
        standingTiles.push(...objectPreview.standingTiles);
      }
    }
    const events=[];
    for(const summary of await this.api.events?.list?.(mapId)||[]) {
      const raw=await this.api.events.getRaw?.(mapId,summary.id)||await this.api.events.getFull?.(mapId,summary.id)||summary;
      const event=previewEvent(raw);
      if(event.characterName) {
        event.image=await this.image(`character:${event.characterName}`,async()=>{
          const invoke=globalThis.__TAURI_INTERNALS__?.invoke||window.__TAURI__?.core?.invoke;
          if(!invoke)return null;
          const name=event.characterName.replace(/\\/g,'/').replace(/\.(png|webp|bmp)$/i,'');
          for(const ext of ['png','webp','bmp'])try {
            const bytes=await invoke('read_binary_file',{path:`${this.api.editor.gameRoot()}/Graphics/Characters/${name}.${ext}`});
            return await createImageBitmap(new Blob([new Uint8Array(bytes)]));
          } catch {}
          return null;
        });
        if(event.image)Object.assign(event,eventFrame(event,event.image));
      } else if(event.tileId>=384) {
        event.image=resources.get(info.tilesetId)?.image;
        if(event.image){const columns=Math.floor(event.image.width/32),index=event.tileId-384;
          Object.assign(event,{sx:index%columns*32,sy:Math.floor(index/columns)*32,sw:32,sh:32});}
      }
      events.push(event);
    }
    return { canvas, info, scale, missing, tiles: records.length, standingTiles, events };
  }
  async dispose() {
    this.disposed = true;
    for (const value of this.images.values()) (await value)?.close?.();
    this.images.clear();
  }
}
