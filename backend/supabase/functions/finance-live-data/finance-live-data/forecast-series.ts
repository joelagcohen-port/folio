export const FORECAST_SERIES_CONTRACT='dated-end-of-day-v1';
const cents=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&Number.isSafeInteger(Math.round(v*100))?Math.round(v*100):null;
const date=(v:any)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export const addForecastDays=(v:string,n:number)=>new Date(Date.parse(v+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function buildDatedForecast(start:string,horizon:number,starting:number,events:any[]){
 const initial=cents(starting);if(!date(start)||![30,60,90].includes(horizon)||initial===null||!Array.isArray(events))throw new Error('Invalid forecast series inputs');
 const daily=new Map<string,number>(),end=addForecastDays(start,horizon);
 for(const event of events){const value=cents(event?.amount);if(!date(event?.date)||value===null||event.date<start||event.date>end)throw new Error('Forecast event outside dated range');const sum=(daily.get(event.date)||0)+value;if(!Number.isSafeInteger(sum))throw new Error('Forecast amount overflow');daily.set(event.date,sum);}
 let balance=initial,low=initial,high=initial,lowDate=start;const points=[];
 for(let day=0;day<=horizon;day++){const key=addForecastDays(start,day);balance+=daily.get(key)||0;if(!Number.isSafeInteger(balance))throw new Error('Forecast balance overflow');if(balance<low){low=balance;lowDate=key;}high=Math.max(high,balance);points.push({date:key,balance:balance/100});}
 return {points,starting_balance:initial/100,projected_low:low/100,projected_high:high/100,ending_balance:balance/100,low_date:lowDate,series_contract:FORECAST_SERIES_CONTRACT};
}
export function verifiedDatedSnapshot(snapshot:any){
 try{const inputs=snapshot?.source_provenance?.forecast_inputs;
 if(snapshot?.input_quality!=='complete'||snapshot?.coverage?.complete!==true||inputs?.series_contract!==FORECAST_SERIES_CONTRACT||typeof inputs.timezone!=='string'||!inputs.timezone||typeof snapshot.household_id!=='string'||!snapshot.household_id||!Array.isArray(snapshot.points)||!snapshot.points.length||!Array.isArray(snapshot.account_states)||!snapshot.account_states.length||(!Number.isFinite(Date.parse(snapshot.generated_at))||Date.parse(snapshot.generated_at)>Date.now())||typeof snapshot.input_revision!=='string'||!snapshot.input_revision)return null;
 const identities=snapshot.account_states.map((a:any)=>{if(typeof a?.canonical_account_id!=='string'||!a.canonical_account_id||typeof a.account_id!=='string'||!a.account_id||!['depository','credit'].includes(a.type)||a.lifecycle_status!=='active')throw new Error('Unverified account scope');return[a.canonical_account_id,a.account_id,a.type,a.lifecycle_status].join('|');}).sort();if(new Set(identities).size!==identities.length)return null;
 const series=buildDatedForecast(snapshot.points[0].date,snapshot.horizon_days,snapshot.starting_balance,snapshot.events);
 if(series.points.length!==snapshot.points.length||series.points.some((p:any,i:number)=>p.date!==snapshot.points[i]?.date||p.balance!==snapshot.points[i]?.balance)||series.projected_low!==snapshot.projected_low||series.ending_balance!==snapshot.ending_balance)return null;
 return {...series,scope:identities,household_id:snapshot.household_id,timezone:inputs.timezone,horizon_days:snapshot.horizon_days,generated_at:snapshot.generated_at,input_revision:snapshot.input_revision};
 }catch{return null;}
}
export function compareVerifiedForecasts(before:any,after:any){
 const a=verifiedDatedSnapshot(before),b=verifiedDatedSnapshot(after),unavailable={status:'unavailable',projected_low_delta:null,reason:'incomparable_snapshots'};
 if(before?.source_provenance?.forecast_inputs?.cash_scope_currency!=='USD'||after?.source_provenance?.forecast_inputs?.cash_scope_currency!=='USD'||before?.source_provenance?.forecast_inputs?.cash_scope_currency_verified!==true||after?.source_provenance?.forecast_inputs?.cash_scope_currency_verified!==true)return unavailable;
 if(!a||!b||a.household_id!==b.household_id||a.timezone!==b.timezone||a.horizon_days!==b.horizon_days||a.points[0].date!==b.points[0].date||a.points.at(-1)?.date!==b.points.at(-1)?.date||JSON.stringify(a.scope)!==JSON.stringify(b.scope)||Date.parse(a.generated_at)>=Date.parse(b.generated_at))return unavailable;
 const eventEvidence=(row:any)=>row.events.map((e:any)=>[e.stream_key??null,e.date,e.amount,e.flow_type??null,e.forecast_adjustment===true,e.categories??null]).sort((x:any,y:any)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
 const balanceEvidence=(row:any)=>(row.source_provenance?.forecast_inputs?.cash_scope_source_states??[]).map((r:any)=>[r.canonical_account_id,r.account_id,r.current_balance]).sort((x:any,y:any)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
 const financialChanged=a.starting_balance!==b.starting_balance||JSON.stringify(a.points)!==JSON.stringify(b.points)||JSON.stringify(eventEvidence(before))!==JSON.stringify(eventEvidence(after))||JSON.stringify(balanceEvidence(before))!==JSON.stringify(balanceEvidence(after));
 return {status:'available',reason:null,series_contract:FORECAST_SERIES_CONTRACT,from:a.generated_at,to:b.generated_at,household_id:b.household_id,timezone:b.timezone,horizon_days:b.horizon_days,start_date:b.points[0].date,end_date:b.points.at(-1)!.date,before_low:a.projected_low,after_low:b.projected_low,projected_low_delta:Math.round((b.projected_low-a.projected_low)*100)/100,financial_changed:financialChanged,freshness_only:!financialChanged,before_input_revision:a.input_revision,after_input_revision:b.input_revision};
}
