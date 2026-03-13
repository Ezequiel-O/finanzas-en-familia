import { filterTransactionsByPeriodAndUser } from './transactions.js';
import { getSubcategoryAllocationsForTransaction } from './subcategoryAllocations.js';

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase();
}

function parseSubcategoryNames(meta) {
  const list = [];
  const raw = String(meta?.budgetSubcategoryNames || '').trim();
  if (raw) {
    raw.split(';').forEach((name) => {
      const trimmed = String(name || '').trim();
      if (trimmed) list.push(trimmed);
    });
  }
  const single = String(meta?.budgetSubcategoryName || '').trim();
  if (single) list.push(single);
  return Array.from(new Set(list));
}

function matchesSubcategory(meta, subId, subName) {
  const id = subId ? String(subId) : '';
  if (id) {
    const ids = Array.isArray(meta?.budgetSubcategoryIds)
      ? meta.budgetSubcategoryIds
      : meta?.budgetSubcategoryId
      ? [meta.budgetSubcategoryId]
      : [];
    if (ids.some((value) => String(value) === id)) return true;
  }
  const nameKey = normalizeLabel(subName);
  if (!nameKey) return false;
  const names = parseSubcategoryNames(meta);
  return names.some((name) => normalizeLabel(name) === nameKey);
}

export function getSubcategorySpentForPeriod({
  transactions,
  periodKey,
  cutDay,
  category,
  subId,
  subName,
  breakdown,
}) {
  if (!periodKey) return 0;
  const periodTx = filterTransactionsByPeriodAndUser(
    transactions,
    periodKey,
    cutDay,
    null,
    false,
  );
  return periodTx.reduce((sum, tx) => {
    if (tx?.type !== 'gasto') return sum;
    if (tx?.category !== category) return sum;
    const allocations = getSubcategoryAllocationsForTransaction({
      transaction: tx,
      breakdown,
    });
    if (allocations.length) {
      const match = allocations.find(
        (item) => String(item.id) === String(subId),
      );
      if (!match) return sum;
      return sum + Number(match.amount || 0);
    }
    if (!matchesSubcategory(tx?.meta || {}, subId, subName)) return sum;
    const amt = Number(tx.amount || 0);
    return Number.isNaN(amt) ? sum : sum + amt;
  }, 0);
}

export function resolveFixedCategory({
  entry,
  breakdown = [],
  fixedCategories,
  category,
}) {
  if (entry?.isFixed !== undefined) return !!entry.isFixed;
  if (
    fixedCategories &&
    Object.prototype.hasOwnProperty.call(fixedCategories, category)
  ) {
    return !!fixedCategories[category];
  }
  return breakdown.some((item) => item?.isFixed);
}

function findBreakdownItem(breakdown, subId, subName) {
  const id = subId ? String(subId) : '';
  if (id) {
    const match = breakdown.find((item) => String(item?.id || '') === id);
    if (match) return match;
  }
  const nameKey = normalizeLabel(subName);
  if (!nameKey) return null;
  return (
    breakdown.find(
      (item) => normalizeLabel(item?.name || '') === nameKey,
    ) || null
  );
}

export function getFixedCarryoverForSubcategory({
  budgetsAll,
  transactions,
  cutDay,
  category,
  fixedCategories,
  subId,
  subName,
  currentPeriodKey,
}) {
  if (!budgetsAll || !currentPeriodKey) return 0;
  const periods = Object.keys(budgetsAll)
    .filter((pk) => pk < currentPeriodKey)
    .sort();
  if (!periods.length) return 0;

  let pending = 0;

  for (const pk of periods) {
    const entry = budgetsAll?.[pk]?.[category];
    const breakdown = Array.isArray(entry?.breakdown) ? entry.breakdown : [];
    const isFixedCategory = resolveFixedCategory({
      entry,
      breakdown,
      fixedCategories,
      category,
    });
    if (!isFixedCategory || !breakdown.length) {
      pending = 0;
      continue;
    }
    const item = findBreakdownItem(breakdown, subId, subName);
    if (!item) {
      pending = 0;
      continue;
    }
    const base = Number(item.amount || 0);
    const effective = base + pending;
    const spent = getSubcategorySpentForPeriod({
      transactions,
      periodKey: pk,
      cutDay,
      category,
      subId: item.id || subId,
      subName: item.name || subName,
      breakdown,
    });
    pending = Math.max(0, effective - spent);
  }

  return pending;
}
