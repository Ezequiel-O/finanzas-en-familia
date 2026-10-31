import { describe, expect, it } from 'vitest';
import { householdHealth } from '../health.js';
import { KIND, cashEffect, classifyTransaction, periodLedger, summarizeFlows, txDateKey } from '../ledger.js';

const debts = [
  { id: 'd1', name: 'Crédito', original: 300000, schedule: [{ id: 'q1', periodKey: '2026-10', plannedAmount: 100000 }, { id: 'q2', periodKey: '2026-11', plannedAmount: 100000 }, { id: 'q3', periodKey: '2026-12', plannedAmount: 100000 }] },
  { id: 'sub', name: 'Netflix', isSubscription: true, original: 9000, schedule: [{ id: 's1', periodKey: '2026-10', plannedAmount: 9000 }] },
];
const savings = [{ id: 'g1', name: 'Emergencia', goal: 1000000, saved: 200000 }];

const tx = [
  // Periodo anterior (sep): sobró 150.000
  { type: 'ingreso', amount: 1000000, date: '2026-09-01' },
  { type: 'gasto', amount: 850000, category: 'Alimentación', date: '2026-09-10' },
  // Octubre
  { type: 'ingreso', amount: 1200000, date: '2026-10-01' },
  { type: 'gasto', amount: 400000, category: 'Alimentación', date: '2026-10-03' },
  { type: 'ingreso', amount: 20000, category: 'Alimentación', date: '2026-10-04', meta: { kind: 'refund' } },
  { type: 'gasto', amount: 100000, category: 'Deudas', date: '2026-10-05', meta: { debtId: 'd1', debtQuotaIds: ['q1'] } },
  { type: 'gasto', amount: 9000, category: 'Deudas', date: '2026-10-06', meta: { debtId: 'sub', debtQuotaIds: ['s1'] } },
  { type: 'gasto', amount: 300000, category: 'Ahorro', date: '2026-10-07', meta: { savingId: 'g1' } },
  { type: 'ingreso', amount: 50000, category: 'Ahorro', date: '2026-10-08', meta: { kind: 'saving_withdrawal', savingId: 'g1' } },
  { type: 'gasto', amount: 70000, category: 'Traspaso', date: '2026-10-09', meta: { kind: 'transfer' } },
  { type: 'ingreso', amount: 5000, category: 'Ajuste Balance', date: '2026-10-10', meta: { source: 'balance-calculator' } },
];

describe('clasificación', () => {
  const subscriptionIds = new Set(['sub']);
  it.each([
    [tx[2], KIND.INCOME],
    [tx[3], KIND.CONSUMPTION],
    [tx[4], KIND.REFUND],
    [tx[5], KIND.DEBT],
    [tx[6], KIND.SUBSCRIPTION],
    [tx[7], KIND.SAVING],
    [tx[8], KIND.SAVING_WITHDRAWAL],
    [tx[9], KIND.TRANSFER],
    [tx[10], KIND.ADJUSTMENT],
  ])('%o -> %s', (t, kind) => {
    expect(classifyTransaction(t, { subscriptionIds })).toBe(kind);
  });

  it('el traspaso no mueve la caja del hogar', () => {
    expect(cashEffect(tx[9])).toBe(0);
  });
});

describe('periodLedger', () => {
  const l = periodLedger({ transactions: tx, periodKey: '2026-10', cutDay: 1, debts });

  it('arrastra el saldo del periodo anterior', () => {
    expect(l.opening).toBe(150000);
  });

  it('separa cada flujo', () => {
    expect(l).toMatchObject({
      income: 1200000,
      refunds: 20000,
      consumption: 400000,
      subscriptions: 9000,
      debtPayments: 100000,
      savingContributions: 300000,
      savingWithdrawals: 50000,
      adjustments: 5000,
      transfers: 70000,
    });
    expect(l.consumptionNet).toBe(389000); // 400.000 + 9.000 − 20.000
    expect(l.savingsNet).toBe(250000);
  });

  it('cuadra: saldo inicial + flujo neto = saldo final', () => {
    // 150.000 + 1.200.000 + 20.000 + 50.000 + 5.000 − 400.000 − 100.000 − 9.000 − 300.000
    expect(l.closing).toBe(616000);
    expect(l.opening + l.netCashFlow).toBe(l.closing);
  });

  it('ingresos no incluyen ajustes ni retiros de ahorro', () => {
    expect(l.inflows).toBe(1220000);
  });

  it('indicadores sobre el ingreso', () => {
    expect(l.savingsRate).toBeCloseTo(250000 / 1200000);
    expect(l.debtLoad).toBeCloseTo(100000 / 1200000); // sin la suscripción
  });

  it('cuadre global: la suma de flujos de todos los periodos es el saldo final', () => {
    const all = summarizeFlows(tx, { debts });
    expect(all.netCashFlow).toBe(l.closing);
  });
});

describe('txDateKey', () => {
  it('convierte createdAt UTC a fecha local para movimientos antiguos', () => {
    const local = new Date(2026, 9, 31, 22, 30); // 22:30 local
    expect(txDateKey({ createdAt: local.toISOString() })).toBe('2026-10-31');
    expect(txDateKey({ date: '2026-10-01', createdAt: local.toISOString() })).toBe('2026-10-01');
  });
});

describe('householdHealth', () => {
  it('calcula patrimonio neto y fondo de emergencia', () => {
    const h = householdHealth({ transactions: tx, debts, savings, periodKey: '2026-10', cutDay: 1 });
    expect(h.cash).toBe(616000);
    expect(h.savedTotal).toBe(450000); // 200.000 + 300.000 − 50.000
    expect(h.debtRemaining).toBe(200000);
    expect(h.netWorth).toBe(616000 + 450000 - 200000);
    expect(h.avgMonthlySpend).toBe(850000); // solo septiembre tiene datos
    expect(h.emergencyMonths).toBeCloseTo(450000 / 850000);
    expect(h.debtObligations).toBe(100000);
    expect(h.debtLoad).toBeCloseTo(100000 / 1200000);
  });
});
