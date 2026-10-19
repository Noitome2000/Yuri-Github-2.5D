const DIRECTORY='Data/MakerStudioPseudo3D/.recycle-requests';
const LIBRARY='Data/MakerStudioPseudo3D/library.json';
const HELPER='Plugins/MakerStudio/003_Editor/Mods/maker-studio-pseudo3d/RecycleResources.exe';
export async function runResourceRecycle(api,invoke,request){
  const root=api.editor.gameRoot?.();
  if(!root||!invoke)throw Error('当前宿主无法启动 Windows 回收站操作。');
  const text=await api.fs.readProjectFile(LIBRARY);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  const expectedHash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  const id=crypto.randomUUID();
  await api.fs.projectMkdir(DIRECTORY);
  await api.fs.writeProjectFile(`${DIRECTORY}/request-${id}.json`,JSON.stringify({...request,expectedHash,createdUtc:new Date().toISOString()}));
  await invoke('open_path',{path:`${root.replace(/\\/g,'/')}/${HELPER}`});
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    let result;
    try{result=JSON.parse(await api.fs.readProjectFile(`${DIRECTORY}/result-${id}.json`));}catch{/* The one-shot native helper has not returned yet. */}
    if(result){
      if(!result.ok)throw Error(result.error||'系统回收站操作失败。');
      return {result,library:JSON.parse(await api.fs.readProjectFile(LIBRARY))};
    }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw Error('回收站操作尚未返回。请重新打开编辑器核对结果，避免重复操作。');
}
