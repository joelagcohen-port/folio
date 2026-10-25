import {prepareAgentAction,executeAgentAction} from '../../folio-agent-actions.ts';
import { folioClientNeedsUpdate, folioUpdateRequiredResponse } from '../../folio-version.ts';
export async function POST(request:Request){
 const authorization=request.headers.get('authorization');if(!authorization?.startsWith('Bearer '))return Response.json({error:'Sign in required.'},{status:401});
 const body=await request.json().catch(()=>null) as any;
 if(!body||!['prepare','execute'].includes(body.operation))return Response.json({error:'Choose a supported action.'},{status:400});
 if(folioClientNeedsUpdate(request))return folioUpdateRequiredResponse();
 const result=await (body.operation==='prepare'?prepareAgentAction:executeAgentAction)(body.args||{},authorization);
 return Response.json(result.data,{status:result.status,headers:{'cache-control':'no-store'}});
}
