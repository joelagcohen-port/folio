type BadgeApi = { setAppBadge?: (count:number)=>Promise<void>; clearAppBadge?: ()=>Promise<void> };

export function createAppBadgeReconciler(badge:BadgeApi) {
  let revision=0,queue:Promise<void>=Promise.resolve();
  return (value:unknown) => {
    const count=Math.max(0,Math.floor(Number(value)||0)),current=++revision;
    queue=queue.then(async()=>{
      if(current!==revision)return;
      if(count)await badge.setAppBadge?.(count);
      else await badge.clearAppBadge?.();
    }).catch(()=>{});
    return queue;
  };
}
