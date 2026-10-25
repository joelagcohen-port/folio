(function(global){
  'use strict';
  const day=(value)=>new Date(value+'T12:00:00Z');
  const key=(value)=>value.toISOString().slice(0,10);
  function inputFrom(snapshot,history,rows){
    const months=(history?.months||[]).filter(m=>m<snapshot.month),all=[...(history?.rows||[]),...rows];
    const buckets=new Map();
    for(const row of all){if(row.date>snapshot.today||!Number.isFinite(row.amount))continue;const id=row.date+'|'+row.category;buckets.set(id,{date:row.date,category:row.category,amount:(buckets.get(id)?.amount||0)+row.amount});}
    const bills=[];let cadenceComplete=true;
    for(const stream of snapshot.recurring||[]){
      if(stream.status!=='Active'||stream.primaryEligible===false||(stream.reviewReasons||[]).length||!Number.isFinite(stream.amount)||Math.abs(stream.amount)<=0||!stream.forecast||['income','transfer','repayment','internal_transfer','credit_card_repayment','needs_review'].includes(stream.type)||!/^20\d\d-\d\d-\d\d$/.test(stream.dateIso||''))continue;
      if(!['Weekly','Biweekly','Monthly','Annual','Quarterly'].includes(stream.frequency))cadenceComplete=false;
      const ids=new Set(stream.transactionIds||[]),matched=new Set(all.filter(row=>ids.has(row.id)).map(row=>row.category));
      const category=typeof stream.category==='string'&&stream.category.trim()?stream.category:(matched.size===1?[...matched][0]:null);
      let date=stream.dateIso;
      for(let i=0;i<32&&date.slice(0,7)<=snapshot.month;i++){
        if(date>snapshot.today)bills.push({id:stream.id+':'+date,name:String(stream.name).slice(0,120),category,date,amount:Math.abs(Number(stream.amount)||0)});
        // Only exact supported cadences are extended. Ambiguous semimonthly dates remain next-only.
        const days=stream.frequency==='Weekly'?7:stream.frequency==='Biweekly'?14:null;
        if(!days)break;
        const d=day(date);d.setUTCDate(d.getUTCDate()+days);date=key(d);
      }
    }
    return {today:snapshot.today,updatedAt:snapshot.updatedAt,budgets:snapshot.budgets.filter(b=>b.id),days:[...buckets.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.category.localeCompare(b.category)),historyMonths:months,historyReady:history?.ready===true&&months.length>=2&&history.forMonth===snapshot.month&&Date.now()-Date.parse(history.updatedAt)<86400000,recurringReady:snapshot.recurringReady&&snapshot.recurringComplete===true&&cadenceComplete,bills};
  }
  function budgetCoachSelection(categories,selected,manual,dismissedKeys){
    const actionable=categories.filter(x=>x.usable&&(x.risk!=='steady'||x.remainingWeekends!==null));
    const actionableUnreviewed=actionable.find(x=>!dismissedKeys.has(x.key));
    const category=manual?categories.find(x=>x.id===selected&&actionable.includes(x)):actionableUnreviewed||categories.find(x=>x.id===selected&&actionable.includes(x))||actionable[0]||null;
    const reviewed=Boolean(category&&!manual&&dismissedKeys.has(category.key));
    return {actionable,category,reviewed,expanded:Boolean(category&&!reviewed)};
  }
  function init(api){
    let value=null,selected=null,manual=false,working=false,timer=null,currentKey='',failedKey='',loaded=false,cache=null,visitBaseline=null,epoch=0,owner=null,error='',showBrief=false,queued=false,visitRecorded=false;
    const root=api.root,e=api.escape,money=api.money;
    const guidedHomeContent=root.querySelector('.folio-guided-home-content');
    function setHomeBriefContext(active){
      const slot=root.querySelector('.folio2-home-brief-body'),source=guidedHomeContent?.querySelector('.fg-priority'),moved=slot?.querySelector('.fg-priority');
      if(active&&slot&&source&&source!==moved){if(moved)moved.replaceWith(source);else slot.append(source);}
      if(!active&&guidedHomeContent&&moved){const placeholder=guidedHomeContent.querySelector('.fg-priority');if(placeholder&&placeholder!==moved)placeholder.replaceWith(moved);else if(moved.parentElement!==guidedHomeContent)guidedHomeContent.append(moved);}
    }
    function signalCoachingReady(){global.dispatchEvent(new CustomEvent('folio-coaching-ready',{detail:{agentState:value?.agentState||null}}));}
    const dismissed=()=>new Set(global.__folioDismissedInsightKeys||[]);
    const action=(name,label,primary=false)=>`<button type="button" data-coach="${name}" class="fc-button${primary?' fc-primary':''}">${e(label)}</button>`;
    function dismiss(id){const keys=dismissed();keys.add(id);global.__folioDismissedInsightKeys=[...keys];parent.postMessage({type:'folio-dismiss-guided-insight',insightKey:id},location.origin);}
    function evidence(c){return `<details class="fc-evidence"><summary>Why this suggestion</summary><dl><div><dt>Monthly target</dt><dd>${money(c.target)}</dd></div><div><dt>Spent so far</dt><dd>${money(c.spent)}</dd></div><div><dt>Known bills still ahead</dt><dd>${money(c.reserve)}</dd></div>${c.projected!==null?`<div><dt>Estimated month-end</dt><dd>${money(c.projected)}</dd></div>`:''}${c.typicalWeekend!==null?`<div><dt>Typical shopping weekend</dt><dd>${money(c.typicalWeekend)}</dd></div>`:''}</dl><p>${c.historyMonths} complete months of history · ${c.purchaseDays} purchase days. Estimates blend history and recent spending; a weekend pattern requires repeated purchases and most spending on weekends.</p><p>Known bills and spending estimates overlap; we use the larger estimate rather than adding them. Pending purchases are included. Future purchases and bill amounts can change.${value.coaching.unknownBills?' Some upcoming bills could not be matched to a category; review Recurring before moving money.':''}</p>${value.brief.goals.length?`<p>Your active goals: ${value.brief.goals.map(e).join(' · ')}. Transfers preserve the total budget and do not change goal contributions.</p>`:''}</details>`;}
    function render(){
      if(!api.enabled()){root.querySelector('.fc-budget')?.remove();return;}
      const f2BriefSlot=root.querySelector('[data-panel="home"].folio2-home-mode .folio2-home-brief-body');
      const home=f2BriefSlot?.querySelector('.fg-priority')||root.querySelector('.fg-home .fg-priority'),overview=root.querySelector('.folio-budget-overview');
      if(f2BriefSlot&&home&&home.parentElement!==f2BriefSlot)f2BriefSlot.append(home);
      if(!value){root.querySelector('.fc-budget')?.remove();if(home&&(working||error)){home.classList.add('fc-card');home.innerHTML=`<p class="fg-eyebrow">HOUSEHOLD BRIEF</p><p role="status">${e(error||'Preparing your brief…')}</p>${error?action('retry','Try again'):''}`;}return;}
      if(home){
        const b=value.brief,seen=!showBrief&&dismissed().has(b.key);
        home.classList.add('fc-card');home.innerHTML=seen?`<p class="fg-eyebrow">HOUSEHOLD BRIEF</p><p>You’re caught up.</p>${action('show-brief','View brief')}`:`<p class="fg-eyebrow">HOUSEHOLD BRIEF</p>${b.changes?.length?`<p class="fc-context">Since your last visit · ${b.changes.length} meaningful change${b.changes.length===1?'':'s'}</p>`:''}<h3>${e(b.title)}</h3><p>${e(b.text)}</p>${b.changes?.length?`<p class="fc-context">${e(b.changes.slice(0,2).join(' · '))}</p>`:''}<details class="fc-evidence"><summary>Brief details</summary>${b.changes?.length?`<ul>${b.changes.map(change=>`<li>${e(change)}</li>`).join('')}</ul>`:''}<dl><div><dt>Budget remaining</dt><dd>${money(value.coaching.totalTarget-value.coaching.totalSpent)}</dd></div>${b.forecast?`<div><dt>Projected cash low · ${e(new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'}).format(day(b.forecast.date)))}</dt><dd>${money(b.forecast.balance)}</dd></div>`:''}</dl><p>${value.coaching.nextBills.length?value.coaching.nextBills.map(x=>`${e(x.name)} · ${money(x.amount)}`).join('<br>'):'No upcoming payments in the loaded recurring data.'}</p>${b.goals.length?`<p>Your goals: ${b.goals.map(e).join(' · ')}</p>`:''}<p>${b.ai?'AI summary of':'Calculated from'} your loaded household data and the current cash forecast. ${e(new Date(b.generatedAt).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}. Forecasts are estimates.${!value.coaching.categories.some(c=>c.usable)?' Personalized budget coaching is waiting for complete history.':''}</p></details><div class="fc-actions">${action('brief-action',b.action==='planning'?'Review outlook':b.action==='budget'?'Review budget':b.action==='accounts'?'Review accounts':'Review bills',true)}${action('dismiss-brief','Got it')}</div>`;
      }
      if(!overview)return;
      const forecast=root.querySelector('[data-panel="budget"] .folio-budget-forecast');
      let card=root.querySelector('.fc-budget');if(!card){card=document.createElement('section');card.className='fc-budget';forecast?.after(card);}
      root.querySelectorAll('[data-panel="budget"] .fg-budget-summary,[data-panel="budget"] .fg-inline').forEach(n=>n.remove());
      const categories=value.coaching.categories;card.hidden=false;
      const selection=budgetCoachSelection(categories,selected,manual,dismissed()),actionable=selection.actionable;
      let c=selection.category;
      selected=c?.id||null;
      const seen=selection.reviewed,explanation=c?value.explanations.find(x=>x.id===c.id):null;
      if(!c||seen){
        card.classList.remove('fc-card');
        card.classList.add('fc-budget-compact');
        const reviewed=Boolean(seen&&c);
        const emptyReason=!categories.length?'Personalized coaching will appear when enough spending history is available.':categories.find(x=>!x.usable)?.summary||'No budget suggestion needs attention right now. Your targets and spending details remain below.';
        const html=reviewed
          ?`<button class="folio-budget-coach-row" type="button" data-coach="show-coach" aria-label="Open reviewed ${e(c.name)} suggestion"><span>Budget coach</span><span>${e(c.name)} · Reviewed</span><span class="folio-budget-row-chevron" aria-hidden="true">›</span></button>`
          :`<details class="fc-evidence fc-coach-compact"><summary class="folio-budget-coach-row"><span>Budget coach</span><span>No new suggestions</span><span class="folio-budget-row-chevron" aria-hidden="true">›</span></summary><p>${e(emptyReason)}</p></details>`;
        if(card.__content!==html){card.innerHTML=html;card.__content=html;}
        return;
      }
      card.classList.remove('fc-budget-compact');
      card.classList.add('fc-card');
      const html=`<div class="fc-heading"><h3>Budget coach</h3><span>This month</span></div><label class="fc-picker"><span class="fc-sr">Budget category</span><select data-coach-category aria-label="Budget category">${actionable.map(x=>`<option value="${e(x.id)}"${x.id===c.id?' selected':''}>${e(x.name)}</option>`).join('')}</select></label><p class="fc-guidance">${e(c.summary)}</p>${explanation?`<p class="fc-context">${e(explanation.text)}</p>`:''}<div class="fc-metrics"><div><span>Remaining</span><strong>${money(c.remaining)}</strong></div><div><span>${c.weekendAllowance!==null?'Per weekend':c.allowance!==null?'Next '+c.windowDays+' days':'Estimated month-end'}</span><strong>${c.weekendAllowance!==null?money(c.weekendAllowance):c.allowance!==null?money(c.allowance):'—'}</strong></div></div>${evidence(c)}${c.transfer?`<p class="fc-transfer">Consider ${money(c.transfer.amount)} from ${e(c.transfer.fromName)}. Review both allocations before confirming.</p>`:''}<div class="fc-actions">${action(c.transfer?'transfer':'transactions',c.transfer?'Review transfer':'Transactions',true)}${action('dismiss-coach','Got it')}</div>`;
      // Preserve focus, open evidence, and native picker state across background renders.
      if(card.__content!==html){const open=card.querySelector('details')?.open;card.innerHTML=html;card.__content=html;if(open&&card.querySelector('details'))card.querySelector('details').open=true;}
    }
    async function refresh(force=false){
      if(!api.enabled()){signalCoachingReady();return;}if(working){queued=true;return;}
      const snapshot=api.snapshot();if(!snapshot){signalCoachingReady();return;}
      const user=global.__folioSessionUserId;if(!user)return;
      if(owner!==user){owner=user;value=null;loaded=false;cache=null;visitBaseline=null;visitRecorded=false;currentKey='';failedKey='';epoch++;}
      const mine=epoch;working=true;let requestKey='';
      try{
        if(!loaded){cache=await api.read('household-guidance');visitBaseline=cache?.value?.stateSnapshot||null;loaded=true;}
        const stable={...snapshot,updatedAt:undefined};
        const serialized=JSON.stringify(stable);
        const hash=global.crypto?.subtle?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serialized)))).map(n=>n.toString(16).padStart(2,'0')).join(''):serialized;
        requestKey=hash;
        if(!force&&(hash===currentKey||hash===failedKey))return;
        // Local guidance is only a render-while-refreshing snapshot. Ask the server
        // to validate its agent-state version so new events or memory changes are seen.
        if(!force&&cache?.key===hash&&Date.now()-cache.savedAt<6*3600000&&cache.value?.coaching){value=cache.value;render();}
        error='';render();
        const token=await global.__folioWaitForSession();
        const response=await fetch('/api/folio-coaching',{method:'POST',signal:AbortSignal.timeout(35000),headers:{'content-type':'application/json',authorization:'Bearer '+token,'x-folio-api-generation':document.querySelector('meta[name="folio-api-generation"]')?.content||'1'},body:JSON.stringify({snapshot,previousState:visitBaseline}),cache:'no-store'});
        const data=await response.json();if(mine!==epoch||owner!==global.__folioSessionUserId)return;
        if(!response.ok){failedKey=hash;error=data.disabled?'The brief is currently unavailable.':data.error||'Your brief could not load. Try again.';render();return;}
        value=data;currentKey=hash;failedKey='';cache={key:hash,savedAt:Date.now(),value};await api.write('household-guidance',cache);render();signalCoachingReady();
        if(!visitRecorded&&data.agentState?.financial_state_version){visitRecorded=true;fetch('/api/folio',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,'x-folio-api-generation':document.querySelector('meta[name="folio-api-generation"]')?.content||'1'},body:JSON.stringify({tool:'get_agent_state',args:{mark_seen:true,state_version:data.agentState.financial_state_version}}),cache:'no-store'}).catch(()=>{visitRecorded=false;});}
      }catch{failedKey=requestKey;error='Your brief could not load. Try again.';render();signalCoachingReady();}
      finally{working=false;if(queued){queued=false;clearTimeout(timer);timer=setTimeout(()=>refresh(),700);}}
    }
    function update(){if(!api.snapshot()){render();return;}render();clearTimeout(timer);timer=setTimeout(()=>refresh(),700);}
    root.addEventListener('change',event=>{if(event.target.matches('[data-coach-category]')){selected=event.target.value;manual=true;render();}});
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-coach]');if(!button)return;
      if(button.dataset.coach==='retry'){failedKey='';refresh(true);return;}if(!value)return;
      const name=button.dataset.coach,c=value.coaching.categories.find(x=>x.id===selected);
      if(name==='dismiss-brief'){dismiss(value.brief.key);showBrief=false;}
      if(name==='dismiss-coach'&&c){dismiss(c.key);manual=false;selected=null;}
      if(name==='show-coach')manual=true;
      if(name==='show-brief')showBrief=true;
      if(name==='brief-action'){if(value.brief.action==='budget'){selected=value.brief.focusId;manual=true;api.openPage('budget');}else if(value.brief.action==='planning'&&value.brief.planId)api.openPlanReview?.(value.brief.planId);else api.openPage(value.brief.action==='planning'?'planning':'recurring');}
      if(name==='transfer'&&c?.transfer)api.transfer(c);
      if(name==='transactions'&&c)api.transactions(c.id);
      render();
    });
    global.addEventListener('folio-guided-preferences',render);
    function invalidate(){epoch++;visitBaseline=cache?.value?.stateSnapshot||visitBaseline;value=null;cache=null;currentKey='';failedKey='';loaded=true;error='Refreshing household insights…';api.write('household-guidance',null).catch(()=>{});render();}
    return {update,refresh,render,invalidate,setHomeBriefContext,agentBudgetState:()=>Array.isArray(value?.coaching?.categories)?value.coaching.categories:null};
  }
  global.FolioCoaching={init,inputFrom,budgetCoachSelection};
})(typeof window==='undefined'?globalThis:window);
