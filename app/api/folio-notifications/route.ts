import {getFolioPublicOrigin,sendPushJobs} from '../../../lib/server-shared/push-delivery.ts';
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { callFolioOperation, isRecord } from '../../folio-server';
import { validPushSubscription } from '../../../lib/server-shared/delivery-policy.ts';
import { folioClientNeedsUpdate, folioUpdateRequiredResponse } from '../../folio-version.ts';
const headers={'cache-control':'no-store'};
export async function GET(){return Response.json({publicKey:process.env.FOLIO_VAPID_PUBLIC_KEY||null,configured:Boolean(process.env.FOLIO_VAPID_PUBLIC_KEY&&process.env.FOLIO_VAPID_PRIVATE_KEY&&process.env.FOLIO_PUBLIC_URL)}, {headers});}
export async function POST(request:Request){
 const authorization=request.headers.get('authorization');
 if(!authorization?.startsWith('Bearer '))return Response.json({error:'Sign in required.'},{status:401,headers});
 const body=await request.json().catch(()=>null);
 if(!isRecord(body))return Response.json({error:'Invalid request.'},{status:400,headers});
 const tool=String(body.tool||''),args=isRecord(body.args)?body.args:{};
 if(!['get_notification_settings','get_agent_event_detail'].includes(tool)&&folioClientNeedsUpdate(request))return folioUpdateRequiredResponse();
 if(tool!=='dispatch'){
  if(!['get_notification_settings','save_notification_settings','save_push_subscription','remove_push_subscription','get_agent_event_detail'].includes(tool))return Response.json({error:'Unsupported notification operation.'},{status:400,headers});
  const result=await callFolioOperation(tool,args,authorization);
  return Response.json(result.data,{status:result.status,headers});
 }
 const publicKey=process.env.FOLIO_VAPID_PUBLIC_KEY,privateKey=process.env.FOLIO_VAPID_PRIVATE_KEY;
 let publicOrigin:string|undefined;try{publicOrigin=getFolioPublicOrigin();}catch{}
 if(!publicKey||!privateKey||!publicOrigin)return Response.json({error:'Push delivery is not configured.'},{status:503,headers});
 const claimed=await callFolioOperation('claim_agent_notifications',{},authorization);
 if(!claimed.ok)return Response.json(claimed.data,{status:claimed.status,headers});
 const jobs=isRecord(claimed.data)&&Array.isArray(claimed.data.jobs)?claimed.data.jobs:[];
 const result=await sendPushJobs(jobs,{publicKey,privateKey,subject:publicOrigin},buildPushPayload,(args:any)=>callFolioOperation('complete_agent_notifications',args,authorization),validPushSubscription);
 console.info('Folio push batch',{...result,llm_calls:0});
 return Response.json(result,{headers});
}
