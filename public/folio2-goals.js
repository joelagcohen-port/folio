(() => {
  'use strict';

  const TYPE_LABELS = {
    save: 'Save money',
    debt: 'Pay off debt',
    spending_reduction: 'Reduce spending',
    cash_floor: 'Protect cash',
  };
  // These four icons are copied from the approved rendered detail states in
  // recovered-originals/F2-goals-rental-final. Keep them as source SVGs so the
  // goal type remains recognizable without substituting generic glyphs.
  const TYPE_ICONS = {
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 5c-1.5 0-2.8 1.4-3 2-3.5-1.5-11-.3-11 5 0 1.8 0 3 2 4.5V20h4v-2h3v2h4v-4c1-.5 1.7-1 2-2h2v-4h-2c0-1-.5-1.5-1-2V5z"></path><path d="M2 9v1c0 1.1.9 2 2 2h1"></path><path d="M16 11h.01"></path></svg>',
    debt: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.7587 4H16.2413C17.0463 3.99999 17.7106 3.99998 18.2518 4.04419C18.8139 4.09012 19.3306 4.18868 19.816 4.43597C20.5686 4.81947 21.1805 5.43139 21.564 6.18404C21.8113 6.66937 21.9099 7.18608 21.9558 7.74817C22 8.28936 22 8.95372 22 9.75868V14.2413C22 15.0463 22 15.7106 21.9558 16.2518C21.9099 16.8139 21.8113 17.3306 21.564 17.816C21.1805 18.5686 20.5686 19.1805 19.816 19.564C19.3306 19.8113 18.8139 19.9099 18.2518 19.9558C17.7106 20 17.0463 20 16.2413 20H7.75872C6.95374 20 6.28938 20 5.74817 19.9558C5.18608 19.9099 4.66937 19.8113 4.18404 19.564C3.43139 19.1805 2.81947 18.5686 2.43597 17.816C2.18868 17.3306 2.09012 16.8139 2.04419 16.2518C1.99998 15.7106 1.99999 15.0463 2 14.2413V9.7587C1.99999 8.95373 1.99998 8.28937 2.04419 7.74818C2.09012 7.18608 2.18868 6.66937 2.43597 6.18404C2.81947 5.43139 3.43139 4.81947 4.18404 4.43597C4.66937 4.18868 5.18608 4.09012 5.74817 4.04419C6.28937 3.99998 6.95373 3.99999 7.7587 4ZM4 11V14.2C4 15.0566 4.00078 15.6389 4.03755 16.089C4.07337 16.5274 4.1383 16.7516 4.21799 16.908C4.40973 17.2843 4.7157 17.5903 5.09202 17.782C5.24842 17.8617 5.47262 17.9266 5.91104 17.9624C6.36113 17.9992 6.94342 18 7.8 18H16.2C17.0566 18 17.6389 17.9992 18.089 17.9624C18.5274 17.9266 18.7516 17.8617 18.908 17.782C19.2843 17.5903 19.5903 17.2843 19.782 16.908C19.8617 16.7516 19.9266 16.5274 19.9624 16.089C19.9992 15.6389 20 15.0566 20 14.2V11H4ZM19.9982 9C19.9951 8.55447 19.9864 8.20463 19.9624 7.91104C19.9266 7.47262 19.8617 7.24842 19.782 7.09202C19.5903 6.7157 19.2843 6.40973 18.908 6.21799C18.7516 6.1383 18.5274 6.07337 18.089 6.03755C17.6389 6.00078 17.0566 6 16.2 6H7.8C6.94342 6 6.36113 6.00078 5.91104 6.03755C5.47262 6.07337 5.24842 6.1383 5.09202 6.21799C4.7157 6.40973 4.40973 6.7157 4.21799 7.09202C4.1383 7.24842 4.07337 7.47262 4.03755 7.91104C4.01357 8.20463 4.00489 8.55447 4.00176 9H19.9982ZM14 15C14 14.4477 14.4477 14 15 14H17C17.5523 14 18 14.4477 18 15C18 15.5523 17.5523 16 17 16H15C14.4477 16 14 15.5523 14 15Z"></path></svg>',
    spending_reduction: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"></polyline><polyline points="16 17 22 17 22 11"></polyline></svg>',
    cash_floor: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.344 10.036a1 1 0 1 0-1.688-1.072l-2.474 3.896-.943-1.034a1 1 0 0 0-1.478 1.348l1.826 2a1 1 0 0 0 1.583-.138l3.174-5Z"></path><path fill-rule="evenodd" d="M13.203 1.935a3 3 0 0 0-2.405 0l-6 2.625A3 3 0 0 0 3 7.308V13a9 9 0 1 0 18 0V7.308a3 3 0 0 0-1.797-2.748l-6-2.625Zm-1.604 1.832a1 1 0 0 1 .802 0l6 2.625a1 1 0 0 1 .599.916V13a7 7 0 1 1-14 0V7.308a1 1 0 0 1 .6-.916l6-2.625Z" clip-rule="evenodd"></path></svg>',
  };
  const DETAIL_GROUPS = {
    save: [['Savings activity', 'Contributions and corrections'], ['How Folio tracks this', 'Linked accounts and matching evidence'], ['Your path to the goal', 'Monthly contribution and target date'], ['Goal settings', 'Tracking, lifecycle, and management']],
    debt: [['Payment activity', 'Payments, balance changes, corrections'], ['How Folio tracks this', 'Linked debt and payment matching'], ['Your path to payoff', 'Interest, monthly payments, and timing'], ['Goal settings', 'Tracking, lifecycle, and management']],
    spending_reduction: [['Spending changes', 'Expected increases and reductions'], ['Category breakdown', 'What is driving the result'], ['Progress & projections', 'Baseline, trend, and target'], ['Goal settings', 'Categories, protections, and management']],
    cash_floor: [['Cash activity', 'Accounts, balances, and movement'], ['Forecast & risks', 'Upcoming bills, income, and projections'], ['How Folio protects this goal', 'Alerts and permitted recommendations'], ['Goal settings', 'Reserve, monitored accounts, and management']],
  };

  function finite(value) {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string' && value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function exactCanonicalScope(goalIds, forecastIds, current) {
    if (current !== true || !Array.isArray(goalIds) || !Array.isArray(forecastIds) || !goalIds.length || !forecastIds.length) return false;
    const normalize = values => {
      if (values.some(value => typeof value !== 'string' || !value.trim())) return null;
      const ids = values.map(value => value.trim());
      if (new Set(ids).size !== ids.length) return null;
      return ids.sort();
    };
    const goal = normalize(goalIds), forecast = normalize(forecastIds);
    return Boolean(goal && forecast && goal.length === forecast.length && goal.every((id, index) => id === forecast[index]));
  }

  function reviewFormRows(scope) {
    if (!scope?.querySelectorAll) return [];
    return [...scope.querySelectorAll('input,select,textarea')].map((field, index) => {
      const labelElement = field.labels?.[0]?.cloneNode(true);
      labelElement?.querySelectorAll('input,select,textarea').forEach(child => child.remove());
      const label = String(labelElement?.textContent || field.getAttribute('aria-label') || field.name || field.className || `Field ${index + 1}`).trim().replace(/\s+/g, ' ');
      const value = field.type === 'checkbox' || field.type === 'radio'
        ? (field.checked ? 'Selected' : 'Not selected')
        : field.tagName === 'SELECT'
          ? [...field.selectedOptions].map(option => option.textContent.trim()).join(', ') || 'Not set'
          : String(field.value ?? '').trim() || 'Not set';
      return [label, field.disabled ? `${value} · unavailable` : value];
    });
  }

  function normalizeObjectives(goals, plans) {
    const byGoalId = new Map((Array.isArray(goals) ? goals : []).filter(row => row && row.id).map(row => [String(row.id), row]));
    const objectiveByKey = new Map();
    for (const plan of Array.isArray(plans) ? plans : []) {
      if (!plan || !plan.plan_id) continue;
      const goalId = plan.goal_id == null ? '' : String(plan.goal_id);
      const goal = goalId ? byGoalId.get(goalId) : null;
      const type = goal?.type === 'debt' || plan.plan_type === 'debt_payoff' ? 'debt'
        : goal?.type === 'spending_reduction' || plan.plan_type === 'spending_reduction' ? 'spending_reduction'
          : goal?.type === 'cash_floor' || plan.plan_type === 'cash_floor' ? 'cash_floor' : 'save';
      const key = goal ? `goal:${goalId}` : `plan:${String(plan.plan_id)}`;
      const prior = objectiveByKey.get(key);
      objectiveByKey.set(key, {
        ...(prior || {}),
        key,
        id: goalId || String(plan.plan_id),
        goalId: goal?.id || null,
        planId: String(plan.plan_id),
        type,
        name: goal?.name || plan.name || TYPE_LABELS[type],
        goal: goal || null,
        plan,
        status: plan.status || goal?.status || 'unknown',
        monthly: finite(plan.target_monthly ?? goal?.monthly),
        target: finite(goal?.type === 'debt' ? (goal.sourceStart !== undefined ? goal.sourceStart : goal.start) : (goal?.sourceTarget !== undefined ? goal.sourceTarget : (goal?.target ?? plan.goal_target))),
        current: finite(goal?.sourceCurrent !== undefined ? goal.sourceCurrent : goal?.current),
        updatedAt: plan.updated_at || goal?.updatedAt || null,
      });
    }
    for (const goal of byGoalId.values()) {
      const key = `goal:${String(goal.id)}`;
      if (objectiveByKey.has(key)) continue;
      const type = goal.type === 'debt' ? 'debt' : 'save';
      objectiveByKey.set(key, {
        key, id: String(goal.id), goalId: String(goal.id), planId: null, type,
        name: goal.name || TYPE_LABELS[type], goal, plan: null,
        status: goal.status || 'active', monthly: finite(goal.monthly),
        target: finite(goal.type === 'debt' ? (goal.sourceStart !== undefined ? goal.sourceStart : goal.start) : (goal.sourceTarget !== undefined ? goal.sourceTarget : goal.target)), current: finite(goal.sourceCurrent !== undefined ? goal.sourceCurrent : goal.current), updatedAt: goal.updatedAt || null,
      });
    }
    return [...objectiveByKey.values()];
  }

  function editDestination(objective) {
    if (objective?.type === 'debt') return 'debt';
    if (objective?.type === 'cash_floor') return objective.plan ? 'plan' : 'unavailable';
    // A linked savings goal also has a plan. Its Edit action must open goal
    // settings; the plan editor only changes the plan's monthly contribution.
    if (objective?.type === 'save' && objective.goalId) return 'goal-settings';
    if (objective?.plan) return 'plan';
    return 'unavailable';
  }

  function savingsSummaryForGoal(data, goalId) {
    if (goalId === null || goalId === undefined || String(goalId).trim() === '') return null;
    const candidates = [...(Array.isArray(data?.goals) ? data.goals : []), ...(data?.current_goal ? [data.current_goal] : [])];
    return candidates.find(item => String(item?.goal_id || '') === String(goalId)) || null;
  }

  function escaped(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function formatMoney(value, money) {
    return value === null ? 'Unavailable' : money(value);
  }

  function renderHub(container, { goals, plans, loaded, money, onOpen, onAdd }) {
    const objectives = normalizeObjectives(goals, plans);
    const active = objectives.filter(item => !['archived', 'completed', 'ended'].includes(item.status));
    container.innerHTML = `<header class="folio2-goals-heading"><div><p class="folio2-goals-eyebrow">YOUR FINANCIAL GOALS</p><h2>Your goals</h2></div><button type="button" data-folio2-goal-add>Add goal</button></header>
      <p class="folio2-goals-description">One place for what you want to accomplish.</p>
      <div class="folio2-goal-types" aria-label="Goal types" hidden>${Object.entries(TYPE_LABELS).map(([type, label]) => `<button type="button" data-folio2-goal-create="${type}">${escaped(label)}</button>`).join('')}</div>
      <p class="folio2-goals-state" role="status">${loaded ? `${active.length} active ${active.length === 1 ? 'goal' : 'goals'}` : 'Loading your goals…'}</p>
      <div class="folio2-objectives">${loaded ? active.map(item => `<button type="button" class="folio2-objective" data-folio2-objective="${escaped(item.key)}"><span><small>${escaped(TYPE_LABELS[item.type])}</small><strong>${escaped(item.name)}</strong><span>${item.type === 'debt' ? `${formatMoney(item.current, money)} current balance` : `${formatMoney(item.current, money)} tracked`}${item.target !== null ? ` · ${formatMoney(item.target, money)} target` : ''}</span></span><span class="folio2-goal-chevron" aria-hidden="true">›</span></button>`).join('') : '<p>Goal information is unavailable right now.</p>'}</div>
      <p class="folio2-goals-note">Progress reflects the available goal and plan records. Estimates and planned amounts are not confirmed progress.</p>`;
    container.querySelector('[data-folio2-goal-add]')?.addEventListener('click', event => { const chooser=container.querySelector('.folio2-goal-types');chooser.hidden=!chooser.hidden;event.currentTarget.setAttribute('aria-expanded',String(!chooser.hidden)); });
    container.querySelectorAll('[data-folio2-goal-create]').forEach(button => button.addEventListener('click', () => onAdd?.(button.dataset.folio2GoalCreate)));
    container.querySelectorAll('[data-folio2-objective]').forEach(button => button.addEventListener('click', () => onOpen?.(objectives.find(item => item.key === button.dataset.folio2Objective))));
    return objectives;
  }

  function valueRows(rows) {
    return `<dl class="folio2-goal-value-rows">${rows.map(([label, value, state]) => `<div><dt>${escaped(label)}</dt><dd${state ? ` data-state="${escaped(state)}"` : ''}>${escaped(value)}</dd></div>`).join('')}</dl>`;
  }

  function progressMarkup(progress, name, progressText, remainingText) {
    if (!progress || !Number.isFinite(progress.percent)) return '<div class="folio2-goal-progress-unavailable">Progress information is unavailable.</div>';
    const percent = Math.max(0, Math.min(100, progress.percent));
    return `<div class="folio2-goal-progress" role="progressbar" aria-label="${escaped(name)}" aria-valuenow="${Math.round(percent)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div><div class="folio2-goal-progress-meta"><strong>${escaped(progressText || `${Math.round(percent)}% complete`)}</strong>${remainingText ? `<span>${escaped(remainingText)}</span>` : ''}</div>`;
  }

  function detailValues(objective, { money, savingsSummary, savingsError, planning, progress, debtPath, spendingEvaluation, cashEvidence }) {
    const goal = objective.goal || {};
    const type = objective.type;
    if (type === 'save') {
      const automatic = goal.trackingMode && goal.trackingMode !== 'manual';
      const confirmed = automatic ? finite(savingsSummary?.current_amount) : null;
      const reviewAmount = finite(savingsSummary?.month_needs_review_amount);
      const possibleEvidence = !savingsError && reviewAmount !== null && reviewAmount > 0;
      const reviewStatus = savingsError || reviewAmount === null ? 'Activity status unavailable' : possibleEvidence ? 'Needs your confirmation' : 'No pending review';
      return {
        heroLabel: automatic ? 'CONFIRMED SAVINGS' : 'USER-REPORTED SAVINGS',
        hero: formatMoney(confirmed ?? (automatic ? null : objective.current), money),
        heroSub: objective.target === null ? 'Goal target unavailable' : `of ${formatMoney(objective.target, money)} goal`,
        progress: confirmed !== null ? progress : (!automatic ? progress : null),
        progressText: progress ? `${Math.round(progress.percent)}% complete` : null,
        remainingText: progress?.remaining != null ? `${formatMoney(progress.remaining, money)} remaining` : null,
        monthlyLabel: 'PLANNED MONTHLY CONTRIBUTION', monthly: formatMoney(objective.monthly, money),
        insight: possibleEvidence,
        noticed: possibleEvidence ? 'Possible contribution ' + formatMoney(reviewAmount, money) + ' needs your confirmation. It is not included in confirmed savings.' : '',
        noticedStatus: possibleEvidence ? 'Needs your confirmation' : '',
        reviewAvailable: possibleEvidence && savingsSummary?.review_action_available === true,
        reviewUnavailable: possibleEvidence && savingsSummary?.review_action_available !== true,
        groups: [
          valueRows([['Confirmed this month', savingsError ? 'Unavailable' : formatMoney(finite(savingsSummary?.month_net_contributions), money)], ['Possible contributions', savingsError ? 'Unavailable' : formatMoney(reviewAmount, money)], ['Needs review', savingsError || reviewAmount === null ? 'Unavailable' : possibleEvidence ? 'Yes' : 'No']]),
          valueRows([['Tracking', goal.trackingMode || 'Unavailable'], ['Linked account', goal.account || 'Unavailable'], ['Evidence', automatic ? 'Linked account and matched activity' : 'User-reported; not independently verified']]),
          valueRows([['Monthly contribution', formatMoney(objective.monthly, money)], ['Target date', goal.deadline || objective.plan?.ends_on || 'Unavailable'], ['Plan status', objective.plan?.status || 'No linked plan']]),
          `<div class="folio2-goal-management-actions"><button type="button" data-goal-action="edit">Edit goal</button><button type="button" data-goal-action="history" disabled>View goal history · unavailable</button><button type="button" data-goal-action="pause" disabled>Pause tracking · unavailable</button><button type="button" data-goal-action="archive" disabled>Archive goal · unavailable</button></div>`,
        ],
      };
    }
    if (type === 'debt') {
      const balance = finite(objective.current), apr = finite(goal.apr ?? objective.plan?.apr), monthlyPayment = finite(objective.monthly);
      const amortizing = balance !== null && balance > 0 && apr !== null && apr >= 0 && monthlyPayment !== null && monthlyPayment > balance * apr / 1200;
      const candidateMonths = finite(debtPath?.months);
      const payoffMonths = amortizing && candidateMonths !== null && Number.isInteger(candidateMonths) && candidateMonths > 0 && candidateMonths < 120 ? candidateMonths : null;
      const futureInterest = finite(debtPath?.futureInterest);
      return {
        heroLabel: 'CURRENT DEBT BALANCE',
        hero: formatMoney(objective.current, money),
        heroSub: objective.target === null ? 'Starting balance unavailable' : `remaining from ${formatMoney(objective.target, money)} starting balance`,
        progress,
        progressText: progress ? `${Math.round(progress.percent)}% paid down` : null,
        remainingText: progress?.reduced != null ? `${formatMoney(progress.reduced, money)} reduced` : null,
        monthlyLabel: 'PLANNED MONTHLY PAYMENT', monthly: formatMoney(objective.monthly, money),
        insight: false, noticed: '', noticedStatus: '', reviewAvailable: false, reviewUnavailable: false,
        supplemental: `<section class="folio2-goal-debt-estimate" aria-label="Estimated payoff"><div><span>Estimated payoff</span><strong>${payoffMonths === null ? 'Unavailable' : `${payoffMonths} months`}</strong></div><div><span>Estimated future interest</span><strong>${futureInterest === null ? 'Unavailable' : formatMoney(futureInterest, money)}</strong></div><p>Based on the current balance, APR, and planned payment. New purchases, fees, or rate changes can affect this estimate.</p></section>`,
        groups: [
          valueRows([['Payments', 'Unavailable'], ['Balance changes', 'Unavailable'], ['Corrections', 'Unavailable']]),
          valueRows([['Linked debt account', goal.account || 'Unavailable'], ['APR', goal.apr == null ? 'Unavailable' : `${escaped(goal.apr)}%`], ['Balance source', 'Existing debt account record']]),
          valueRows([['Planned monthly payment', formatMoney(objective.monthly, money)], ['Estimated payoff', payoffMonths === null ? 'Unavailable' : `${payoffMonths} months`], ['Estimated future interest', futureInterest === null ? 'Unavailable' : formatMoney(futureInterest, money)]]),
          `<div class="folio2-goal-management-actions"><button type="button" data-goal-action="edit">Edit goal</button><button type="button" data-goal-action="history" disabled>View goal history · unavailable</button><button type="button" data-goal-action="pause" disabled>Pause tracking · unavailable</button><button type="button" data-goal-action="archive" disabled>Archive goal · unavailable</button></div>`,
        ],
      };
    }
    if (type === 'spending_reduction') {
      const reduction = finite(objective.plan?.target_monthly ?? objective.target);
      const evaluation = spendingEvaluation || objective.plan?.latest || null;
      const projectedReduction = finite(evaluation?.projected_reduction);
      const progressPercent = finite(evaluation?.progress_percent);
      const progressState = progressPercent === null ? null : { percent: progressPercent, progressText: `${Math.round(progressPercent)}% of target projected`, remainingText: finite(evaluation?.remaining_reduction) === null ? null : `${formatMoney(finite(evaluation.remaining_reduction), money)} more cuts needed` };
      return {
        heroLabel: 'REDUCE MONTHLY SPENDING', hero: formatMoney(projectedReduction, money),
        heroSub: projectedReduction === null ? 'Projected net monthly reduction unavailable' : 'projected net monthly reduction',
        progress: progressState,
        progressText: progressState?.progressText,
        remainingText: progressState?.remainingText,
        monthlyLabel: 'TARGET MONTHLY REDUCTION', monthly: formatMoney(reduction, money),
        insight: typeof evaluation?.recommendation === 'string' && Boolean(evaluation.recommendation.trim()),
        noticed: typeof evaluation?.recommendation === 'string' ? evaluation.recommendation : '',
        noticedStatus: typeof evaluation?.recommendation_status === 'string' ? evaluation.recommendation_status : '', reviewAvailable: evaluation?.review_action_available === true, reviewUnavailable: Boolean(evaluation?.recommendation) && evaluation?.review_action_available !== true,
        supplemental: `<section class="folio2-goal-balancing"><h3>How it's balancing out</h3><p>Monthly projection</p>${valueRows([['Previous spending baseline', formatMoney(finite(evaluation?.baseline_monthly), money)], ['Expected increases', formatMoney(finite(evaluation?.expected_increases), money)], ['Other spending reductions', formatMoney(finite(evaluation?.other_reductions), money)], ['Projected total spending', formatMoney(finite(evaluation?.projected_total), money)]])}<small>Illustrative month-end estimate, not completed savings. Your actual result is determined from eligible transactions when the month closes.</small></section>`,
        groups: [
          valueRows([['Expected increases', Array.isArray(evaluation?.increases) ? evaluation.increases.map(item => `${item.name}: ${formatMoney(finite(item.amount), money)}`).join(', ') : 'Unavailable'], ['Other reductions', Array.isArray(evaluation?.reductions) ? evaluation.reductions.map(item => `${item.name}: ${formatMoney(finite(item.amount), money)}`).join(', ') : 'Unavailable']]),
          valueRows([['Categories driving the result', Array.isArray(evaluation?.categories) ? evaluation.categories.map(item => item.name).join(', ') : 'Unavailable'], ['Category details', Array.isArray(evaluation?.categories) && evaluation.categories.length ? 'See current plan evaluation' : 'Unavailable']]),
          valueRows([['Baseline', formatMoney(finite(evaluation?.baseline_monthly), money)], ['Trend', evaluation?.trend_label || 'Unavailable'], ['Target', formatMoney(reduction, money)], ['Evaluation', evaluation?.assessment || 'Unavailable']]),
          valueRows([['Plan status', objective.plan?.status || 'Unavailable'], ['Protected categories', Array.isArray(objective.plan?.constraints) ? objective.plan.constraints.filter(item => item.kind === 'protected_category').length : 'Unavailable'], ['Minimum budgets', Array.isArray(objective.plan?.constraints) ? objective.plan.constraints.filter(item => item.kind === 'minimum_budget').length : 'Unavailable']]),
        ],
      };
    }
    const evidence=cashEvidence;
    const savedScope=objective.plan?.cash_account_scope;
    const scopeLabel=savedScope?.mode==='all_cash_accounts'?'All eligible cash accounts':savedScope?.mode==='selected_accounts'&&Array.isArray(savedScope.canonical_account_ids)?`${savedScope.canonical_account_ids.length} selected canonical accounts`:'Not set';
    const scopeCurrent=evidence?.plan_id===objective.plan?.plan_id&&evidence?.plan_version===Number(objective.plan?.version)&&JSON.stringify(evidence?.scope)===JSON.stringify(savedScope)&&evidence?.household_id===objective.plan?.household_id&&evidence?.today===planning?.today;
    const projectedLow=scopeCurrent&&evidence?.forecast?.status==='current'?finite(evidence.forecast.projected_low):null;
    const forecastCurrent=scopeCurrent&&projectedLow!==null&&evidence?.forecast?.currency==='USD'&&evidence.forecast.horizon_days===30&&Array.isArray(evidence.forecast.points)&&evidence.forecast.points.length===31;
    const minimum = finite(objective.plan?.floor_amount);
    const cash=scopeCurrent&&evidence?.current?.status==='current'&&evidence?.current?.currency==='USD'?finite(evidence.current.amount):null;
    planning={...planning,points:forecastCurrent?evidence.forecast.points:null,lowDate:forecastCurrent?evidence.forecast.low_date:null};
    const maintained = cash !== null && minimum !== null ? cash >= minimum : null;
    const reserveRisk = forecastCurrent && minimum !== null && projectedLow < minimum;
    const points = forecastCurrent && Array.isArray(planning?.points) && planning.points.length >= 31 ? planning.points.slice(0, 31) : null;
    return {
      heroLabel: 'MAINTAIN CASH RESERVE', hero: formatMoney(cash, money),
      heroSub: cash === null || minimum === null ? 'Current cash or minimum reserve unavailable' : `${formatMoney(minimum, money)} minimum`,
      progress: planning?.cashProgress || null,
      progressText: maintained === null ? 'Reserve status unavailable' : maintained ? 'Reserve currently maintained' : 'Reserve below minimum',
      remainingText: cash !== null && minimum !== null ? `${formatMoney(Math.abs(cash - minimum), money)} ${maintained ? 'above' : 'below'} minimum` : null,
      monthlyLabel: 'MINIMUM CASH RESERVE', monthly: formatMoney(minimum, money),
      insight: reserveRisk,
      noticed: reserveRisk ? 'Forecast cash falls below this goal’s minimum reserve on ' + String(evidence.forecast.low_date || 'a projected date') + '.' : '',
      noticedStatus: reserveRisk ? 'Forecast risk · Needs review' : '',
      reviewAvailable: planning?.riskReviewAvailable === true,
      reviewUnavailable: forecastCurrent && minimum !== null && projectedLow < minimum && planning?.riskReviewAvailable !== true,
      forecastPoints: forecastCurrent ? planning.points : null,
      supplemental: `<section class="folio2-goal-looking-ahead"><header><div><h3>Looking ahead</h3><span>Next 30 days</span></div></header><div class="folio2-goal-forecast-metric"><small>PROJECTED LOW CASH</small><strong>${forecastCurrent ? formatMoney(projectedLow, money) : 'Unavailable'}</strong><span>${forecastCurrent ? `${escaped(planning.lowDate || 'Date unavailable')} · ${minimum !== null ? projectedLow < minimum ? 'Below reserve' : 'Reserve maintained' : 'Reserve comparison unavailable'}` : 'Current, complete forecast for this goal’s selected accounts is unavailable.'}</span></div><div class="folio2-goal-cash-chart" data-folio2-goal-cash-chart>${points ? '<svg viewBox="0 0 390 210" role="img" aria-label="Verified projected cash balance for the next 30 days"><g></g></svg>' : '<p role="status">Forecast chart unavailable for this goal’s selected account scope.</p>'}</div></section>`,
      groups: [
        valueRows([['Monitored accounts', scopeLabel], ['Balances', cash === null ? 'Unavailable for selected accounts' : formatMoney(cash, money)], ['Balance source time', scopeCurrent&&evidence?.current?.source_as_of?evidence.current.source_as_of:'Unavailable'], ['Unavailable selected accounts', scopeCurrent&&Array.isArray(evidence?.missing_account_ids)?String(evidence.missing_account_ids.length):'Unavailable'], ['Movement', 'Unavailable']]),
        valueRows([['Upcoming bills', 'Unavailable'], ['Income changes', 'Unavailable'], ['Projected low', forecastCurrent ? formatMoney(projectedLow, money) : 'Unavailable'], ['Coverage', forecastCurrent ? 'Current and complete' : 'Unavailable']]),
        valueRows([['Alerts', 'Unavailable'], ['Permitted recommendations', 'No money movement is authorized by this goal'], ['Goal status', objective.status || 'Unavailable']]),
        valueRows([['Minimum reserve', formatMoney(minimum, money)], ['Account scope', scopeLabel], ['Forecast protection', 'Subject to existing household permissions']]),
      ],
    };
  }

  function renderDetail(container, objective, options) {
    if (!objective) return false;
    const view = detailValues(objective, options);
    const groups = DETAIL_GROUPS[objective.type] || DETAIL_GROUPS.save;
    const money = options.money;
    const groupMarkup = groups.map(([label, subtitle], index) => `<details class="folio2-goal-disclosure" data-folio2-goal-section="${index}"><summary><span class="folio2-goal-disclosure-label"><strong>${escaped(label)}</strong><small>${escaped(subtitle)}</small></span><span aria-hidden="true">⌄</span></summary><div>${view.groups[index]}</div></details>`).join('');
    const reviewEnabled = view.reviewAvailable && typeof options.onReview === 'function';
    const progress = objective.type === 'cash_floor' ? '' : progressMarkup(view.progress, objective.name, view.progressText, view.remainingText);
    const cashStatus = objective.type === 'cash_floor' ? `<p class="folio2-goal-cash-status">${escaped(view.progressText)}${view.remainingText ? ` · ${escaped(view.remainingText)}` : ''}</p>` : '';
    container.innerHTML = `<header class="folio2-goal-toolbar"><button type="button" data-folio2-goals-back>‹ Goals</button><span>${escaped(TYPE_LABELS[objective.type])}</span><span></span></header><section class="folio2-goal-hero"><span class="folio2-goal-hero-icon">${TYPE_ICONS[objective.type] || TYPE_ICONS.save}</span><p class="folio2-goals-eyebrow">${escaped(objective.name).toUpperCase()}</p><small>${escaped(view.heroLabel)}</small><strong>${escaped(view.hero)}</strong><span>${escaped(view.heroSub || view.sub || '')}</span>${progress}${cashStatus}</section><section class="folio2-goal-monthly"><div><small>${escaped(view.monthlyLabel)}</small><strong>${escaped(view.monthly)}</strong></div><button type="button" data-folio2-goal-edit="${escaped(objective.key)}">Edit</button></section>${view.supplemental || ''}<section class="folio2-goal-noticed"><div class="folio2-goal-noticed-copy"><strong>Folio noticed</strong><span>${escaped(view.noticedStatus || 'Status unavailable')}</span></div><p>${escaped(view.noticed)}</p><button type="button" data-folio2-goal-review ${reviewEnabled ? '' : 'disabled title="Review action unavailable for the current evidence."'}>Review</button></section>${groupMarkup}`;
    if (view.insight !== true) container.querySelector('.folio2-goal-noticed')?.remove();
    container.querySelector('[data-folio2-goals-back]')?.addEventListener('click', () => options.onBack?.());
    container.querySelector('[data-folio2-goal-edit]')?.addEventListener('click', () => options.onEdit?.(objective));
    container.querySelector('[data-folio2-goal-review]')?.addEventListener('click', () => options.onReview?.(objective));
    if (objective.type === 'cash_floor' && view.forecastPoints) options.onBindCashChart?.(container.querySelector('[data-folio2-goal-cash-chart] svg'), view.forecastPoints);
    container.querySelectorAll('[data-goal-action="edit"]').forEach(button => button.addEventListener('click', () => options.onEdit?.(objective)));
    return true;
  }

  function bindReviewGate(root, selector, describe, isEnabled) {
    const dialog = root.querySelector('.folio2-goal-review-dialog');
    if (!dialog) return () => {};
    let committing = false;
    const captureForm = target => {
      const scope = target.closest('dialog') || target.closest('form') || root;
      return JSON.stringify([...scope.querySelectorAll('input,select,textarea')].map(field => ({
        name: field.name || field.className || field.id || field.type,
        type: field.type || field.tagName,
        value: field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value,
        disabled: field.disabled,
      })));
    };
    const onClick = event => {
      if (committing || !isEnabled()) return;
      const target = event.target.closest(selector);
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const body = dialog.querySelector('.folio2-goal-review-body');
      const rows = describe(target);
      let reviewedForm = captureForm(target), reviewedRows = JSON.stringify(rows);
      const renderRows = (currentRows, changed = false) => {
        body.innerHTML = currentRows.map(([label, value]) => `<div><span>${escaped(label)}</span><strong>${escaped(value || 'Not set')}</strong></div>`).join('')
          + (changed ? '<p role="status">The form changed after review. Review these updated values before confirming.</p>' : '');
      };
      renderRows(rows);
      dialog.showModal();
      dialog.querySelector('[data-folio2-goal-review-cancel]').onclick = () => dialog.close();
      dialog.querySelector('[data-folio2-goal-review-confirm]').onclick = () => {
        const currentRows = describe(target), currentRowsJson = JSON.stringify(currentRows), currentForm = captureForm(target);
        if (currentForm !== reviewedForm || currentRowsJson !== reviewedRows) {
          reviewedForm = currentForm;
          reviewedRows = currentRowsJson;
          renderRows(currentRows, true);
          return;
        }
        dialog.close();
        committing = true;
        target.click();
        committing = false;
      };
    };
    root.addEventListener('click', onClick, true);
    return () => root.removeEventListener('click', onClick, true);
  }

  let reviewedMutationEpoch=0,activeReviewedMutation=null;
  function cancelReviewedMutation(){reviewedMutationEpoch++;activeReviewedMutation?.cancel();activeReviewedMutation=null;}
  async function reviewedMutation(options) {
    cancelReviewedMutation();const epoch=reviewedMutationEpoch;
    const {root, kind, owner, getOwner, request, reviewOperation, confirmOperation, call, rows, storage = sessionStorage} = options;
    const dialog=root.querySelector('.folio2-goal-review-dialog');
    if(!dialog)throw new Error('The goal review could not be opened.');
    if(!owner?.userId||!owner?.householdId)throw new Error('Sign in and select a household before reviewing a goal.');
    const storageKey=`folio2:goal-review:${owner.userId}:${owner.householdId}:${kind}`;
    const sameOwner=()=>JSON.stringify(getOwner())===JSON.stringify(owner);
    const current=()=>epoch===reviewedMutationEpoch&&sameOwner()&&(options.isCurrent?.()??true);
    if(!current())return null;
    let pending;try{pending=JSON.parse(storage.getItem(storageKey)||'null');}catch{throw new Error('Goal review recovery is unavailable. Reload before saving.');}
    const validId=value=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
    if(pending&&(!pending.review||!validId(pending.review.review_id)||!validId(pending.key)||pending.review.actor_user_id!==owner.userId||pending.review.household_id!==owner.householdId||pending.confirmOperation!==confirmOperation||!Array.isArray(pending.rows)))throw new Error('The saved goal review could not be verified. Refresh Goals before saving.');
    if(!pending||!pending.attempted){
      const response=await call(reviewOperation,{...request,household_id:owner.householdId});if(!current())return null;
      const review=response.data?.review;
      if(!review||!validId(review.review_id)||review.actor_user_id!==owner.userId||review.household_id!==owner.householdId)throw new Error('The goal review response could not be verified.');
      pending={review,key:crypto.randomUUID(),confirmOperation,rows:typeof options.describeReview==='function'?options.describeReview(review):rows,attempted:false};storage.setItem(storageKey,JSON.stringify(pending));
    }
    if(!current())return null;
    return new Promise(resolve=>{
      let busy=false,settled=false;
      const body=dialog.querySelector('.folio2-goal-review-body'),confirm=dialog.querySelector('[data-folio2-goal-review-confirm]'),cancel=dialog.querySelector('[data-folio2-goal-review-cancel]');
      const finish=value=>{if(settled)return;settled=true;if(activeReviewedMutation?.epoch===epoch)activeReviewedMutation=null;dialog.removeEventListener('close',closed);dialog.removeEventListener('cancel',cancelled);resolve(value);};
      const closed=()=>{if(!pending.attempted)storage.removeItem(storageKey);finish(null);};
      const cancelled=event=>{if(busy)event.preventDefault();};
      activeReviewedMutation={epoch,cancel:()=>{if(!pending.attempted)storage.removeItem(storageKey);finish(null);if(dialog.open)dialog.close();}};
      const render=message=>{body.innerHTML=pending.rows.map(([label,value])=>`<div><span>${escaped(label)}</span><strong>${escaped(value??'Not set')}</strong></div>`).join('')+(message?`<p role="status">${escaped(message)}</p>`:'');confirm.textContent=pending.attempted?'Retry saved confirmation':'Confirm';};
      render(pending.attempted?'A previous save has an uncertain result. Retry the exact saved confirmation before making another change.':'');
      cancel.onclick=()=>{if(!busy)dialog.close();};confirm.disabled=false;cancel.disabled=false;
      confirm.onclick=async()=>{
        if(busy)return;if(!current()){finish(null);if(epoch===reviewedMutationEpoch)dialog.close();return;}
        busy=true;confirm.disabled=true;cancel.disabled=true;
        try{
          pending.attempted=true;storage.setItem(storageKey,JSON.stringify(pending));
          const response=await call(confirmOperation,{household_id:owner.householdId,review_id:pending.review.review_id,idempotency_key:pending.key,confirm:true});
          if(!current()){finish(null);return;}
          const receipt=response.data?.receipt;
          if(!receipt||receipt.review_id!==pending.review.review_id||receipt.idempotency_key!==pending.key||receipt.actor_user_id!==owner.userId||receipt.household_id!==owner.householdId)throw new Error('The saved result could not be verified. Retry the same confirmation.');
          storage.removeItem(storageKey);finish(receipt);dialog.close();
        }catch(error){
          if(!current()){finish(null);return;}
          const status=Number(error?.status||error?.statusCode);
          if(status===409||status===400||status===403){storage.removeItem(storageKey);render(error.message||'Refresh this goal and review again.');confirm.disabled=true;}
          else{render(error.message||'The save result is uncertain. Retry the same confirmation.');confirm.disabled=false;}
        }finally{busy=false;if(current())cancel.disabled=false;}
      };
      dialog.addEventListener('close',closed);dialog.addEventListener('cancel',cancelled);
      dialog.setAttribute('data-folio2-full-review','');if(!dialog.open)dialog.showModal();
    });
  }

  window.Folio2Goals = { reviewedMutation, cancelReviewedMutation, TYPE_LABELS, DETAIL_GROUPS, normalizeObjectives, editDestination, savingsSummaryForGoal, renderHub, renderDetail, bindReviewGate, exactCanonicalScope, reviewFormRows, finite };
})();
