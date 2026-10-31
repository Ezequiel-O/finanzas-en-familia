// src/domain/ledger.js
// Libro del hogar: una sola definición de saldo y de cada tipo de flujo,
// para que todas las pantallas muestren las mismas cifras.
//
// Criterio contable: BASE CAJA. Un gasto se registra cuando sale la plata.
// - Compras con tarjeta de crédito: NO se registran como gasto al comprar;
//   el gasto es la cuota cuando se paga (categoría Deudas, vinculada a la deuda).
// - Aportes a ahorro: la plata sale de la caja pero NO es consumo.
// - Ajustes de conciliación: corrigen la caja pero NO son ingreso ni gasto.
// - Traspasos entre miembros: no cambian la caja del hogar.
//
//   saldo final = saldo inicial + ingresos + reembolsos + retiros de ahorro
//                 − consumo − suscripciones − cuotas − aportes a ahorro ± ajustes
import { DEBT_CATEGORY, SAVINGS_CATEGORY } from '../constants.js';
import { getBudgetPeriod, shiftMonth } from '../utils/budgetPeriod.js';
import { addDaysToKey, toLocalDateKey } from './dates.js';
import { toNumber } from './money.js';

export const ADJUSTMENT_CATEGORY = 'Ajuste Balance';
export const TRANSFER_CATEGORY = 'Traspaso';

export const KIND = Object.freeze({
  INCOME: 'income',
  REFUND: 'refund',
  CONSUMPTION: 'consumption',
  SUBSCRIPTION: 'subscription',
  DEBT: 'debt',
  SAVING: 'saving',
  SAVING_WITHDRAWAL: 'saving_withdrawal',
  TRANSFER: 'transfer',
  ADJUSTMENT: 'adjustment',
});

// Fecha contable del movimiento. Los antiguos sin `date` usan `createdAt` (ISO en UTC),
// que se convierte a la fecha local para no correr el día.
export function txDateKey(t) {
  if (t?.date) return String(t.date).slice(0, 10);
  const created = t?.createdAt;
  if (!created) return '';
  if (typeof created === 'number') return toLocalDateKey(new Date(created));
  const raw = String(created);
  if (raw.includes('T')) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return toLocalDateKey(d);
  }
  return raw.slice(0, 10);
}

// Un ajuste corrige la caja sin ser ingreso ni gasto. Si alguien le puso después una
// categoría real (p. ej. Otros), la marca `meta` queda vieja: manda la categoría y el
// movimiento suma como gasto de esa categoría, igual que en Movimientos.
export function isAdjustment(t) {
  if (t?.category === ADJUSTMENT_CATEGORY) return true;
  if (String(t?.category || '').trim()) return false;
  return t?.meta?.kind === 'adjustment' || t?.meta?.source === 'balance-calculator';
}

export function subscriptionDebtIds(debts) {
  return new Set((debts || []).filter((d) => d?.isSubscription && d.id).map((d) => d.id));
}

export function classifyTransaction(t, { subscriptionIds = new Set() } = {}) {
  if (t?.meta?.kind === 'transfer' || t?.category === TRANSFER_CATEGORY) return KIND.TRANSFER;
  if (isAdjustment(t)) return KIND.ADJUSTMENT;
  if (t?.type === 'ingreso') {
    if (t?.meta?.kind === 'saving_withdrawal' || t?.category === SAVINGS_CATEGORY) {
      return KIND.SAVING_WITHDRAWAL;
    }
    if (t?.meta?.kind === 'refund') return KIND.REFUND;
    return KIND.INCOME;
  }
  if (t?.category === DEBT_CATEGORY) {
    return t?.meta?.debtId && subscriptionIds.has(t.meta.debtId) ? KIND.SUBSCRIPTION : KIND.DEBT;
  }
  if (t?.category === SAVINGS_CATEGORY) return KIND.SAVING;
  return KIND.CONSUMPTION;
}

// Efecto en la caja del hogar: + entra, − sale, 0 traspaso interno.
export function cashEffect(t) {
  if (t?.meta?.kind === 'transfer' || t?.category === TRANSFER_CATEGORY) return 0;
  const amount = toNumber(t?.amount);
  if (t?.type === 'ingreso') return amount;
  if (t?.type === 'gasto') return -amount;
  return 0;
}

const emptyFlows = () => ({
  income: 0,
  refunds: 0,
  consumption: 0,
  subscriptions: 0,
  debtPayments: 0,
  savingContributions: 0,
  savingWithdrawals: 0,
  adjustments: 0,
  transfers: 0,
  netCashFlow: 0,
});

