import { repairHierarchy } from './scene-hierarchy.js';
import { normalizeAnimation, normalizeAnimationSpeed } from './model-animation.js';
import {normalizeEffects,normalizeLight} from './visual-effects.js';
import {normalizeFolders,organizeMountainFolders,organizeMountainSubfolders} from './resource-folders.js';
export const SCHEMA_VERSION = 1;
export const TILE_SIZE = 32;

export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function emptyLibrary() {
  return { schemaVersion: SCHEMA_VERSION, folderSchemaVersion:1, mountainGroupingVersion:2, revision: 0, textures: [], assets: [], folders: [] };
}

export function emptyScene(mapId) {
  return { schemaVersion: SCHEMA_VERSION, mapId: Number(mapId) || 0, revision: 0, instances: [], groups: [], effects:normalizeEffects() };
}

export function normalizeLibrary(raw) {
  const result = emptyLibrary();
  if (!raw || !Array.isArray(raw.assets)) return result;
  result.revision = finite(raw.revision);
  result.mountainGroupingVersion = Math.max(0, Math.round(finite(raw.mountainGroupingVersion, 0)));
  result.textures = Array.isArray(raw.textures) ? raw.textures.filter(Boolean).map((texture) => ({
    id: String(texture.id || uid("texture")),
    name:String(texture.name||texture.label||''),
    path: String(texture.path || ""),
    image: String(texture.image || ""),
    width: clamp(Math.round(finite(texture.width, 1)), 1, 8192),
    height: clamp(Math.round(finite(texture.height, 1)), 1, 8192)
  })) : [];
  result.assets = raw.assets.filter(Boolean).map((asset) => {
    const type = asset.type === "billboard" ? "billboard" : "model";
    const normalized = {
      id: String(asset.id || uid("asset")),
      name: String(asset.name || (type === "model" ? "未命名模型" : "未命名立牌")),
      type,
      wind: type === 'billboard' && asset.wind === true,
      category: String(asset.category || '').trim(),
      folderId:String(asset.folderId||''),
      tags: [...new Set((Array.isArray(asset.tags) ? asset.tags : []).map(String).map(t => t.trim()).filter(Boolean))],
      favorite: asset.favorite === true,
      modular: asset.modular === true,
      meshGroup: String(asset.meshGroup || ''),
      rotationGroup:String(asset.rotationGroup||''),
      variantRotation:normalizeAngle(finite(asset.variantRotation)),
      cornerKind: String(asset.cornerKind || ''),
      wallDirections: Array.isArray(asset.wallDirections) ? asset.wallDirections.map(String) : [],
      gridUnits: clamp(finite(asset.gridUnits, 16), .001, 1024),
      collisionDefault: asset.collisionDefault !== false,
      footprintW: clamp(Math.round(finite(asset.footprintW, 1)), 1, 32),
      footprintD: clamp(Math.round(finite(asset.footprintD, 1)), 1, 32),
      pixelHeight: asset.modular === true ? clamp(finite(asset.pixelHeight, 32), 1, 768)
        : clamp(Math.round(finite(asset.pixelHeight, 96)), 16, 768),
      createdAt: asset.createdAt || new Date().toISOString()
    };
    if (type === "billboard") {
      normalized.image = String(asset.image || "");
      normalized.imageWidth = clamp(Math.round(finite(asset.imageWidth, 32)), 1, 8192);
      normalized.imageHeight = clamp(Math.round(finite(asset.imageHeight, 32)), 1, 8192);
    } else {
      normalized.vertices = Array.isArray(asset.vertices)
        ? asset.vertices.map((vertex) => [finite(vertex?.[0]), finite(vertex?.[1]), finite(vertex?.[2])]) : [];
      normalized.uvs = Array.isArray(asset.uvs)
        ? asset.uvs.map((uv) => [finite(uv?.[0]), finite(uv?.[1])]) : [];
      normalized.faces = Array.isArray(asset.faces) ? asset.faces.map((face) => ({
        a: Math.max(0, Math.round(finite(face?.a))), b: Math.max(0, Math.round(finite(face?.b))),
        c: Math.max(0, Math.round(finite(face?.c))), color: normalizeColor(face?.color),
        texture: String(face?.texture || "")
      })).filter((face) => face.a !== face.b && face.b !== face.c && face.a !== face.c) : [];
      normalized.sourceObj = String(asset.sourceObj || "");
      normalized.animation = normalizeAnimation(asset.animation, normalized.vertices.length);
      normalized.generatedNative = asset.generatedNative === true;
      normalized.pivotX = finite(asset.pivotX, 0);
      normalized.pivotY = finite(asset.pivotY, 0);
      normalized.pivotZ = finite(asset.pivotZ, 0);
      normalized.rotationX = finite(asset.rotationX, 0);
      normalized.rotationY = finite(asset.rotationY, 0);
      normalized.rotationZ = finite(asset.rotationZ, 0);
      normalized.meshOffsetX = finite(asset.meshOffsetX, 0);
      normalized.meshOffsetY = finite(asset.meshOffsetY, 0);
      normalized.meshOffsetZ = finite(asset.meshOffsetZ, 0);
    }
    return normalized;
  });
  normalizeFolders(result,raw.folders);
  if(!raw.folderSchemaVersion)organizeMountainFolders(result);
  if(Number(raw.mountainGroupingVersion||0)<2)organizeMountainSubfolders(result);
  return result;
}

