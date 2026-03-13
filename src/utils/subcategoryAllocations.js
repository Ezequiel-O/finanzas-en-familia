function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function extractSubcategoryIds(meta) {
  const ids = Array.isArray(meta?.budgetSubcategoryIds)
    ? meta.budgetSubcategoryIds
    : meta?.budgetSubcategoryId
    ? [meta.budgetSubcategoryId]
    : [];
  return Array.from(
    new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)),
  );
}

function normalizeWeights(ids, weights, total) {
  const safeTotal = Math.round(toNumber(total));
  if (!ids.length || safeTotal <= 0) return {};
  const entries = ids.map((id) => ({
    id,
    weight: Math.max(toNumber(weights[id]), 0),
  }));
  const weightSum = entries.reduce((sum, item) => sum + item.weight, 0);
  if (!weightSum) return {};

  const raw = entries.map((item) => ({
    id: item.id,
    raw: (item.weight / weightSum) * safeTotal,
  }));
  const floors = raw.map((item) => ({
    id: item.id,
    value: Math.floor(item.raw),
    frac: item.raw - Math.floor(item.raw),
  }));
  let remainder =
    safeTotal - floors.reduce((sum, item) => sum + item.value, 0);
  floors.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < floors.length && remainder > 0; i += 1) {
    floors[i].value += 1;
    remainder -= 1;
  }
  const out = {};
  floors.forEach((item) => {
    out[item.id] = item.value;
  });
  return out;
}

function allocateEvenly(ids, total) {
  const safeTotal = Math.round(toNumber(total));
  if (!ids.length || safeTotal <= 0) return {};
  const base = Math.floor(safeTotal / ids.length);
  let remainder = safeTotal - base * ids.length;
  const out = {};
  ids.forEach((id, idx) => {
    out[id] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    if (idx === ids.length - 1 && remainder !== 0) {
      out[id] = out[id] + remainder;
    }
  });
  return out;
}

function normalizeAllocationMap(raw) {
  if (!raw) return null;
  const out = {};
  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      if (!item || !item.id) return;
      out[String(item.id)] = toNumber(item.amount);
    });
  } else if (typeof raw === 'object') {
    Object.entries(raw).forEach(([key, value]) => {
      const id = String(key || '').trim();
      if (!id) return;
      out[id] = toNumber(value);
    });
  }
  return Object.keys(out).length ? out : null;
}

function buildBreakdownWeights(ids, breakdown) {
  if (!Array.isArray(breakdown) || !breakdown.length) return null;
  const weights = {};
  ids.forEach((id) => {
    const match = breakdown.find((item) => String(item?.id || '') === id);
    if (!match) return;
    weights[id] = toNumber(match.amount);
  });
  return Object.keys(weights).length ? weights : null;
}

export function getSubcategoryAllocationsForTransaction({
  transaction,
  breakdown = [],
}) {
  if (!transaction) return [];
  const ids = extractSubcategoryIds(transaction.meta || {});
  if (!ids.length) return [];
  const amount = Math.round(toNumber(transaction.amount));
  if (amount <= 0) return [];
  if (ids.length === 1) return [{ id: ids[0], amount }];

  const metaAllocations = normalizeAllocationMap(
    transaction?.meta?.budgetSubcategoryAmounts ||
      transaction?.meta?.budgetSubcategoryAllocations,
  );
  if (metaAllocations) {
    const normalized = normalizeWeights(ids, metaAllocations, amount);
    if (Object.keys(normalized).length) {
      return Object.entries(normalized).map(([id, value]) => ({
        id,
        amount: value,
      }));
    }
  }

  const breakdownWeights = buildBreakdownWeights(ids, breakdown);
  if (breakdownWeights) {
    const normalized = normalizeWeights(ids, breakdownWeights, amount);
    if (Object.keys(normalized).length) {
      return Object.entries(normalized).map(([id, value]) => ({
        id,
        amount: value,
      }));
    }
  }

  const evenSplit = allocateEvenly(ids, amount);
  return Object.entries(evenSplit).map(([id, value]) => ({
    id,
    amount: value,
  }));
}
