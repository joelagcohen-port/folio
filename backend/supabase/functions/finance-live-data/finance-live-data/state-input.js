// Data adapters mirror the existing UI; parity-tested against browser adapters.
const day=value=>new Date(value+"T12:00:00Z");
const key=value=>value.toISOString().slice(0,10);
export function inputFrom(snapshot,history,rows){
    const months=(history?.months||[]).filter(m=>m<snapshot.month),all=[...(history?.rows||[]),...rows];
    const buckets=new Map();
    for(const row of all){if(row.date>snapshot.today||!Number.isFinite(row.amount))continue;const id=row.date+'|'+row.category;buckets.set(id,{date:row.date,category:row.category,amount:(buckets.get(id)?.amount||0)+row.amount});}
    const bills=[];let cadenceComplete=true;
    for(const stream of snapshot.recurring||[]){
      if(stream.status!=='Active'||!stream.forecast||stream.primaryEligible===false||['income','transfer','repayment','needs_review'].includes(stream.type)||!/^20\d\d-\d\d-\d\d$/.test(stream.dateIso||''))continue;
      if(!['Weekly','Biweekly','Monthly','Annual','Quarterly'].includes(stream.frequency))cadenceComplete=false;
      const ids=new Set(stream.transactionIds||[]),matched=new Set(all.filter(row=>ids.has(row.id)).map(row=>row.category));
      for(const linked of history?.transactionCategories||[])if(ids.has(linked.id)&&linked.category)matched.add(linked.category);
      const category=stream.category?String(stream.category):(matched.size===1?[...matched][0]:null);
      let date=stream.dateIso;
      for(let i=0;i<32&&date.slice(0,7)<=snapshot.month;i++){
        if(date>snapshot.today){const amount=Number(stream.amount),amountValid=stream.amount!==null&&stream.amount!==undefined&&stream.amount!==''&&Number.isFinite(amount);bills.push({id:stream.id+':'+date,name:String(stream.name).slice(0,120),category,date,amount:Math.abs(Number(stream.amount)||0),amountValid,currency_code:stream.currency??null,currency_verified:stream.currencyVerified===true,lifecycle_paused:stream.lifecyclePaused===true,lifecycle_skipped_dates:stream.lifecycleSkippedDates??[],pending_occurrence_date:stream.pendingOccurrenceDate??null});}
        // Only exact supported cadences are extended. Ambiguous semimonthly dates remain next-only.
        const days=stream.frequency==='Weekly'?7:stream.frequency==='Biweekly'?14:null;
        if(!days)break;
        const d=day(date);d.setUTCDate(d.getUTCDate()+days);date=key(d);
      }
    }
    return {today:snapshot.today,updatedAt:snapshot.updatedAt,budgets:snapshot.budgets.filter(b=>b.id),days:[...buckets.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.category.localeCompare(b.category)),historyMonths:months,historyReady:history?.ready===true&&months.length>=2&&history.forMonth===snapshot.month&&Date.now()-Date.parse(history.updatedAt)<86400000,recurringReady:snapshot.recurringReady&&snapshot.recurringComplete===true&&cadenceComplete,bills};
  }
export function recurringKind(stream) {
    const normalized=String(stream.recurring_kind||'').toLowerCase();if(normalized==='income')return'income';if(normalized==='internal_transfer')return'transfer';if(normalized==='credit_card_repayment')return'repayment';if(normalized==='needs_review')return'needs_review';if(normalized==='subscription')return'subscription';if(normalized==='expense')return'bill';
    const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const primary = normalize(stream.personal_finance_category_primary), detail = normalize(stream.personal_finance_category_detailed);
    const description = String(stream.description || stream.merchant_name || '');
    // Credit-card repayments carry transfer categories too, but remain cash-flow
    // obligations. Classify them before excluding actual account transfers.
    if (primary.includes('credit_card_payment') || detail.includes('credit_card_payment') || /credit card (?:payment|repayment)/i.test(description)) return 'repayment';
    // Restrict text matching to bank-account transfer wording: Zelle/vendor payments may be expenses.
    if (/^transfers?($|_)/.test(primary) || /^transfers?_(in|out|internal|account)/.test(detail) || /\b(?:online\s+)?transfer\s+(?:to|from)\s+(?:chk|sav|checking|savings)\b/i.test(description) || /\b(?:internal|interaccount|inter-account) transfer\b/i.test(description)) return 'transfer';
    if (stream.flow_type === 'inflow') return 'income';
    return ['services', 'general_services', 'entertainment'].includes(primary) ? 'subscription' : 'bill';
  }
export function excludeNonIncomeInflows(streams, transactionRows) {
    const excluded = new Set((transactionRows || []).filter(tx =>
      (['refund', 'reimbursement', 'statement_credit'].includes(tx.refund_relationship_type) && tx.refund_status !== 'not_refund') ||
      tx.effective_type === 'refund' || tx.effective_type === 'other_inflow'
    ).map(tx => tx.transaction_id));
    for (const stream of streams || []) {
      const ids = Array.isArray(stream.transaction_ids) ? stream.transaction_ids : [];
      stream.contains_non_income_inflow = stream.flow_type === 'inflow' && ids.some(id => excluded.has(id));
      if (stream.contains_non_income_inflow) {
        stream.forecast_classification = 'refund_or_other_inflow';
        stream.include_in_forecast = false;
      }
    }
    return streams;
  }
export function budgetPlanningGroup(item){
        if(['Fixed','Flexible','Non-monthly'].includes(item.group))return item.group;
        const name=String(item.name||'').trim().toLowerCase();
        const fixed=new Set(['mortgage','rent','garbage','water','gas & electric','internet & cable','phone','auto payment','student loans','loan repayment','insurance','child care','office rent','business insurance','credit card payment','credit card payments','debt payment','debt repayment','loan payment','loan payments','credit card debt']);
        const nonMonthly=new Set(['gifts','charity','travel & vacation','home improvement','auto maintenance','taxes','medical','dentist','education','furniture & housewares','electronics']);
        const flexible=new Set(['dining','groceries','restaurants','fast food','coffee shops','shopping','entertainment','personal care','gas','fuel','transportation','pets','household supplies','subscriptions','clothing','uncategorized']);
        if(fixed.has(name))return 'Fixed';if(nonMonthly.has(name))return 'Non-monthly';
        if(flexible.has(name))return 'Flexible';
        return item.strict===true?'Unknown':'Flexible';
      }
