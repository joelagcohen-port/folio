/* Shared select presentation. Original selects remain the source of truth for
   values, option groups, validation, and existing change handlers. */
(() => {
  function init() {
    const root = document.getElementById('folio-dashboard-production');
    if (!root) return;
    const controls = new Map();
    let active = null, sequence = 0, scheduled = false;
    const labelFor = select => {
      if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
      const label = select.labels?.[0];
      if (label) {
        const clone = label.cloneNode(true);
        clone.querySelectorAll('select,.folio-select-trigger,.folio-select-menu').forEach(node => node.remove());
        return clone.textContent.trim() || 'Choose an option';
      }
      return 'Choose an option';
    };
    function sync(select, button) {
      const text = select.selectedOptions[0]?.textContent || 'Choose an option';
      if (button.firstChild.textContent !== text) button.firstChild.textContent = text;
      if (button.disabled !== select.disabled) button.disabled = select.disabled;
      const label = labelFor(select) + ': ' + text;
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
      if (button.hidden !== select.hidden) button.hidden = select.hidden;
    }
    function close(returnFocus = false) {
      if (!active) return;
      const {button, menu} = active;
      active = null;
      button.setAttribute('aria-expanded', 'false');
      if (menu.matches(':popover-open')) menu.hidePopover();
      menu.remove();
      if (returnFocus && button.isConnected) button.focus();
    }
    function position(menu, button) {
      const rect = button.getBoundingClientRect(), viewport = window.visualViewport;
      const height = viewport?.height || innerHeight, width = viewport?.width || innerWidth;
      const offsetTop = viewport?.offsetTop || 0, offsetLeft = viewport?.offsetLeft || 0;
      const visibleTop = offsetTop + 12, visibleBottom = offsetTop + height - 12;
      const visibleLeft = offsetLeft + 12, visibleRight = offsetLeft + width - 12;
      const above = Math.max(0, rect.top - visibleTop), below = Math.max(0, visibleBottom - rect.bottom);
      const useAbove = below < Math.min(260, above);
      const visibleHeight = Math.max(1, visibleBottom - visibleTop);
      const menuHeight = Math.min(320, visibleHeight, Math.max(1, above, below));
      const menuWidth = Math.min(Math.max(rect.width, 220), Math.max(1, visibleRight - visibleLeft));
      menu.style.width = `${menuWidth}px`;
      menu.style.maxHeight = `${menuHeight}px`;
      menu.style.left = `${Math.max(visibleLeft, Math.min(rect.left, visibleRight - parseFloat(menu.style.width)))}px`;
      const desiredTop = useAbove ? rect.top - menuHeight - 6 : rect.bottom + 6;
      menu.style.top = `${Math.max(visibleTop, Math.min(desiredTop, visibleBottom - menuHeight))}px`;
      menu.style.bottom = 'auto';
    }
    function open(select, button) {
      close(); sync(select, button);
      if (select.disabled) return;
      const menu = document.createElement('div');
      menu.className = 'folio-select-menu'; menu.id = `${button.getAttribute('aria-controls')}-popover`;
      menu.setAttribute('popover', 'auto');
      const listbox = document.createElement('div');
      listbox.className = 'folio-select-listbox'; listbox.id = button.getAttribute('aria-controls');
      listbox.setAttribute('role', 'listbox'); listbox.setAttribute('aria-label', labelFor(select));
      const searchable = select.hasAttribute('data-folio-category-picker');
      let search = null;
      if (searchable) {
        const searchWrap = document.createElement('div'); searchWrap.className = 'folio-select-search-wrap';
        search = document.createElement('input'); search.type = 'search'; search.className = 'folio-select-search';
        search.setAttribute('role', 'searchbox'); search.setAttribute('aria-label', 'Search categories'); search.setAttribute('aria-controls', listbox.id);
        search.placeholder = 'Search categories'; search.autocomplete = 'off'; search.spellcheck = false;
        searchWrap.append(search); menu.append(searchWrap);
      }
      const noResults = document.createElement('div'); noResults.className = 'folio-select-no-results';
      noResults.setAttribute('role', 'status'); noResults.setAttribute('aria-live', 'polite');
      noResults.textContent = 'No matching categories'; noResults.hidden = true;
      const entries = [], groups = [];
      for (const child of select.children) {
        if (child.tagName === 'OPTGROUP') {
          const heading = document.createElement('div'); heading.className = 'folio-select-group';
          heading.setAttribute('role', 'presentation'); heading.textContent = child.label; listbox.append(heading);
          const entry = {heading, options: []}; groups.push(entry);
          for (const option of child.children) addOption(option, child, entry);
        } else if (child.tagName === 'OPTION') addOption(child, null, null);
      }
      function addOption(option, parent, group) {
        if (option.tagName !== 'OPTION' || option.hidden) return;
        const item = document.createElement('button'); item.type = 'button'; item.className = 'folio-select-option';
        item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(option.selected));
        item.textContent = option.textContent; item.disabled = option.disabled || parent?.disabled === true; item.tabIndex = -1;
        item.dataset.searchText = option.textContent.trim().toLocaleLowerCase();
        item.addEventListener('click', () => choose(option, item));
        listbox.append(item); entries.push({option, item, group}); if (group) group.options.push(item);
      }
      function choose(option, item) {
        if (!option || item?.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event('input', {bubbles: true}));
        select.dispatchEvent(new Event('change', {bubbles: true}));
        sync(select, button); close(true);
      }
      function visibleOptions() { return entries.filter(entry => !entry.item.hidden && !entry.item.disabled).map(entry => entry.item); }
      function filterCategories() {
        const query = search.value.trim().toLocaleLowerCase(); let matches = 0;
        for (const {option, item} of entries) {
          const match = !query || option.textContent.toLocaleLowerCase().includes(query);
          item.hidden = !match; if (match && !item.disabled) matches++;
        }
        for (const group of groups) group.heading.hidden = !group.options.some(item => !item.hidden);
        noResults.hidden = matches > 0;
      }
      if (search) search.addEventListener('input', filterCategories);
      menu.append(listbox, noResults); button.after(menu); active = {select, button, menu, listbox, search};
      position(menu, button); button.setAttribute('aria-expanded', 'true'); menu.showPopover();
      const enabled = visibleOptions;
      if (search) search.focus({preventScroll:true});
      else (listbox.querySelector('[aria-selected="true"]:not(:disabled)') || enabled()[0])?.focus();
      menu.addEventListener('toggle', event => { if(event.newState === 'closed' && active?.menu === menu) close(); });
      const moveFocus = delta => {
        const items = enabled(), index = items.indexOf(document.activeElement);
        if (!items.length) return;
        items[(index + delta + items.length) % items.length].focus();
      };
      if (search) search.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); (enabled()[0])?.focus(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); enabled().at(-1)?.focus(); }
        else if (event.key === 'Enter') { event.preventDefault();const focused=listbox.querySelector('button:focus');const target=focused||enabled()[0];if(target)target.click(); }
      });
      let typeahead = '', lastKey = 0;
      listbox.addEventListener('keydown', event => {
        const items = enabled(), index = items.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === 'Tab') { close(true); return; }
        if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1); }
        if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1); }
        if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
        if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
        if (!search && event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
          typeahead = Date.now() - lastKey > 700 ? event.key : typeahead + event.key; lastKey = Date.now();
          items.find(item => item.textContent.toLocaleLowerCase().startsWith(typeahead.toLocaleLowerCase()))?.focus();
        }
      });
    }
    function refresh() {
      scheduled = false;
      for (const [select, button] of controls) if (!select.isConnected) { if (active?.select === select) close(); button.remove(); controls.delete(select); }
      for (const select of root.querySelectorAll('select')) {
        let button = controls.get(select);
        if (!button) {
          button = document.createElement('button'); button.type = 'button'; button.className = 'folio-select-trigger';
          button.append(document.createElement('span'));
          button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', `folio-select-list-${++sequence}`);
          select.classList.add('folio-select-native'); select.after(button); controls.set(select, button);
          button.addEventListener('click', () => active?.select === select ? close(true) : open(select, button));
          button.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(select, button); } });
          select.addEventListener('change', () => sync(select, button));
          select.addEventListener('invalid', event => { event.preventDefault(); button.focus(); });
        }
        sync(select, button);
      }
    }
    new MutationObserver(records => { if (active && records.some(record => record.target === active.select || active.select.contains(record.target))) close(); if (!scheduled) { scheduled = true; requestAnimationFrame(refresh); } }).observe(root, {subtree:true, childList:true, attributes:true, attributeFilter:['hidden','disabled','selected','label','value']});
    root.addEventListener('click', event => { if (active && !active.menu.contains(event.target) && event.target !== active.button && !active.button.contains(event.target)) close(); });
    const reposition = () => { if (active) position(active.menu, active.button); };
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    window.addEventListener('scroll', event => { if (!active || active.menu.contains(event.target)) return;if(active.search&&document.activeElement===active.search)reposition();else close(); }, true);
    window.FolioSelect = {refresh}; refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true}); else init();
})();
