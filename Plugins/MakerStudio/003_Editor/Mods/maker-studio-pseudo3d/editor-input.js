// Some Maker Studio builds register tools without dispatching canvas input.
// Wrap native callbacks and bridge only events that the host has not delivered.
export function connectMapInput(api, definition, options = {}) {
  const seen = new WeakSet();
  let captured = null;
  let lastEvent = null;
  const focusedCanvases = new Set();
  const active = () => api.editor.activeTool?.() === definition.id &&
    (options.isActive?.() ?? true);
  const wrapped = { ...definition };
  for (const name of ["onPointerDown", "onPointerMove", "onPointerUp"]) {
    wrapped[name] = (event) => {
      if (!active()) { finish(); return; }
      const original = event.originalEvent;
      if (original) {
        if (seen.has(original)) return;
        seen.add(original);
      }
      definition[name]?.(event);
    };
  }
  wrapped.onDeactivate = () => { finish(); definition.onDeactivate?.(); };
  const canvasFor = (event) => event.target?.closest?.("canvas.map-canvas");
  const convert = (event, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const viewport = api.editor.viewport?.() || { x: 0, y: 0, zoom: 1 };
    const canvasX = (event.clientX - rect.left) * canvas.width / Math.max(1, rect.width);
    const canvasY = (event.clientY - rect.top) * canvas.height / Math.max(1, rect.height);
    const worldX = (canvasX + viewport.x) / (viewport.zoom || 1);
    const worldY = (canvasY + viewport.y) / (viewport.zoom || 1);
    return { mapId: api.editor.activeMapId(), worldX, worldY,
      tileX: Math.floor(worldX / 32), tileY: Math.floor(worldY / 32),
      button: event.button, buttons: event.buttons, pointerId: event.pointerId,
      altKey: event.altKey, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, originalEvent: event };
  };
  const down = (event) => {
    if (!active() || event.button !== 0) return;
    const canvas = canvasFor(event);
    if (!canvas) return;
    if (options.focusCanvas) {
      if (!canvas.hasAttribute('tabindex')) { canvas.tabIndex=-1; focusedCanvases.add(canvas); }
      canvas.focus({preventScroll:true});
    }
    captured = canvas;
    // Prevent compatibility mousedown from starting a native tile operation.
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    lastEvent = convert(event, canvas);
    wrapped.onPointerDown(lastEvent);
  };
  const move = (event) => {
    if (!active()) { finish(); return; }
    const canvas = captured || canvasFor(event);
    if (!canvas) return;
    lastEvent = convert(event, canvas);
    if (captured && !(event.buttons & 1)) { finish(); return; }
    wrapped.onPointerMove(lastEvent);
  };
  const up = (event) => {
    if (!captured || event.button !== 0) return;
    lastEvent = convert(event, captured);
    releaseCapture();
    wrapped.onPointerUp(lastEvent);
  };
  const releaseCapture = () => {
    const canvas = captured;
    captured = null;
    const pointerId = lastEvent?.pointerId;
    if (canvas?.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
  };
  const finish = () => {
    const pending = captured;
    releaseCapture();
    if (pending) definition.onPointerUp?.({ ...lastEvent, button: 0, buttons: 0, originalEvent: null });
  };
  const blockMouse = (event) => {
    if (!active()) { finish(); return; }
    if (options.isolate && event.type === 'mousemove' && (event.buttons & 6)) return;
    if (active() && (captured || canvasFor(event)) &&
        (event.button === 0 || event.buttons & 1 || (options.isolate && event.type === 'mousemove'))) event.stopPropagation();
  };
  api.tools.registerTool(wrapped);
  const listeners = [["pointerdown", down], ["pointermove", move], ["pointerup", up],
    ["pointercancel", finish], ["blur", finish], ["mousedown", blockMouse], ["mouseup", blockMouse]];
  if (options.isolate) listeners.push(['mousemove',blockMouse]);
  for (const [name, handler] of listeners) window.addEventListener(name, handler, true);
  const disconnect = () => {
    finish();
    for (const [name, handler] of listeners) window.removeEventListener(name, handler, true);
    for (const canvas of focusedCanvases) if (canvas.getAttribute('tabindex')==='-1') canvas.removeAttribute('tabindex');
    focusedCanvases.clear();
  };
  disconnect.finish = finish;
  return disconnect;
}

export function lineCells(from, to) {
  if (!from) return [to];
  const cells = [];
  let x = from.x, y = from.y;
  const dx = Math.abs(to.x - x), dy = -Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1, sy = y < to.y ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) break;
    const twice = error * 2;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
  return cells;
}

// The same older builds expose registerOverlay but never invoke its render
// callback. A transparent sibling canvas supplies that missing presentation.
export function connectMapOverlay(api, render, options = {}) {
  if (!options.independent && typeof api.ui.registerSceneProvider === "function") return () => {};
  let native = null, overlay = null, frame = null;
  const resize = new ResizeObserver(() => schedule());
  const draw = () => {
    frame = null;
    const current = document.querySelector("canvas.map-canvas");
    if (current !== native) {
      resize.disconnect(); overlay?.remove(); overlay = null; native = current;
      if (native) {
        overlay = document.createElement("canvas");
        overlay.className = "maker-map-plugin-overlay";
        overlay.style.cssText = "position:absolute;pointer-events:none;z-index:2;";
        native.parentElement.append(overlay); resize.observe(native);
      }
    }
    if (!native || !overlay) return;
    const rect = native.getBoundingClientRect();
    if (overlay.width !== native.width) overlay.width = native.width;
    if (overlay.height !== native.height) overlay.height = native.height;
    overlay.style.left = `${native.offsetLeft}px`; overlay.style.top = `${native.offsetTop}px`;
    overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const viewport = api.editor.viewport?.() || { x: 0, y: 0, zoom: 1 };
    render(ctx, { mapId: api.editor.activeMapId(), zoom: viewport.zoom,
      viewportX: viewport.x, viewportY: viewport.y, tileSize: 32 * viewport.zoom });
  };
  const schedule = () => { if (frame == null) frame = requestAnimationFrame(draw); };
  // Native mousemove queues the viewport commit in RAF. Listening at window
  // bubble phase queues us after that commit, so we draw the current viewport
  // in the same frame instead of waiting for mouseup or unrelated DOM changes.
  const navigationMove = event => {
    if(event.buttons && event.target?.closest?.('canvas.map-canvas,.map-canvas-container,.minimap')) {
      // pointermove may already have queued a hover paint before the host's
      // compatibility mousemove commits its pan. Move that paint behind it.
      if(frame!=null)cancelAnimationFrame(frame);
      frame=requestAnimationFrame(draw);
    }
  };
  if(options.independent)for(const name of ['mousedown','mousemove'])window.addEventListener(name,navigationMove);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  const events = ["mod:requestRedraw", "pointerup", "wheel", "resize"];
  if (options.event) events.push(options.event);
  if (!options.independent) events.push('pointermove');
  for (const name of events) window.addEventListener(name, schedule);
  schedule();
  const dispose = () => {
    observer.disconnect(); resize.disconnect();
    if (frame != null) cancelAnimationFrame(frame);
    for (const name of events) window.removeEventListener(name, schedule);
    if(options.independent)for(const name of ['mousedown','mousemove'])window.removeEventListener(name,navigationMove);
    overlay?.remove();
  };
  dispose.redraw = schedule;
  return dispose;
}
