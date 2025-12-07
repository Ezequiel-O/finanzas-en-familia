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
  const day = Math.max(1, Math.min(28, Number(cutDay) || 1)); // limitar 1–28
  const start = new Date(y, m - 1, day);
  const end = new Date(y, m, day); // siguiente mes mismo día

  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  return { start: startStr, end: endStr };
}

function formatBudgetPeriodLabel(monthKeyStr, cutDay = 1) {
  const { start, end } = getBudgetPeriod(monthKeyStr, cutDay);

  // start y end vienen como "YYYY-MM-DD"
  const startDate = new Date(start + 'T00:00:00');
  const endExclusive = new Date(end + 'T00:00:00');

  // el periodo real llega hasta el día anterior a end (end es exclusivo)
  endExclusive.setDate(endExclusive.getDate() - 1);

  const fmt = (d) =>
    d
      .toLocaleDateString('es-CL', {
        day: '2-digit',
        month: 'short',
      })
      .replace('.', ''); // para quitar el punto de "nov."

  return `${fmt(startDate)} al ${fmt(endExclusive)}`;
}

export function budgetMonthKeyForDate(dateStr, cutDay = 1) {
  if (!dateStr) return monthKey(new Date());

  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return monthKey(new Date());

  const day = d.getDate();
  const offset = day >= cutDay ? 0 : -1; // si el día es menor al corte, pertenece al mes "anterior" de presupuesto

  const base = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return monthKey(base);
}
