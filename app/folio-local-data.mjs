const eventCacheEpochs = new Map();

export function userEventDetailCacheEpoch(userId) {
  return eventCacheEpochs.get(userId) ?? 0;
}

/** Remove the current user's cached financial data from this origin. */
export function clearUserEventDetailCache(userId, storage) {
  if (!userId) return;
  eventCacheEpochs.set(userId, userEventDetailCacheEpoch(userId) + 1);
  const eventPrefix = `folio:event-detail:${userId}:`;
  const chatKey = `folio-chat:${userId}`;
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return;
    for (const key of Object.keys(storage)) {
      if (key.startsWith(eventPrefix) || key === chatKey) storage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable in private browsing or restricted contexts.
  }
}
