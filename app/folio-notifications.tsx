'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { fetchJsonWithDeadline, folioAssistantRequest, loadFolioAssistantState } from './folio-assistant-client';
import { isAssistantWatch, isRecord, type AssistantState, type AssistantWatch } from './folio-assistant-contract';
import { assistantWatchOutcomeLabel, formatAssistantClock, formatAssistantDate, formatAssistantInstant, formatAssistantMinorAmount, formatAssistantOffset, isAssistantTransactionId } from './folio-assistant-display';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row=Record<string,any>;
const installationKey='folio:push-installation-id';
export function pushInstallationId(create=false){
 try{const id=localStorage.getItem(installationKey);if(id&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))return id;
  if(create){const next=crypto.randomUUID();localStorage.setItem(installationKey,next);return next;}
 }catch{}return '';
}
export async function notificationRequest(token:string,tool:string,args:Row={},signal?:AbortSignal){
 const {response,data}=await fetchJsonWithDeadline('/api/folio-notifications',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,'x-folio-api-generation':String(process.env.NEXT_PUBLIC_FOLIO_API_GENERATION||1)},body:JSON.stringify({tool,args})},{signal});
 if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Could not save notification settings.');return data as Row;
}
function keyBytes(value:string){return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
export async function disconnectPushDevice(token:string,signal?:AbortSignal){
 if(!('serviceWorker' in navigator))return;
 const registration=await navigator.serviceWorker.getRegistration('/');
 const sub=await registration?.pushManager?.getSubscription();
 if(!sub)return;
 // Unsubscribe locally even if the server is offline. Invalid endpoints are
 // also disabled by the sender on 404/410.
 await sub.unsubscribe();
 const result=await notificationRequest(token,'remove_push_subscription',{endpoint:sub.endpoint},signal);
 if(result.saved!==true)throw new Error('Folio could not confirm that this device was removed. Refresh settings before retrying.');
}
function savedNotificationSettings(value:unknown,requireDevices:boolean){
 if(!isRecord(value)||!isRecord(value.preferences)||typeof value.preferences.push_enabled!=='boolean'||typeof value.preferences.in_app_enabled!=='boolean')throw new Error('Notification settings could not be verified. Your last saved settings are unchanged.');
 const rawDevices=value.devices;
 if(requireDevices&&!Array.isArray(rawDevices))throw new Error('Notification devices could not be verified. Your last saved settings are unchanged.');
 if(rawDevices!==undefined&&(!Array.isArray(rawDevices)||!rawDevices.every(device=>isRecord(device)&&typeof device.subscription_id==='string'&&typeof device.enabled==='boolean'&&typeof device.device_label==='string'&&(device.installation_id===null||device.installation_id===undefined||typeof device.installation_id==='string')&&typeof device.created_at==='string')))throw new Error('Notification devices could not be verified. Your last saved settings are unchanged.');
 return {preferences:value.preferences,devices:(Array.isArray(rawDevices)?rawDevices:undefined) as Row[]|undefined};
}
function savedPushConfig(value:unknown){
 if(!isRecord(value)||typeof value.configured!=='boolean'||(value.configured&&typeof value.publicKey!=='string'))throw new Error('Notification setup could not be verified. Your saved settings are unchanged.');
 return value;
}
function requireSaved(value:unknown){if(!isRecord(value)||value.saved!==true)throw new Error('Folio could not confirm this notification change. Refresh settings before retrying.');return value;}
function assistantWatchSnoozeUntil(watch:AssistantWatch){
 const now=Date.now();let until=now+7*24*60*60*1000;
 if(watch.expires_at){const expiry=Date.parse(watch.expires_at);if(Number.isFinite(expiry))until=Math.min(until,expiry);}
 return until>now?new Date(until).toISOString():null;
}
const categories=[['cash_flow','Cash-flow risks'],['budgets','Budget risks'],['recurring','Recurring bill changes'],['income','Income issues'],['account_health','Account connections'],['transactions','Unusual transactions'],['investments','Investment changes']];
function AssistantWatchSettingsDetails({watch,timezone,hasPushDevice,onReviewRefund}:{watch:AssistantWatch;timezone:string;hasPushDevice:boolean;onReviewRefund?:()=>void}){
 const schedule=watch.schedule,refund=watch.refund,zone=schedule?.timezone||timezone||'UTC';
 const due=schedule?`${formatAssistantDate(schedule.local_date)} at ${formatAssistantClock(schedule.local_time)} ${zone} (${formatAssistantOffset(schedule.utc_offset_minutes)})`:'';
 const expiry=watch.expires_at?formatAssistantInstant(watch.expires_at,zone):null;
 const expected=refund?formatAssistantMinorAmount(refund.expected_amount_minor,refund.currency):null;
 const baseline=refund?formatAssistantMinorAmount(refund.baseline_received_minor,refund.currency):null;
 const remaining=refund?formatAssistantMinorAmount(Math.max(0,refund.expected_amount_minor-refund.baseline_received_minor),refund.currency):null;
 const originalAmount=refund?formatAssistantMinorAmount(refund.original_amount_minor,refund.currency):null;
 return <div className="folio-assistant-watch-details">
  {schedule&&<small>{watch.template==='expected_refund'?'Expected by':'Scheduled for'} {due}</small>}
  {watch.template==='one_time_follow_up'&&watch.follow_up&&<small>{watch.follow_up.check.replace(/_/g,' ')}{watch.follow_up.category_name?` · ${watch.follow_up.category_name}`:''}{watch.follow_up.reminder_text?` · “${watch.follow_up.reminder_text}”`:''}</small>}
  {watch.template==='expected_refund'&&refund&&<>
   <small>Original: {refund.original_merchant} · {formatAssistantDate(refund.original_date)} · {originalAmount||'amount unavailable'}</small>
   <small>Expected total {expected||'amount unavailable'} · verified at setup {baseline||'amount unavailable'} · remaining {remaining||'amount unavailable'}</small>
  </>}
  {expiry&&<small>Catch-up window ends {expiry}</small>}
  {watch.last_outcome&&<small className={`folio-assistant-watch-outcome-text ${watch.last_outcome==='needs_review'||watch.last_outcome==='unavailable'||watch.last_outcome==='missed'?'needs-attention':''}`}>{assistantWatchOutcomeLabel(watch.last_outcome)}</small>}
  {watch.last_checked_at&&<small>Last checked {formatAssistantInstant(watch.last_checked_at,zone)||'time unavailable'}</small>}
  {watch.next_check_at&&<small>Next check {formatAssistantInstant(watch.next_check_at,zone)||'time unavailable'}</small>}
  {watch.delivery==='chat_and_push'&&<small>{hasPushDevice?'Push requested for existing enabled devices; delivery time is not guaranteed.':'Chat will still be saved; no enabled push device is available. This watch does not enable notifications.'}</small>}
  {watch.template==='expected_refund'&&watch.last_outcome==='needs_review'&&onReviewRefund&&<button type="button" className="folio-assistant-watch-review-refund" onClick={onReviewRefund}>Review refund</button>}
 </div>;
}

export function FolioNotificationSettings({token,userId,onClose,onChanged,onOpenTransaction}:{token:string;userId:string;onClose:()=>void;onChanged:()=>void;onOpenTransaction?:(transactionId:string)=>void}){
 const [preferences,setPreferences]=useState<Row|null>(null),[devices,setDevices]=useState<Row[]>([]),[dataOwnerId,setDataOwnerId]=useState(''),[assistantState,setAssistantState]=useState<AssistantState|null>(null),[assistantOwnerId,setAssistantOwnerId]=useState(''),[assistantLoadError,setAssistantLoadError]=useState(''),[assistantErrorOwnerId,setAssistantErrorOwnerId]=useState(''),[publicKey,setPublicKey]=useState(''),[busyState,setBusyState]=useState({userId,busy:false}),[messageState,setMessageState]=useState({userId,text:''}),[permission,setPermission]=useState('Checking…'),[supported,setSupported]=useState(false),[thisEndpoint,setThisEndpoint]=useState('');
 const actorRef=useRef({userId,token});
 useLayoutEffect(()=>{if(actorRef.current.userId!==userId||actorRef.current.token!==token)actorRef.current={userId,token};},[userId,token]);
 const isActorCurrent=(actor:typeof actorRef.current)=>actorRef.current===actor;
 const actorRequestsRef=useRef(new Map<AbortController,typeof actorRef.current>());
 const startActorRequest=()=>{const actor=actorRef.current,controller=new AbortController();actorRequestsRef.current.set(controller,actor);return {actor,controller};};
 const finishActorRequest=(controller:AbortController)=>{actorRequestsRef.current.delete(controller);};
 const busy=busyState.userId===userId&&busyState.busy,setBusy=(value:boolean)=>setBusyState({userId,busy:value});
 const message=messageState.userId===userId?messageState.text:'',setMessage=(value:string)=>setMessageState({userId,text:value});
 const ownerPreferences=dataOwnerId===userId?preferences:null,ownerDevices=dataOwnerId===userId?devices:[],ownerAssistantState=assistantOwnerId===userId?assistantState:null,ownerAssistantLoadError=assistantErrorOwnerId===userId?assistantLoadError:'';
 const dialogRef=useRef<HTMLElement|null>(null),closeRef=useRef(onClose),busyRef=useRef(false);
 useEffect(()=>{closeRef.current=onClose;busyRef.current=busy},[onClose,busy]);
 useEffect(()=>{const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;dialogRef.current?.querySelector<HTMLElement>('button,select,input')?.focus();const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busyRef.current){event.preventDefault();closeRef.current()}};window.addEventListener('keydown',onKey);return()=>{window.removeEventListener('keydown',onKey);previous?.focus()}},[]);
 const load=async(actor=actorRef.current,signal?:AbortSignal)=>{const data=savedNotificationSettings(await notificationRequest(token,'get_notification_settings',{},signal),true);if(isActorCurrent(actor)){setPreferences(data.preferences);setDevices(data.devices||[]);setDataOwnerId(userId);}return data;};
 useEffect(()=>{let active=true;
  const actor=actorRef.current;
  const controller=new AbortController();actorRequestsRef.current.set(controller,actor);
  const can='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
  queueMicrotask(()=>{if(active){setSupported(can);setPermission(can?Notification.permission:'unsupported');}});
  Promise.all([load(actor,controller.signal),fetchJsonWithDeadline('/api/folio-notifications',{}, {signal:controller.signal})]).then(([data,config])=>{const checkedConfig=savedPushConfig(config.data);if(active&&isActorCurrent(actor)){setPreferences(data.preferences);setDevices(data.devices||[]);setDataOwnerId(userId);setPublicKey(checkedConfig.configured?String(checkedConfig.publicKey):'');}}).catch(error=>{if(active&&isActorCurrent(actor)&&!controller.signal.aborted)setMessage(error instanceof Error?error.message:'Notification settings could not be verified.');});
  loadFolioAssistantState(token,undefined,controller.signal).then(state=>{if(active&&isActorCurrent(actor)){setAssistantState(state);setAssistantOwnerId(userId);setAssistantLoadError('');setAssistantErrorOwnerId(userId);}}).catch(error=>{if(active&&isActorCurrent(actor)&&!controller.signal.aborted){setAssistantLoadError(error instanceof Error?error.message:'Assistant settings are unavailable.');setAssistantErrorOwnerId(userId);}});
  if(can)navigator.serviceWorker.getRegistration('/').then(r=>r?.pushManager.getSubscription()).then(async sub=>{if(active&&isActorCurrent(actor))setThisEndpoint(sub?.endpoint||'');if(sub&&Notification.permission==='denied'&&active&&isActorCurrent(actor)){requireSaved(await notificationRequest(token,'remove_push_subscription',{endpoint:sub.endpoint,permission:'denied'},controller.signal));}}).catch(()=>{});
  return()=>{active=false;for(const [requestController,requestActor] of actorRequestsRef.current){if(requestActor===actor){requestController.abort();actorRequestsRef.current.delete(requestController);}}};
 },[token,userId]);
 async function save(patch:Row){const {actor,controller}=startActorRequest();setBusy(true);setMessage('');try{const data=savedNotificationSettings(await notificationRequest(token,'save_notification_settings',{preferences:patch},controller.signal),false);if(!isActorCurrent(actor))return;setPreferences(data.preferences);setDevices(data.devices||devices);setDataOwnerId(userId);setMessage('Saved.');onChanged();}catch(error){if(isActorCurrent(actor)&&!controller.signal.aborted)setMessage((error as Error).message);}finally{finishActorRequest(controller);setBusy(false);}}
 async function saveAssistantPreferences(patch:Row){
  const {actor,controller}=startActorRequest();
  setBusy(true);setMessage('');
  try{
   const data=savedNotificationSettings(await notificationRequest(token,'save_notification_settings',{preferences:patch},controller.signal),false);
   if(!isActorCurrent(actor))return;setPreferences(data.preferences);setDataOwnerId(userId);setMessage('Saved.');onChanged();
   try{const fresh=await loadFolioAssistantState(token,undefined,controller.signal);if(isActorCurrent(actor)){setAssistantState(fresh);setAssistantOwnerId(userId);setAssistantLoadError('');setAssistantErrorOwnerId(userId);}}
   catch(error){if(isActorCurrent(actor)&&!controller.signal.aborted){setAssistantLoadError(error instanceof Error?error.message:'Assistant settings could not be refreshed.');setAssistantErrorOwnerId(userId);}}
  }catch(error){if(isActorCurrent(actor)&&!controller.signal.aborted)setMessage((error as Error).message);}finally{finishActorRequest(controller);setBusy(false);}
 }
 async function setWatchState(watch:AssistantWatch,status:'active'|'snoozed'|'resolved'){
  const {actor,controller}=startActorRequest();
  setBusy(true);setMessage('');
  try{
   const args:Row={watch_id:watch.watch_id,expected_version:watch.version,status};
   if(status==='snoozed'){const snoozedUntil=assistantWatchSnoozeUntil(watch);if(!snoozedUntil)throw new Error('This watch has reached its confirmed end date and cannot be snoozed.');args.snoozed_until=snoozedUntil;}
   const reconcile=async()=>{
    if(!isActorCurrent(actor)||controller.signal.aborted)return;
    setMessage('Could not confirm that watch change. Checking the saved watch status; no change will be repeated.');
    try{const state=await loadFolioAssistantState(token,undefined,controller.signal);if(isActorCurrent(actor)){setAssistantState(state);setAssistantOwnerId(userId);setAssistantLoadError('');setAssistantErrorOwnerId(userId);setMessage('Saved watch status refreshed. No change was repeated.');}}
    catch(error){if(isActorCurrent(actor)&&!controller.signal.aborted){setAssistantLoadError(error instanceof Error?error.message:'Watch status is unavailable.');setAssistantErrorOwnerId(userId);setMessage('Could not verify the watch change. Refresh settings before trying again.');}}
   };
   let receipt:unknown;
   try{receipt=await folioAssistantRequest<{watch:unknown}>(token,'set_assistant_watch_state',args,controller.signal);}
   catch{await reconcile();return;}
   if(!isActorCurrent(actor))return;
   if(!isRecord(receipt)||!isAssistantWatch(receipt.watch)){await reconcile();return;}
   const savedWatch=receipt.watch;
   let refreshed:AssistantState|null=null;
   try{refreshed=await loadFolioAssistantState(token,undefined,controller.signal);}catch(error){if(controller.signal.aborted)throw error;}
   if(!isActorCurrent(actor))return;
   if(refreshed){setAssistantState(refreshed);setAssistantOwnerId(userId);setAssistantLoadError('');setAssistantErrorOwnerId(userId);}
   else{setAssistantState(current=>current?{...current,watches:current.watches.map(item=>item.watch_id===savedWatch.watch_id?savedWatch:item)}:current);setAssistantOwnerId(userId);setAssistantLoadError('The watch was saved, but the latest settings could not be loaded.');setAssistantErrorOwnerId(userId);}
   const zone=String(ownerPreferences?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
   setMessage(status==='resolved'?'Watch stopped.':status==='snoozed'?`Watch snoozed until ${formatAssistantInstant(savedWatch.snoozed_until||String(args.snoozed_until||''),zone)||'its confirmed end time'}.`:'Watch resumed.');onChanged();
  }catch(error){if(isActorCurrent(actor)&&!controller.signal.aborted)setMessage((error as Error).message);}
  finally{finishActorRequest(controller);setBusy(false);}
 }
 async function enable(){
  const {actor,controller}=startActorRequest();
  setBusy(true);setMessage('');
  try{
   // Request permission directly inside the user's click, before async fetches.
   const result=await Notification.requestPermission();if(!isActorCurrent(actor)||controller.signal.aborted)return;setPermission(result);
   if(result!=='granted'){setMessage('Notifications are off. You can change permission in your browser or device settings.');return;}
   const registration=await Promise.race([navigator.serviceWorker.ready,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Notification setup is taking longer than expected. Try again.')),10000))]);
   if(!isActorCurrent(actor)||controller.signal.aborted)return;
   const existing=await registration.pushManager.getSubscription();
   const sub=existing||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(publicKey)});
   const installation_id=pushInstallationId(true);if(!installation_id)throw new Error('This browser could not save its device identity. Check storage settings and try again.');
   requireSaved(await notificationRequest(token,'save_push_subscription',{subscription:sub.toJSON(),installation_id,device_label:/iPhone|iPad/.test(navigator.userAgent)?'iPhone / iPad':'Browser device'},controller.signal));if(!isActorCurrent(actor)||controller.signal.aborted)return;
   const data=savedNotificationSettings(await notificationRequest(token,'save_notification_settings',{preferences:{push_enabled:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}},controller.signal),false);
   if(!isActorCurrent(actor))return;setThisEndpoint(sub.endpoint);setPreferences(data.preferences);setDevices(data.devices||devices);setDataOwnerId(userId);await load(actor,controller.signal);if(!isActorCurrent(actor))return;setMessage('Important alerts are enabled on this device.');onChanged();
  }catch(error){if(isActorCurrent(actor)&&!controller.signal.aborted)setMessage((error as Error).message);}finally{finishActorRequest(controller);setBusy(false);}
 }
 async function disableDevice(id?:string){const {actor,controller}=startActorRequest();setBusy(true);try{if(id&&ownerDevices.find(d=>d.subscription_id===id)?.installation_id===pushInstallationId()&&thisEndpoint){await disconnectPushDevice(token,controller.signal);if(isActorCurrent(actor))setThisEndpoint('');}else if(id)requireSaved(await notificationRequest(token,'remove_push_subscription',{subscription_id:id},controller.signal));else{await disconnectPushDevice(token,controller.signal);if(isActorCurrent(actor))setThisEndpoint('');}if(!isActorCurrent(actor)||controller.signal.aborted)return;await load(actor,controller.signal);if(!isActorCurrent(actor))return;setMessage('Device notifications disabled.');}catch(error){if(isActorCurrent(actor)&&!controller.signal.aborted)setMessage((error as Error).message);}finally{finishActorRequest(controller);setBusy(false);}}
 const enabledDevices=ownerDevices.filter(d=>d.enabled).length;
 const assistantWatches=ownerAssistantState?.watches.filter(watch=>watch.status==='active'||watch.status==='snoozed')||[];
 const hasPushDevice=Boolean(ownerPreferences?.push_enabled&&enabledDevices>0);
 const currentDeviceRegistered=Boolean(thisEndpoint&&ownerDevices.some(d=>d.enabled&&d.installation_id===pushInstallationId()));
 const currentDeviceEnabled=Boolean(ownerPreferences?.push_enabled&&currentDeviceRegistered);
 const pushStatus=permission==='denied'?'Permission denied':!supported?'Not available on this device':currentDeviceEnabled?'Enabled':'Disabled';
 const badgeSupported=typeof navigator!=='undefined'&&typeof (navigator as Navigator&{setAppBadge?:(count?:number)=>Promise<void>}).setAppBadge==='function';
 return <div className="dashboard-tab-order-layer" onMouseDown={()=>!busy&&onClose()}><section ref={dialogRef} className="dashboard-tab-order-dialog folio-notification-settings" role="dialog" aria-modal="true" aria-labelledby="notifications-title" onMouseDown={e=>e.stopPropagation()}>
  <div className="dashboard-tab-order-head"><div><span className="dashboard-menu-eyebrow">Settings</span><h2 id="notifications-title">Notifications</h2></div><button type="button" onClick={onClose} aria-label="Close notification settings"><X size={20}/></button></div>
  <p>Choose where Folio alerts appear. Financial details stay inside Folio.</p>
  {!ownerPreferences&&!message&&<p>Loading preferences…</p>}
  {ownerPreferences&&<>
   <label className="folio-notification-switch"><span>In-app alerts</span><input aria-label="In-app alerts" type="checkbox" checked={ownerPreferences.in_app_enabled} disabled={busy} onChange={e=>void save({in_app_enabled:e.target.checked})}/></label>
   <label className="folio-notification-switch"><span>Push alerts</span><input aria-label="Push alerts" type="checkbox" checked={ownerPreferences.push_enabled} disabled={busy||(!ownerPreferences.push_enabled&&!ownerDevices.some(d=>d.enabled))} onChange={e=>void save({push_enabled:e.target.checked})}/></label>
   <div className="folio-notification-status-row"><span><strong>Push status</strong><small>{pushStatus}{enabledDevices?` · ${enabledDevices} device${enabledDevices===1?'':'s'} enabled`:''}</small></span>{permission==='denied'&&<small>Change permission in device settings.</small>}{!supported&&<small>On iPhone, add Folio to your Home Screen.</small>}{supported&&!publicKey&&<small>Setup temporarily unavailable.</small>}</div>
   <div className="folio-notification-status-row"><span><strong>App badge</strong><small>{badgeSupported?'Available':'Not available'} · Shows unresolved alerts on supported devices</small></span></div>
   {supported&&permission!=='denied'&&<button type="button" className="dashboard-tab-order-save" disabled={busy||!publicKey} onClick={()=>void enable()}>{busy?'Saving…':currentDeviceRegistered?'Enable / repair this device':'Enable notifications'}</button>}
   {currentDeviceRegistered&&<button type="button" disabled={busy} onClick={()=>void disableDevice()}>Disable this device</button>}
   <label className="folio-notification-switch"><span><strong>Weekly review alerts</strong><small>Existing alert category; this does not schedule the Assistant review below.</small></span><input aria-label="Weekly review alerts" type="checkbox" checked={Boolean(ownerPreferences.weekly_review)} disabled={busy} onChange={e=>void save({weekly_review:e.target.checked})}/></label>
   <details className="folio-assistant-schedule-settings"><summary><span className="folio-notification-disclosure-copy"><strong>Ask Folio schedule &amp; watches</strong><span className="folio-summary-note">Off by default. In-app insights only; this does not enable push.</span></span></summary>
    <div className="folio-assistant-schedule-body">
     <label className="folio-notification-switch"><span><strong>Proactive insights</strong><small>{ownerPreferences.assistant_proactive_enabled?'On: eligible financial updates appear in your saved Ask Folio chat. Confirmed bounded watches stay separate.':'Off: Folio won’t start eligible insight conversations. Confirmed bounded watches stay separate.'}</small></span><input aria-label="Proactive insights" type="checkbox" checked={Boolean(ownerPreferences.assistant_proactive_enabled)} disabled={busy} onChange={e=>void saveAssistantPreferences({assistant_proactive_enabled:e.target.checked})}/></label>
     <label className="folio-notification-switch"><span><strong>Daily safety checks</strong><small>{ownerPreferences.assistant_daily_check_enabled?'On: one daily check looks for an eligible current risk and only messages when there is one. No all-clear messages; this does not enable broader proactive insights.':'Off: no daily check runs. This is separate from broader proactive insights and does not change your device’s push permission.'}</small></span><input aria-label="Daily safety checks" type="checkbox" checked={Boolean(ownerPreferences.assistant_daily_check_enabled)} disabled={busy} onChange={e=>void saveAssistantPreferences({assistant_daily_check_enabled:e.target.checked})}/></label>
     {Boolean(ownerPreferences.assistant_daily_check_enabled)&&<label className="folio-assistant-time">Check time <input type="time" value={typeof ownerPreferences.assistant_daily_check_time==='string'?ownerPreferences.assistant_daily_check_time:'08:00'} disabled={busy} onChange={e=>void saveAssistantPreferences({assistant_daily_check_time:e.target.value})}/></label>}
     <label className="folio-notification-switch"><span><strong>Weekly review</strong><small>{ownerPreferences.assistant_weekly_review_enabled?'On: a short in-chat summary is scheduled for the saved day and time.':'Off: no scheduled weekly review runs.'}</small></span><input aria-label="Scheduled weekly review" type="checkbox" checked={Boolean(ownerPreferences.assistant_weekly_review_enabled)} disabled={busy} onChange={e=>void saveAssistantPreferences({assistant_weekly_review_enabled:e.target.checked})}/></label>
     {Boolean(ownerPreferences.assistant_weekly_review_enabled)&&<div className="folio-assistant-schedule-fields"><label>Day <select aria-label="Weekly review day" value={Number.isInteger(ownerPreferences.assistant_weekly_review_day)?ownerPreferences.assistant_weekly_review_day:0} disabled={busy} onChange={e=>void saveAssistantPreferences({assistant_weekly_review_day:Number(e.target.value)})}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,index)=><option value={index} key={day}>{day}</option>)}</select></label><label>Time <input aria-label="Weekly review time" type="time" value={typeof ownerPreferences.assistant_weekly_review_time==='string'?ownerPreferences.assistant_weekly_review_time:'09:00'} disabled={busy} onChange={e=>void saveAssistantPreferences({assistant_weekly_review_time:e.target.value})}/></label></div>}
     <div className="folio-assistant-timezone"><span>Time zone</span><strong>{String(ownerPreferences.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC')}</strong><button type="button" disabled={busy} onClick={()=>void saveAssistantPreferences({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'})}>Use this device</button></div>
     <p className="folio-assistant-push-note">Assistant schedules do not ask for browser notification permission or turn on push. Eligible important alerts use your existing push setting.</p>
     <div className="folio-assistant-watch-list"><h3>Bounded watches</h3>{assistantWatches.length?assistantWatches.map(watch=>{
      const refundId=watch.refund?.original_transaction_id;
      const canReviewRefund=watch.template==='expected_refund'&&watch.last_outcome==='needs_review'&&isAssistantTransactionId(refundId);
      return <div className="folio-assistant-watch" key={watch.watch_id}>
       <div><strong>{watch.label}</strong><small>{watch.status==='snoozed'?'Snoozed':'Active'}{ownerPreferences.in_app_enabled===false?' · Paused while in-app alerts are off.':''}</small>
       <AssistantWatchSettingsDetails watch={watch} timezone={String(ownerPreferences.timezone||'UTC')} hasPushDevice={hasPushDevice} onReviewRefund={canReviewRefund&&onOpenTransaction?()=>{onClose();onOpenTransaction(refundId!);}:undefined}/>
      </div>
      {watch.status==='active'?<button type="button" disabled={busy} onClick={()=>void setWatchState(watch,'snoozed')}>Snooze</button>:<button type="button" disabled={busy} onClick={()=>void setWatchState(watch,'active')}>Resume</button>}
      <button type="button" disabled={busy} onClick={()=>void setWatchState(watch,'resolved')}>Stop</button>
      </div>}) : ownerAssistantState ? <p>No active watches. You can ask Folio to review a bounded watch in chat.</p> : <p>Loading your private watch settings…</p>}{assistantWatches.length>0&&<p>Snooze pauses a watch for up to 7 days and never extends its confirmed end date.</p>}{ownerAssistantLoadError&&<p role="status">Watch list unavailable. {ownerAssistantLoadError}</p>}</div>
    </div>
   </details>
   <details><summary>Alert categories</summary>{categories.map(([key,label])=><label key={key} className="folio-notification-switch"><span>{label}</span><input aria-label={label} type="checkbox" checked={Boolean(ownerPreferences[key])} disabled={busy} onChange={e=>void save({[key]:e.target.checked})}/></label>)}<p>Push alerts are available for selected account, cash-flow, recurring, and plan risks. Other categories control in-app delivery.</p></details>
   <details className="folio-notification-disclosure"><summary><span className="folio-notification-disclosure-copy"><strong>Quiet hours</strong><span className="folio-summary-note">Delay non-urgent notifications during this time.</span></span></summary><label className="folio-notification-switch"><span>Pause alerts during quiet hours</span><input aria-label="Pause alerts during quiet hours" type="checkbox" checked={Boolean(ownerPreferences.quiet_hours_enabled)} disabled={busy} onChange={e=>void save({quiet_hours_enabled:e.target.checked})}/></label>
   {ownerPreferences.quiet_hours_enabled&&<div className="folio-quiet-hours"><label>From <input type="time" value={ownerPreferences.quiet_hours_start} disabled={busy} onChange={e=>void save({quiet_hours_start:e.target.value})}/></label><label>Until <input type="time" value={ownerPreferences.quiet_hours_end} disabled={busy} onChange={e=>void save({quiet_hours_end:e.target.value})}/></label><p>Time zone: {ownerPreferences.timezone}</p><button type="button" disabled={busy} onClick={()=>void save({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})}>Use this device’s time zone</button></div>}</details>
   {!!ownerDevices.filter(d=>d.enabled).length&&<details><summary>Enabled devices ({ownerDevices.filter(d=>d.enabled).length})</summary>{ownerDevices.filter(d=>d.enabled).map(d=><div className="folio-notification-switch" key={d.subscription_id}><span>{d.device_label}{d.installation_id&&d.installation_id===pushInstallationId()?' · This installation':''}<small style={{display:'block'}}>Added {new Date(d.created_at).toLocaleDateString()}</small></span><button type="button" disabled={busy} onClick={()=>void disableDevice(d.subscription_id)}>Remove</button></div>)}</details>}
  </>}
  {ownerAssistantLoadError&&<p role="status">Assistant watch list unavailable. {ownerAssistantLoadError}</p>}
  <p role="status" aria-live="polite">{message}</p>
 </section></div>;
}