export function normalizeScene(raw, mapId) {
  const result = emptyScene(mapId);
  if (!raw || !Array.isArray(raw.instances)) return result;
  result.revision = finite(raw.revision);
  result.effects = normalizeEffects(raw.effects);
  result.instances = raw.instances.filter(Boolean).map((instance, index) => ({
    id: String(instance.id || uid("p3d")), assetId: String(instance.assetId || ""),
    name:String(instance.name||''),parentId:String(instance.parentId||''),locked:!!instance.locked,editorVisible:instance.editorVisible!==false,
    x: finite(instance.x), y: finite(instance.y), rotation: normalizeAngle(finite(instance.rotation)),
    scale: clamp(finite(instance.scale, 1), 0.1, 8), opacity: clamp(Math.round(finite(instance.opacity, 255)), 0, 255),
    footprintW: clamp(Math.round(finite(instance.footprintW, 1)), 1, 32),
    footprintD: clamp(Math.round(finite(instance.footprintD, 1)), 1, 32),
    collision: instance.collision !== false, visible: instance.visible !== false,
    walkable: instance.walkable === true,
    elevation: clamp(finite(instance.elevation, 0), -2048, 2048),
    animationEnabled: instance.animationEnabled !== false,
    animationSpeed: normalizeAnimationSpeed(instance.animationSpeed),
    wind: typeof instance.wind === 'boolean' ? instance.wind : null,
    light: normalizeLight(instance.light),
    order: finite(instance.order, (index + 1) * 1024)
  }));
  result.groups=(Array.isArray(raw.groups)?raw.groups:[]).filter(Boolean).map((group,index)=>({
    id:String(group.id||uid('group')),name:String(group.name||'空物体'),parentId:String(group.parentId||''),group:true,batch:group.batch===true,
    x:finite(group.x),y:finite(group.y),rotation:normalizeAngle(finite(group.rotation)),scale:clamp(finite(group.scale,1),.1,8),
    elevation:clamp(finite(group.elevation,0),-2048,2048),
    footprintW:1,footprintD:1,locked:!!group.locked,editorVisible:group.editorVisible!==false,order:finite(group.order,(index+1)*1024)
  }));
  return repairHierarchy(result);
}

export function normalizeAngle(value) {
  return ((value % 360) + 360) % 360;
}

export function normalizeColor(value) {
  const match = String(value || "").match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toLowerCase()}` : "#b8c0cc";
}

export function parseMtl(text) {
  const colors = new Map();
  colors.textures = new Map();
  let current = "default";
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [command, ...args] = line.split(/\s+/);
    if (command.toLowerCase() === "newmtl") current = args.join(" ") || "default";
    if (command.toLowerCase() === 'map_kd' && args.length && !args[0].startsWith('-')) colors.textures.set(current, args.join(' '));
    if (command.toLowerCase() === "kd" && args.length >= 3) {
      const rgb = args.slice(0, 3).map((entry) => clamp(Math.round(finite(entry) * 255), 0, 255));
      colors.set(current, `#${rgb.map((entry) => entry.toString(16).padStart(2, "0")).join("")}`);
    }
  }
  return colors;
}

