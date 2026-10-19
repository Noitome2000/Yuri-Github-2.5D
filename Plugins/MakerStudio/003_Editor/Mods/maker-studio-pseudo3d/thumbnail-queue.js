// Run at most one expensive raster job per animation frame. Keys deduplicate
// texture completion and visibility notifications; detached cards do no work.
export function createThumbnailQueue(schedule = requestAnimationFrame, cancel = cancelAnimationFrame) {
  const jobs=new Map();let frame=null;
  const run=()=>{frame=null;for(const [key,job] of jobs){jobs.delete(key);if(!key.isConnected)continue;job();break;}if(jobs.size)frame=schedule(run);};
  return {enqueue(key,job){jobs.set(key,job);if(frame==null)frame=schedule(run);},
    clear(){jobs.clear();if(frame!=null)cancel(frame);frame=null;}};
}
