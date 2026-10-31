// src/domain/annualSummary.js
// Resumen del año por PERIODOS de presupuesto (respeta el día de corte), con las mismas
// cifras que Plan del mes: ingreso real, presupuesto (con arrastre de fijos, cuotas y ahorro)
// y gasto real. No proyecta: solo informa lo que ya pasó y lo que está planificado.
import { DEBT_CATEGORY, SAVINGS_CATEGORY } from '../constants.js';
import { formatBudgetPeriodLabel, getBudgetPeriod } from '../utils/budgetPeriod.js';
import { categoryBudgetStatus } from './budgetHealth.js';
import { commitmentsForPeriod, plannedForSavingPeriod } from './commitments.js';
import { todayKey } from './dates.js';
import { periodLedger } from './ledger.js';
import { toNumber } from './money.js';

function entryAmount(entry) {
  if (typeof entry === 'number') return toNumber(entry);
  if (entry && typeof entry === 'object') {
    return toNumber(entry.funded !== undefined ? entry.funded : entry.plan);
  }
  return 0;
}

// Presupuesto total de un periodo, con la misma regla que la tabla de Presupuestos.
export function periodBudgetTotal({
  periodKey,
  categories = [],
  budgetsAll = {},
  transactions = [],
  debts = [],
  savings = [],
  cutDay = 1,
  fixedCategories = {},
  today = todayKey(),
}) {
  const regular = categories.filter((c) => c !== DEBT_CATEGORY && c !== SAVINGS_CATEGORY);
  const regularTotal = regular.reduce(
    (sum, category) =>
      sum +
      categoryBudgetStatus({ budgetsAll, transactions, cutDay, category, periodKey, fixedCategories }).funded,
    0,
  );
  // Cuotas del periodo por su valor y las atrasadas por lo que falta pagar.
  const debtTotal = commitmentsForPeriod({ debts, transactions, periodKey, cutDay, today }).reduce(
    (sum, item) => sum + (item.isOverdue ? item.pending : item.planned),
    0,
  );
  const savingsEntry = entryAmount(budgetsAll?.[periodKey]?.[SAVINGS_CATEGORY]);
  const savingsTotal =
    savingsEntry > 0
      ? savingsEntry
      : (savings || []).reduce((sum, s) => sum + plannedForSavingPeriod(s, periodKey, cutDay), 0);
  return regularTotal + debtTotal + savingsTotal;
}

export function annualSummary({
  year,
  categories = [],
  budgetsAll = {},
  transactions = [],
  debts = [],
  savings = [],
  cutDay = 1,
  fixedCategories = {},
  today = todayKey(),
}) {
  const periods = Array.from({ length: 12 }, (_, idx) => {
    const periodKey = `${year}-${String(idx + 1).padStart(2, '0')}`;
    const { start, end } = getBudgetPeriod(periodKey, cutDay);
    const status = today >= end ? 'closed' : today >= start ? 'current' : 'future';
    const ledger = periodLedger({ transactions, periodKey, cutDay, debts });
    const budget = periodBudgetTotal({
      periodKey,
      categories,
      budgetsAll,
      transactions,
      debts,
      savings,
      cutDay,
      fixedCategories,
      today,
    });
    const income = ledger.income;
    // Salidas reales (consumo, suscripciones, cuotas y aportes) menos reembolsos: igual que
    // "Gastado hasta ahora" en Plan del mes. Ajustes y traspasos no cuentan.
    const spent = ledger.outflows - ledger.refunds;
    return {
      periodKey,
      label: formatBudgetPeriodLabel(periodKey, cutDay),
      status,
      income,
      budget,
      spent,
      budgetLeft: budget - spent,
      result: income - spent,
      hasActivity: ledger.transactions.length > 0,
      isOverBudget: status !== 'future' && spent > budget && spent > 0,
    };
  });

  // Solo periodos con algo que mostrar: el actual y los que tienen movimientos o presupuesto.
  const visible = periods.filter((p) => p.status === 'current' || p.hasActivity || p.budget > 0);
  const elapsed = visible.filter((p) => p.status !== 'future');
  const closed = elapsed.filter((p) => p.status === 'closed');
  const sum = (list, key) => list.reduce((s, p) => s + p[key], 0);
  const income = sum(elapsed, 'income');
  const spent = sum(elapsed, 'spent');

  return {
    periods: visible,
    totals: {
      income,
      spent,
      budget: sum(elapsed, 'budget'),
      result: income - spent,
      savingsRate: income > 0 ? (income - spent) / income : null,
      periodsCount: elapsed.length,
      closedCount: closed.length,
      overBudgetCount: elapsed.filter((p) => p.isOverBudget).length,
      avgClosedIncome: closed.length ? Math.round(sum(closed, 'income') / closed.length) : 0,
      avgClosedSpent: closed.length ? Math.round(sum(closed, 'spent') / closed.length) : 0,
    },
  };
}