export function summarizeFlows(transactions, { debts = [] } = {}) {
  const subscriptionIds = subscriptionDebtIds(debts);
  const f = emptyFlows();
  (transactions || []).forEach((t) => {
    const amount = toNumber(t?.amount);
    switch (classifyTransaction(t, { subscriptionIds })) {
      case KIND.INCOME:
        f.income += amount;
        break;
      case KIND.REFUND:
        f.refunds += amount;
        break;
      case KIND.CONSUMPTION:
        f.consumption += amount;
        break;
      case KIND.SUBSCRIPTION:
        f.subscriptions += amount;
        break;
      case KIND.DEBT:
        f.debtPayments += amount;
        break;
      case KIND.SAVING:
        f.savingContributions += amount;
        break;
      case KIND.SAVING_WITHDRAWAL:
        f.savingWithdrawals += amount;
        break;
      case KIND.ADJUSTMENT:
        f.adjustments += cashEffect(t);
        break;
      case KIND.TRANSFER:
        f.transfers += amount;
        break;
      default:
        break;
    }
    f.netCashFlow += cashEffect(t);
  });
  return f;
}

// Gasto neto de una categoría: gastos menos reembolsos de esa misma categoría.
// Es la cifra que se compara con el presupuesto en todas las pantallas.
export function categorySpent(transactions, category) {
  return (transactions || []).reduce((sum, t) => {
    if (t?.category !== category) return sum;
    if (t.meta?.kind === 'transfer' || isAdjustment(t)) return sum;
    const amount = toNumber(t.amount);
    if (t.type === 'gasto') return sum + amount;
    if (t.type === 'ingreso' && t.meta?.kind === 'refund') return sum - amount;
    return sum;
  }, 0);
}

// Libro de un periodo de presupuesto.
export function periodLedger({ transactions = [], periodKey, cutDay = 1, debts = [] }) {
  const { start, end } = getBudgetPeriod(periodKey, cutDay);
  let opening = 0;
  const inPeriod = [];
  (transactions || []).forEach((t) => {
    const d = txDateKey(t);
    if (!d) return;
    if (d < start) opening += cashEffect(t);
    else if (d < end) inPeriod.push(t);
  });
  const flows = summarizeFlows(inPeriod, { debts });
  const consumptionNet = flows.consumption + flows.subscriptions - flows.refunds;
  const savingsNet = flows.savingContributions - flows.savingWithdrawals;
  return {
    periodKey,
    start,
    end,
    opening,
    ...flows,
    // Lo que entró de verdad (sin ajustes ni retiros de ahorro).
    inflows: flows.income + flows.refunds,
    consumptionNet,
    savingsNet,
    // Total de salidas reales del periodo (sin traspasos ni ajustes).
    outflows: flows.consumption + flows.subscriptions + flows.debtPayments + flows.savingContributions,
    closing: opening + flows.netCashFlow,
    savingsRate: flows.income > 0 ? savingsNet / flows.income : null,
    debtLoad: flows.income > 0 ? flows.debtPayments / flows.income : null,
    transactions: inPeriod,
  };
}

// Promedio de consumo neto de los N periodos anteriores (para meses de fondo de emergencia).
export function averageConsumption({ transactions, periodKey, cutDay = 1, debts = [], periods = 3 }) {
  const values = [];
  for (let i = 1; i <= periods; i += 1) {
    const pk = shiftMonth(periodKey, -i);
    const l = periodLedger({ transactions, periodKey: pk, cutDay, debts });
    if (l.transactions.length) values.push(l.consumptionNet + l.debtPayments);
  }
  if (!values.length) return 0;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

// Plata real del hogar a `today`: todo lo que entró menos lo que salió hasta hoy, sin
// ingresos esperados ni movimientos con fecha futura. Traspasos internos no cuentan.
export function cashOnHand(transactions, today) {
  return (transactions || []).reduce((sum, t) => {
    const d = txDateKey(t);
    if (!d || d > today) return sum;
    return sum + cashEffect(t);
  }, 0);
}

// Ingresos de un periodo separados en lo que ya llegó (fecha ≤ hoy) y lo que está
// registrado con fecha futura. Sin ajustes, traspasos ni retiros de ahorro.
export function periodIncomeSplit({ transactions = [], periodKey, cutDay = 1, today }) {
  const { start, end } = getBudgetPeriod(periodKey, cutDay);
  return (transactions || []).reduce(
    (acc, t) => {
      const d = txDateKey(t);
      if (!d || d < start || d >= end || classifyTransaction(t) !== KIND.INCOME) return acc;
      if (d <= today) acc.received += toNumber(t.amount);
      else acc.upcoming += toNumber(t.amount);
      return acc;
    },
    { received: 0, upcoming: 0 },
  );
}

// Saldo de un periodo a hoy (o a su último día si ya terminó) y el proyectado al cierre,
// que suma lo registrado con fecha futura.
export function periodBalances({ transactions = [], periodKey, cutDay = 1, today }) {
  const { end } = getBudgetPeriod(periodKey, cutDay);
  const lastDay = addDaysToKey(end, -1);
  const asOf = [lastDay, today].sort()[0];
  let atToday = 0;
  let projected = 0;
  (transactions || []).forEach((t) => {
    const d = txDateKey(t);
    if (!d || d >= end) return;
    const effect = cashEffect(t);
    projected += effect;
    if (d <= asOf) atToday += effect;
  });
  return { asOf, atToday, projected };
}
