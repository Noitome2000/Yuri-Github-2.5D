// Menus live inside the dialog's top layer. One owner handles dismissal and
// keyboard navigation; disposal on close/unload removes every listener.
export function createResourceMenu(root,kind='resource') {
  let menu = null, previous = null;
  function close(restore = false) {
    menu?.remove(); menu = null;
    if (restore && previous?.isConnected) previous.focus();
  }
  function outside(event) { if (menu && !menu.contains(event.target)) close(); }
  function key(event) {
    if (!menu) return;
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape' || event.key === 'Tab') { close(true); return; }
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 :
      (i + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  }
  root.addEventListener('pointerdown', outside, true);
  root.addEventListener('keydown', key, true);
  // Focusing an item can scroll its containing dock; that is not a click
  // outside the menu and must not dismiss keyboard navigation.
  return {
    open(event, entries) {
      event.preventDefault(); event.stopPropagation(); close(); previous = document.activeElement;
      menu = document.createElement('div'); menu.className = 'ms-resource-menu'; menu.setAttribute('role', 'menu');
      menu.dataset.menuKind=kind;
      for (const entry of entries) {
        if (!entry) { const divider = document.createElement('hr'); menu.append(divider); continue; }
        const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem');
        item.textContent = entry.label; item.disabled = !!entry.disabled;
        item.onclick = () => { close(true); entry.run(); }; menu.append(item);
      }
      root.append(menu);
      const rect = menu.getBoundingClientRect();
      const anchor = event.target?.getBoundingClientRect?.();
      const x = event.clientX || anchor?.left || 10, y = event.clientY || anchor?.bottom || 10;
      menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth-rect.width-4))}px`;
      menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight-rect.height-4))}px`;
      menu.querySelector('button:not(:disabled)')?.focus();
    },
    close,
    dispose() { close(); root.removeEventListener('pointerdown', outside, true); root.removeEventListener('keydown', key, true); }
  };
}

export const resourceStyles = `
.ms-resource-menu{position:fixed;z-index:1000;min-width:225px;max-height:90vh;overflow:auto;padding:4px;background:#303030;border:1px solid #666;box-shadow:0 5px 22px #0009}
.ms-resource-menu button{display:block!important;width:100%;text-align:left;border:0!important;background:transparent!important;padding:7px 12px!important}
.ms-resource-menu button:hover:not(:disabled),.ms-resource-menu button:focus{background:#486b91!important;outline:none}
.ms-resource-menu hr{border:0;border-top:1px solid #555;margin:4px}
.msp3d-asset.is-selected{outline:2px solid #528ac5;outline-offset:-2px;background:#34485c!important}.msp3d-asset.is-cut{opacity:.5}
.ms-project.is-list .msp3d-assets{display:flex!important;flex-direction:column;gap:2px}.ms-project.is-list .msp3d-asset{height:45px!important;min-height:45px;flex-direction:row!important;align-items:center}
.ms-project.is-list .msp3d-preview{width:55px!important;height:42px!important}.ms-project.is-list .msp3d-asset-meta{flex:1;flex-direction:row}.ms-project.is-list .msp3d-asset-meta strong{white-space:nowrap}
.ms-texture-row{display:flex;flex-direction:column;gap:5px;padding:8px;border:1px solid #555}.ms-texture-row img{width:100%;height:100px;object-fit:contain;image-rendering:pixelated;background:repeating-conic-gradient(#444 0% 25%,#666 0% 50%) 50% / 16px 16px}
.ms-texture-row select{width:100%;background:#383838;color:#eee;min-height:28px}.ms-texture-actions{display:flex;gap:4px;flex-wrap:wrap}.ms-variant-picker{width:100%;background:#383838;color:#eee;padding:6px}
.ms-texture-row{display:grid;grid-template-columns:64px minmax(0,1fr)}.ms-texture-row>strong,.ms-texture-actions{grid-column:1/-1}.ms-texture-row img{grid-column:1;grid-row:2/4;width:64px;height:64px;cursor:pointer}.ms-texture-input{grid-column:2;grid-row:2;display:flex;flex-direction:column;gap:3px;font-size:11px}.ms-texture-row>small{grid-column:2;grid-row:3;color:#aaa}
.ms-resource-text-form{display:flex;flex-direction:column;gap:10px;padding:16px}.ms-resource-text-form input{padding:8px}.ms-resource-text-actions{display:flex;gap:8px;justify-content:flex-end}
`;
