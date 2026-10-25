(() => {
  const DAY_X_START = 47;
  const CHART_RIGHT_GUTTER = 15;
  const Y_TOP = 16;
  const Y_BOTTOM = 223;
  const VIEW_WIDTH = 400;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const isAmount = (value) => typeof value === 'number' && Number.isFinite(value);
  const cash = (value) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(Number.isFinite(value) && Math.abs(value) < 0.5 ? 0 : value);
  const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  function monthName(monthKey, options = { month: 'long', year: 'numeric' }) {
    if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return String(monthKey || 'the selected month');
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
      .format(new Date(`${monthKey}-01T12:00:00Z`));
  }

  function addComparisonOptions(select, labels) {
    const selected = select.value;
    const base = [...select.options].filter((option) => option.value === 'average' || option.value === 'none');
    select.replaceChildren(...base);
    const existing = new Set(base.map((option) => option.value));
    for (const [key, label] of Object.entries(labels || {})) {
      if (key === 'average' || key === 'none' || existing.has(key)) continue;
      select.add(new Option(label, key));
      existing.add(key);
    }
    if (!existing.has('none')) select.add(new Option('No comparison', 'none'));
    select.value = [...select.options].some((option) => option.value === selected) ? selected : 'average';
  }

  function initialize(widget, onExplore) {
    if (widget.__folio2Spending) {
      widget.__folio2Spending.onExplore = onExplore;
      return widget.__folio2Spending;
    }
    const select = widget.querySelector('.folio-spend-comparison');
    const svg = widget.querySelector('.folio-running-spend-chart svg');
    const drawing = svg.querySelector('g');
    const chart = widget.querySelector('.folio-running-spend-chart');
    const chartLabel = widget.querySelector('.folio-comparison-label');
    const status = widget.querySelector('.folio-history-status');
    const state = { model: null, day: null, lastMonth: null, onExplore };
    const inspect = widget.querySelector('.folio2-spending-inspection');
    const pace = widget.querySelector('.folio2-spending-pace');
    const details = widget.querySelector('.folio2-spending-details-content');
    const detailAlignment = widget.querySelector('.folio2-spending-details-note');
    const noticed = widget.querySelector('.folio2-spending-noticed-copy');
    const noticedCard = widget.querySelector('.folio2-spending-noticed');
    const total = widget.querySelector('.folio2-spending-total');
    const monthLabel = widget.querySelector('.folio2-spending-month');
    const dateRange = widget.querySelector('.folio2-spending-date-range');
    const explore = widget.querySelector('.folio2-spending-explore');
    const detailExplore = widget.querySelector('.folio2-spending-details-explore');

    function render() {
      const model = state.model;
      if (!model) return;
      const days = model.daysInMonth;
      const current = Array.isArray(model.current) ? model.current : [];
      const lastActualIndex = current.reduce((last, value, index) => isAmount(value) ? index + 1 : last, 0);
      const latestActualDay = Math.min(clamp(Number(model.latestDay) || days, 1, days), lastActualIndex || 1);
      const day = clamp(Number(state.day ?? latestActualDay) || 1, 1, days);
      state.day = day;
      const comparisonKey = select.value;
      const comparison = comparisonKey === 'none' ? null : model.comparisons?.[comparisonKey];
      const selectedActual = day <= latestActualDay ? current[day - 1] : undefined;
      const selectedComparison = Array.isArray(comparison) ? comparison[day - 1] : undefined;
      const currentEndIndex = Math.min(latestActualDay, current.length);
      const availableValues = [...current, ...(Array.isArray(comparison) ? comparison : [])].filter(isAmount);
      const width = Math.max(400, Math.round(chart.clientWidth || 400));
      const dayXEnd = width - CHART_RIGHT_GUTTER;

      if (current.length) {
        let min = Math.min(0, ...availableValues);
        let max = Math.max(5000, Math.ceil(Math.max(0, ...availableValues) / 5000) * 5000);
        if (max === min) max = min + 1;
        if (min < 0) min -= Math.abs(min) * 0.08;
        const x = (date) => DAY_X_START + (date - 1) / Math.max(1, days - 1) * (dayXEnd - DAY_X_START);
        const y = (value) => Y_BOTTOM - (value - min) / (max - min) * (Y_BOTTOM - Y_TOP);
        const pathFor = (series, lastIndex) => {
          const points = [];
          for (let i = 0; i < Math.min(lastIndex, series.length); i += 1) {
            if (isAmount(series[i])) points.push(`${points.length ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(series[i]).toFixed(1)}`);
          }
          return points.join(' ');
        };
        const currentPath = pathFor(current, currentEndIndex);
        const comparisonPath = Array.isArray(comparison) ? pathFor(comparison, days) : '';
        const grid = Array.from({ length: 5 }, (_, index) => {
          const value = min + (max - min) * index / 4;
          const yValue = y(value);
          const label = Math.abs(value) >= 1000 ? `${value < 0 ? '−' : ''}$${Math.round(Math.abs(value) / 1000)}k` : cash(value);
          return `<line x1="${DAY_X_START}" y1="${yValue.toFixed(1)}" x2="${dayXEnd}" y2="${yValue.toFixed(1)}" stroke="#46514d" stroke-opacity=".37" stroke-width="1"/><text x="40" y="${(yValue + 4).toFixed(1)}" fill="#9da7a3" font-size="10" text-anchor="end">${label}</text>`;
        }).join('');
        const ticks = [...new Set([1, 8, 15, 22, days])].filter((date) => date <= days);
        const monthLabel = monthName(model.monthKey, { month: 'short' });
        const labels = ticks.map((date) => `<text x="${x(date).toFixed(1)}" y="247" text-anchor="middle" fill="#9da7a3" font-size="10">${date === 1 ? `${monthLabel} 1` : date}</text>`).join('');
        const pieces = [grid, labels];
        if (comparisonPath) pieces.push(`<path d="${comparisonPath}" fill="none" stroke="#a2aaa7" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`);
        if (currentPath) {
          const lastDay = currentEndIndex;
          const finalValue = current[lastDay - 1];
          if (lastDay > 0 && isAmount(finalValue)) {
            const actualStartX = x(1);
            pieces.push(`<path d="${currentPath} L${x(lastDay).toFixed(1)},${y(0).toFixed(1)} L${actualStartX.toFixed(1)},${y(0).toFixed(1)} Z" fill="#f47744" fill-opacity=".09"/>`);
            pieces.push(`<circle cx="${x(lastDay).toFixed(1)}" cy="${y(finalValue).toFixed(1)}" r="3.8" fill="#f47744"/>`);
          }
          pieces.push(`<path d="${currentPath}" fill="none" stroke="#f47744" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
        pieces.push(`<line x1="${x(day).toFixed(1)}" x2="${x(day).toFixed(1)}" y1="${Y_TOP}" y2="${Y_BOTTOM}" stroke="#ced7d2" stroke-width="1.2" stroke-opacity=".58" stroke-dasharray="3 4"/>`);
        if (isAmount(selectedActual)) pieces.push(`<circle cx="${x(day).toFixed(1)}" cy="${y(selectedActual).toFixed(1)}" r="5" fill="#f47744" stroke="#1c2220" stroke-width="1.8"/>`);
        if (isAmount(selectedComparison)) pieces.push(`<circle cx="${x(day).toFixed(1)}" cy="${y(selectedComparison).toFixed(1)}" r="4.5" fill="#a2aaa7" stroke="#1c2220" stroke-width="1.8"/>`);
        pieces.push(`<rect x="${DAY_X_START}" y="${Y_TOP}" width="${dayXEnd - DAY_X_START}" height="${Y_BOTTOM - Y_TOP + 14}" fill="transparent" data-hit="1"/>`);
        drawing.innerHTML = pieces.join('');
        svg.setAttribute('viewBox', `0 0 ${width} 267`);
      } else {
        drawing.innerHTML = `<text x="195" y="115" text-anchor="middle" fill="#9da7a3" font-size="13">${escapeText(model.currentUnavailable || 'Spending history is unavailable.')}</text>`;
      }

      const futureDate = day > Number(model.latestDay);
      const actualLabel = isAmount(selectedActual) ? `${cash(selectedActual)} spent` : futureDate ? 'Future date · no actual yet' : 'Not yet available';
      const comparisonLabel = isAmount(selectedComparison) ? `${cash(selectedComparison)} comparison` : '';
      if (chartLabel) chartLabel.textContent = comparisonKey === 'none' ? 'No comparison' : model.labels?.[comparisonKey] || 'Comparison unavailable';
      const title = svg.querySelector('title');
      if (title) title.textContent = `${monthName(model.monthKey)} cumulative spending compared with ${comparisonKey === 'none' ? 'no comparison' : model.labels?.[comparisonKey] || 'the selected prior period'}`;
      inspect.innerHTML = `${monthName(model.monthKey, { month: 'short' })} ${day} <span class="sep">·</span> <strong class="folio2-spending-actual">${actualLabel}</strong>${comparisonLabel ? ` <span class="sep">·</span> <strong class="folio2-spending-comparison">${comparisonLabel}</strong>` : ''}`;
      svg.setAttribute('role', 'slider');
      svg.setAttribute('tabindex', '0');
      svg.setAttribute('aria-label', 'Cumulative spending chart. Tap, drag, or use arrow keys to inspect a calendar day.');
      svg.setAttribute('aria-valuemin', '1');
      svg.setAttribute('aria-valuemax', String(days));
      svg.setAttribute('aria-valuenow', String(day));
      svg.setAttribute('aria-valuetext', `${monthName(model.monthKey, { month: 'long' })} ${day}, ${actualLabel}${comparisonLabel ? `, ${comparisonLabel}` : ''}`);
      total.textContent = current.length && isAmount(current[currentEndIndex - 1]) ? cash(current[currentEndIndex - 1]) : '—';
      monthLabel.textContent = monthName(model.monthKey);
      dateRange.textContent = `${monthName(model.monthKey, { month: 'short' })} 1–${days}`;

      const selectedDifference = isAmount(selectedActual) && isAmount(selectedComparison) ? selectedActual - selectedComparison : null;
      if (comparisonKey === 'none') {
        pace.textContent = 'No comparison selected.';
      } else if (isAmount(selectedActual) && isAmount(selectedComparison) && selectedComparison > 0) {
        const delta = selectedDifference / selectedComparison * 100;
        pace.textContent = `${Math.abs(Math.round(delta))}% ${delta > 0 ? 'above' : 'below'} ${escapeText(model.labels?.[comparisonKey] || 'the selected comparison')} through ${monthName(model.monthKey, { month: 'short' })} ${day}.`;
      } else if (isAmount(selectedActual) && isAmount(selectedComparison)) {
        pace.textContent = `${cash(selectedActual)} actual compared with ${cash(selectedComparison)} through ${monthName(model.monthKey, { month: 'short' })} ${day}; a percentage is unavailable for this baseline.`;
      } else if (comparisonKey === 'average' && !Array.isArray(comparison)) {
        pace.textContent = 'The 12-month average is unavailable. Choose an available month or no comparison.';
      } else if (!isAmount(selectedActual) && futureDate && isAmount(selectedComparison)) {
        pace.textContent = `Future date: actual spending has not happened yet. The historical comparison shows ${escapeText(model.labels?.[comparisonKey] || 'the selected period')} for the same calendar day.`;
      } else if (!isAmount(selectedActual)) {
        pace.textContent = 'Spending for this day is not yet available.';
      } else {
        pace.textContent = 'Comparison is unavailable for this day.';
      }
      pace.classList.toggle('folio-negative', isAmount(selectedDifference) && selectedDifference > 0);
      pace.classList.toggle('folio-positive', isAmount(selectedDifference) && selectedDifference < 0);

      const difference = selectedDifference;
      const differenceLabel = difference === null ? 'Unavailable' : `${difference > 0 ? '+' : difference < 0 ? '−' : ''}${cash(Math.abs(difference))}`;
      const dateKicker = `${monthName(model.monthKey, { month: 'long' }).toUpperCase()} ${day}`;
      const actualValue = isAmount(selectedActual) ? cash(selectedActual) : futureDate ? 'Future date · no actual yet' : 'Unavailable';
      const comparisonName = comparisonKey === 'average' ? 'Typical last 12 months' : model.labels?.[comparisonKey] || 'Comparison';
      details.innerHTML = comparisonKey === 'none'
        ? `<div class="folio2-spending-details-date">${escapeText(dateKicker)}</div><div class="folio2-spending-detail-row"><span>This month</span><strong>${actualValue}</strong></div><p class="folio2-spending-no-comparison">Choose a comparison above to view the difference.</p>`
        : `<div class="folio2-spending-details-date">${escapeText(dateKicker)}</div><div class="folio2-spending-detail-row"><span>This month</span><strong>${actualValue}</strong></div><div class="folio2-spending-detail-row"><span>${escapeText(comparisonName)}</span><strong>${isAmount(selectedComparison) ? cash(selectedComparison) : 'Unavailable'}</strong></div><div class="folio2-spending-detail-row"><span>Spending difference</span><strong>${differenceLabel}</strong></div>${futureDate ? '<p class="folio2-spending-no-comparison">This is a future date. Historical comparison is shown for context; no current-month actual is expected yet.</p>' : ''}`;
      detailAlignment.textContent = comparisonKey === 'average'
        ? 'Typical spending uses the last 12 completed calendar months, aligned at the same point in each month. Individual previous-month selections show that month’s actual spending history.'
        : comparisonKey === 'none'
          ? ''
          : 'Individual previous-month selections show that month’s actual spending history.';
      const hasInsight = comparisonKey !== 'none' && isAmount(selectedActual) && isAmount(selectedComparison) && selectedDifference !== 0;
      noticedCard.hidden = !hasInsight;
      if (hasInsight) {
        const through = 'Through ' + monthName(model.monthKey, { month: 'short' }) + ' ' + day + ', ';
        noticed.textContent = selectedComparison > 0
          ? through + 'spending is ' + Math.abs(Math.round(selectedDifference / selectedComparison * 100)) + '% ' + (selectedActual > selectedComparison ? 'above' : 'below') + ' ' + (model.labels?.[comparisonKey] || 'the selected comparison') + '.'
          : through + 'actual spending is ' + cash(selectedActual) + ' compared with ' + cash(selectedComparison) + '. Percentage change is unavailable for this baseline.';
      } else noticed.textContent = '';
      const date = `${model.monthKey}-${String(day).padStart(2, '0')}`;
      explore.disabled = !isAmount(selectedActual);
      detailExplore.disabled = !isAmount(selectedActual);
      explore.setAttribute('data-selected-date', date);
      if (status?.dataset.folio2Unavailable === 'true') status.hidden = false;
    }

    const chooseDay = (event) => {
      if (!state.model || !widget.closest('#folio-dashboard-production')?.classList.contains('folio2-spending-mode')) return;
      const rect = svg.getBoundingClientRect();
      const viewWidth = Number(svg.getAttribute('viewBox')?.split(/\s+/)[2]) || VIEW_WIDTH;
        const viewX = (event.clientX - rect.left) / Math.max(1, rect.width) * viewWidth;
      const days = state.model.daysInMonth;
      state.day = clamp(Math.round(1 + (viewX - DAY_X_START) / (viewWidth - CHART_RIGHT_GUTTER - DAY_X_START) * (days - 1)), 1, days);
      render();
    };
    let activePointer = null;
    svg.addEventListener('pointerdown', (event) => {
      activePointer = event.pointerId;
      chooseDay(event);
      try { svg.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional in older browsers. */ }
    });
    svg.addEventListener('pointermove', (event) => { if (activePointer === event.pointerId) chooseDay(event); });
    for (const name of ['pointerup', 'pointercancel']) svg.addEventListener(name, () => { activePointer = null; });
    svg.addEventListener('keydown', (event) => {
      if (!widget.closest('#folio-dashboard-production')?.classList.contains('folio2-spending-mode') || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const max = state.model?.daysInMonth || 31;
      state.day = clamp((state.day || 1) + (event.key === 'ArrowLeft' ? -1 : 1), 1, max);
      render();
    });
    select.addEventListener('change', () => { if (widget.closest('#folio-dashboard-production')?.classList.contains('folio2-spending-mode')) render(); });
    explore.addEventListener('click', () => {
      if (!widget.closest('#folio-dashboard-production')?.classList.contains('folio2-spending-mode') || !state.model || state.day > state.model.latestDay || !isAmount(state.model.current?.[state.day - 1])) return;
      const current = state.model.current;
      const cumulative = current[state.day - 1];
      state.onExplore?.({ date: explore.dataset.selectedDate, total: cumulative, day: state.day, start: `${state.model.monthKey}-01` });
    });
    detailExplore.addEventListener('click', () => explore.click());
    if (typeof window.ResizeObserver === 'function') {
      const observer = new window.ResizeObserver(() => {
        if (widget.closest('#folio-dashboard-production')?.classList.contains('folio2-spending-mode')) render();
      });
      observer.observe(chart);
      state.resizeObserver = observer;
    } else {
      window.addEventListener('resize', () => {
        if (widget.closest('#folio-dashboard-production')?.classList.contains('folio2-spending-mode')) render();
      }, { passive: true });
    }
    state.paint = render;
    widget.__folio2Spending = state;
    return state;
  }

  function render(widget, model, onExplore) {
    const state = initialize(widget, onExplore);
    const previousModel = state.model;
    const monthChanged = state.lastMonth !== null && state.lastMonth !== model.monthKey;
    state.lastMonth = model.monthKey;
    state.model = model;
    addComparisonOptions(widget.querySelector('.folio-spend-comparison'), model.labels);
    const current = Array.isArray(model.current) ? model.current : [];
    const lastActualIndex = current.reduce((last, value, index) => isAmount(value) ? index + 1 : last, 0);
    const latest = Math.min(clamp(Number(model.latestDay) || model.daysInMonth, 1, model.daysInMonth), lastActualIndex || 1);
    if (state.day === null || monthChanged || (state.day > latest && previousModel?.latestDay !== model.latestDay)) state.day = latest;
    state.day = clamp(state.day, 1, model.daysInMonth);
    const select = widget.querySelector('.folio-spend-comparison');
    if (![...select.options].some((option) => option.value === select.value)) select.value = 'average';
    const status = widget.querySelector('.folio-history-status');
    if (!model.current?.length && status) {
      status.hidden = false;
      status.dataset.folio2Unavailable = 'true';
      status.textContent = model.stale
        ? 'Could not refresh spending. Showing saved information where available.'
        : 'Spending data is unavailable. Retry to load current history.';
    } else if (status?.dataset.folio2Unavailable === 'true') {
      status.dataset.folio2Unavailable = 'false';
      status.hidden = !status.textContent;
    }
    state.onExplore = onExplore || state.onExplore;
    state.paint();
    return state;
  }

  function leave(widget) {
    const select = widget.querySelector('.folio-spend-comparison');
    if (select?.value === 'none') select.value = 'average';
    select?.querySelector('option[value="none"]')?.remove();
    const svg = widget.querySelector('.folio-running-spend-chart svg');
    if (svg) {
      svg.setAttribute('viewBox', '0 0 390 240');
      svg.setAttribute('role', 'img');
      for (const name of ['tabindex', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) svg.removeAttribute(name);
      const title = svg.querySelector('title');
      if (title) title.textContent = 'September cumulative spending compared with the selected prior period';
    }
  }

  window.Folio2Spending = { render, leave, cash, monthName };
})();
