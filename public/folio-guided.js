/* Progressive experience. No model-generated financial arithmetic or automatic writes. */
(function (global) {
  'use strict';
  const cents = n => Math.round(Number(n) * 100) / 100;
  function displayDate(value, year = false) {
    const date = new Date(String(value).slice(0,10) + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', ...(year?{year:'numeric'}:{}), timeZone:'UTC' }).format(date) : 'Date unavailable';
  }
  function displayDateRange(start, end) {
    if(start===end)return displayDate(start);
    if(String(start).slice(0,7)===String(end).slice(0,7))return displayDate(start)+'–'+Number(String(end).slice(8,10));
    const crossYear=String(start).slice(0,4)!==String(end).slice(0,4);
    return displayDate(start,crossYear)+' – '+displayDate(end,crossYear);
  }
  function displayInstantDate(value, options = {}) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', options).format(date) : 'Date unavailable';
  }
  function recurringKind(stream) {
    const normalized=String(stream.recurring_kind||'').toLowerCase();
    if(normalized==='income')return 'income';
    if(normalized==='expense')return 'bill';
    if(normalized==='subscription')return 'subscription';
    if(normalized==='internal_transfer')return 'transfer';
    if(normalized==='credit_card_repayment')return 'repayment';
    if(normalized==='needs_review')return 'needs_review';
    const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const primary = normalize(stream.personal_finance_category_primary), detail = normalize(stream.personal_finance_category_detailed);
    const description = String(stream.description || stream.merchant_name || '');
    if (primary === 'credit_card_payment' || /credit_card_payment/.test(detail)) return 'repayment';
    // Card repayments must be classified before generic TRANSFER_OUT; Zelle/vendor
    // rails are ordinary income or expense unless they name an internal account move.
    if (/^transfers?($|_)/.test(primary) || /^transfers?_(in|out|internal|account)/.test(detail) || /\b(?:online\s+)?transfer\s+(?:to|from)\s+(?:chk|sav|checking|savings)\b/i.test(description) || /\b(?:internal|interaccount|inter-account) transfer\b/i.test(description)) return 'transfer';
    if (stream.flow_type === 'inflow') return 'income';
    return ['services', 'general_services', 'entertainment'].includes(primary) ? 'subscription' : 'bill';
  }
  function rankRecurringInsights(snapshot, now = new Date()) {
    if(snapshot.agentEventsReady===true)return (snapshot.agentEvents||[]).filter(e=>e.event_type==='recurring_amount_change'&&(e.delivery_channels||['in_app']).includes('in_app')).flatMap(event=>{const item=(snapshot.recurring||[]).find(r=>(r.streamKey||r.streamId)===event.facts?.stream_key);return item?[{...item,eventId:event.event_id,amount:Number(event.facts.typical_amount),lastAmount:Number(event.facts.typical_amount)+Number(event.facts.increase),difference:Number(event.facts.increase)}]:[];});
    const updated = Date.parse(snapshot.recurringUpdatedAt), age = now - updated;
    if (!snapshot.recurringReady || snapshot.recurringComplete === false || !Number.isFinite(updated) || age < 0 || age > 300000) return [];
    return (snapshot.recurring || []).filter(item => {
      const latest = Date.parse(item.lastDate + 'T00:00:00Z'), days = (now - latest) / 86400000;
      return item.id && item.status === 'Active' && item.primaryEligible !== false && !(item.reviewReasons||[]).length && ['bill', 'subscription'].includes(item.type) && item.maturity === 'MATURE' && item.currency === 'USD' &&
        Number.isFinite(item.amount) && item.amount > 0 && Number.isFinite(item.lastAmount) && item.lastAmount > 0 && days >= 0 && days <= 45;
    }).map(item => ({ ...item, difference: cents(item.lastAmount - item.amount) }))
      .filter(item => item.difference > Math.max(5, item.amount * .08))
      .sort((a,b) => b.difference-a.difference || a.name.localeCompare(b.name));
  }
  // Each insight type has a local forward-fix guard; Guided itself remains default-off server-side.
  const enabledInsightTypes = Object.freeze({ transactions: true, overview: true, accounts: true, investments: true, cashflow: true, planning: true });
  function rankCashFlowIncrease(snapshot, now = new Date()) {
    const cash = snapshot.cashFlow, updated = Date.parse(cash?.updatedAt || ''), age = now - updated;
    if (!enabledInsightTypes.cashflow || !cash?.ready || cash.mode !== 'month' || !Number.isFinite(updated) || age < 0 || age > 300000) return [];
    const selected = cash.selected, prior = cash.prior;
    if (!selected?.range?.start || !selected?.range?.end || !prior?.range?.start || !prior?.range?.end || selected.range.end >= snapshot.today || !Number.isFinite(Number(selected.out)) || !Number.isFinite(Number(prior.out)) || Number(prior.out) <= 0) return [];
    const increase = cents(Number(selected.out) - Number(prior.out));
    if (increase < 100 || increase / Number(prior.out) < .15) return [];
    const categoryMap = rows => new Map((rows || []).filter(row => row?.type === 'expense' && row.category && Number.isFinite(Number(row.money_out))).map(row => [String(row.category), Number(row.money_out)]));
    const current = categoryMap(selected.categories), previous = categoryMap(prior.categories), names = [...new Set([...current.keys(), ...previous.keys()])];
    const changes = names.map(category => ({ category, delta:cents((current.get(category) || 0) - (previous.get(category) || 0)), currentTotal:current.get(category) || 0 })).filter(row => row.delta > 0).sort((a,b) => b.delta-a.delta || a.category.localeCompare(b.category));
    const top = changes[0];
    if (!top || Math.abs(cents(changes.reduce((sum,row) => sum + row.delta, 0)) - increase) > .01) return [];
    return [{ type:'cashflow-increase', selected, prior, increase, category:top.category, categoryIncrease:top.delta, currentCategoryTotal:top.currentTotal, id:`cashflow:${selected.range.start}:${selected.range.end}:${prior.range.start}:${prior.range.end}:${increase}:${top.category}:${top.delta}` }];
  }
  function rankPlanningLow(snapshot, now = new Date()) {
    if (snapshot.agentEventsReady === true) return (snapshot.agentEvents || []).filter(event => event.event_type === 'cash_floor_risk' && (event.delivery_channels||['in_app']).includes('in_app')).map(event => ({ type:'planning-low', eventId:event.event_id, title:event.title, summary:event.summary, projectedLow:Number(event.facts?.minimum_balance), lowDate:event.facts?.minimum_date, horizonDays:Number(event.facts?.horizon_days), scopeLabel:event.facts?.scope || 'Connected cash accounts', id:'agent-event:'+event.event_id }));
    const planning = snapshot.planning, updated = Date.parse(planning?.updatedAt || ''), age = now - updated;
    if (!enabledInsightTypes.planning || !planning?.ready || !Number.isFinite(updated) || age < 0 || age > 300000 || !Number.isFinite(Number(planning.projectedLow)) || Number(planning.projectedLow) >= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(planning.lowDate || '')) || !Number.isFinite(Number(planning.horizonDays)) || Number(planning.horizonDays) <= 0) return [];
    const event = planning.lowEvent && /^\d{4}-\d{2}-\d{2}$/.test(String(planning.lowEvent.date || '')) && planning.lowEvent.date === planning.lowDate && Number(planning.lowEvent.amount) < 0 ? planning.lowEvent : null;
    return [{ type:'planning-low', projectedLow:Number(planning.projectedLow), lowDate:planning.lowDate, horizonDays:Number(planning.horizonDays), scopeLabel:planning.scopeLabel || 'Connected cash accounts', lowEvent:event, id:`planning-low:${planning.horizonDays}:${planning.lowDate}:${cents(planning.projectedLow)}:${planning.scopeLabel || 'cash'}` }];
  }
  function rankTransactionInsights(snapshot, now = new Date()) {
    const updated = Date.parse(snapshot.transactionsUpdatedAt), age = now - updated;
    if (!enabledInsightTypes.transactions || !snapshot.transactionsReady || snapshot.transactionsComplete !== true || !snapshot.month || !Number.isFinite(updated) || age < 0 || age > 300000 || snapshot.transactionScope !== 'household-current-month') return [];
    const rows = (snapshot.reviewRows || []).filter(row => row && row.id && Number.isFinite(Number(row.amount)) && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || '')) && String(row.date).slice(0,7) === snapshot.month && String(row.date) <= snapshot.today);
    if (!rows.length) return [];
    rows.sort((a,b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
    const ids = [...new Set(rows.map(row => String(row.id)))].sort();
    if (ids.length !== rows.length) return [];
    return [{ type:'transactions', scope:snapshot.transactionScope, period:snapshot.month, rows, ids, id:`transactions:${snapshot.month}:${snapshot.transactionScope}:${ids.join(',')}` }];
  }
  function rankHomePriority(snapshot, now = new Date(), dismissed = new Set()) {
    if (snapshot.agentEventsReady === true) {
      const event = (snapshot.agentEvents || []).find(item => (item.delivery_channels||['home']).includes('home') && !dismissed.has('agent-event:'+item.event_id));
      if (event) {
        const facts = event.facts || {}, destination=event.recommended_actions?.[0]?.payload?.destination, kind = destination || (event.event_type === 'budget_pace_risk' ? 'budget' : event.event_type === 'recurring_amount_change' ? 'recurring' : event.event_type === 'cash_floor_risk' || event.event_type==='plan_at_risk' ? 'planning' : event.event_type === 'account_sync_issue' ? 'accounts' : 'income');
        return { kind, item:kind==='budget'?{ id:event.event_id, name:facts.category || event.title, target:Number(facts.target)||0, spent:Number(facts.spent)||0, remaining:Number(facts.remaining)||0, eventId:event.event_id }:null, event, planId:event.event_type==='plan_at_risk'?String(facts.plan_id||''):null, headline:event.title, explanation:event.summary, key:'agent-event:'+event.event_id };
      }
      return null;
    }
    const budget = rankInsights(snapshot, now).find(item => !dismissed.has(item.id + ':' + item.target + ':' + snapshot.month));
    if (budget) return { kind:'budget', item:budget, key:budget.id + ':' + budget.target + ':' + snapshot.month };
    const recurring = rankRecurringInsights(snapshot, now).find(item => !dismissed.has('recurring:'+item.id+':'+item.lastDate+':'+item.lastAmount));
    return recurring ? { kind:'recurring', item:recurring, key:'recurring:'+recurring.id+':'+recurring.lastDate+':'+recurring.lastAmount } : null;
  }
  function rankAccountHealth(snapshot, now = new Date()) {
    if(snapshot.agentEventsReady===true)return (snapshot.agentEvents||[]).filter(e=>e.event_type==='account_sync_issue'&&(e.delivery_channels||['in_app']).includes('in_app')).flatMap(event=>{const account=(snapshot.accounts||[]).find(a=>a.institution===event.facts?.institution);return account?[{...account,accountId:account.id,id:'agent-event:'+event.event_id,type:event.facts.state==='stale'?'stale':'failed',scope:'account:'+account.id}]:[];});
    if (!enabledInsightTypes.accounts || snapshot.accountsReady !== true) return [];
    const auth = new Set(['login_required','authentication_required','auth_required','reauth_required']);
    const failed = new Set(['needs_attention','error','failed','sync_failed']);
    const refreshing = new Set(['refreshing','pending','syncing','in_progress']);
    const candidates = (snapshot.accounts || []).filter(account => account && account.id && !refreshing.has(String(account.status || '').toLowerCase())).map(account => {
      const status = String(account.status || '').toLowerCase();
      const sourceTime = Date.parse(account.sourceBalanceUpdatedAt || '');
      const stale = Number.isFinite(sourceTime) && now - sourceTime >= 48 * 60 * 60 * 1000;
      const type = auth.has(status) ? 'auth' : failed.has(status) ? 'failed' : stale ? 'stale' : null;
      return type ? { ...account, type, sourceTime: Number.isFinite(sourceTime) ? sourceTime : null } : null;
    }).filter(Boolean);
    const priority = { auth: 0, failed: 1, stale: 2 };
    return candidates.sort((a,b) => priority[a.type] - priority[b.type] || (a.type === 'stale' ? a.sourceTime - b.sourceTime : 0) || String(a.id).localeCompare(String(b.id))).map(item => ({ ...item, accountId:item.id, scope: 'account:' + item.id, id: `account-health:${item.type}:${item.id}:${item.type === 'stale' ? item.sourceBalanceUpdatedAt : String(item.status || '').toLowerCase()}` }));
  }
  function rankInvestmentFailures(snapshot) {
    const investment=snapshot.investment, priority=['holdings','history','benchmark'];
    if (!enabledInsightTypes.investments || !investment?.scope || !Number.isInteger(investment.episode)) return [];
    const failure=priority.map(dataset=>(investment.failures||[]).find(item=>item?.dataset===dataset)).find(Boolean);
    if (!failure) return [];
    const headline={holdings:'Holdings could not be refreshed.',history:'Investment history is unavailable.',benchmark:'Benchmark comparison is unavailable.'}[failure.dataset];
    return [{type:'investment-failure',dataset:failure.dataset,scope:investment.scope,scopeLabel:investment.scopeLabel||'Investment account',retainedHoldingsDate:investment.retainedHoldingsDate||null,episode:investment.episode,headline,id:`investment-failure:${failure.dataset}:${investment.scope}:${investment.episode}`}];
  }
  function rankInsights(snapshot, now = new Date()) {
    if(snapshot.agentEventsReady===true)return (snapshot.agentEvents||[]).filter(e=>e.event_type==='budget_pace_risk'&&(e.delivery_channels||['in_app']).includes('in_app')).flatMap(event=>{const budget=(snapshot.budgets||[]).find(b=>b.name===event.facts?.category);return budget?[{...budget,eventId:event.event_id,remaining:Number(event.facts.remaining),difference:Number(event.facts.projected_overage),pace:Number(event.facts.target)}]:[];});
    if (!snapshot.budgetsReady || !snapshot.updatedAt || now - new Date(snapshot.updatedAt) > 300000) return [];
    const periodMonth=String(snapshot.month||snapshot.today||'').slice(0,7),periodDay=Number(String(snapshot.today||'').slice(8,10))||now.getDate(),periodParts=periodMonth.match(/^(\d{4})-(\d{2})$/),daysInPeriod=periodParts?new Date(Date.UTC(Number(periodParts[1]),Number(periodParts[2]),0)).getUTCDate():new Date(now.getFullYear(),now.getMonth()+1,0).getDate(),fraction=periodDay/daysInPeriod;
    return snapshot.budgets.filter(b => b.group === 'Flexible' && b.id && b.target > 0 && Number.isFinite(b.spent))
      .map(b => ({ ...b, pace: cents(b.target * fraction), difference: cents(b.spent - b.target * fraction), remaining: cents(b.target - b.spent) }))
      .filter(b => b.difference >= Math.max(25, b.target * .1))
      .sort((a, b) => b.difference - a.difference || a.name.localeCompare(b.name));
  }
  function guidedPreference(storage, user) {
    // Guided Home is the permanent experience; legacy device markers are ignored.
    return true;
  }
  function init(api) {
    const root = api.root, escape = api.escape, money = api.money;
    const state = { enabled: false, available: false, weekly: false, user: null, busy: false, selected: null, proposal: null, review: null, focus: null, dismissed: new Set(), flagsLoaded: false, explicitPageSelected: false };
    let flagsRequest = null, closeAnimation = null;
    const motion = (el, frames, duration = 260) => {
      if (!el?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
      el.getAnimations().forEach(a => a.cancel());
      return el.animate(frames, { duration, easing: 'cubic-bezier(.2,.8,.2,1)' });
    };
    const el = (tag, cls) => { const n = document.createElement(tag); n.className = cls; return n; };
    let home = root.querySelector('[data-panel="home"]');
    if (!home) { home = el('section', 'folio-page fg-home'); home.dataset.panel = 'home'; home.hidden = true; root.querySelector('.folio-dashboard').before(home); api.pages.push(home); }
    const homeContent = home.querySelector('.folio-guided-home-content') || home;
    let tab = root.querySelector('.folio-tab[data-page="home"]');
    if (!tab) { tab = el('button', 'folio-tab'); tab.type = 'button'; tab.dataset.page = 'home'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'false'); tab.innerHTML = '<i data-lucide="house" aria-hidden="true"></i><span>Home</span>'; root.querySelector('.folio-tabs').prepend(tab); api.tabs.push(tab); tab.onclick = () => navigate('home'); }
    const resume = el('button', 'folio-action fg-resume'); resume.type = 'button'; resume.hidden = true; resume.textContent = 'Return to weekly review'; root.querySelector('.folio-tabs').after(resume); resume.onclick = () => review();
    const dialog = el('dialog', 'fg-dialog'); dialog.setAttribute('aria-labelledby', 'fg-dialog-title'); root.append(dialog);
    dialog.innerHTML = '<header class="fg-dialog-head"><div><span class="folio-muted folio-small" data-fg-context></span><h2 id="fg-dialog-title"></h2></div><button type="button" class="fg-close" aria-label="Close details">×</button></header><div class="fg-body"></div><p class="fg-status" role="status" aria-live="polite"></p>';
    const body = dialog.querySelector('.fg-body'), status = dialog.querySelector('.fg-status');
    const key = () => 'folio-guided-v1:' + state.user;
    const reviewKey = () => key() + ':review:' + api.snapshot().weekStart;
    function dismissedKeys(value) {
      return new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && item.length > 0 && item.length <= 2000));
    }
    function applyDismissedInsights(value) {
      state.dismissed = dismissedKeys(value);
      if (state.enabled) render();
    }
    function dismissInsight(keyValue) {
      if (typeof keyValue !== 'string' || !keyValue || keyValue.length > 2000) return;
      state.dismissed.add(keyValue);
      if (keyValue.startsWith('agent-event:')) { api.call?.('feedback_agent_event', { event_id:keyValue.slice('agent-event:'.length), feedback:'snoozed', snooze_days:7 }).catch(() => {}); return; }
      parent.postMessage({ type:'folio-dismiss-guided-insight', insightKey:keyValue }, location.origin);
    }
    function persistReview() { if (state.user) try { sessionStorage.setItem(reviewKey(), JSON.stringify(state.review)); } catch {} }
    function clearReview() { state.review = null; resume.hidden = true; persistReview(); }
    function syncShell() {
      document.documentElement.classList.toggle('fg-modal-open', dialog.open);
      const activeTab = root.querySelector('.folio-tab[aria-selected="true"]');
      const folio2OptIn = new URLSearchParams(location.search).get('folio2') !== '0';
      const activePanel = root.querySelector('.folio-page:not([hidden])')?.dataset.panel;
      const folio2ActivityPage = folio2OptIn && ['folio2-spending', 'folio2-cashflow'].includes(activePanel) ? activePanel : null;
      const scenarioOpen = Boolean(root.querySelector('.folio-scenario-sheet:not([hidden])'));
      const rentalClassificationOpen = Boolean(root.querySelector('.rental-classification-dialog[open]'));
      const nativeDialogOpen = Boolean(root.querySelector('dialog[open]'));
      parent.postMessage({ type: 'folio-mobile-shell', enabled: state.enabled, title: folio2ActivityPage ? 'Activity' : activeTab?.querySelector('span')?.textContent || 'Home', page: folio2ActivityPage || activeTab?.dataset.page || 'home', modal: dialog.open || scenarioOpen || rentalClassificationOpen || nativeDialogOpen }, location.origin);
    }
    function setEnabled(enabled) {
      state.enabled = enabled && state.available && Boolean(state.user);
      const bootPending = !state.flagsLoaded || !state.user;
      tab.hidden = !state.enabled && !bootPending; root.classList.toggle('fg-enabled', state.enabled);
      root.querySelector('[data-page="dashboard"] span').textContent = state.enabled ? 'Overview' : 'Dashboard';
      if (!state.enabled) { close(true); clearReview(); api.clearTransactionReview?.(); api.renderDashboardBudgets?.(); api.renderDashboardSubscriptions?.(); api.renderDashboardCash?.(); root.querySelectorAll('.fg-inline,.fg-budget-summary,.fg-recurring-summary,.fg-transaction-summary,.fg-investment-summary,.fg-account-summary').forEach(n => n.remove()); const overviewSummary=root.querySelector('.fg-overview-summary');if(overviewSummary){overviewSummary.hidden=true;overviewSummary.innerHTML='';} if (home.classList.contains('folio2-home-mode')) { home.hidden = false; } else if (bootPending) { if (!state.explicitPageSelected) home.hidden = false; } else { if (!home.hidden) api.openPage('dashboard'); home.hidden = true; } }
      else { render(); }
      syncShell();
      root.dispatchEvent(new CustomEvent('folio-guided-render'));
    }
    let experienceFlagsRevision = 0;
    function applyExperienceFlags(flags, { source = 'network', expectedRevision = experienceFlagsRevision } = {}) {
      if (source === 'network' && expectedRevision !== experienceFlagsRevision) return;
      if (source === 'worker') experienceFlagsRevision++;
      state.available = flags.enabled === true; state.weekly = flags.weeklyReview === true;
      state.guidance = flags.coaching !== false;
      const first = !state.flagsLoaded; state.flagsLoaded = true;
      const preferred = guidedPreference(localStorage, state.user);
      setEnabled(state.available && (state.enabled || preferred));
      if (first && state.enabled && !state.explicitPageSelected) navigate('home');
      if (!state.weekly) { clearReview(); if (dialog.open && dialog.dataset.flow === 'review') close(true); }
    }
    async function checkFlags() {
      if (flagsRequest) return flagsRequest;
      flagsRequest = (async () => {
        const expectedRevision = experienceFlagsRevision;
        try {
          const response = await fetch('/api/experience', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error();
          const flags=await response.json();
          if(!flags||typeof flags.enabled!=='boolean'||typeof flags.weeklyReview!=='boolean'||(flags.coaching!==undefined&&typeof flags.coaching!=='boolean'))throw new Error();
          applyExperienceFlags(flags, { expectedRevision });
        } catch {
          /* A failed initial read is not an administrator's kill-switch. Keep
             Home usable; only an explicit, valid disabled response hides it. */
          if (!state.flagsLoaded) {
            state.available = true; state.weekly = false; state.guidance = true; state.flagsLoaded = true;
            setEnabled(true);
            if (!state.explicitPageSelected) navigate('home');
          }
        }
      })().finally(() => { flagsRequest = null; });
      return flagsRequest;
    }
    navigator.serviceWorker?.addEventListener('message', event => {
      const sourceUrl = event.source?.scriptURL;
      if (event.data?.type !== 'folio-experience-refresh' || typeof sourceUrl !== 'string') return;
      try { const workerUrl = new URL(sourceUrl, location.href); if (workerUrl.origin !== location.origin || workerUrl.pathname !== '/sw.js') return; } catch { return; }
      const flags = event.data.flags;
      if (!flags || typeof flags.enabled !== 'boolean' || typeof flags.weeklyReview !== 'boolean' || typeof flags.coaching !== 'boolean') return;
      applyExperienceFlags(flags, { source: 'worker' });
    });
    function identify(user) {
      if (!user || user === state.user) return;
      state.user = user; state.dismissed.clear();
      const preferred = guidedPreference(localStorage, user); try { state.review = JSON.parse(sessionStorage.getItem(reviewKey()) || 'null'); } catch {}
      setEnabled(preferred); if (state.enabled && !state.explicitPageSelected) navigate('home');
    }
    applyDismissedInsights(global.__folioDismissedInsightKeys);
    addEventListener('folio-guided-preferences', event => applyDismissedInsights(event.detail?.dismissedInsightKeys));
    addEventListener('message', event => { if (event.origin === location.origin && event.source === parent && event.data?.type === 'folio-session') identify(event.data.userId); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkFlags(); render(); } });
    const timer = setInterval(() => { if (!document.hidden) checkFlags(); }, 60000);
    addEventListener('pagehide', () => clearInterval(timer), { once: true });
    function navigate(page) { if (state.busy) return; close(true); api.openPage(page); }
    function open(title, html, context = '', direction = 1, flow = 'insight') {
      if(!state.enabled)return;
      const wasOpen = dialog.open;
      if (closeAnimation) { closeAnimation.cancel(); closeAnimation = null; }
      if (!wasOpen) state.focus = document.activeElement;
      dialog.dataset.flow = flow; dialog.querySelector('#fg-dialog-title').textContent = title; dialog.querySelector('[data-fg-context]').textContent = context;
      body.innerHTML = html; status.textContent = '';
      if (flow === 'review') { body.scrollTop = 0; dialog.scrollTop = 0; }
      if (!wasOpen) { dialog.showModal(); motion(dialog, [{ opacity: .5, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0)' }], 280); }
      else motion(body, [{ opacity: .4, transform: `translateX(${direction * 16}px)` }, { opacity: 1, transform: 'translateX(0)' }], 200);
      syncShell();
      (body.querySelector('input,button') || dialog.querySelector('.fg-close')).focus({ preventScroll: true });
    }
    function close(immediate = false) {
      if (state.busy && !immediate) return;
      const finish = () => { dialog.close(); syncShell(); (state.focus?.isConnected?state.focus:root.querySelector('.folio-tab[aria-selected="true"]'))?.focus({ preventScroll: true }); };
      if (!dialog.open) return;
      if (immediate) { closeAnimation?.cancel(); closeAnimation = null; finish(); return; }
      const a = motion(dialog, [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(16px)' }], 180);
      closeAnimation = a; if (a) a.finished.then(() => { if (closeAnimation === a) { finish(); closeAnimation = null; } }).catch(() => {}); else finish();
    }
    dialog.querySelector('.fg-close').onclick = () => close();
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } });
    const action = (name, label, cls = '') => `<button type="button" class="fg-action ${cls}" data-fg="${name}">${label}</button>`;
    const facts = rows => `<dl class="fg-facts">${rows.map(([a,b]) => `<div><dt>${escape(a)}</dt><dd>${escape(b)}</dd></div>`).join('')}</dl>`;
    function currentInsight() { return rankInsights(api.snapshot()).find(b => !state.dismissed.has(b.id + ':' + b.target + ':' + api.snapshot().month)); }
    const recurringKey = item => item.eventId?'agent-event:'+item.eventId:'recurring:'+item.id+':'+item.lastDate+':'+item.lastAmount;
    function recurringInsight() { return rankRecurringInsights(api.snapshot()).find(item => !state.dismissed.has(recurringKey(item))); }
    function explainRecurring() {
      const item = recurringInsight(); if (!item) return;
      state.recurringSelected = item;
      open('Latest charge is higher', facts([['Typical amount',money(item.amount)],['Latest charge',money(item.lastAmount)],['Difference',money(item.difference)],['Charged on',displayDate(item.lastDate)]]) + '<p>Compared with Plaid’s average for this recurring payment. This may be a variable bill or a one-time change, not a confirmed price increase.</p><div class="fg-actions">'+action('recurring-detail','View recurring details','fg-primary')+action('recurring-later','Later','fg-link')+'</div>', item.name);
    }
    function homePriorityInsight(){
      if (!enabledInsightTypes.overview) return null;
      if(api.snapshot().agentEventsReady!==true)return null;
      const priority=rankHomePriority(api.snapshot(),new Date(),state.dismissed), item=priority?.item;
      if (!priority) return null;
      return priority;
    }
    function accountHealthInsight(){ return rankAccountHealth(api.snapshot()).find(item=>!state.dismissed.has(item.id)); }
    function cashFlowInsight(){ return rankCashFlowIncrease(api.snapshot()).find(item=>!state.dismissed.has(item.id)); }
    function planningInsight(){ return rankPlanningLow(api.snapshot()).find(item=>!state.dismissed.has(item.id)); }
    function accountStatusLabel(item){ return item.type==='auth'?'Sign-in required':item.type==='failed'?'Needs attention':'Source balance is older than 48 hours'; }
    function explainAccountHealth(){ const item=accountHealthInsight();if(!item)return;const rows=[['Institution',item.institution||'Institution unavailable'],['Account',item.name||'Account'],['Status',accountStatusLabel(item)]];if(item.sourceBalanceUpdatedAt)rows.push(['Source balance date',displayDate(item.sourceBalanceUpdatedAt,true)]);open('Account needs attention',facts(rows)+'<p>Open this account to use its existing Plaid sync control.</p><div class="fg-actions">'+action('account-open','Open account','fg-primary')+action('account-later','Later','fg-link')+'</div>',item.institution||'Accounts'); }
    function transactionInsight(){ const item=rankTransactionInsights(api.snapshot()).find(candidate => !state.dismissed.has(transactionKey(candidate))); if(state.transactionSelected&&state.transactionSelected.id!==item?.id)state.transactionSelected=null; return item; }
    function transactionKey(item){ return item?.id || ''; }
    function reviewRows(){ return transactionInsight()?.rows || []; }
    function explainTransactions(){
      const item=transactionInsight(); if(!item) return;
      state.transactionSelected=item; const rows=item.rows;
      open('Transactions need a category', facts([['Transactions',String(rows.length)],['Period',new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(item.period+'-01T00:00:00Z'))]]).replace('</dl>','') + rows.slice(0,5).map(row=>'<div class="fg-transaction-fact"><span>'+escape(displayDate(row.date))+' · '+escape(row.name)+'</span><strong>'+(Number(row.amount)<0?'+':'')+money(Math.abs(row.amount))+'</strong></div>').join('')+'</dl>'+(rows.length>5?'<p>Showing 5 of '+rows.length+'.</p>':'')+'<p>Pending and posted transactions are included.</p><div class="fg-actions">'+action('transaction-list','Review','fg-primary')+action('transaction-later','Later','fg-link')+'</div>','This month');
    }
    function render() {
      if (!state.enabled) return;
      const s = api.snapshot(), priority = homePriorityInsight(), insight = priority?.kind==='budget'?priority.item:null, recurring = null, stale = !s.updatedAt || Date.now() - new Date(s.updatedAt) > 300000, recurringCurrent=s.recurringReady&&s.recurringCurrentForForecast!==false;
      const priorityPage={budget:'budget',recurring:'recurring',planning:'planning',accounts:'accounts',income:'recurring'}[priority?.kind]||'inbox';
      const ready = s.budgetsReady, displayBudget=ready||s.savedBudget===true, total = ready?s.budgets.reduce((a,b) => a+b.target,0):Number(s.savedBudgetPlanned)||0, spent = ready?s.budgets.reduce((a,b) => a+b.spent,0):Number(s.savedBudgetSpent)||0;
      home.setAttribute('aria-busy','false');
      homeContent.innerHTML = `<div class="fg-heading"><div><p class="fg-eyebrow">${escape(s.dateLabel)}</p><h2>Your money, today.</h2></div></div>
        <p class="fg-fresh">${s.startupRetryAvailable ? (s.startupHasCachedData ? 'Saved household information is still visible.' : 'No saved household snapshot is available yet.') : s.error ? 'Some data could not be refreshed.' : s.loading ? 'Refreshing your data…' : s.updatedAt ? 'Updated '+escape(new Date(s.updatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}))+(stale?' · refresh needed':'') : 'Waiting for live data…'} ${s.startupRetryAvailable ? action('retry-startup','Retry loading data','fg-link') : action('refresh','Refresh','fg-link')}</p>
        <div class="fg-readout"><button type="button" data-fg="forecast"><span>Projected low</span><strong>${s.forecastReady && s.forecastLow !== null ? money(s.forecastLow) : '—'}</strong><small>${!s.forecastReady?`Forecast unavailable · ${escape(s.forecastReason||'No verified forecast is available for these accounts.')}`:s.forecastStatus==='updating'?`Updating · last verified ${s.forecastAsOf?escape(displayInstantDate(s.forecastAsOf,{month:'short',day:'numeric'})):'earlier'} · ${escape(s.forecastRange||'')}`:s.forecastStale?`Last verified · refresh unavailable · ${s.forecastAsOf?escape(displayInstantDate(s.forecastAsOf,{month:'short',day:'numeric'})):'earlier'} · ${escape(s.forecastRange||'')}`:`Current · Next ${s.forecastDays} days · est.`}</small></button><button type="button" data-fg="budget"><span>Budget remaining</span><strong>${displayBudget ? money(total-spent) : '—'}</strong><small>${displayBudget ? escape(new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(new Date(s.month+'-01T00:00:00Z')))+(total>0?' · '+Math.round(spent/total*100)+'% used':' · no targets')+(s.savedBudget?' · saved, updating':'') : 'Budget data unavailable'}</small></button></div>
        <div class="fg-columns"><section class="fg-priority"><p class="fg-eyebrow">${priority?'WORTH A LOOK':s.agentEventsUnavailable?'UNAVAILABLE':s.agentEventsReady?'ALL CAUGHT UP':'CHECKING FOR CHANGES'}</p><h3>${priority?escape(priority.headline):s.agentEventsUnavailable?'Needs attention could not be checked.':s.agentEventsReady?'No new items need your attention.':'Folio is checking your latest financial state.'}</h3>${priority?'<p>'+escape(priority.explanation)+'</p>':''}<div class="fg-priority-actions">${priority?action('overview-priority','Review','fg-primary')+action('overview-later','Later','fg-link'):action('budget','Open Budget','fg-link')}</div></section>
        <section><div class="fg-section-head"><h3>Coming up</h3><span>Next 7 days</span></div>${recurringCurrent?(s.upcoming.length?s.upcoming.slice(0,2).map(item=>`<div class="fg-bill"><div>${escape(item.name)}<small>${escape(displayDate(item.dateIso))} · expected</small></div><strong>${money(Math.abs(item.amount))}</strong></div>`).join(''):'<p class="folio-muted">No payments predicted in the next 7 days.</p>'):s.recurringReady?'<p class="folio-muted">Saved recurring activity is being updated.</p>':'<p class="folio-muted">Upcoming payments unavailable.</p>'}${action('recurring','View recurring payments →','fg-link')}</section></div>
        ${state.weekly?`<section class="fg-weekly"><div><h3>Your weekly review</h3><p>${state.review?.done?'You’re caught up for this review period.':'A look back, then a plan for the week ahead.'}</p><small>${escape(displayDateRange(s.weekStart,s.today))}</small></div>${action('review',state.review&&!state.review.done?'Continue review →':'Start review →')}</section>`:''}
        <div class="fg-footer">${reviewRows().length?action('transaction-review',reviewRows().length+' transaction'+(reviewRows().length===1?'':'s')+' to categorize →','fg-link'):''}${action('budget','Open Budget →','fg-link')}${action('overview','Open Overview →','fg-link')}</div>`;
      resume.hidden = !state.weekly || !state.review || state.review.done;
      decorateBudget(insight);
      decorateOverviewBudget();
      decorateOverviewSubscriptions();
      decorateOverviewCash();
      decorateTransactions();
      decorateInvestments();
      decorateOverviewPriority();
      decorateAccounts();
      decorateCashFlow();
      decoratePlanning();
      if (recurring) {
        const summary=el('section','fg-budget-summary fg-recurring-summary');
        summary.innerHTML=`<p>${escape(recurring.name)}: latest charge ${money(recurring.difference)} above usual.</p>${action('recurring-insight','Review →','fg-link')}`;
        root.querySelector('.folio-recurring-overview').after(summary);
      }
      root.dispatchEvent(new CustomEvent('folio-guided-render'));
    }
    function decorateOverviewBudget() {
      const list=root.querySelector('[data-widget="budgets"] .folio-budget-list'), budget=api.overviewBudget?.();
      if (!list || !budget) return;
      const periodLabel=budget.period==='week'?'this week':'this month';
      if (!budget.ready&&!budget.saved) { list.innerHTML='<div class="fg-overview-budget-empty">Budget data unavailable.</div>'; return; }
      if (budget.planned<=0) { list.innerHTML='<div class="fg-overview-budget-empty"><strong>No budget targets '+periodLabel+'.</strong><p>Set targets in Budget to track spending.</p><button type="button" class="fg-action fg-primary" data-fg-overview-budget>View budget</button></div>'; list.querySelector('[data-fg-overview-budget]').onclick=()=>api.openOverviewBudget?.(budget.period); return; }
      const over=budget.remaining<0, headline=over?money(Math.abs(budget.remaining))+' over budget':money(budget.remaining)+' remaining '+periodLabel, pct=Math.max(0,Math.min(100,budget.spent/budget.planned*100)), attention=(budget.attention||[]).slice(0,2);
      list.innerHTML='<section class="fg-overview-budget"><strong class="'+(over?'folio-negative':'')+'">'+headline+'</strong><p>'+money(budget.spent)+' spent of '+money(budget.planned)+' planned'+(budget.saved?' · saved, updating':'')+'</p><div class="folio-progress" role="progressbar" aria-label="Budget progress" aria-valuenow="'+Math.round(pct)+'" aria-valuemin="0" aria-valuemax="100" aria-valuetext="'+money(budget.spent)+' spent of '+money(budget.planned)+' planned; '+(over?money(Math.abs(budget.remaining))+' over budget':money(budget.remaining)+' remaining')+'"><span class="'+(over?'over':'')+'" style="width:'+pct+'%"></span></div>'+(!budget.saved&&attention.length?'<div class="fg-budget-attention">'+attention.map(item=>'<button type="button" data-fg-overview-category="'+escape(item.name)+'"><span>'+escape(item.name)+'</span><strong class="folio-negative">'+money(item.over)+' over</strong></button>').join('')+'</div>':'')+'<button type="button" class="fg-action fg-link" data-fg-overview-budget>View budget</button></section>';
      list.querySelector('[data-fg-overview-budget]').onclick=()=>api.openOverviewBudget?.(budget.period);
      list.querySelectorAll('[data-fg-overview-category]').forEach(button=>button.onclick=()=>api.openOverviewBudgetCategory?.(button.dataset.fgOverviewCategory,budget.period));
    }
    function decorateOverviewSubscriptions() {
      const content=root.querySelector('[data-widget="subscriptions"] .folio-dashboard-subscriptions-content'), subtitle=root.querySelector('[data-widget="subscriptions"] .folio-card-head .folio-muted'), subscriptions=api.overviewSubscriptions?.();
      if (!content || !subtitle) return;
      if (!subscriptions?.ready) { subtitle.textContent='Subscriptions unavailable'; content.innerHTML='<div class="folio-empty">Subscriptions are unavailable until recurring activity is complete and current.</div>'; return; }
      subtitle.textContent=money(subscriptions.monthly)+' monthly subscriptions · '+subscriptions.count+' active';
      content.innerHTML=subscriptions.focus.length?'<div class="folio-dashboard-focus-list">'+subscriptions.focus.map(item=>{const higher=Number.isFinite(Number(item.difference))&&Number(item.difference)>0,label=higher?'Charged '+escape(displayDate(item.lastDate))+' · higher than usual':escape(item.frequency)+' · expected '+escape(displayDate(item.dateIso)),amount=higher?Number(item.lastAmount):Math.abs(Number(item.amount));return '<button class="folio-summary-row folio-dashboard-focus-row" type="button" data-fg-overview-subscription="'+escape(item.id)+'"><span><b>'+escape(item.name)+'</b><small>'+label+'</small></span><strong>'+money(amount)+'</strong></button>';}).join('')+'</div>':'<div class="folio-empty">'+(subscriptions.count?'No upcoming subscription payments.':'No active subscriptions found.')+'</div>';
      content.querySelectorAll('[data-fg-overview-subscription]').forEach(button=>button.onclick=()=>api.recurringDetail?.(button.dataset.fgOverviewSubscription));
    }
    function decorateOverviewCash() {
      const classic=root.querySelector('[data-widget="cash-flow"] .folio-dashboard-cash-classic'), summary=root.querySelector('[data-widget="cash-flow"] .folio-dashboard-cash-summary'), cash=api.overviewCashFlow?.();
      if (!classic || !summary) return;
      if (!cash?.ready) { classic.hidden=true; summary.hidden=false; summary.innerHTML='<div class="folio-empty">Cash flow is unavailable until the selected history is complete and current.</div><button type="button" class="fg-action fg-link" data-fg-overview-cash>View cash flow</button>'; summary.querySelector('[data-fg-overview-cash]').onclick=()=>api.openOverviewCashFlow?.(); return; }
      classic.hidden=true; summary.hidden=false;
      const netClass=cash.net<0?'folio-negative':'folio-positive', net=(cash.net>=0?'+':'')+money(cash.net);
      summary.innerHTML='<section class="fg-overview-cash"><strong class="'+netClass+'">'+net+' net</strong><p>'+escape(cash.label)+'</p><div class="fg-cash-totals"><div><span>Money in</span><strong>'+money(cash.income)+'</strong></div><div><span>Money out</span><strong>'+money(cash.out)+'</strong></div></div>'+(cash.focus?'<div class="fg-budget-attention"><button type="button" data-fg-overview-cash-category="'+escape(cash.focus.name)+'" data-fg-overview-cash-total="'+cash.focus.total+'"><span>Largest spending category · '+escape(cash.focus.name)+'</span><strong>'+money(cash.focus.total)+'</strong></button></div>':'')+'<button type="button" class="fg-action fg-link" data-fg-overview-cash>View cash flow</button></section>';
      summary.querySelector('[data-fg-overview-cash]').onclick=()=>api.openOverviewCashFlow?.();
      summary.querySelectorAll('[data-fg-overview-cash-category]').forEach(button=>button.onclick=()=>api.openOverviewCashFlowCategory?.(button.dataset.fgOverviewCashCategory,Number(button.dataset.fgOverviewCashTotal)));
    }
    function decorateOverviewPriority() {
      const summary=root.querySelector('.fg-overview-summary'), panel=root.querySelector('[data-panel="dashboard"]'), priority=homePriorityInsight();
      if (!summary) return;
      summary.hidden=true;summary.innerHTML='';
      if (!priority || !panel || panel.hidden) return;
      summary.innerHTML='<div><strong>'+escape(priority.headline)+'</strong><p>'+escape(priority.explanation)+'</p></div><div class="fg-summary-actions">'+action('overview-priority','Review','fg-primary')+action('overview-later','Later','fg-link')+'</div>';
      summary.hidden=false;
    }
    function decorateAccounts() {
      root.querySelectorAll('.fg-account-summary').forEach(n=>n.remove());
      const item=accountHealthInsight(), panel=root.querySelector('[data-panel="accounts"]'), groups=root.querySelector('.folio-account-groups');
      if (!item || !panel || panel.hidden || !groups || groups.hidden) return;
      const summary=el('section','fg-account-summary fg-transaction-summary');
      summary.innerHTML='<div><strong>'+escape(item.institution||'Account')+' needs attention.</strong><p>'+escape(accountStatusLabel(item))+'.</p></div><div class="fg-summary-actions">'+action('account-insight','Review','fg-primary')+action('account-later','Later','fg-link')+'</div>';
      groups.before(summary);
    }
    function decorateTransactions() {
      root.querySelectorAll('.fg-transaction-summary').forEach(n => n.remove());
      const item=transactionInsight(), panel=root.querySelector('[data-panel="transactions"]');
      if (!item || !panel || panel.hidden || root.querySelector('.folio-search-row')?.hidden || root.querySelector('.folio-transactions')?.hidden || api.transactionScopeSupported?.() !== true) return;
      const summary=el('section','fg-transaction-summary');
      summary.innerHTML='<div><strong>'+escape(item.rows.length+' transaction'+(item.rows.length===1?' needs':'s need')+' a category.')+'</strong><p>This month · pending and posted transactions.</p></div><div class="fg-summary-actions">'+action('transaction-review','Review','fg-primary')+action('transaction-later','Later','fg-link')+'</div>';
      panel.querySelector('.folio-filter-panel').after(summary);
    }
    function decorateCashFlow() {
      root.querySelectorAll('.fg-cashflow-insight').forEach(n=>n.remove());
      const item=cashFlowInsight(), panel=root.querySelector('[data-panel="spending"]'); if(!item || !panel || panel.hidden) return;
      const summary=el('section','fg-cashflow-insight fg-transaction-summary');
      summary.innerHTML='<div><strong>Spending increased '+money(item.increase)+' from the prior month.</strong><p>'+escape(item.category)+' contributed '+money(item.categoryIncrease)+' of the increase.</p></div><div class="fg-summary-actions">'+action('cashflow-insight','Review','fg-primary')+action('cashflow-later','Later','fg-link')+'</div>';
      panel.querySelector('.folio-summary')?.before(summary);
    }
    function decoratePlanning() {
      root.querySelectorAll('.fg-planning-insight').forEach(n=>n.remove());
      const item=planningInsight(), panel=root.querySelector('[data-panel="planning"]'); if(!item || !panel || panel.hidden) return;
      const summary=el('section','fg-planning-insight fg-transaction-summary');
      summary.innerHTML='<div><strong>Cash is forecast to fall below zero.</strong><p>'+money(item.projectedLow)+' on '+escape(displayDate(item.lowDate))+' · '+escape(item.scopeLabel)+'.</p></div><div class="fg-summary-actions">'+action('planning-insight','Review','fg-primary')+action('planning-later','Later','fg-link')+'</div>';
      panel.querySelector('.folio-plan-forecast-head')?.parentElement?.after(summary);
    }
    function investmentFailure(){return rankInvestmentFailures(api.snapshot()).find(item=>!state.dismissed.has(item.id));}
    function decorateInvestments() { root.querySelectorAll('.fg-investment-summary').forEach(n=>n.remove()); const item=investmentFailure(),panel=root.querySelector('[data-panel="investments"]'); if(!item||!panel||panel.hidden)return; const summary=el('section','fg-investment-summary fg-transaction-summary'); summary.innerHTML='<div><strong>'+escape(item.headline)+'</strong><p>'+escape(item.scopeLabel)+'.</p></div><div class="fg-summary-actions">'+action('investment-insight','Review','fg-primary')+action('investment-later','Later','fg-link')+'</div>'; panel.querySelector('.folio-invest-summary')?.after(summary); }
    function decorateBudget(insight) {
      root.querySelectorAll('.fg-inline,.fg-budget-summary,.fg-recurring-summary,.fg-transaction-summary').forEach(n => n.remove());
      if (!insight || api.budgetPeriod() !== 'month') return;
      const summary = el('section','fg-budget-summary'); summary.innerHTML=`<p>${escape(insight.name)} is ${money(insight.difference)} above its straight-line spending pace.</p>${action('insight','Review →','fg-link')}`;
      root.querySelector('.folio-budget-overview').after(summary);
      const row=[...root.querySelectorAll('[data-edit-budget]')].find(n=>n.dataset.editBudget===insight.name);
      if (row) { const note=el('div','fg-inline'); note.innerHTML=`<span>Ahead of pace</span>${action('insight','Why? →','fg-link')}`; row.after(note); }
    }
    function explain(back = false) {
      const b = state.selected || currentInsight();
      if (!b) return;
      state.selected = b; state.proposal = null;
      open('Ahead of pace', facts([['Spending',money(b.spent)],['Straight-line pace',money(b.pace)],['Budget remaining',money(b.remaining)]])+'<p>Pace is not a prediction of overspending.</p>'+action('evidence','View supporting transactions →','fg-link')+'<div class="fg-actions">'+action('adjust','Adjust target','fg-primary')+action('keep','Keep current target','fg-link')+'</div>',b.name,back?-1:1);
    }
    function explainInvestmentFailure(){const item=investmentFailure();if(!item)return;const available=item.dataset==='holdings'?(item.retainedHoldingsDate?'Last successful holdings source date: '+displayDate(item.retainedHoldingsDate):'No successful holdings source date is available.'):'Any displayed historical values keep their recorded snapshot dates.';open('Investment data unavailable',facts([['Dataset',item.dataset==='holdings'?'Holdings':item.dataset==='history'?'Balance history':'S&P 500 comparison'],['Scope',item.scopeLabel],['Available',available]])+'<p>'+escape(item.dataset==='benchmark'?'The comparison is unavailable. This does not change the portfolio balance.':'The latest refresh failed. Open Accounts to retry the connected institution.')+'</p><div class="fg-actions">'+action('investment-accounts','Open Accounts','fg-primary')+action('investment-later','Later','fg-link')+'</div>',item.scopeLabel);}
    function explainCashFlow(){const item=cashFlowInsight();if(!item)return;open('Spending increased',facts([['Selected period',displayDateRange(item.selected.range.start,item.selected.range.end)],['Prior period',displayDateRange(item.prior.range.start,item.prior.range.end)],['Money out',money(item.selected.out)],['Prior money out',money(item.prior.out)],['Increase',money(item.increase)],['Largest contribution',item.category+' · '+money(item.categoryIncrease)]])+'<p>Pending and posted expenses are included. This compares completed calendar months only.</p><div class="fg-actions">'+action('cashflow-category','View '+escape(item.category),'fg-primary')+action('cashflow-later','Later','fg-link')+'</div>','Cash Flow');}
    function explainPlanning(){const item=planningInsight();if(!item)return;const rows=[['Projected low',money(item.projectedLow)],['Forecast date',displayDate(item.lowDate)],['Horizon','Next '+item.horizonDays+' days'],['Scope',item.scopeLabel]];if(item.lowEvent)rows.push(['Existing outgoing event',String(item.lowEvent.name || 'Forecast payment')+' · '+money(Math.abs(item.lowEvent.amount))]);open('Cash shortfall predicted',facts(rows)+'<p>This uses existing forecast assumptions. It is not a safe-to-spend amount.</p><div class="fg-actions">'+action('planning-open','Open Planning','fg-primary')+action('planning-later','Later','fg-link')+'</div>',item.scopeLabel);}
    function adjust() {
      const b = state.selected;
      open('Adjust monthly target', `<label class="fg-label" for="fg-target">New target (USD)</label><input id="fg-target" type="number" min="0" max="1000000000" step="0.01" value="${b.target.toFixed(2)}" inputmode="decimal"><p>Current target: ${money(b.target)}. This changes your budget, not your account balance.</p><div class="fg-actions">${action('preview','Preview change','fg-primary')}${action('explain','Back to insight','fg-link')}</div>`,b.name);
      const input = body.querySelector('#fg-target');
      input?.select?.();
    }
    async function preview() {
      const input=body.querySelector('#fg-target'); if(!input.reportValidity() || !input.value) return;
      const amount=Number(input.value); if(amount===state.selected.target){status.textContent='That is already your current target. Enter a different amount to preview a change.';input.focus({preventScroll:true});input.select?.();return;}
      await work(async()=>{
        const {data}=await api.call('guided_budget_preview',{budget_target_id:state.selected.id,category:state.selected.name,expected_target:state.selected.target,monthly_target_amount:amount});
        state.proposal=data.proposal;
        open('Preview change',facts([['Current target',money(data.proposal.expected_target)],['New target',money(data.proposal.monthly_target_amount)],['Change to total planned',money(data.proposal.monthly_target_amount-data.proposal.expected_target)]])+'<p>Takes effect immediately. Transactions stay unchanged.</p><div class="fg-actions">'+action('confirm','Confirm target change','fg-primary')+action('adjust','Back to adjustment','fg-link')+'</div>',state.selected.name);
      });
    }
    async function work(fn) {
      if(state.busy)return;state.busy=true;dialog.setAttribute('aria-busy','true');dialog.querySelectorAll('button').forEach(b=>b.disabled=true);status.textContent='Checking…';
      try{await fn();}catch(error){status.textContent=error.message||'Could not complete the request. Refresh before trying again.';}
      finally{state.busy=false;dialog.removeAttribute('aria-busy');dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
    }
    async function confirm() {
      if(!state.proposal)return;
      await work(async()=>{
        status.textContent='Saving…';
        const {data}=await api.call('guided_budget_commit',{...state.proposal,confirm:true});
        if(!data.saved)throw new Error('Save could not be verified. Refresh Budget before trying again.');
        state.proposal=null;
        const refreshed=await api.refresh();
        open('Target updated','<p>Your change is saved.'+(refreshed?'':' The latest totals could not be loaded. Refresh Budget to see them.')+'</p>'+action('done',state.review&&!state.review.done?'Return to review':'Back to Budget','fg-primary'),state.selected.name);
        render();
      });
    }
    function review() {
      if(!state.weekly)return;
      const s=api.snapshot(),recurringCurrent=s.recurringReady&&s.recurringCurrentForForecast!==false;if(!state.review||state.review.done||state.review.period!==s.weekStart)state.review={step:0,done:false,period:s.weekStart};
      persistReview();resume.hidden=false;
      if(state.review.step===0)open('This week so far',facts([['Spending',s.weekReady?money(s.weekSpent):'Unavailable']])+`<p>${escape(displayDateRange(s.weekStart,s.today))}. Transfers and card repayments excluded.</p>`+'<div class="fg-actions">'+(reviewRows().length?action('transaction-review','Review uncategorized transactions →','fg-link'):'')+action('review-next','Look ahead →','fg-primary')+'</div>', 'Weekly review · 1 of 2',1,'review');
      else {
        const eventCards=(s.agentEvents||[]).filter(e=>(e.delivery_channels||['weekly_review']).includes('weekly_review')).slice(0,5).map(e=>'<article class="fg-review-event"><h3>'+escape(e.title)+'</h3><p>'+escape(e.summary)+'</p></article>').join('');
        const resolved=s.weeklyReview?.summary?.resolved?.length?'<p class="fg-review-resolved">'+s.weeklyReview.summary.resolved.length+' items handled in your latest weekly review.</p>':'';
        const paymentTotal=recurringCurrent?money(s.upcoming.reduce((a,b)=>a+Math.abs(b.amount),0)):'Unavailable';
        open('Look ahead','<div class="fg-review-events">'+resolved+eventCards+'</div>'+'<section class="fg-review-payments"><div><h3>Expected payments</h3><p>Next 7 days</p></div><strong>'+escape(paymentTotal)+'</strong></section>'+'<p class="fg-review-prompt">Review your budget and upcoming payments.</p><div class="fg-actions fg-review-actions">'+action('review-budget','Review Budget →')+action('review-recurring',recurringInsight()?'Review higher charge →':'View upcoming payments →','fg-link')+'</div><div class="fg-actions fg-review-finish-actions">'+action('review-finish','Finish review','fg-primary')+action('review-back','← Back','fg-link')+'</div>', 'Weekly review · 2 of 2',1,'review');
      }
    }
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-fg]');if(!button||!state.enabled||state.busy)return;
      const a=button.dataset.fg;
      if(a==='retry-startup')work(async()=>{await api.retryStartup?.();render();});
      if(a==='refresh')work(async()=>{await api.refresh();render();});
      if(a==='budget'||a==='overview'||a==='recurring')navigate(a==='overview'?'dashboard':a);
      if(a==='forecast'){const s=api.snapshot(),status=!s.forecastReady?'Unavailable':s.forecastStatus==='updating'?'Updating':s.forecastStale?'Last verified':'Current';open('Cash outlook',facts([['Lowest projected balance',s.forecastReady&&s.forecastLow!==null?money(s.forecastLow):'Unavailable'],['Status',status],...(!s.forecastReady?[['Reason',s.forecastReason||'No verified forecast is available for these accounts.']]:[]),...(s.forecastReady?[['Verified',s.forecastAsOf?displayInstantDate(s.forecastAsOf,{month:'short',day:'numeric',year:'numeric'}):'Date unavailable'],['Forecast dates',s.forecastRange||`Next ${s.forecastDays} days`]]:[]) ])+`<p>Estimated balance, not available spending money.</p>`+action('planning','Open Planning →','fg-primary'));}
      if(a==='planning')navigate('planning');
      if(a==='insight'){state.selected=currentInsight();explain();}
      if(a==='explain')explain(true);
      if(a==='adjust')adjust();if(a==='preview')preview();if(a==='confirm')confirm();
      if(a==='later'||a==='keep'){const b=a==='later'?currentInsight():state.selected;if(b)dismissInsight(b.id+':'+b.target+':'+api.snapshot().month);close();render();}
      if(a==='evidence'){const b=state.selected,origin=root.querySelector('[data-panel="dashboard"]')?.hidden===false?'dashboard':null;close(true);api.evidence(b.id,origin);}
      if(a==='done'){close(true);if(state.review&&!state.review.done)review();else navigate('budget');}
      if(a==='transaction-review')explainTransactions();
      if(a==='transaction-later'){const item=transactionInsight();if(item)dismissInsight(transactionKey(item));state.transactionSelected=null;close();render();}
      if(a==='transaction-list'){const item=transactionInsight();if(!item)return;close(true);api.reviewTransactions({returnToReview:Boolean(state.review&&!state.review.done),transactionIds:item.ids,origin:root.querySelector('.folio-tab[aria-selected="true"]')?.dataset.page||'home'}).catch(error=>open('Review unavailable','<p>'+escape(error.message)+'</p>'+action('transaction-review','Try again','fg-primary')));}
      if(a==='overview-priority'){const priority=homePriorityInsight();if(priority?.event){if(priority.kind==='planning'&&priority.planId)api.openPlanningInsight?.(priority.planId);else navigate(({budget:'budget',recurring:'recurring',planning:'planning',accounts:'accounts',income:'recurring'})[priority.kind]||'inbox');}}
      if(a==='overview-later'){const priority=homePriorityInsight();if(priority)dismissInsight(priority.key);close();render();}
      if(a==='account-insight')explainAccountHealth();
      if(a==='account-later'){const item=accountHealthInsight();if(item)dismissInsight(item.id);close();render();}
      if(a==='account-open'){const item=accountHealthInsight();if(!item)return;close(true);api.openAccountHealth?.(item.accountId);}
      if(a==='investment-insight')explainInvestmentFailure();
      if(a==='investment-later'){const item=investmentFailure();if(item)dismissInsight(item.id);close();render();api.renderInvestmentQuality?.();}
      if(a==='investment-accounts'){close(true);api.openInvestmentRecovery?.();}
      if(a==='cashflow-insight')explainCashFlow();
      if(a==='cashflow-category'){const item=cashFlowInsight();if(!item)return;close(true);api.openCashFlowIncrease?.(item);}
      if(a==='cashflow-later'){const item=cashFlowInsight();if(item)dismissInsight(item.id);close();render();}
      if(a==='planning-insight')explainPlanning();
      if(a==='planning-open'){close(true);api.openPlanningInsight?.();}
      if(a==='planning-later'){const item=planningInsight();if(item)dismissInsight(item.id);close();render();}
      if(a==='review')review();
      if(a==='review-next'){state.review.step=1;review();}
      if(a==='review-back'){state.review.step=0;review();}
      if(a==='recurring-insight')explainRecurring();
      if(a==='recurring-later'){const item=dialog.open?state.recurringSelected:recurringInsight();if(item)dismissInsight(recurringKey(item));close();render();}
      if(a==='recurring-detail'){const item=state.recurringSelected,origin=root.querySelector('[data-panel="dashboard"]')?.hidden===false?'dashboard':null;close(true);api.recurringDetail(item.id,origin);}
      if(a==='review-recurring'){persistReview();if(recurringInsight())explainRecurring();else navigate('recurring');}
      if(a==='review-budget'){persistReview();navigate('budget');}
      if(a==='review-finish'){state.review.done=true;persistReview();resume.hidden=true;close();render();}
    });
    root.querySelector('.folio-tabs').addEventListener('click', event => { if (event.target.closest('.folio-tab')) state.explicitPageSelected = true; }, true);
    root.addEventListener('folio-open-page', event => { if (event.detail?.page) state.explicitPageSelected = true; }, true);
    checkFlags();
    return { render, review, syncShell, enabled:()=>state.enabled, bootPending:()=>!state.flagsLoaded||!state.user, investmentFailureVisible:()=>Boolean(investmentFailure()), motion, beforePage:()=>{if(dialog.open&&!state.busy)close(true);}, afterPage:page=>{syncShell();if(state.enabled){render();motion(root.querySelector(`[data-panel="${page}"]`),[{opacity:.3},{opacity:1}],180);}}, state };
  }
  global.FolioGuided = { init, rankInsights, rankHomePriority, rankTransactionInsights, rankAccountHealth, rankInvestmentFailures, rankCashFlowIncrease, rankPlanningLow, displayDate, displayDateRange, displayInstantDate, recurringKind, rankRecurringInsights, guidedPreference };
})(globalThis);
