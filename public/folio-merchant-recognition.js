(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FolioMerchantRecognition = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const text = (value, limit = 120) => {
    if (typeof value !== 'string') return null;
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
    return clean ? clean.slice(0, limit) : null;
  };

  function safeWebsite(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const clean = value.trim();
    const bare = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])\.?$/i.test(clean);
    if (!clean || clean.startsWith('//') || (!bare && !/^https:\/\//i.test(clean))) return null;
    try {
      const url = new URL(bare ? `https://${clean}` : clean);
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      const validDns = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(host);
      const localSuffix = /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host);
      const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || /^[0-9.]+$/.test(host);
      const ipv6 = host.includes(':') || host.startsWith('[') || host.endsWith(']');
      if (url.protocol !== 'https:' || !validDns || localSuffix || ipv4 || ipv6 || url.username || url.password || (url.port && url.port !== '443')) return null;
      return `https://${host}`;
    } catch (_) {
      return null;
    }
  }

  function safeLocation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const output = {};
    for (const key of ['city', 'region', 'postal_code', 'country']) {
      const clean = text(value[key], key === 'postal_code' ? 24 : 80);
      if (clean) output[key] = clean;
    }
    return Object.keys(output).length ? output : null;
  }

  function asRows(value) {
    return Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
  }

  function transactionData(transaction) {
    const tx = transaction && typeof transaction === 'object' ? transaction : {};
    const raw = tx.raw && typeof tx.raw === 'object' && !Array.isArray(tx.raw) ? tx.raw : tx;
    const field = name => raw[name] !== undefined && raw[name] !== null ? raw[name] : tx[name];
    const id = text(field('merchant_entity_id'), 180);
    const counterparties = asRows(field('counterparties'));
    const merchants = counterparties.filter(item => item.type === 'merchant');
    const counterparty = id ? merchants.find(item => text(item.entity_id, 180) === id) || null : merchants[0] || null;
    const merchantName = text(field('plaid_merchant_name'), 120) || text(counterparty && counterparty.name, 120);
    const location = safeLocation(field('location')) || safeLocation(counterparty && counterparty.location);
    const website = safeWebsite(field('website')) || safeWebsite(counterparty && counterparty.website);
    return { tx, raw, merchantEntityId: id || text(counterparty && counterparty.entity_id, 180), merchantName, location, website };
  }

  function details(transaction) {
    const { merchantEntityId, merchantName, location, website } = transactionData(transaction);
    return { merchantEntityId, merchantName, location, website };
  }

  function normalizedName(value) {
    return text(value, 120)?.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || '';
  }

  function merchantGroupKey(transaction, householdId, fallbackIndex = 0) {
    const { tx, raw, merchantEntityId, merchantName, location } = transactionData(transaction);
    const embeddedHousehold = text(raw.household_id || tx.household_id, 80);
    const scope = text(householdId, 80) || embeddedHousehold || 'current';
    if (embeddedHousehold && householdId && embeddedHousehold !== String(householdId)) return null;
    if (merchantEntityId) return `household:${scope}:entity:${merchantEntityId}`;
    const name = normalizedName(merchantName);
    // A name without a specific place is not enough to infer identity. Keep it separate.
    const locality = location && (location.city || location.postal_code) ? location : null;
    if (name && locality) {
      const place = ['city', 'region', 'postal_code', 'country'].map(key => normalizedName(locality[key] || '')).join('|');
      return `household:${scope}:name-place:${name}:${place}`;
    }
    const txid = text(raw.transaction_id || tx.transaction_id || tx.id, 180) || `row-${fallbackIndex}`;
    return `household:${scope}:transaction:${txid}`;
  }

  function groupByMerchant(transactions, householdId) {
    const groups = new Map();
    for (const [index, transaction] of (Array.isArray(transactions) ? transactions : []).entries()) {
      const key = merchantGroupKey(transaction, householdId, index);
      if (!key) continue;
      if (!groups.has(key)) {
        const { merchantName, tx, raw } = transactionData(transaction);
        const label = merchantName || text(raw.name || tx.name, 120) || 'Merchant details unavailable';
        groups.set(key, { key, label, items: [] });
      }
      groups.get(key).items.push(transaction);
    }
    return [...groups.values()];
  }

  return { safeWebsite, safeLocation, details, merchantGroupKey, groupByMerchant };
});
