export const TILE_SIZE = 32;
export const SCHEMA_VERSION = 2;
export const DIRECTIONS = ["north", "east", "south", "west"];
export const CORNERS = ["north_west", "north_east", "south_east", "south_west"];
export const EDGE_STYLES = ["hard", "soft", "round"];
export const CELL_TYPES = ["solid", "overpass"];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const cellKey = (x, y) => `${Math.trunc(x)},${Math.trunc(y)}`;

export function emptyTerrain(mapId) {
  return { schemaVersion: SCHEMA_VERSION, mapId: Number(mapId) || 0, revision: 0,
    heightStep: 16, cells: {} };
}

export function isCornerSlope(slope) {
  return typeof slope === "string" && /^(outer|inner)_(north|south)_(east|west)$/.test(slope);
}

export function normalizeCell(value) {
  if (!value || typeof value !== "object") return null;
  const height = clamp(Math.round(finite(value.height)), 0, 32);
  const slope = DIRECTIONS.includes(value.slope) || isCornerSlope(value.slope) ? value.slope : null;
  const type = value.type === "overpass" && height > 0 ? "overpass" : "solid";
  const style = EDGE_STYLES.includes(value.style) ? value.style : "hard";
  if (height <= 0 && !slope) return null;
  const cell = { height };
  if (slope) cell.slope = slope;
  if (type !== "solid") cell.type = type;
  if (style !== "hard") cell.style = style;
  return cell;
}

export function normalizeTerrain(raw, mapId) {
  const result = emptyTerrain(mapId);
  if (!raw || typeof raw !== "object") return result;
  result.revision = Math.max(0, Math.trunc(finite(raw.revision)));
  result.heightStep = clamp(Math.round(finite(raw.heightStep, 16)), 4, 64);
  const source = raw.cells && typeof raw.cells === "object" ? raw.cells : {};
  for (const [key, value] of Object.entries(source)) {
    const match = /^(\d+),(\d+)$/.exec(key);
    if (!match) continue;
    const cell = normalizeCell(value);
    if (cell) result.cells[key] = cell;
  }
  return result;
}

// Corner order: northwest, northeast, southwest, southeast.
export function cornerHeights(cell) {
  const h = Math.max(0, Number(cell?.height) || 0);
  switch (cell?.slope) {
  case "north": return [h + 1, h + 1, h, h];
  case "east": return [h, h + 1, h, h + 1];
  case "south": return [h, h, h + 1, h + 1];
  case "west": return [h + 1, h, h + 1, h];
  case "outer_north_west": return [h + 1, h, h, h];
  case "outer_north_east": return [h, h + 1, h, h];
  case "outer_south_west": return [h, h, h + 1, h];
  case "outer_south_east": return [h, h, h, h + 1];
  case "inner_north_west": return [h, h + 1, h + 1, h + 1];
  case "inner_north_east": return [h + 1, h, h + 1, h + 1];
  case "inner_south_west": return [h + 1, h + 1, h, h + 1];
  case "inner_south_east": return [h + 1, h + 1, h + 1, h];
  default: return [h, h, h, h];
  }
}

export function centerHeight(cell) {
  const h = Math.max(0, Number(cell?.height) || 0);
  if (cell?.slope?.startsWith("outer_")) return h + 1 - Math.SQRT1_2;
  if (cell?.slope?.startsWith("inner_")) return h + Math.SQRT1_2;
  const corners = cornerHeights(cell);
  return corners.reduce((sum, value) => sum + value, 0) / 4;
}

export function edgeHeight(cell, direction) {
  const [nw, ne, sw, se] = cornerHeights(cell);
  if (direction === "north") return (nw + ne) / 2;
  if (direction === "east") return (ne + se) / 2;
  if (direction === "south") return (sw + se) / 2;
  return (nw + sw) / 2;
}

export function edgeSurfaces(cell, direction) {
  const top = edgeHeight(cell, direction);
  return cell?.type === "overpass" ? [0, top] : [top];
}

export function canTransition(fromCell, toCell, direction) {
  const opposite = { north: "south", east: "west", south: "north", west: "east" };
  return edgeSurfaces(fromCell, direction).some((from) =>
    edgeSurfaces(toCell, opposite[direction]).some((to) => Math.abs(from - to) < 0.001));
}
