(() => {
  'use strict';

  const databaseName = 'folio-canonical-transactions-v1';
  const databaseVersion = 2;
  const metaStore = 'replica_meta';
  const rowStore = 'replica_rows';
  const liveRequests = new Map();
  // Epochs remain monotonic even after a successful sync clears the dirty bit.
  // That prevents an in-flight local read from missing an invalidate-and-refresh ABA.
  const staleNamespaces = new Map();
  const userEpochs = new Map();
  let databasePromise;

  const namespaceFor = (userId, householdId) => {
    const user = String(userId || '').trim();
    const household = String(householdId || '').trim();
    return user && household ? `${user}:${household}:canonical-v1` : null;
  };

  function openDatabase() {
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.onupgradeneeded = event => {
        const db = request.result;
        if (!db.objectStoreNames.contains(metaStore)) {
          const store = db.createObjectStore(metaStore, { keyPath: 'namespace' });
          store.createIndex('byUser', 'userId', { unique: false });
        }
        let rows;
        if (!db.objectStoreNames.contains(rowStore)) {
          rows = db.createObjectStore(rowStore, { keyPath: ['namespace', 'generation', 'transaction_id'] });
          rows.createIndex('byDate', ['namespace', 'generation', 'effectiveDate'], { unique: false });
          rows.createIndex('byReplica', ['namespace', 'generation'], { unique: false });
          rows.createIndex('byUser', 'userId', { unique: false });
        } else {
          rows = request.transaction.objectStore(rowStore);
          if (!rows.indexNames.contains('byDate')) rows.createIndex('byDate', ['namespace', 'generation', 'effectiveDate'], { unique: false });
        }
        if (event.oldVersion < 2) {
          const incompleteNamespaces = new Set();
          const cursorRequest = rows.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              const metas = request.transaction.objectStore(metaStore).openCursor();
              metas.onsuccess = () => {
                const metaCursor = metas.result;
                if (!metaCursor) return;
                const meta = metaCursor.value;
                metaCursor.update({ ...meta, dateIndexVersion: 2, dateIndexComplete: !incompleteNamespaces.has(meta.namespace) });
                metaCursor.continue();
              };
              return;
            }
            const record = cursor.value, rawDate = record.row?.effective_transaction_date || record.row?.transaction_date || '', effectiveDate = String(rawDate).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) incompleteNamespaces.add(record.namespace);
            cursor.update({ ...record, effectiveDate: /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ? effectiveDate : '' });
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); databasePromise = null; };
        resolve(db);
      };
      request.onerror = () => { databasePromise = null; reject(request.error || new Error('Could not open local transaction storage.')); };
      request.onblocked = () => { databasePromise = null; reject(new Error('Local transaction storage is busy.')); };
    }).catch(error => { databasePromise = null; throw error; });
    return databasePromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Local transaction storage request failed.'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Local transaction storage update failed.'));
    });
  }

  async function getMeta(namespace) {
    const db = await openDatabase();
    const tx = db.transaction(metaStore, 'readonly');
    const done = transactionDone(tx);
    const result = await requestResult(tx.objectStore(metaStore).get(namespace));
    await done;
    return result || null;
  }

  async function putMeta(meta, verify) {
    const db = await openDatabase();
    verify?.();
    const tx = db.transaction(metaStore, 'readwrite');
    tx.objectStore(metaStore).put(meta);
    await transactionDone(tx);
  }

  async function replicaRecords(namespace, generation) {
    const db = await openDatabase();
    const tx = db.transaction(rowStore, 'readonly');
    const done = transactionDone(tx);
    const index = tx.objectStore(rowStore).index('byReplica');
    const records = await requestResult(index.getAll(IDBKeyRange.only([namespace, generation])));
    await done;
    return records;
  }

  async function replicaSearchSnapshot(namespace, filters) {
    const hasStart = filters.start_date !== undefined && filters.start_date !== null && filters.start_date !== '';
    const hasEnd = filters.end_date !== undefined && filters.end_date !== null && filters.end_date !== '';
    const dateScoped = hasStart || hasEnd;
    const start = hasStart && typeof filters.start_date === 'string' ? filters.start_date : '';
    const end = hasEnd && typeof filters.end_date === 'string' ? filters.end_date : '\uffff';
    if (dateScoped && ((hasStart && !/^\d{4}-\d{2}-\d{2}$/.test(start)) || (hasEnd && !/^\d{4}-\d{2}-\d{2}$/.test(end)) || (start && end !== '\uffff' && start > end))) return null;
    const db = await openDatabase();
    const tx = db.transaction([metaStore, rowStore], 'readonly');
    const metaRequest = tx.objectStore(metaStore).get(namespace);
    let meta = null, rowCount = null, records = null, unusable = false;
    const result = new Promise((resolve, reject) => {
      metaRequest.onsuccess = () => {
        meta = metaRequest.result || null;
        if (!meta?.complete || !meta.activeGeneration || meta.schemaVersion !== 1 || (dateScoped && (meta.dateIndexVersion !== 2 || meta.dateIndexComplete !== true))) { unusable = true; return; }
        const store = tx.objectStore(rowStore), replicaIndex = store.index('byReplica'), replicaRange = IDBKeyRange.only([namespace, meta.activeGeneration]);
        const countRequest = replicaIndex.count(replicaRange);
        countRequest.onsuccess = () => { rowCount = countRequest.result; };
        countRequest.onerror = () => { try { tx.abort(); } catch {} };
        let rowsRequest;
        if (dateScoped) {
          rowsRequest = store.index('byDate').getAll(IDBKeyRange.bound([namespace, meta.activeGeneration, start], [namespace, meta.activeGeneration, end]));
        } else rowsRequest = replicaIndex.getAll(replicaRange);
        rowsRequest.onsuccess = () => { records = rowsRequest.result; };
        rowsRequest.onerror = () => { try { tx.abort(); } catch {} };
      };
      metaRequest.onerror = () => { try { tx.abort(); } catch {} };
      tx.oncomplete = () => resolve(!unusable && meta && rowCount === meta.totalRows && Array.isArray(records) ? { ...meta, complete: true, rows: records.map(record => record.row) } : null);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Local transaction search failed.'));
    });
    return result;
  }

  async function deleteGeneration(namespace, generation) {
    if (generation === null || generation === undefined) return;
    const db = await openDatabase();
    const tx = db.transaction(rowStore, 'readwrite');
    const request = tx.objectStore(rowStore).index('byReplica').openCursor(IDBKeyRange.only([namespace, generation]));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await transactionDone(tx);
  }

  function assertCurrent(namespace, userId, epoch) {
    const active = liveRequests.get(namespace);
    if (!active || active.controller.signal.aborted || (userEpochs.get(userId) || 0) !== epoch) {
      throw new DOMException('Transaction sync cancelled.', 'AbortError');
    }
  }

  async function persistPage(namespace, userId, localGeneration, meta, rows, verify) {
    const db = await openDatabase();
    verify?.();
    const tx = db.transaction([metaStore, rowStore], 'readwrite');
    const store = tx.objectStore(rowStore);
    for (const item of rows) {
      const row = item?.row;
      const id = String(item?.transaction_id || row?.transaction_id || '');
      if (!id || item.deleted || !row || typeof row !== 'object') continue;
      const candidateDate = String(row.effective_transaction_date || row.transaction_date || '').slice(0, 10), validDate = /^\d{4}-\d{2}-\d{2}$/.test(candidateDate);
      store.put({ namespace, userId, generation: localGeneration, transaction_id: id, effectiveDate: validDate ? candidateDate : '', row });
    }
    tx.objectStore(metaStore).put(meta);
    await transactionDone(tx);
  }

  async function persistDeltaPage(namespace, userId, generation, meta, rows, verify) {
    const db = await openDatabase();
    verify?.();
    const tx = db.transaction([metaStore, rowStore], 'readwrite');
    const store = tx.objectStore(rowStore);
    for (const item of rows) {
      const id = String(item?.transaction_id || item?.row?.transaction_id || '');
      if (!id) throw new Error('Transaction update is missing its ID.');
      if (item.deleted) store.delete([namespace, generation, id]);
      else if (item.row && typeof item.row === 'object') { const candidateDate=String(item.row.effective_transaction_date||item.row.transaction_date||'').slice(0,10),validDate=/^\d{4}-\d{2}-\d{2}$/.test(candidateDate);store.put({ namespace, userId, generation, transaction_id: id, effectiveDate: validDate?candidateDate:'', row: item.row }); }
      else throw new Error('Transaction update could not be verified.');
    }
    tx.objectStore(metaStore).put(meta);
    await transactionDone(tx);
  }

  async function cloneGeneration(namespace, userId, fromGeneration, toGeneration, meta, verify) {
    const records = await replicaRecords(namespace, fromGeneration);
    const db = await openDatabase();
    verify?.();
    const tx = db.transaction([metaStore, rowStore], 'readwrite');
    const store = tx.objectStore(rowStore);
    for (const record of records) store.put({ ...record, generation: toGeneration });
    tx.objectStore(metaStore).put(meta);
    await transactionDone(tx);
    return records.length;
  }

  async function promoteGeneration(namespace, meta, oldGeneration, verify) {
    const db = await openDatabase();
    verify?.();
    const tx = db.transaction(metaStore, 'readwrite');
    tx.objectStore(metaStore).put(meta);
    await transactionDone(tx);
    if (oldGeneration !== null && oldGeneration !== undefined && oldGeneration !== meta.activeGeneration) {
      void deleteGeneration(namespace, oldGeneration).catch(() => {});
    }
  }

  async function fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller, restartCount = 0 }) {
    const verify = () => assertCurrent(namespace, userId, epoch);
    let meta = await getMeta(namespace) || { namespace, userId, householdId, schemaVersion: 1, complete: false };
    let stage = meta.staging || null;
    let firstResponse = null;
    if (!stage) {
      firstResponse = await request({ action: 'sync_prepared_transactions', mode: 'page', limit: 500 });
      assertCurrent(namespace, userId, epoch);
      if (firstResponse.restart_required) throw new Error('The transaction snapshot could not be started.');
      stage = { generation: firstResponse.generation, revision: firstResponse.revision, totalRows: firstResponse.total_rows, localGeneration: `full-${firstResponse.generation}-${Date.now()}`, cursor: null, received: 0, done: false, dateIndexComplete: true, fresh: firstResponse.fresh, stale: firstResponse.stale, refreshedAt: firstResponse.refreshed_at || null };
      meta = { ...meta, namespace, userId, householdId, schemaVersion: 1, staging: stage, syncState: 'downloading' };
      await putMeta(meta, verify);
    }

    let response = firstResponse;
    while (true) {
      assertCurrent(namespace, userId, epoch);
      if (stage.done) {
        const stagedRows = await replicaRecords(namespace, stage.localGeneration);
        if (stage.received !== stage.totalRows || stagedRows.length !== stage.totalRows) {
          await deleteGeneration(namespace, stage.localGeneration);
          if (restartCount >= 1) throw new Error('The local transaction copy could not be verified.');
          meta = { ...meta, staging: null, syncState: 'restart_required' };
          await putMeta(meta, verify);
          return fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller, restartCount: restartCount + 1 });
        }
        const oldGeneration = meta.activeGeneration ?? null;
        meta = { ...meta, activeGeneration: stage.localGeneration, serverGeneration: stage.generation, revision: stage.revision, totalRows: stage.totalRows, complete: true, dateIndexVersion: 2, dateIndexComplete: stagedRows.every(record => /^\d{4}-\d{2}-\d{2}$/.test(String(record.effectiveDate || ''))), fresh: stage.fresh, stale: stage.stale, refreshedAt: stage.refreshedAt, syncState: 'ready', staging: null, pendingDelta: null };
        await promoteGeneration(namespace, meta, oldGeneration, verify);
        return { ...meta, rows: (await replicaRecords(namespace, meta.activeGeneration)).map(record => record.row) };
      }
      if (!response) {
        response = await request({ action: 'sync_prepared_transactions', mode: 'page', generation: stage.generation, revision: stage.revision, cursor: stage.cursor, limit: 500 });
        assertCurrent(namespace, userId, epoch);
      }
      if (response.restart_required || response.generation !== stage.generation || response.revision !== stage.revision || response.total_rows !== stage.totalRows) {
        await deleteGeneration(namespace, stage.localGeneration);
        meta = { ...meta, staging: null, syncState: 'restart_required' };
        await putMeta(meta, verify);
        if (restartCount >= 1) throw new Error('The household transaction history changed repeatedly during sync.');
        return fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller, restartCount: restartCount + 1 });
      }
      const entries = Array.isArray(response.rows) ? response.rows : [];
      const received = stage.received + entries.filter(item => !item.deleted).length;
      const pageHasDates = entries.filter(item => !item.deleted).every(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.row?.effective_transaction_date || item?.row?.transaction_date || '').slice(0, 10)));
      const nextStage = { ...stage, dateIndexComplete: stage.dateIndexComplete !== false && pageHasDates, cursor: response.next_cursor, received, done: response.has_more !== true && response.complete === true, fresh: response.fresh, stale: response.stale, refreshedAt: response.refreshed_at || stage.refreshedAt };
      const nextMeta = { ...meta, staging: nextStage, syncState: response.has_more ? 'downloading' : 'verifying' };
      await persistPage(namespace, userId, stage.localGeneration, nextMeta, entries, verify);
      assertCurrent(namespace, userId, epoch);
      stage = nextStage;
      meta = nextMeta;
      onProgress?.({ received, total: stage.totalRows });
      if (response.has_more) {
        response = null;
        continue;
      }
      const stagedRows = await replicaRecords(namespace, stage.localGeneration);
      if (!response.complete || received !== stage.totalRows || stagedRows.length !== stage.totalRows) {
        await deleteGeneration(namespace, stage.localGeneration);
        if (restartCount >= 1) throw new Error('The local transaction copy could not be verified.');
        meta = { ...meta, staging: null, syncState: 'restart_required' };
        await putMeta(meta, verify);
        return fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller, restartCount: restartCount + 1 });
      }
      const oldGeneration = meta.activeGeneration ?? null;
      meta = { ...meta, activeGeneration: stage.localGeneration, serverGeneration: stage.generation, revision: stage.revision, totalRows: stage.totalRows, complete: true, dateIndexVersion: 2, dateIndexComplete: stagedRows.every(record => /^\d{4}-\d{2}-\d{2}$/.test(String(record.effectiveDate || ''))), fresh: stage.fresh, stale: stage.stale, refreshedAt: stage.refreshedAt, syncState: 'ready', staging: null, pendingDelta: null };
      await promoteGeneration(namespace, meta, oldGeneration, verify);
      return { ...meta, rows: (await replicaRecords(namespace, meta.activeGeneration)).map(record => record.row) };
    }
  }

  async function deltaSync({ namespace, userId, householdId, request, onProgress, epoch, controller }) {
    const verify = () => assertCurrent(namespace, userId, epoch);
    let meta = await getMeta(namespace);
    if (!meta?.complete || !meta.activeGeneration || meta.schemaVersion !== 1) return fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller });
    if (!meta.pendingDelta) {
      const first = await request({ action: 'sync_prepared_transactions', mode: 'delta', generation: meta.serverGeneration, revision: meta.revision, limit: 500 });
      assertCurrent(namespace, userId, epoch);
      if (first.restart_required) return fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller });
      if (first.revision === meta.revision && !first.rows.length) {
        meta = { ...meta, serverGeneration: first.generation, fresh: first.fresh, stale: first.stale, refreshedAt: first.refreshed_at || meta.refreshedAt, syncState: 'ready' };
        await putMeta(meta, verify);
        return { ...meta, rows: (await replicaRecords(namespace, meta.activeGeneration)).map(record => record.row) };
      }
      const localGeneration = `delta-${first.generation}-${first.target_revision ?? first.revision}-${Date.now()}`;
      const pendingDelta = { baseRevision: meta.revision, targetRevision: first.target_revision ?? first.revision, generation: first.generation, totalRows: first.total_rows, localGeneration, oldGeneration: meta.activeGeneration, cursorRevision: null, cursorTransactionId: null, fresh: first.fresh, stale: first.stale, refreshedAt: first.refreshed_at || null };
      const nextMeta = { ...meta, pendingDelta, syncState: 'updating' };
      await cloneGeneration(namespace, userId, meta.activeGeneration, localGeneration, nextMeta, verify);
      meta = nextMeta;
      return applyDeltaPages({ namespace, userId, householdId, request, onProgress, epoch, controller, meta, first });
    }
    return applyDeltaPages({ namespace, userId, householdId, request, onProgress, epoch, controller, meta, first: null });
  }

  async function promoteDeltaGeneration(namespace, userId, epoch, meta, pending) {
    const verify = () => assertCurrent(namespace, userId, epoch);
    const records = await replicaRecords(namespace, pending.localGeneration);
    if (records.length !== pending.totalRows) {
      await deleteGeneration(namespace, pending.localGeneration);
      const reset = { ...meta, pendingDelta: null, syncState: 'restart_required' };
      await putMeta(reset, verify);
      return null;
    }
    const complete = {
      ...meta,
      activeGeneration: pending.localGeneration,
      serverGeneration: pending.generation,
      revision: pending.targetRevision,
      totalRows: pending.totalRows,
      complete: true,
      dateIndexVersion: 2,
      dateIndexComplete: meta.dateIndexComplete !== false && records.every(record => /^\d{4}-\d{2}-\d{2}$/.test(String(record.effectiveDate || ''))),
      fresh: pending.fresh,
      stale: pending.stale,
      refreshedAt: pending.refreshedAt,
      syncState: 'ready',
      pendingDelta: null,
    };
    await promoteGeneration(namespace, complete, pending.oldGeneration, verify);
    if (pending.oldGeneration !== undefined && pending.oldGeneration !== pending.localGeneration) void deleteGeneration(namespace, pending.oldGeneration).catch(() => {});
    return { ...complete, rows: records.map(record => record.row) };
  }

  async function applyDeltaPages({ namespace, userId, householdId, request, onProgress, epoch, controller, meta, first }) {
    const verify = () => assertCurrent(namespace, userId, epoch);
    let page = first;
    let pending = meta.pendingDelta;
    while (true) {
      assertCurrent(namespace, userId, epoch);
      if (pending.done) {
        const promoted = await promoteDeltaGeneration(namespace, userId, epoch, meta, pending);
        if (promoted) return promoted;
        return fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller });
      }
      if (!page) {
        page = await request({ action: 'sync_prepared_transactions', mode: 'delta', generation: pending.generation, revision: pending.baseRevision, target_revision: pending.targetRevision, change_revision: pending.cursorRevision, cursor: pending.cursorTransactionId, limit: 500 });
        assertCurrent(namespace, userId, epoch);
      }
      if (page.restart_required || (page.target_revision ?? page.revision) !== pending.targetRevision || page.generation !== pending.generation) {
        await deleteGeneration(namespace, pending.localGeneration);
        meta = { ...meta, pendingDelta: null, syncState: 'restart_required' };
        await putMeta(meta, verify);
        return fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller });
      }
      const entries = Array.isArray(page.rows) ? page.rows : [];
      const updated = { ...pending, cursorRevision: page.next_cursor_revision ?? pending.cursorRevision, cursorTransactionId: page.next_cursor_transaction_id ?? null, totalRows: page.total_rows, fresh: page.fresh, stale: page.stale, refreshedAt: page.refreshed_at || pending.refreshedAt, done: page.has_more !== true };
      const nextMeta = { ...meta, pendingDelta: updated, syncState: page.has_more ? 'updating' : 'verifying' };
      await persistDeltaPage(namespace, userId, pending.localGeneration, nextMeta, entries, verify);
      assertCurrent(namespace, userId, epoch);
      meta = nextMeta;
      pending = updated;
      onProgress?.({ changed: entries.length, hasMore: page.has_more });
      if (!page.has_more) {
        const promoted = await promoteDeltaGeneration(namespace, userId, epoch, meta, pending);
        if (promoted) return promoted;
        return fullSync({ namespace, userId, householdId, request, onProgress, epoch, controller });
      }
      page = null;
    }
  }

  async function sync({ userId, householdId, request, onProgress } = {}) {
    const namespace = namespaceFor(userId, householdId);
    if (!namespace || typeof request !== 'function') throw new Error('A signed-in household is required for transaction sync.');
    const existing = liveRequests.get(namespace);
    if (existing) return existing.promise;
    const invalidationEpoch = staleNamespaces.get(namespace)?.epoch || 0;
    const controller = new AbortController();
    const epoch = userEpochs.get(String(userId)) || 0;
    const context = { namespace, userId: String(userId), householdId: String(householdId), request, onProgress, epoch, controller };
    const promise = (async () => {
      const current = await getMeta(namespace);
      assertCurrent(namespace, context.userId, epoch);
      if (current?.staging) return fullSync(context);
      return deltaSync(context);
    })();
    liveRequests.set(namespace, { userId: String(userId), controller, promise });
    try { const result = await promise; if (result?.fresh === true && result?.stale === false) { const invalidation = staleNamespaces.get(namespace); if (invalidation && invalidation.epoch === invalidationEpoch) invalidation.dirty = false; } return result; }
    finally { if (liveRequests.get(namespace)?.promise === promise) liveRequests.delete(namespace); }
  }

  async function readComplete({ userId, householdId } = {}) {
    const namespace = namespaceFor(userId, householdId);
    if (!namespace) return null;
    const meta = await getMeta(namespace);
    if (!meta?.complete || !meta.activeGeneration || meta.schemaVersion !== 1) return null;
    const records = await replicaRecords(namespace, meta.activeGeneration);
    if (records.length !== meta.totalRows) return { ...meta, complete: false, rows: [] };
    return { ...meta, rows: records.map(record => record.row) };
  }

  async function search({ userId, householdId, filters = {} } = {}) {
    const namespace = namespaceFor(userId, householdId);
    if (!namespace || staleNamespaces.get(namespace)?.dirty) return null;
    const invalidationEpoch = staleNamespaces.get(namespace)?.epoch || 0;
    const snapshot = await replicaSearchSnapshot(namespace, filters);
    const invalidation = staleNamespaces.get(namespace);
    if (invalidation?.dirty || (invalidation?.epoch || 0) !== invalidationEpoch) return null;
    if (!snapshot?.complete) return null;
    const query = String(filters.query || '').trim().toLocaleLowerCase();
    const ids = Array.isArray(filters.transaction_ids) ? new Set(filters.transaction_ids.map(String)) : null;
    const canonicalAccountIds = Array.isArray(filters.canonical_account_ids) ? new Set(filters.canonical_account_ids.map(String)) : null;
    const rows = snapshot.rows.filter(row => {
      const date = String(row.effective_transaction_date || row.transaction_date || '').slice(0, 10);
      if (filters.account_id && String(row.account_id || '') !== String(filters.account_id)) return false;
      if (canonicalAccountIds && !canonicalAccountIds.has(String(row.canonical_account_id || ''))) return false;
      if (ids && !ids.has(String(row.transaction_id || ''))) return false;
      if (filters.start_date && date < filters.start_date) return false;
      if (filters.end_date && date > filters.end_date) return false;
      if (filters.include_pending === false && row.pending === true) return false;
      if (filters.pending_only === true && row.pending !== true) return false;
      if (filters.category && String(row.effective_category || '') !== filters.category) return false;
      if (query && ![row.name, row.effective_merchant_name, row.plaid_merchant_name, row.original_description]
        .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query))) return false;
      return true;
    }).sort((a, b) => String(b.effective_transaction_date || '').localeCompare(String(a.effective_transaction_date || '')) || String(a.transaction_id).localeCompare(String(b.transaction_id)));
    return { ...snapshot, canonicalScopeComplete: snapshot.rows.every(row => typeof row?.canonical_account_id === 'string' && row.canonical_account_id.length > 0), rows };
  }

  async function markStale({ userId, householdId } = {}) {
    const namespace = namespaceFor(userId, householdId);
    if (!namespace) return;
    const invalidation = staleNamespaces.get(namespace) || { epoch: 0, dirty: false };
    invalidation.epoch++;
    invalidation.dirty = true;
    staleNamespaces.set(namespace, invalidation);
    const meta = await getMeta(namespace);
    if (meta) await putMeta({ ...meta, fresh: false, stale: true, syncState: 'needs_sync' });
  }

  async function clearUser(userId) {
    const user = String(userId || '').trim();
    if (!user) return;
    userEpochs.set(user, (userEpochs.get(user) || 0) + 1);
    for (const namespace of staleNamespaces.keys()) if (namespace.startsWith(`${user}:`)) staleNamespaces.delete(namespace);
    for (const [namespace, active] of liveRequests) if (active.userId === user) {
      active.controller.abort();
      liveRequests.delete(namespace);
    }
    try {
      const db = await openDatabase();
      const tx = db.transaction([metaStore, rowStore], 'readwrite');
      const metaIndex = tx.objectStore(metaStore).index('byUser');
      const rowIndex = tx.objectStore(rowStore).index('byUser');
      for (const index of [metaIndex, rowIndex]) {
        const cursorRequest = index.openCursor(IDBKeyRange.only(user));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }
      await transactionDone(tx);
    } catch {}
    // Purge the older dashboard snapshot store too; it is keyed by user ID,
    // but is still personal financial data retained across logout otherwise.
    try {
      const legacy = await new Promise((resolve, reject) => {
        const request = indexedDB.open('folio-finance-snapshots-v1', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (legacy.objectStoreNames.contains('snapshots')) {
        const legacyTx = legacy.transaction('snapshots', 'readwrite');
        const cursor = legacyTx.objectStore('snapshots').openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (String(item.primaryKey).startsWith(`${user}:`)) item.delete();
          item.continue();
        };
        await transactionDone(legacyTx);
      }
      legacy.close();
    } catch {}
  }

  globalThis.FolioTransactionReplica = Object.freeze({ namespaceFor, sync, readComplete, search, markStale, clearUser });
})();
