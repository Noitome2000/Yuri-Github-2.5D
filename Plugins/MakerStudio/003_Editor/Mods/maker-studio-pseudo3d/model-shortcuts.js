// The host's window capture listener stops native edit shortcuts before later
// mod listeners run. Register through its dispatcher while this layer owns them.
export function createModelShortcuts(api, enabled, handlers) {
  let registrations = [], disposed = false;
  function clear() {
    for (const item of registrations) {
      if (typeof item === 'function') item();
      else item?.dispose?.();
    }
    registrations = [];
  }
  function sync() {
    if (disposed || !enabled()) { clear(); return; }
    if (registrations.length || typeof api.ui.registerShortcut !== 'function') return;
    for (const [key, handler] of Object.entries(handlers)) {
      registrations.push(api.ui.registerShortcut(key, () => {
        if (!enabled()) { sync(); return; }
        const target = document.activeElement;
        if (target?.closest?.("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
        handler();
      }));
    }
  }
  return {sync,dispose(){disposed=true;clear();}};
}
