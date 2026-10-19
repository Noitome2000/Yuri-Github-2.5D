// Converted rigid-node clips. Bounds stay fixed for the complete animation.
export function normalizeAnimation(raw, vertexCount) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.frames) || raw.frames.length < 2 || raw.frames.length > 180) return null;
  const validVertices = vertices => Array.isArray(vertices) && vertices.length === vertexCount && vertices.every(v =>
    Array.isArray(v) && v.length === 3 && v.every(Number.isFinite));
  if (!Number.isFinite(raw.fps) || raw.fps <= 0 || raw.fps > 60 ||
      !raw.frames.every(f => typeof f?.sourceObj === 'string' && f.sourceObj && validVertices(f.vertices)) ||
      !Array.isArray(raw.bounds) || raw.bounds.length !== 2 ||
      !raw.bounds.every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) return null;
  return { version:1, name:String(raw.name || '循环动画'), fps:raw.fps,
    sourceFps:raw.sourceFps, sourceFrames:raw.sourceFrames, bounds:raw.bounds, frames:raw.frames };
}

export function normalizeAnimationSpeed(value) {
  const speed = value == null || value === '' ? 1 : Number(value);
  return Number.isFinite(speed) ? Math.max(0.1, Math.min(4, speed)) : 1;
}

export function animationFrameIndex(asset, instance, seconds) {
  const clip = asset.animation;
  if (!clip || instance.animationEnabled === false) return 0;
  return Math.floor(Math.max(0, seconds) * normalizeAnimationSpeed(instance.animationSpeed) * clip.fps) % clip.frames.length;
}

const frameAssets = new WeakMap();
export function advanceAnimationClock(clock, instance, now) {
  const elapsed = clock.last == null ? 0 : Math.max(0, now - clock.last);
  clock.last = now;
  clock.seconds = instance.animationEnabled === false ? 0 :
    (clock.seconds || 0) + elapsed * normalizeAnimationSpeed(instance.animationSpeed);
  return clock.seconds;
}

export function animatedAsset(asset, instance, seconds) {
  const clip = asset.animation;
  if (!clip) return asset;
  const index = animationFrameIndex(asset, instance, seconds);
  let cached = frameAssets.get(asset);
  if (!cached) { cached = []; frameAssets.set(asset, cached); }
  return cached[index] ||= { ...asset, vertices:clip.frames[index].vertices, sourceObj:clip.frames[index].sourceObj };
}
