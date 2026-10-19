// Model axes are X/right, Y/up, Z/depth. Match Model3D's Ry * Rx * Rz
// matrix (Z, then X, then Y); instance yaw is applied afterwards.
export function modelPivot(asset) {
  return ['X', 'Y', 'Z'].map(axis =>
    (Number(asset[`pivot${axis}`]) || 0) + (Number(asset[`meshOffset${axis}`]) || 0));
}

export function rotateModelVertices(asset) {
  const vertices = asset.vertices || [];
  const angles = ['X', 'Y', 'Z'].map(axis => (Number(asset[`rotation${axis}`]) || 0) * Math.PI / 180);
  if (angles.every(angle => angle === 0)) return vertices;
  const [cx, cy, cz] = angles.map(Math.cos), [sx, sy, sz] = angles.map(Math.sin);
  const [px, py, pz] = modelPivot(asset);
  return vertices.map(vertex => {
    const x = vertex[0] - px, y = vertex[1] - py, z = vertex[2] - pz;
    const zx = x * cz - y * sz, zy = x * sz + y * cz;
    const xy = zy * cx - z * sx, xz = zy * sx + z * cx;
    return [px + zx * cy + xz * sy, py + xy, pz - zx * sy + xz * cy];
  });
}
