// The host has a single custom-dialog slot occupied by the 3D workspace.
// Child dialogs belong to that workspace and never replace its scene canvas.
export function createWorkspaceDialogs(root) {
  const dialogs=new Set();
  let disposing=false;
  function show({title,width=420,height=190,render,onCloseRequest}) {
    const previous=document.activeElement;
    const dialog=document.createElement('dialog');dialog.className='ms-workspace-dialog';
    dialog.setAttribute('aria-label',title);dialog.setAttribute('aria-modal','true');
    dialog.style.width=`${width}px`;dialog.style.height=`${height}px`;
    const header=document.createElement('header'),heading=document.createElement('strong'),closeButton=document.createElement('button');
    heading.textContent=title;closeButton.type='button';closeButton.textContent='×';closeButton.setAttribute('aria-label','关闭'+title);
    header.append(heading,closeButton);
    const host=document.createElement('div');host.className='ms-workspace-dialog-body';dialog.append(header,host);
    let cleanup=null,closed=false,drag=null;
    const view=document.defaultView;
    const position=(x,y)=>{
      const rect=dialog.getBoundingClientRect();
      dialog.style.left=`${Math.max(0,Math.min(view.innerWidth-rect.width,x))}px`;
      dialog.style.top=`${Math.max(0,Math.min(view.innerHeight-rect.height,y))}px`;
    };
    const stopDrag=()=>{
      const previousDrag=drag;drag=null;
      if(previousDrag&&header.hasPointerCapture(previousDrag.id))header.releasePointerCapture(previousDrag.id);
    };
    header.addEventListener('pointerdown',event=>{
      if(event.button!==0||event.target.closest('button'))return;
      event.preventDefault();event.stopPropagation();
      const rect=dialog.getBoundingClientRect();
      drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove',event=>{
      if(!drag||drag.id!==event.pointerId)return;
      event.preventDefault();event.stopPropagation();
      position(drag.left+event.clientX-drag.x,drag.top+event.clientY-drag.y);
    });
    for(const name of ['pointerup','pointercancel','lostpointercapture'])header.addEventListener(name,stopDrag);
    const keepVisible=()=>{stopDrag();const rect=dialog.getBoundingClientRect();position(rect.left,rect.top);};
    view.addEventListener('resize',keepVisible);
    const handle={close(){
      if(closed)return;closed=true;dialogs.delete(handle);
      stopDrag();view.removeEventListener('resize',keepVisible);
      dialog.close();cleanup?.();dialog.remove();
      if(!disposing&&root.isConnected){
        const target=previous?.isConnected?previous:root.querySelector('.ms-project');
        target?.focus({preventScroll:true});
      }
    }};
    const requestClose=()=>onCloseRequest?onCloseRequest():handle.close();
    closeButton.onclick=requestClose;
    dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();requestClose();});
    dialog.addEventListener('close',()=>handle.close());
    // Keep Escape and shortcuts out of the parent dialog/map editor. Native
    // modal behavior provides focus containment and blocks background input.
    dialog.addEventListener('keydown',event=>event.stopPropagation());
    dialogs.add(handle);root.append(dialog);
    try{
      cleanup=render(host);dialog.showModal();
      const rect=dialog.getBoundingClientRect();
      position((view.innerWidth-rect.width)/2,(view.innerHeight-rect.height)/2);
    }catch(error){handle.close();throw error;}
    return handle;
  }
  return {show,dispose(){disposing=true;for(const dialog of [...dialogs])dialog.close();}};
}

export const workspaceDialogStyles=`
.ms-workspace-dialog{position:fixed;inset:auto;left:0;top:0;margin:0;box-sizing:border-box;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);padding:0;border:1px solid #666;background:#303030;color:#f2f2f2;box-shadow:0 8px 32px #0009;overflow:hidden}
.ms-workspace-dialog[open]{display:flex;flex-direction:column}.ms-workspace-dialog::backdrop{background:#0006}
.ms-workspace-dialog>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 10px;background:#383838;color:#fff;flex:none;cursor:move;touch-action:none;user-select:none}
.ms-workspace-dialog .ms-resource-text-form{color:#f2f2f2}.ms-workspace-dialog .ms-resource-text-form input{background:#202020;color:#fff;caret-color:#fff;border:1px solid #888}.ms-workspace-dialog .ms-resource-text-form input:focus{outline:2px solid #8bbff1;outline-offset:1px}.ms-workspace-dialog .ms-resource-text-form input::selection{background:#356ba8;color:#fff}
.ms-workspace-dialog-body{flex:1;min-height:0;overflow:auto}.ms-resource-confirm{padding:16px;white-space:pre-wrap}.ms-resource-confirm+.ms-resource-text-actions{padding:0 16px 16px}
`;
