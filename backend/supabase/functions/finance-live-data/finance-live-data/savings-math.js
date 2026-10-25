// Shared deterministic projection. public/folio-savings.js is an exact browser copy,
// checked by verify-financial-plans.mjs. No LLM or financial-data fetch is needed.
(function(root){
  function project({today,starts_on,ends_on,current,target,monthly}){
    const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
    if(!valid(today)||!valid(starts_on)||!valid(ends_on)||ends_on<starts_on||![current,target,monthly].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))return null;
    const from=today>starts_on?today:starts_on,month=day=>Number(day.slice(0,4))*12+Number(day.slice(5,7));
    // Preserve Folio's calendar-month contribution assumption: no extra deposit
    // in the current month; one contribution in each later month through the end.
    const months=Math.max(0,month(ends_on)-month(from)),projected=Math.round((current+months*monthly)*100)/100;
    return {months,projected,shortfall:Math.round(Math.max(0,target-projected)*100)/100,required_monthly:months?Math.ceil(Math.max(0,target-current)*100/months)/100:null};
  }
  root.FolioSavingsMath={project};
})(globalThis);
