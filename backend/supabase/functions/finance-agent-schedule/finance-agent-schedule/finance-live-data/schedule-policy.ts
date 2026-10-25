export function scheduledTriggers(now:Date,zone='UTC'){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(now);
 const get=(type:string)=>parts.find(p=>p.type===type)?.value||'';
 const date=`${get('year')}-${get('month')}-${get('day')}`,hour=Number(get('hour')),day=Number(get('day')),triggers=[];
 // Catch up missed checks later the same day; stable keys make retries harmless.
 if(hour>=8)triggers.push({key:`daily:${date}`,type:day===15?'mid_month':day===new Date(Number(get('year')),Number(get('month')),0).getDate()?'month_end':'daily'});
 if(get('weekday')==='Sun'&&hour>=9)triggers.push({key:`weekly:${date}`,type:'weekly'});
 return triggers;
}
export function weeklyReviewSummary(events:any[],decisions:any[],goals:any[],forecast:any){
 return {events:events.filter(e=>(e.delivery_channels||[]).includes('weekly_review')).map(e=>({event_id:e.event_id,title:e.title,summary:e.summary,status:e.status})).slice(0,12),resolved:decisions.filter(d=>['approved','acknowledged','expected'].includes(d.feedback)).map(d=>({event_type:d.event_type,feedback:d.feedback})).slice(0,12),goals:goals.map(g=>({name:g.name,current:g.current_amount,target:g.target_amount})),forecast};
}
