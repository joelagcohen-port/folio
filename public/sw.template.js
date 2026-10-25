// The host registers this worker with the immutable build id. Stage the new
// shell before activation so the legacy bridge never reloads into a missing app.
const BUILD_ID = __FOLIO_BUILD_ID__;
const API_GENERATION = __FOLIO_API_GENERATION__;
const MIN_SUPPORTED_GENERATION = __FOLIO_MIN_SUPPORTED_GENERATION__;
const SHELL_CACHE = `folio-shell-${BUILD_ID}`;
// Keep immutable asset URLs in a build-specific cache until every open client
// confirms that it has converged to this build.
const ASSET_CACHE = `folio-assets-${BUILD_ID}`;
const OFFLINE_CACHE = 'folio-offline-v3';
async function reportLifecycle(event){
  try{await fetch(new Request(new URL('/api/folio-telemetry',self.location.origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event,workerBuild:BUILD_ID,serverBuild:BUILD_ID,serverGeneration:API_GENERATION}),cache:'no-store',signal:AbortSignal.timeout(1200)}));}catch{}
}
async function isDashboardDocument(response){
  if(!response?.ok||!response.headers.get('content-type')?.includes('text/html'))return false;
  try{return (await response.clone().text()).includes('id="folio-dashboard-production"');}catch{return false;}
}
async function shellIdentityMatches(response,path){
  if(!response?.ok||!response.headers.get('content-type')?.includes('text/html'))return false;
  try{
    const body=await response.clone().text(),build=body.match(/<meta\s+name=["']folio-build-id["']\s+content=["']([^"']+)/i)?.[1],generation=Number(body.match(/<meta\s+name=["']folio-api-generation["']\s+content=["'](\d+)/i)?.[1]);
    return build===BUILD_ID&&generation===API_GENERATION&&(path!=='/dashboard'||await isDashboardDocument(response))&&(path!=='/'||body.includes('/_next/static/'));
  }catch{return false;}
}
async function isExperienceResponse(response){
  if(!response?.ok)return false;
  try{const flags=await response.clone().json();return flags&&typeof flags.enabled==='boolean'&&typeof flags.weeklyReview==='boolean'&&(flags.coaching===undefined||typeof flags.coaching==='boolean');}catch{return false;}
}
async function isRuntimeConfigResponse(response){
  if(!response?.ok||response.redirected||response.type==='opaqueredirect'||!response.headers.get('content-type')?.toLowerCase().includes('application/json'))return false;
  try{const config=await response.clone().json(),url=new URL(config?.supabaseUrl);return (url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))&&typeof config.supabaseAnonKey==='string'&&config.supabaseAnonKey.length>0;}catch{return false;}
}
function shellAssets(documentText){
  const found=new Set();
  for(const match of documentText.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi))found.add(match[1]);
  for(const match of documentText.matchAll(/<link\b[^>]*>/gi)){
    const tag=match[0],rel=tag.match(/\brel=["']([^"']+)["']/i)?.[1]||'';
    if(!/stylesheet|modulepreload/i.test(rel))continue;
    const href=tag.match(/\bhref=["']([^"']+)["']/i)?.[1];if(href)found.add(href);
  }
  return [...found].map(value=>new URL(value,self.location.origin)).filter(url=>url.origin===self.location.origin);
}
async function cachedVerifiedAsset(request){
  const keys=(await caches.keys()).filter(key=>key.startsWith('folio-assets-')).reverse();
  for(const key of keys){const cached=await (await caches.open(key)).match(request);if(cached)return cached;}
  return null;
}
async function stageDocument(path,cache){
  const url=new URL(path,self.location.origin),response=await fetch(new Request(url,{cache:'reload',credentials:'same-origin',redirect:'error'}));
  if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))throw new Error('Folio shell document could not be staged.');
  const body=await response.clone().text();
  const embeddedBuild=body.match(/<meta\s+name=["']folio-build-id["']\s+content=["']([^"']+)/i)?.[1];
  const embeddedGeneration=Number(body.match(/<meta\s+name=["']folio-api-generation["']\s+content=["'](\d+)/i)?.[1]);
  if(embeddedBuild!==BUILD_ID||embeddedGeneration!==API_GENERATION)throw new Error('Folio shell identity does not match the server contract.');
  if(path==='/dashboard'&&!await isDashboardDocument(response))throw new Error('Folio dashboard could not be verified.');
  if(path==='/'&&!body.includes('/_next/static/'))throw new Error('Folio launch shell could not be verified.');
  const assets=shellAssets(body),assetCache=await caches.open(ASSET_CACHE);
  await Promise.all(assets.map(async asset=>{
    const result=await fetch(new Request(asset,{cache:'reload',credentials:'same-origin',redirect:'error'}));
    if(!result.ok||result.type==='opaque')throw new Error('A Folio startup asset could not be staged.');
    await assetCache.put(asset.href,result.clone());
  }));
  await cache.put(path,response.clone());
}
 self.addEventListener('install', event => {
  event.waitUntil((async()=>{
    const contractResponse=await fetch(new Request(new URL('/api/version',self.location.origin),{cache:'no-store',credentials:'same-origin',redirect:'error'}));
    if(!contractResponse.ok)throw new Error('Folio version contract could not be verified.');
    const contract=await contractResponse.json();
    if(typeof contract.buildId!=='string'||!contract.buildId||!Number.isInteger(contract.apiGeneration)||!Number.isInteger(contract.minSupportedGeneration))throw new Error('Folio version contract is invalid.');
    if(contract.buildId!==BUILD_ID||contract.apiGeneration!==API_GENERATION||contract.minSupportedGeneration!==MIN_SUPPORTED_GENERATION)throw new Error('Worker, client and server version contracts do not match.');
    const shell=await caches.open(SHELL_CACHE);
    await Promise.all([stageDocument('/',shell),stageDocument('/dashboard',shell)]);
    const offline=await caches.open(OFFLINE_CACHE);
    try{await offline.add('/offline.html');}catch{}
    await self.skipWaiting();
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='folio-worker-identity'&&event.ports?.[0])event.ports[0].postMessage({buildId:BUILD_ID,apiGeneration:API_GENERATION,minSupportedGeneration:MIN_SUPPORTED_GENERATION});
  if(event.data?.type==='folio-client-ready')event.waitUntil(checkCurrentClientsAndRetire());
});
async function bridgeLegacyWindows(){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const topLevel=windows.filter(client=>client.frameType==='top-level'&&new URL(client.url).origin===self.location.origin);
  const identities=await Promise.all(topLevel.map(async client=>{
    let identity=null;
    try{
      const channel=new MessageChannel();
      const reply=new Promise(resolve=>{channel.port1.onmessage=event=>resolve(event.data||null);});
      client.postMessage({type:'folio-worker-compatibility-check',buildId:BUILD_ID,apiGeneration:API_GENERATION,minSupportedGeneration:MIN_SUPPORTED_GENERATION},[channel.port2]);
      identity=await Promise.race([reply,new Promise(resolve=>setTimeout(()=>resolve(null),1800))]);
      channel.port1.close();
    }catch{}
    if(identity)return identity.buildId===BUILD_ID&&Number(identity.apiGeneration)===API_GENERATION;
    const marker=new URL(`/__folio_recovery/bridge/${encodeURIComponent(BUILD_ID)}/${encodeURIComponent(client.id)}`,self.location.origin).href;
    const cache=await caches.open(SHELL_CACHE);
    if(await cache.match(marker))return false;
    await cache.put(marker,new Response(JSON.stringify({attempted:true}),{headers:{'content-type':'application/json'}}));
    await reportLifecycle('bridge_navigation');
    try{await client.navigate(client.url);}catch{}
    return false;
  }));
  return identities.every(Boolean);
}
async function checkCurrentClientsAndRetire(){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const topLevel=windows.filter(client=>client.frameType==='top-level'&&new URL(client.url).origin===self.location.origin);
  const identities=await Promise.all(topLevel.map(client=>new Promise(resolve=>{
    try{const channel=new MessageChannel();const timer=setTimeout(()=>{channel.port1.close();resolve(null);},1200);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data||null);};client.postMessage({type:'folio-worker-identity'},[channel.port2]);}catch{resolve(null);}
  })));
  if(identities.length>0&&identities.every(identity=>identity?.buildId===BUILD_ID&&Number(identity.apiGeneration)===API_GENERATION)){
    const keys=await caches.keys(),retired=keys.filter(key=>(key.startsWith('folio-shell-')&&key!==SHELL_CACHE)||(key.startsWith('folio-assets-')&&key!==ASSET_CACHE)||(key.startsWith('folio-offline-')&&key!==OFFLINE_CACHE));await Promise.all(retired.map(key=>caches.delete(key)));if(retired.length)await reportLifecycle('cache_retired');
    return true;
  }
  return false;
}
self.addEventListener('activate', event => event.waitUntil((async()=>{
  await self.clients.claim();
  if(await bridgeLegacyWindows())await checkCurrentClientsAndRetire();
})()));
// Cache only the generic app documents, public assets, and anonymous runtime
// configuration. Authenticated financial operations and responses stay online.
function networkOrCached(event,request,cacheName,key,isUsable,offlineFallback,{networkFirst=false,returnCachedImmediately=false,notifyExperienceRefresh=false,evictInvalidCached=false}={}){
  const cachePromise=caches.open(cacheName);
  const network=cachePromise.then(async cache=>{
    let networkRequest=networkFirst?new Request(request,{cache:'reload'}):request;
    if(key==='/dashboard'){
      const target=new URL('/dashboard'+(networkFirst?new URL(request.url).search:''),self.location.origin);
      networkRequest=new Request(target.href,{method:'GET',headers:request.headers,credentials:'same-origin',cache:networkFirst?'reload':'default',redirect:'error'});
    }
    const response=await fetch(networkRequest);
    const usable=key==='/dashboard'?await isDashboardDocument(response):notifyExperienceRefresh?await isExperienceResponse(response):await isUsable(response);
    if(usable){try{await cache.put(key,response.clone());}catch{}if(notifyExperienceRefresh){try{const flags=await response.clone().json();const client=event.clientId?await self.clients.get(event.clientId):null;if(client&&flags&&typeof flags==='object')client.postMessage({type:'folio-experience-refresh',flags:{enabled:flags.enabled===true,weeklyReview:flags.weeklyReview===true,coaching:flags.coaching!==false}});}catch{}}}
    return response;
  });
  // Keep the request alive after returning a stale cached document so a slow
  // successful response can become the installed app's next-launch shell.
  event.waitUntil(network.then(()=>{}).catch(()=>{}));
  event.respondWith((async()=>{
    const cache=await cachePromise;
    let cached=await cache.match(key);
    if(!cached&&key==='/dashboard')cached=await cache.match('/dashboard.html');
    if(cached&&key==='/dashboard'&&!await isDashboardDocument(cached))cached=null;
    if(cached&&notifyExperienceRefresh&&!await isExperienceResponse(cached))cached=null;
    if(cached&&evictInvalidCached&&!await isUsable(cached)){
      cached=null;
      try{const fresh=await network;if(await isUsable(fresh))return fresh;await cache.delete(key);return fresh;}catch{try{await cache.delete(key);}catch{}return await offlineFallback();}
    }
    if(cached&&key==='/dashboard')cached=new Response(cached.body,{status:cached.status,statusText:cached.statusText,headers:cached.headers});
    if(!cached){try{return await network;}catch{return await offlineFallback();}}
    if(networkFirst){try{const response=await network;const usable=key==='/dashboard'?await isDashboardDocument(response):await isUsable(response);return usable?response:cached;}catch{return cached;}}
    if(returnCachedImmediately)return cached;
    let timer;
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({kind:'timeout'}),1800);});
    const result=await Promise.race([network.then(response=>({kind:'response',response}),()=>({kind:'error'})),timeout]);
    clearTimeout(timer);
    if(result.kind==='timeout'||result.kind==='error')return cached;
    const usable=key==='/dashboard'?await isDashboardDocument(result.response):await isUsable(result.response);
    return usable?result.response:cached;
  })());
}
self.addEventListener('fetch', event => {
  const request=event.request,url=new URL(request.url);
  if(url.origin!==self.location.origin||request.method!=='GET')return;
  if(request.mode==='navigate'&&['/','/dashboard','/dashboard.html'].includes(url.pathname)&&(!url.search||['/dashboard','/dashboard.html'].includes(url.pathname)&&/^\?folio_retry=\d+$/.test(url.search)||url.search.startsWith('?folio_upgrade='))){
    const key=url.pathname==='/'?'/':'/dashboard';
    event.respondWith((async()=>{
      const cache=await caches.open(SHELL_CACHE),cached=await cache.match(key)||key==='/dashboard'&&await cache.match('/dashboard.html');
      const target=new URL(key==='/'?'/':'/dashboard',self.location.origin);if(url.search)target.search=url.search;
      const networkRequest=new Request(target.href,{method:'GET',headers:request.headers,credentials:'same-origin',cache:'no-store',redirect:'error'});
      const fresh=fetch(networkRequest);
      if(!cached){try{const response=await fresh;if(await shellIdentityMatches(response,key))return response;}catch{}}
      else{
        let timer;try{const outcome=await Promise.race([fresh.then(response=>({response}),()=>({response:null})),new Promise(resolve=>{timer=setTimeout(()=>resolve({response:null}),180);})]);clearTimeout(timer);if(await shellIdentityMatches(outcome.response,key))return outcome.response;}catch{clearTimeout(timer);}
      }
      if(cached&&key==='/dashboard'&&await isDashboardDocument(cached))return cached;
      if(cached&&key==='/')return cached;
      return await caches.match('/offline.html')||new Response('Folio is offline. Reconnect and reload.',{headers:{'content-type':'text/plain'}});
    })());
    return;
  }
  if(url.pathname==='/api/config'){
    networkOrCached(event,request,SHELL_CACHE,request,isRuntimeConfigResponse,async()=>new Response('Folio setup is unavailable offline.',{status:503,headers:{'content-type':'text/plain'}}),{returnCachedImmediately:true,evictInvalidCached:true});
    return;
  }
  if(url.pathname==='/api/experience'){
    networkOrCached(event,request,SHELL_CACHE,request,response=>response.ok,async()=>new Response('Experience settings are unavailable offline.',{status:503,headers:{'content-type':'application/json'}}),{returnCachedImmediately:true,notifyExperienceRefresh:true});
    return;
  }
  const staticAsset=url.pathname.startsWith('/_next/static/')||/\.(?:css|js|svg|png|webp|woff2?|ico|webmanifest)$/.test(url.pathname);
  if(!staticAsset)return;
  // Generated chunks use base64url hashes; only apply that broader pattern
  // inside the generated asset directory so public scripts stay fresh.
  const contentHashed=/[.-][a-f0-9]{8,}[.-]/i.test(url.pathname)||url.pathname.startsWith('/_next/static/')&&/[.-][A-Za-z0-9_-]{8,}[.-]/.test(url.pathname)||/[?&](?:v|hash)=[a-f0-9]{8,}/i.test(url.search);
  if(!contentHashed){
    networkOrCached(event,request,ASSET_CACHE,request,response=>response.ok&&response.type==='basic',async()=>Response.error());
    return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(ASSET_CACHE),cached=await cachedVerifiedAsset(request);
    if(cached)return cached;
    const versionedHelper=url.pathname.startsWith('/folio-')&&/\.(?:css|js)$/.test(url.pathname)&&url.searchParams.has('v');
    if(versionedHelper&&url.searchParams.get('v')!==BUILD_ID)return Response.error();
    try{const response=await fetch(request);if(response.ok&&response.type==='basic'){try{await cache.put(request,response.clone());}catch{}}return response;}catch{return Response.error();}
  })());
});
function safeEventId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:null;}
function safeAssistantMessageId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:null;}
self.addEventListener('push', event => {
  let data={};try{data=event.data?.json()||{};}catch{}
  const id=safeEventId(data.event_id),messageId=safeAssistantMessageId(data.message_id),test=data.category==='test'&&safeEventId(data.test_id);
  const copy={account_health:'An account connection needs attention.',cash_flow:'Your cash forecast needs a review.',recurring:'A recurring bill changed more than usual.'};
  if(self.navigator?.setAppBadge&&Number.isInteger(data.badge_count)&&data.badge_count>=0)event.waitUntil(self.navigator.setAppBadge(data.badge_count).catch(()=>{}));
  event.waitUntil(self.registration.showNotification(test?'Folio · Test notification':'Folio · Financial alert',{
    body:test?'Your Folio test notification arrived. No financial changes were made.':copy[data.category]||'A financial change needs a review.',
    tag:test?`folio-test:${test}`:id?`folio:${id}:${Number(data.event_version)||1}`:'folio-alert',
    icon:'/brand/folio-icon-192.png',data:{event_id:id,message_id:messageId},
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id=safeEventId(event.notification.data?.event_id),messageId=safeAssistantMessageId(event.notification.data?.message_id);
  const path=messageId?`/?folio_message=${encodeURIComponent(messageId)}${id?`&folio_event=${encodeURIComponent(id)}`:''}`:id?`/?folio_event=${encodeURIComponent(id)}`:'/';
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const target=windows.find(client=>new URL(client.url).origin===self.location.origin&&new URL(client.url).pathname==='/');
    if(target){target.postMessage(messageId?{type:'folio-open-assistant-message',message_id:messageId,event_id:id}:{type:'folio-open-notification',event_id:id});await target.focus();}
    else await self.clients.openWindow(path);
  })());
});
