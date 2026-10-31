// src/domain/dates.js
// Fechas en hora local. `toISOString()` convierte a UTC, y en Chile (UTC-3/-4)
// eso adelanta la fecha un día después de las 20-21 h, lo que puede mover un
// gasto al día o al periodo siguiente.

const pad2 = (n) => String(n).padStart(2, '0');

// Date -> "YYYY-MM-DD" usando el calendario local.
export function toLocalDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// "Hoy" en hora local, como "YYYY-MM-DD".
export function todayKey(now = new Date()) {
  return toLocalDateKey(now);
}

// "YYYY-MM-DD" -> Date a medianoche local (o null si no es válida).
export function parseDateKey(key) {
  const match = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Días calendario entre dos claves (b - a). Usa mediodía para evitar saltos por horario de verano.
export function daysBetween(aKey, bKey) {
  const a = parseDateKey(aKey);
  const b = parseDateKey(bKey);
  if (!a || !b) return 0;
  a.setHours(12);
  b.setHours(12);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// "2026-11-08" -> "08 nov"
export function formatShortDate(key) {
  const d = parseDateKey(key);
  if (!d) return '';
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short' }).replace('.', '');
}

// "2027-03-05" -> "mar 2027"
export function formatMonthYear(key) {
  const d = parseDateKey(key);
  if (!d) return '';
  return d.toLocaleDateString('es-CL', { month: 'short', year: 'numeric' }).replace('.', '');
}

export function addDaysToKey(key, days) {
  const d = parseDateKey(key);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return toLocalDateKey(d);
}
