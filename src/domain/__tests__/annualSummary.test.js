import { describe, expect, it } from 'vitest';
import { annualSummary } from '../annualSummary.js';

const tx = (date, type, amount, category = '', extra = {}) => ({ date, type, amount, category, ...extra });

describe('annualSummary', () => {
  // Corte día 28: el periodo "2026-10" va del 28 oct al 27 nov.
  const transactions = [
    tx('2026-10-30', 'ingreso', 1550000),
    tx('2026-11-24', 'ingreso', 100000), // sigue siendo del periodo de octubre
    tx('2026-10-30', 'gasto', 117290, 'Abastecimiento'),
    tx('2026-10-30', 'gasto', 40869, 'Ajuste Balance'), // ajuste: no es gasto
    tx('2026-09-15', 'gasto', 20000, 'Abastecimiento'), // periodo "2026-08" (28 ago–27 sep)
  ];
  const budgetsAll = {
    '2026-10': { Abastecimiento: { funded: 300000 } },
    '2026-11': { Abastecimiento: { funded: 250000 } },
  };

  const summary = annualSummary({
    year: 2026,
    categories: ['Abastecimiento'],
    budgetsAll,
    transactions,
    cutDay: 28,
    today: '2026-10-30',
  });

  it('agrupa por periodo de presupuesto, no por mes calendario', () => {
    const oct = summary.periods.find((p) => p.periodKey === '2026-10');
    expect(oct.status).toBe('current');
    expect(oct.income).toBe(1650000);
    expect(oct.spent).toBe(117290);
    expect(oct.budget).toBe(300000);
    expect(oct.result).toBe(1650000 - 117290);
  });

  it('oculta periodos vacíos y marca los futuros como planificados', () => {
    expect(summary.periods.map((p) => [p.periodKey, p.status])).toEqual([
      ['2026-08', 'closed'],
      ['2026-10', 'current'],
      ['2026-11', 'future'],
    ]);
  });

  it('los totales no incluyen periodos futuros', () => {
    expect(summary.totals.income).toBe(1650000);
    expect(summary.totals.spent).toBe(137290);
    expect(summary.totals.budget).toBe(300000);
    expect(summary.totals.periodsCount).toBe(2);
    // agosto tuvo gasto sin presupuesto
    expect(summary.totals.overBudgetCount).toBe(1);
    expect(summary.totals.closedCount).toBe(1);
  });
});
