import { clamp, normalizeColor } from "./core.js";
import { ScenePainter } from './scene-painter.js';
import { modelPivot, rotateModelVertices } from './model-transform.js';

let modelPainter = null;
export function disposeModelRenderer() { modelPainter?.dispose(); modelPainter = null; }

const LIGHT = [-0.45, 0.78, -0.43];
const AMBIENT = 0.38;
// Creating a CanvasPattern is surprisingly expensive in Chromium. Models and
// map tiles reuse the same source image across many faces, so keep one pattern
// per rendering context and image instead of allocating one for every triangle.
const patternCache = new WeakMap();
export const MAP_PREVIEW_PITCH = 60;
export const MODEL_PERSPECTIVE_DISTANCE = 3.5;

export function modelUnitScale(asset) {
  const vertices = asset.animation?.bounds || asset.vertices || [];
  if (!vertices.length) return 1;
  const spans = [0, 1, 2].map(axis => {
    const values = vertices.map(v => v[axis]);
    return Math.max(...values) - Math.min(...values);
  });
  const height = spans[1] > 0.001 ? spans[1] : Math.max(...spans, 0.001);
  // World scale is independent of viewing angle and projected bounding box.
  return clamp(Number(asset.pixelHeight) || 96, asset.modular ? 1 : 16, 768) / height;
}

