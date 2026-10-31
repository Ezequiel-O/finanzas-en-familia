// src/features/cash/confirmWithinCash.js
// Antes de registrar un gasto, avisa si supera la plata que el hogar tiene hoy
// (no el presupuesto). Devuelve true si se puede guardar.
import { confirmDialog } from '../../components/feedback/feedback.js';
import { todayKey } from '../../domain/dates.js';
import { cashOnHand } from '../../domain/ledger.js';
import { formatCLP } from '../../domain/money.js';

export async function confirmWithinCash({ amount, transactions }) {
  const cash = cashOnHand(transactions, todayKey());
  if (amount <= cash) return true;
  const message =
    cash > 0
      ? `Este gasto de ${formatCLP(amount)} es mayor a lo que tienes hoy: solo hay ${formatCLP(cash)} disponibles. Te quedarías en ${formatCLP(cash - amount)}.`
      : `Hoy no tienes saldo disponible (${formatCLP(cash)}). Este gasto de ${formatCLP(amount)} te dejaría en ${formatCLP(cash - amount)}.`;
  return confirmDialog(`${message}\n\n¿Registrarlo igual?`, {
    title: 'No te alcanza el saldo',
    confirmLabel: 'Registrar igual',
  });
}
