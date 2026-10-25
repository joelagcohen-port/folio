'use client';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { notificationRequest } from './folio-notifications';
import { clearUserEventDetailCache, userEventDetailCacheEpoch } from './folio-local-data.mjs';
const cacheKey=(userId:string,id:string)=>`folio:event-detail:${userId}:${id}`;
export function cacheNotificationEvents(userId:string,events:any[]){
 try{
  const prefix=`folio:event-detail:${userId}:`,ids=new Set(events.slice(0,20).map(e=>cacheKey(userId,e.event_id)));
  for(const key of Object.keys(localStorage))if(key.startsWith(prefix)&&!ids.has(key))localStorage.removeItem(key);
  for(const e of events.slice(0,20))localStorage.setItem(cacheKey(userId,e.event_id),JSON.stringify({event_id:e.event_id,event_type:e.event_type,event_version:e.event_version,title:e.title,summary:e.summary,status:e.status,expires_at:e.expires_at,goal_id:e.facts?.goal_id||null,savings_activity_id:e.facts?.savings_activity_id||e.facts?.activity_id||null}));
 }catch{}
}
export { clearUserEventDetailCache };
export function FolioEventDetail({token,userId,eventId,onClose,onReview,onAction}:{token:string;userId:string;eventId:string;onClose:()=>void;onReview:(target:{page:string;goal_id?:string;savings_activity_id?:string})=>void;onAction:(request:Record<string,unknown>)=>void}){
 const [event,setEvent]=useState<any>(null),[status,setStatus]=useState('Loading insight…'),[fresh,setFresh]=useState(false);
 useEffect(()=>{let active=true,requestVersion=0;setEvent(null);setFresh(false);setStatus('Loading insight…');
  const cacheEpoch=userEventDetailCacheEpoch(userId);
  try{const cached=JSON.parse(localStorage.getItem(cacheKey(userId,eventId))||'null');if(cached){setEvent(cached);setStatus('Saved insight · checking for updates…');}}catch{}
  const reload=(mark_opened:boolean)=>{const version=++requestVersion;return notificationRequest(token,'get_agent_event_detail',{event_id:eventId,mark_opened}).then(data=>{
   if(!active||version!==requestVersion||cacheEpoch!==userEventDetailCacheEpoch(userId))return;setEvent(data.event);setFresh(true);setStatus(data.event?'':'This insight is no longer available to your household.');
   try{if(data.event)localStorage.setItem(cacheKey(userId,eventId),JSON.stringify(data.event));else localStorage.removeItem(cacheKey(userId,eventId));}catch{}
  }).catch(()=>active&&version===requestVersion&&setStatus('Could not refresh. Connect to the internet and try again.'));};
  void reload(true);
  const onUpdate=()=>{setFresh(false);setStatus('Checking latest insight…');void reload(false);};
  window.addEventListener('folio-agent-updated',onUpdate);
  return()=>{active=false;window.removeEventListener('folio-agent-updated',onUpdate);};
 },[token,userId,eventId]);
 const goalId=typeof event?.facts?.goal_id==='string'?event.facts.goal_id:typeof event?.goal_id==='string'?event.goal_id:undefined;
 const savingsActivityId=typeof event?.facts?.savings_activity_id==='string'?event.facts.savings_activity_id:typeof event?.facts?.activity_id==='string'?event.facts.activity_id:typeof event?.savings_activity_id==='string'?event.savings_activity_id:undefined;
 const savingsEvent=event?.event_type==='savings_opportunity'||event?.event_type==='savings_review_needed';
 const page=goalId||savingsEvent?'planning':event?.event_type==='autonomy_action_needs_review'?'autonomy':event?.event_type==='account_sync_issue'?'accounts':event?.event_type==='cash_floor_risk'||event?.event_type==='goal_progress_change'?'planning':event?.event_type?.startsWith('budget_')?'budget':'recurring';
 const resolved=event&&(!['new','surfaced'].includes(event.status)||['acted','dismissed','approved','expected','acknowledged','wrong'].includes(event.user_disposition)||Date.parse(event.expires_at)<=Date.now());
 const actionType=event?.event_type==='account_sync_issue'?'refresh_accounts':event?.event_type==='recurring_amount_change'?'acknowledge_recurring_change':event?.recommended_actions?.some((a:any)=>a.action_type==='reallocate_budget')?'reallocate_budget':null;
 return <div className="dashboard-tab-order-layer"><section className="dashboard-tab-order-dialog" role="dialog" aria-modal="true" aria-labelledby="event-detail-title"><div className="dashboard-tab-order-head"><h2 id="event-detail-title">{event?.title||'Financial insight'}</h2><button type="button" aria-label="Close insight" onClick={onClose}><X size={20}/></button></div>{event&&<><p>{event.summary}</p>{resolved&&<p>This insight has already been handled or has expired.</p>}{fresh&&!resolved&&actionType&&<button className="dashboard-tab-order-save" type="button" onClick={()=>onAction({event_id:event.event_id,event_version:event.event_version,action_type:actionType})}>{actionType==='refresh_accounts'?'Refresh accounts':actionType==='reallocate_budget'?'Review transfer':'Mark expected'}</button>}<button type="button" onClick={()=>onReview({page,goal_id:goalId,savings_activity_id:savingsActivityId})}>{goalId?'Review savings activity':savingsEvent?'Review savings':page==='autonomy'?'Review settings':`Review ${page==='planning'?'cash forecast':page}`}</button></>}<p role="status">{status}</p></section></div>;
}
