import {buildPushPayload} from 'npm:@block65/webcrypto-web-push@2.0.0';
import {serviceClient,collectDailyInvestmentEvidence,refreshAgentState,refreshAssistantEvidenceOnly,listAgentEvents,getAgentState,getAgentStateForAssistant,agentMemories,consistentPlanFinancialState} from './index.ts';
import {sendTestPush} from './test-push.ts';
import {runAgentSchedule,runAssistantProjectionUpdate} from './schedule-runner.ts';
import {runAssistantDueWatches} from './assistant-due-dispatch.ts';
import {dispatchDueAssistantTasks,dispatchAssistantTaskPushes} from './assistant-task-scheduler.ts';
import {assistantTaskCapabilityOperation} from './assistant-task-capability.ts';
Deno.serve(async request=>{
 if(request.method!=='POST')return Response.json({error:'Unauthorized'},{status:401});
 let raw='',totalBytes=0;
 try{if(!request.body)return Response.json({error:'Invalid request'},{status:400});const decoder=new TextDecoder(),reader=request.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;totalBytes+=value.byteLength;if(totalBytes>40960){await reader.cancel();return Response.json({error:'Request too large'},{status:413});}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}catch{return Response.json({error:'Invalid request'},{status:400});}
 const body=(()=>{try{return JSON.parse(raw);}catch{return null;}})();
 if(request.method==='POST'&&body&&typeof body==='object'&&!Array.isArray(body)&&typeof body.operation==='string'&&body.operation.startsWith('assistant_task_'))return assistantTaskCapabilityOperation(request,body);
 const expected=Deno.env.get('PLAID_MCP_SHARED_SECRET')||'',supplied=request.headers.get('x-plaid-app-secret')||'';
 if(!expected||supplied.length!==expected.length)return Response.json({error:'Unauthorized'},{status:401});
 let difference=0;for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^supplied.charCodeAt(i);
 if(difference)return Response.json({error:'Unauthorized'},{status:401});
 if(!body||typeof body!=='object'||Array.isArray(body))return Response.json({error:'Invalid request'},{status:400});
 if(body.operation==='test_push'){try{return Response.json(await sendTestPush(serviceClient(),body,buildPushPayload));}catch(e){return Response.json({error:(e as Error).message},{status:400});}}
 if(body.operation==='assistant_projection_update'){
  if(Object.keys(body).sort().join(',')!=='household_id,operation,source_key'||typeof body.household_id!=='string'||typeof body.source_key!=='string')return Response.json({error:'Invalid request'},{status:400});
  try{return Response.json(await runAssistantProjectionUpdate(serviceClient(),body.household_id,body.source_key,{refreshAgentState:refreshAssistantEvidenceOnly,listAgentEvents}));}
  catch{return Response.json({error:'Assistant projection update failed'},{status:500});}
 }
 if(body.operation==='assistant_due'){if(Object.keys(body).length!==1)return Response.json({error:'Invalid request'},{status:400});try{const db=serviceClient(),now=new Date();const watches=await runAssistantDueWatches(db,{buildPushPayload,refreshAgentState:refreshAssistantEvidenceOnly,listAgentEvents},now);const tasks=await dispatchDueAssistantTasks(db,now);const task_push=await dispatchAssistantTaskPushes(db,{buildPushPayload},now);return Response.json({...watches,scheduled_tasks:tasks,task_push});}catch{return Response.json({error:'Assistant due check failed'},{status:500});}}
 if(body.operation)return Response.json({error:'Unknown operation'},{status:400});
 try{return Response.json(await runAgentSchedule(serviceClient(),{refreshAgentState,refreshAssistantEvidenceOnly,collectDailyInvestmentEvidence,listAgentEvents,getAgentState,getAgentStateForAssistant,loadMemories:agentMemories,loadFinancialState:(c:any)=>consistentPlanFinancialState(serviceClient(),c),buildPushPayload}));}catch{return Response.json({error:'Scheduled check failed'},{status:500});}
});