export function renderModel(asset, rotation = 0, textures = new Map(), pitch = MAP_PREVIEW_PITCH) {
  const pivot = modelPivot(asset);
  const transformed = transformVertices(rotateModelVertices(asset), rotation, pivot);
  if (!transformed.length) return null;
  const radius = Math.max(...asset.vertices.map(v => Math.hypot(...v.map((n, i) => n - pivot[i]))), .001);
  const projection = projectGeometry(transformed, pitch, MODEL_PERSPECTIVE_DISTANCE, [pivot],
    radius * 2 + Math.hypot(...pivot));
  const projected = projection.vertices;
  const projectedPivot = projection.anchors[0];
  const xs = projected.map((point) => point[0]);
  const ys = projected.map((point) => point[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rawWidth = Math.max(0.001, maxX - minX);
  const rawHeight = Math.max(0.001, maxY - minY);
  const scale = Math.min(modelUnitScale(asset), 280 / radius);
  const margin = 8;
  const canvas = document.createElement("canvas");
  canvas.width = clamp(Math.ceil(rawWidth * scale) + margin * 2, 8, 768);
  canvas.height = clamp(Math.ceil(rawHeight * scale) + margin * 2, 8, 768);
  const points = projected.map(([x, y, z]) => [(x - minX) * scale + margin, (y - minY) * scale + margin, z]);
  canvas.makerPivotX = (projectedPivot[0] - minX) * scale + margin;
  canvas.makerPivotY = (projectedPivot[1] - minY) * scale + margin;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(0,0,0,.22)";
  ctx.beginPath();
  ctx.ellipse(canvas.width / 2, canvas.height - 5, Math.min(canvas.width * 0.4, Math.max(7, rawWidth * scale * 0.42)), 5, 0, 0, Math.PI * 2);
  ctx.fill();
  modelPainter ||= new ScenePainter(drawTexturedTriangle);
  modelPainter.reverseDepth = true;
  modelPainter.gpu = modelPainter.begin(ctx);
  const faces = (asset.faces || []).map((face, index) => {
    const vertices = [transformed[face.a], transformed[face.b], transformed[face.c]];
    if (vertices.some((entry) => !entry)) return null;
    const depth = [face.a, face.b, face.c]
      .reduce((sum, vertexIndex) => sum + projected[vertexIndex][2], 0) / 3;
    return { face, index, vertices, depth };
  }).filter(Boolean).sort((a, b) => b.depth - a.depth || a.index - b.index);
  for (const entry of faces) {
    const { face, vertices } = entry;
    const triangle = [points[face.a], points[face.b], points[face.c]];
    if (triangle.some((point) => !point)) continue;
    const image = textures.get(face.texture);
    const uvs = [asset.uvs?.[face.a], asset.uvs?.[face.b], asset.uvs?.[face.c]];
    const light = faceBrightness(vertices[0], vertices[1], vertices[2]);
    if (image?.complete && image.naturalWidth && uvs.every(Boolean)) {
      const channel = Math.round((0.78 + light * 0.22) * 255);
      modelPainter.triangle(triangle,image,uvs,`rgb(${channel},${channel},${channel})`);
    } else {
      modelPainter.triangle(triangle,null,null,shade(face.color, vertices[0], vertices[1], vertices[2]));
    }
  }
  modelPainter.end();
  return canvas;
}

function trianglePath(ctx, triangle) {
  ctx.beginPath();
  ctx.moveTo(triangle[0][0], triangle[0][1]);
  ctx.lineTo(triangle[1][0], triangle[1][1]);
  ctx.lineTo(triangle[2][0], triangle[2][1]);
  ctx.closePath();
}

export function drawTexturedTriangle(ctx, image, triangle, uvs, light) {
  const imageWidth = image.naturalWidth || image.width, imageHeight = image.naturalHeight || image.height;
  const source = uvs.map(([u, v]) => [Number(u) * imageWidth, (1 - Number(v)) * imageHeight]);
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = triangle;
  const denominator = s0[0] * (s1[1] - s2[1]) + s1[0] * (s2[1] - s0[1]) + s2[0] * (s0[1] - s1[1]);
  if (Math.abs(denominator) < 1e-8) return;
  const matrix = (axis) => [
    (d0[axis] * (s1[1] - s2[1]) + d1[axis] * (s2[1] - s0[1]) + d2[axis] * (s0[1] - s1[1])) / denominator,
    (d0[axis] * (s2[0] - s1[0]) + d1[axis] * (s0[0] - s2[0]) + d2[axis] * (s1[0] - s0[0])) / denominator,
    (d0[axis] * (s1[0] * s2[1] - s2[0] * s1[1]) +
      d1[axis] * (s2[0] * s0[1] - s0[0] * s2[1]) +
      d2[axis] * (s0[0] * s1[1] - s1[0] * s0[1])) / denominator
  ];
  const x = matrix(0), y = matrix(1);
  // Canvas anti-aliases every clipped triangle independently. Quads and other
  // triangulated faces would otherwise show a one-pixel transparent diagonal.
  const expandedTriangle = expandTriangle(triangle, 0.65);
  ctx.save();
  trianglePath(ctx, expandedTriangle);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.transform(x[0], y[0], x[1], y[1], x[2], y[2]);
  let patterns = patternCache.get(ctx);
  if (!patterns) { patterns = new WeakMap(); patternCache.set(ctx, patterns); }
  let pattern = patterns.get(image);
  if (!pattern) {
    pattern = ctx.createPattern(image, "repeat");
    if (pattern) patterns.set(image, pattern);
  }
  if (pattern) {
    const minX = Math.floor(Math.min(...source.map((point) => point[0])) / imageWidth) * imageWidth;
    const minY = Math.floor(Math.min(...source.map((point) => point[1])) / imageHeight) * imageHeight;
    const maxX = Math.ceil(Math.max(...source.map((point) => point[0])) / imageWidth) * imageWidth;
    const maxY = Math.ceil(Math.max(...source.map((point) => point[1])) / imageHeight) * imageHeight;
    ctx.fillStyle = pattern;
    ctx.fillRect(minX, minY, Math.max(imageWidth, maxX - minX), Math.max(imageHeight, maxY - minY));
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (light < 0.999) {
    ctx.fillStyle = `rgba(0,0,0,${1 - light})`;
    trianglePath(ctx, expandedTriangle);
    ctx.fill();
  }
  ctx.restore();
}

function expandTriangle(triangle, amount) {
  const center = triangle.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]
  ).map((value) => value / triangle.length);
  return triangle.map(([x, y]) => {
    const dx = x - center[0], dy = y - center[1];
    const length = Math.hypot(dx, dy) || 1;
    return [x + dx / length * amount, y + dy / length * amount];
  });
}

export function transformVertices(vertices, rotation, pivot = [0, 0, 0]) {
  const radians = Number(rotation || 0) * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const px = Number(pivot?.[0]) || 0;
  const pz = Number(pivot?.[2]) || 0;
  return vertices.map((vertex) => {
    const x = Number(vertex[0]) || 0, y = Number(vertex[1]) || 0, z = Number(vertex[2]) || 0;
    const relativeX = x - px, relativeZ = z - pz;
    return [px + relativeX * cos - relativeZ * sin, y,
      pz + relativeX * sin + relativeZ * cos];
  });
}

export function projectVertices(vertices, pitch = MAP_PREVIEW_PITCH,
  perspectiveDistance = MODEL_PERSPECTIVE_DISTANCE) {
  return projectGeometry(vertices, pitch, perspectiveDistance).vertices;
}

function projectGeometry(vertices, pitch = MAP_PREVIEW_PITCH,
  perspectiveDistance = MODEL_PERSPECTIVE_DISTANCE, anchors = [], fixedExtent = null) {
  if (!vertices.length) return { vertices: [], anchors: [] };
  const radians = clamp(Number(pitch) || MAP_PREVIEW_PITCH, 5, 85) * Math.PI / 180;
  const pitchCos = Math.cos(radians), pitchSin = Math.sin(radians);
  const spans = [0, 1, 2].map((axis) => {
    const values = vertices.map((point) => Number(point[axis]) || 0);
    return Math.max(...values) - Math.min(...values);
  });
  const extent = fixedExtent || Math.max(...spans, 0.001);
  let distance = extent * Math.max(Number(perspectiveDistance) || MODEL_PERSPECTIVE_DISTANCE, 1.5);
  const cameraPoints = vertices.map(([rawX, rawY, rawZ]) => {
    const x = Number(rawX) || 0, y = Number(rawY) || 0, z = Number(rawZ) || 0;
    return [x, -y * pitchCos + z * pitchSin, y * pitchSin + z * pitchCos];
  });
  const anchorCameraPoints = anchors.map(([rawX, rawY, rawZ]) => {
    const x = Number(rawX) || 0, y = Number(rawY) || 0, z = Number(rawZ) || 0;
    return [x, -y * pitchCos + z * pitchSin, y * pitchSin + z * pitchCos];
  });
  distance = Math.max(distance, Math.max(...cameraPoints.map((point) => point[2])) + extent * 0.35);
  const project = ([x, y, viewDepth]) => {
    const cameraDepth = Math.max(distance - viewDepth, 0.001);
    const factor = distance / cameraDepth;
    return [x * factor, y * factor, cameraDepth];
  };
  return {
    vertices: cameraPoints.map(project),
    anchors: anchorCameraPoints.map(project)
  };
}

export function shade(rawColor, a, b, c) {
  const brightness = faceBrightness(a, b, c);
  const hex = normalizeColor(rawColor).slice(1);
  const channels = [0, 2, 4].map((offset) => Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * brightness));
  return `rgb(${channels.join(",")})`;
}

export function faceBrightness(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...normal);
  const diffuse = length < 1e-7 ? 0 : Math.abs(normal.reduce((sum, value, index) => sum + value * LIGHT[index], 0) / length);
  return AMBIENT + (1 - AMBIENT) * diffuse;
}

export function drawAssetPreview(canvas, asset, modelCanvas, billboardImage) {
  const width = 136, height = 92;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(0,0,0,.17)";
  ctx.fillRect(0, 0, width, height);
  const source = asset.type === "model" ? modelCanvas : billboardImage;
  if (!source?.width || !source?.height) return;
  const scale = Math.min((width - 12) / source.width, (height - 12) / source.height, 2);
  const drawWidth = source.width * scale, drawHeight = source.height * scale;
  ctx.imageSmoothingEnabled = asset.type !== "billboard";
  ctx.drawImage(source, (width - drawWidth) / 2, height - drawHeight - 5, drawWidth, drawHeight);
}
