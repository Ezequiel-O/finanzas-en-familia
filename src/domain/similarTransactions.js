// src/domain/similarTransactions.js
// Detecta movimientos ya registrados (por ejemplo, a mano) que parecen ser el
// mismo que propone un aviso bancario: mismo monto y tipo, en fechas cercanas.
import { daysBetween, parseDateKey } from './dates.js';

// El aviso puede llegar con días de diferencia respecto de la fecha anotada a mano.
export const SIMILAR_DAYS_WINDOW = 3;
const MAX_MATCHES = 3;

// Un traspaso entre miembros se guarda como gasto.
const storedType = (type) => (type === 'traspaso' ? 'gasto' : type);

export function findSimilarTransactions(candidate, transactions = [], days = SIMILAR_DAYS_WINDOW) {
  const amount = Number(candidate?.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !parseDateKey(candidate?.date)) {
    return [];
  }
  const type = storedType(candidate.type);
  return (Array.isArray(transactions) ? transactions : [])
    .filter(
      (transaction) =>
        transaction &&
        // Lo importado desde otro aviso es otro movimiento (por ejemplo, el pasaje de ayer).
        !transaction.sourceGmailId &&
        transaction.type === type &&
        Number(transaction.amount) === amount &&
        parseDateKey(transaction.date) &&
        Math.abs(daysBetween(candidate.date, transaction.date)) <= days,
    )
    .sort(
      (a, b) =>
        Math.abs(daysBetween(candidate.date, a.date)) -
        Math.abs(daysBetween(candidate.date, b.date)),
    )
    .slice(0, MAX_MATCHES);
}
