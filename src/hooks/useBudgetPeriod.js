import { toLocalDateKey } from '../domain/dates.js';
// src/hooks/useBudgetPeriod.js
export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}`;
}

export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const date = new Date(y, m - 1 + delta, 1);
  return monthKey(date);
}

export function getBudgetPeriod(monthKeyStr, cutDay = 1) {
  const [y, m] = monthKeyStr.split('-').map(Number);
  const day = Math.max(1, Math.min(28, Number(cutDay) || 1));
  const start = new Date(y, m - 1, day);
  const end = new Date(y, m, day);

  const startStr = toLocalDateKey(start);
  const endStr = toLocalDateKey(end);

  return { start: startStr, end: endStr };
}

export function budgetMonthKeyForDate(dateStr, cutDay = 1) {
  if (!dateStr) return monthKey(new Date());

  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return monthKey(new Date());

  const day = d.getDate();
  const offset = day >= cutDay ? 0 : -1;

  const base = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return monthKey(base);
}
