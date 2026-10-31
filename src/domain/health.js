// src/domain/health.js
// Indicadores de salud financiera del hogar.
import { shiftMonth } from '../utils/budgetPeriod.js';
import {
  buildDebtPaidIndex,
  buildSavingsPaidIndex,
  commitmentsForPeriod,
  debtProgress,
  savingProgress,
} from './commitments.js';
import { averageConsumption, periodLedger } from './ledger.js';

export function householdHealth({ transactions = [], debts = [], savings = [], periodKey, cutDay = 1 }) {
  const ledger = periodLedger({ transactions, periodKey, cutDay, debts });

  const savingsIndex = buildSavingsPaidIndex(transactions, savings, cutDay);
  const savedTotal = (savings || []).reduce(
    (s, g) => s + Math.max(0, savingProgress(g, savingsIndex, { periodKey, cutDay }).saved),
    0,
  );

  const debtIndex = buildDebtPaidIndex(transactions);
  const debtRemaining = (debts || [])
    .filter((d) => d && !d.isSubscription && !d.archived) // mismo criterio que Inicio y Compromisos
    .reduce((s, d) => s + debtProgress(d, debtIndex).remaining, 0);

  // Carga financiera = cuotas de deuda que corresponden al periodo (incluye atrasadas,
  // sin suscripciones) / ingreso del periodo. Misma fórmula que en Compromisos.
  const debtObligations = commitmentsForPeriod({ debts, transactions, periodKey, cutDay })
    .filter((i) => i.kind === 'debt')
    .reduce((s, i) => s + i.planned, 0);
  const debtLoad = ledger.income > 0 ? debtObligations / ledger.income : null;

  const avgMonthlySpend = averageConsumption({ transactions, periodKey, cutDay, debts });
  const lastYear = periodLedger({ transactions, periodKey: shiftMonth(periodKey, -12), cutDay, debts });

  return {
    ledger,
    cash: ledger.closing,
    savedTotal,
    debtRemaining,
    // Lo que tienes menos lo que debes.
    netWorth: ledger.closing + savedTotal - debtRemaining,
    savingsRate: ledger.savingsRate,
    debtObligations,
    debtLoad,
    avgMonthlySpend,
    emergencyMonths: avgMonthlySpend > 0 ? savedTotal / avgMonthlySpend : null,
    lastYearConsumption: lastYear.transactions.length ? lastYear.consumptionNet : null,
  };
}
