export function getFolioPublicOrigin(): string {
  const configured = process.env.FOLIO_PUBLIC_URL;
  if (!configured) throw new Error("FOLIO_PUBLIC_URL is not configured.");
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error("FOLIO_PUBLIC_URL must be a valid absolute URL."); }
  if (url.username || url.password) throw new Error("FOLIO_PUBLIC_URL must not include credentials.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("FOLIO_PUBLIC_URL must use HTTPS, except for HTTP loopback development.");
  }
  return url.origin;
}
// Apple can render this encrypted fallback even if background JS cannot run.
// Keep legacy fields so older workers/browsers still show exactly one message.
export function displayablePushPayload(payload:any){
 const validId=(v:any)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
 const test=payload.category==='test'&&validId(payload.test_id),id=validId(payload.event_id)?payload.event_id:null;
 const messageId=validId(payload.message_id)?payload.message_id:null,watchId=validId(payload.watch_id)?payload.watch_id:null;
 const exactLink=id&&messageId?'/?folio_message='+encodeURIComponent(messageId)+'&folio_event='+encodeURIComponent(id):messageId?'/?folio_message='+encodeURIComponent(messageId):id?'/?folio_event='+encodeURIComponent(id):'/';
 const copy:Record<string,string>={account_health:'An account connection needs attention.',cash_flow:'Your cash forecast needs a review.',recurring:'A recurring bill changed more than usual.',assistant_watch:'Folio has a follow-up update.'};
 const notification:any={title:test?'Folio · Test notification':'Folio · Financial alert',body:test?'Your Folio test notification arrived. No financial changes were made.':copy[payload.category]||'A financial change needs a review.',navigate:getFolioPublicOrigin()+exactLink,silent:false,tag:test?'folio-test:'+payload.test_id:id?'folio:'+id+':'+(Number(payload.event_version)||1):messageId?'folio-message:'+messageId:'folio-alert',data:{event_id:id,message_id:messageId,watch_id:watchId}};
 if(!test&&Number.isInteger(payload.badge_count)&&payload.badge_count>=0)notification.app_badge=String(payload.badge_count);
 return {...payload,web_push:8030,notification};
}
// Transport shared by foreground and scheduled delivery. No model calls.
export async function sendPushJobs(jobs:any[],vapid:any,buildPayload:any,complete:any,validSubscription:any,fetcher:typeof fetch=fetch){
 let sent=0,failed=0;
 for(const job of jobs){
  const results=await Promise.all(job.subscriptions.map(async(subscription:any)=>{
   let status=0;
   try{
    if(!validSubscription(subscription))status=400;
    else{const init=await buildPayload({data:JSON.stringify(displayablePushPayload(job.payload)),options:{ttl:3600,urgency:job.payload.priority,topic:job.delivery_id.replaceAll('-','')}},{...subscription,expirationTime:null},vapid);const response=await fetcher(subscription.endpoint,{...init,redirect:'error',signal:AbortSignal.timeout(8000)});status=response.status;}
   }catch{}
   if(status>=200&&status<300)sent++;else failed++;
   return {subscription_id:subscription.subscription_id,http_status:status};
  }));
  await complete({delivery_id:job.delivery_id,claim_token:job.claim_token,results});
 }
 return {processed:jobs.length,sent,failed};
}
