// src/domain/money.js

export function toNumber(n) {
  const num = Number(n || 0);
  return Number.isFinite(num) ? num : 0;
}

export function formatCLP(value) {
  const safe = toNumber(value);
  const formatted = new Intl.NumberFormat('es-CL').format(Math.round(Math.abs(safe)));
  return `${safe < 0 ? '-' : ''}$${formatted}`;
}

// Interpreta montos escritos a mano en pesos chilenos:
// "15000", "15.000", "$15.000", "15 mil", "15 lucas", "1,5 millones", "medio millón".
// Devuelve un entero >= 0, o 0 si no hay monto.
export function parseAmount(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return 0;
  const text = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');

  if (/\bmedio\s+millon/.test(text)) return 500000;

  const multiplier = /\bmillon(es)?\b/.test(text)
    ? 1000000
    : /\b(mil|lucas?|k)\b/.test(text) || /\d\s*k\b/.test(text)
      ? 1000
      : 1;

  const match = text.match(/\d[\d.,\s]*/);
  if (!match) return 0;
  let numeric = match[0].replace(/\s/g, '');

  if (multiplier > 1) {
    // Con "mil"/"millones" la coma o punto suelen ser decimales: "1,5 millones".
    numeric = numeric.replace(/[.,](?=\d{1,2}$)/, '#').replace(/[.,]/g, '').replace('#', '.');
  } else {
    // Sin sufijo, en CLP punto y coma son separadores de miles.
    numeric = numeric.replace(/[.,]/g, '');
  }

  const value = Number(numeric);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * multiplier);
}

// Formatea mientras se escribe: "15000" -> "15.000".
export function formatAmountInput(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return new Intl.NumberFormat('es-CL').format(Number(digits));
}