export function parseObj(text, materialColors = new Map()) {
  const sourceVertices = [];
  const texcoords = [];
  const vertices = [];
  const uvs = [];
  const faces = [];
  const cornerCache = new Map();
  let material = "default";
  const resolveIndex = (raw, count) => {
    const index = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(index) || index === 0) return null;
    return index > 0 ? index - 1 : count + index;
  };
  const resolveCorner = (raw) => {
    const parts = String(raw).split("/");
    const vertexIndex = resolveIndex(parts[0], sourceVertices.length);
    if (vertexIndex == null || vertexIndex < 0 || vertexIndex >= sourceVertices.length) return null;
    const uvIndex = parts.length > 1 && parts[1] !== ""
      ? resolveIndex(parts[1], texcoords.length) : null;
    const key = `${vertexIndex}/${uvIndex == null ? "" : uvIndex}`;
    if (!cornerCache.has(key)) {
      cornerCache.set(key, vertices.length);
      vertices.push(sourceVertices[vertexIndex].slice());
      uvs.push(uvIndex != null && texcoords[uvIndex] ? texcoords[uvIndex].slice() : [0, 0]);
    }
    return cornerCache.get(key);
  };
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [command, ...args] = line.split(/\s+/);
    if (command === "v" && args.length >= 3) {
      sourceVertices.push([finite(args[0]), finite(args[1]), finite(args[2])]);
    } else if (command === "vt" && args.length >= 2) {
      texcoords.push([finite(args[0]), finite(args[1])]);
    } else if (command === "usemtl") {
      material = args.join(" ") || "default";
    } else if (command === "f" && args.length >= 3) {
      const indices = args.map(resolveCorner);
      if (indices.length < 3 || indices.some((entry) => entry == null || entry < 0 || entry >= vertices.length)) continue;
      const color = materialColors.get(material) || colorFromName(material);
      for (let i = 1; i < indices.length - 1; i++) {
        faces.push({ a: indices[0], b: indices[i], c: indices[i + 1], color, material });
      }
    }
  }
  if (!vertices.length || !faces.length) throw new Error("OBJ 必须至少包含一组顶点(v)和面(f)。");
  const xs = vertices.map((v) => v[0]), ys = vertices.map((v) => v[1]), zs = vertices.map((v) => v[2]);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  const floorY = Math.min(...ys);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - floorY;
  const depth = Math.max(...zs) - Math.min(...zs);
  const horizontalTolerance = Math.max(width, depth, 1) * 0.02;
  const verticalTolerance = Math.min(Math.max(height * 0.02, 0.10), 1.0);
  const authoredOrigin = 0 >= Math.min(...xs) - horizontalTolerance &&
    0 <= Math.max(...xs) + horizontalTolerance &&
    0 >= Math.min(...zs) - horizontalTolerance &&
    0 <= Math.max(...zs) + horizontalTolerance &&
    Math.abs(floorY) <= verticalTolerance;
  const sourcePivot = authoredOrigin ? [0, 0, 0] : [centerX, floorY, centerZ];
  const meshOffset = [-centerX, -floorY, -centerZ];
  const centered = vertices.map((v) => [round(v[0] - centerX), round(v[1] - floorY), round(v[2] - centerZ)]);
  return {
    vertices: centered,
    uvs: uvs.map((uv) => [round(uv[0]), round(uv[1])]),
    faces,
    // Runtime Model3D uses source OBJ coordinates, while the editor stores a
    // centred copy. Keeping both values makes their rotation axes identical.
    pivot: sourcePivot.map(round),
    meshOffset: meshOffset.map(round),
    bounds: meshBounds(centered)
  };
}

export function meshBounds(vertices) {
  if (!vertices.length) return { width: 0, height: 0, depth: 0 };
  const axis = (index) => vertices.map((vertex) => vertex[index]);
  const xs = axis(0), ys = axis(1), zs = axis(2);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), depth: Math.max(...zs) - Math.min(...zs) };
}

export function colorFromName(name) {
  let hash = 2166136261;
  for (const character of String(name || "default")) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const hue = ((hash >>> 0) % 360) / 360;
  const [r, g, b] = hslToRgb(hue, 0.38, 0.58);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function hslToRgb(h, s, l) {
  const channel = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)].map((value) => Math.round(value * 255));
}

const round = (value) => Math.round(value * 1e5) / 1e5;

export function instanceBounds(instance, asset) {
  const width = (asset?.footprintW || instance.footprintW || 1) * TILE_SIZE;
  const depth = (asset?.footprintD || instance.footprintD || 1) * TILE_SIZE;
  const height = (asset?.pixelHeight || 96) * (instance.scale || 1);
  const visualWidth = asset?.type === "billboard" && asset.imageHeight
    ? height * asset.imageWidth / asset.imageHeight : Math.max(width, height * 0.8);
  const anchorX = instance.x + instance.footprintW * TILE_SIZE / 2;
  const anchorY = asset?.type === "model"
    ? instance.y + instance.footprintD * TILE_SIZE / 2
    : instance.y + instance.footprintD * TILE_SIZE;
  return { x: Math.min(instance.x, anchorX - visualWidth / 2), y: anchorY - height,
    w: Math.max(width, visualWidth), h: height + depth };
}

export function hitTest(instances, assets, x, y) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return [...instances].reverse().find((instance) => {
    const bounds = instanceBounds(instance, byId.get(instance.assetId));
    return x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.w && y < bounds.y + bounds.h;
  }) || null;
}
