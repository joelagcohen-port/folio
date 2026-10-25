/* Read-only recurring history: exact Folio-linked transaction IDs, never merchant-name guesses. */
(function(global){
  'use strict';
  const mountGenerations=new WeakMap();
  function months(now=new Date()) {
    return Array.from({length:12},(_,i)=>new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-11+i,1)).toISOString().slice(0,7));
  }
  function aggregate(item,rows,keys){
    const ids=new Set(item.transactionIds||[]),seen=new Set();
    // A posted row replaces its pending predecessor only when Folio linked both rows to this exact stream.
    // Exact linked transaction IDs are the authority here. A recurring stream can
    // belong to a mirrored household account whose rows are hidden from normal
    // account searches, so do not reject an exact match because its raw account
    // ID differs from the stream's currently displayed account ID.
    const candidates=rows.filter(row=>ids.has(String(row.transaction_id||'')));
    const replacedPendingIds=new Set(candidates.filter(row=>row.pending!==true).map(row=>String(row.pending_transaction_id||'')).filter(id=>ids.has(id)));
    const buckets=keys.map(key=>({key,total:0,rows:[]}));
    for(const row of candidates){
      const id=String(row.transaction_id||''),date=String(row.plaid_transaction_date||row.transaction_date||'').slice(0,10),amount=Number(row.amount);
      if(seen.has(id)||(row.pending===true&&replacedPendingIds.has(id))||!Number.isFinite(amount))continue;
      if((item.flow==='inflow'&&amount>=0)||(item.flow!=='inflow'&&amount<=0))continue;
      const currency=row.iso_currency_code||row.currency_code;if(currency&&item.currency&&currency!==item.currency)throw Error('Linked payments have inconsistent currencies. History is unavailable.');
      const bucket=buckets.find(b=>b.key===date.slice(0,7));if(!bucket)continue;
      seen.add(id);bucket.rows.push({...row,historyDate:date});bucket.total=Math.round((bucket.total+Math.abs(amount))*100)/100;
    }
    buckets.forEach(b=>b.rows.sort((a,b)=>b.historyDate.localeCompare(a.historyDate)));
    return buckets;
  }
  async function load(item,call,now=new Date()){
    if(!item.transactionIds?.length)throw Error('No linked payments are available for this recurring item.');
    const keys=months(now),rows=[],visited=new Set();let offset=0;
    do{
      if(visited.has(offset))throw Error('History could not be loaded completely. Please retry.');visited.add(offset);
      const {data}=await call('search_transactions',{transaction_ids:item.transactionIds,start_date:keys[0]+'-01',end_date:now.toISOString().slice(0,10),include_pending:true,limit:200,offset});
      if(!Array.isArray(data.transactions))throw Error('History is unavailable. Please retry.');
      rows.push(...data.transactions);
      if(data.next_offset!==null&&(!Number.isInteger(data.next_offset)||data.next_offset<=offset))throw Error('History could not be loaded completely. Please retry.');
      offset=data.next_offset;
      if(offset===null&&Number(data.matched_transactions)>rows.length)throw Error('History could not be loaded completely. Please retry.');
    }while(offset!==null);
    const buckets=aggregate(item,rows,keys);
    if(!buckets.some(b=>b.rows.length)&&item.lastDate>=keys[0]+'-01')throw Error('Recent linked payments were reported, but history could not be loaded. History is unavailable.');
    return buckets;
  }
  async function mount(container,item,api){
    const generation=(mountGenerations.get(container)||0)+1;mountGenerations.set(container,generation);
    const isCurrent=()=>mountGenerations.get(container)===generation;
    const {escape,money,call}=api;
    const currency=item.currency||'USD',format=n=>currency==='USD'?money(n):new Intl.NumberFormat('en-US',{style:'currency',currency}).format(n);
    const quality=item.historyStatus==='unavailable'?'<p class="folio-muted folio-small" role="status">Some linked payments could not be checked. History may be incomplete; your expected amount and schedule are still available.</p>':item.historyStatus==='partial'?'<p class="folio-muted folio-small" role="status">History is incomplete. Some older matched payments may be missing.</p>':'';
    container.innerHTML='<h3>Payment history</h3><p role="status">Loading matched charges…</p>';
    try{
      const buckets=await load(item,call);if(!container.isConnected||!isCurrent())return;
      let selected=buckets.length-1;
      const label=key=>new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(key+'-01T00:00:00Z'));
      const last=item.lastDate?'<p class="folio-muted">Last detected charge: '+escape(global.FolioGuided.displayDate(item.lastDate,true))+'.</p>':'';
      const max=Math.max(1,...buckets.map(b=>b.total));
      container.innerHTML='<h3>Payment history</h3>'+quality+last+'<p class="folio-muted folio-small">12 months · matched payments</p><div class="frh-chart" role="group" aria-label="Monthly payment history">'+buckets.map((b,i)=>'<button type="button" data-history-month="'+i+'" aria-label="'+escape(label(b.key)+': '+format(b.total)+', '+b.rows.length+' payments')+'" aria-pressed="'+(i===selected)+'"><span class="frh-track"><span class="frh-bar" style="height:'+Math.max(2,b.total/max*100)+'%"></span></span><span>'+escape(label(b.key).split(' ')[0].slice(0,3))+'</span></button>').join('')+'</div><div class="frh-month" aria-live="polite"></div><p class="folio-muted folio-small">Only payments linked to this recurring item in Folio are shown. Gaps mean no matched payments were found, not proof the item stopped. Refunds are excluded.</p>';
      const chart=container.querySelector('.frh-chart');
      const monthButtons=Array.from(container.querySelectorAll('[data-history-month]'));
      function selectMonth(index,focus=false){
        selected=Math.max(0,Math.min(buckets.length-1,index));
        render();
        const button=monthButtons[selected];
        button?.scrollIntoView?.({behavior:'smooth',block:'nearest',inline:'center'});
        if(focus)button?.focus?.({preventScroll:true});
      }
      function render(){
        const b=buckets[selected];
        monthButtons.forEach((button,i)=>button.setAttribute('aria-pressed',String(i===selected)));
        container.querySelector('.frh-month').innerHTML='<h3>'+escape(label(b.key))+'</h3><dl class="folio-recurring-fields"><div><dt>Payments</dt><dd>'+b.rows.length+'</dd></div><div><dt>Total</dt><dd>'+format(b.total)+'</dd></div><div><dt>Average</dt><dd>'+format(b.rows.length?b.total/b.rows.length:0)+'</dd></div></dl>'+(b.rows.length?'<ul class="frh-transactions">'+b.rows.map(row=>'<li><span>'+escape(global.FolioGuided.displayDate(row.historyDate))+'<small>'+escape(row.merchant_name||row.name||item.name)+'</small></span><strong>'+format(Math.abs(Number(row.amount)))+'</strong></li>').join('')+'</ul>':'<p>No matched charges found for this month.</p>');
      }
      monthButtons.forEach((button,i)=>{
        button.onclick=()=>selectMonth(i);
        button.onkeydown=event=>{
          const delta=event.key==='ArrowRight'||event.key==='ArrowDown'?1:event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:0;
          if(delta){event.preventDefault();selectMonth(i+delta,true);return;}
          if(event.key==='Home'||event.key==='End'){event.preventDefault();selectMonth(event.key==='Home'?0:buckets.length-1,true);}
        };
      });
      render();
      chart.scrollLeft=chart.scrollWidth;
    }catch(error){if(!container.isConnected||!isCurrent())return;container.innerHTML='<h3>Payment history</h3>'+quality+'<p role="status">'+escape(error.message)+'</p><button class="folio-secondary-action" type="button">Retry history</button>';container.querySelector('button').onclick=()=>mount(container,item,api);}
  }
  global.FolioRecurringHistory={months,aggregate,load,mount};
})(globalThis);
