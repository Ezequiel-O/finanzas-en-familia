// src/utils/budgetPeriod.js

// Clave de mes: "YYYY-MM"
export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}`;
}

// Moverse entre meses aumentando/disminuyendo delta
export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const date = new Date(y, m - 1 + delta, 1);
  return monthKey(date);
}

// Periodo de presupuesto según día de corte
export function getBudgetPeriod(monthKeyStr, cutDay = 1) {
  const [y, m] = monthKeyStr.split('-').map(Number);
  const day = Math.max(1, Math.min(28, Number(cutDay) || 1)); // limitar 1–28

  const start = new Date(y, m - 1, day);
  const end = new Date(y, m, day); // siguiente mes mismo día (exclusivo)

  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  return { start: startStr, end: endStr };
}

// Etiqueta legible del periodo ("28 nov al 27 dic")
export function formatBudgetPeriodLabel(monthKeyStr, cutDay = 1) {
  const { start, end } = getBudgetPeriod(monthKeyStr, cutDay);

  const startDate = new Date(start + 'T00:00:00');
  const endExclusive = new Date(end + 'T00:00:00');

  // El periodo real va hasta el día anterior a end
  endExclusive.setDate(endExclusive.getDate() - 1);

  const fmt = (d) =>
    d
      .toLocaleDateString('es-CL', {
        day: '2-digit',
        month: 'short',
      })
      .replace('.', '');

  return `${fmt(startDate)} al ${fmt(endExclusive)}`;
}

// Dado un día y el día de corte, devuelve el "mes de presupuesto"
export function budgetMonthKeyForDate(dateStr, cutDay = 1) {
  if (!dateStr) return monthKey(new Date());

  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return monthKey(new Date());

  const day = d.getDate();
  const offset = day >= cutDay ? 0 : -1; // si es menor al corte, va al mes anterior

  const base = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return monthKey(base);
}
