import { describe, expect, it } from 'vitest';
import {
  allocateByWeights,
  buildDebtPaidIndex,
  buildDebtPaymentTransaction,
  buildSavingContributionTransaction,
  buildSavingsPaidIndex,
  commitmentsForPeriod,
  debtProgress,
  plannedForSavingPeriod,
  savingProgress,
  summarizeCommitments,
} from '../commitments.js';

const debt = {
  id: 'd1',
  name: 'Tarjeta BCI',
  original: 300000,
  remaining: 300000, // valor guardado desactualizado a propósito
  schedule: [
    { id: 'q1', periodKey: '2026-09', dueDate: '2026-09-05', plannedAmount: 100000, paidAmount: 100000 },
    { id: 'q2', periodKey: '2026-10', dueDate: '2026-10-05', plannedAmount: 100000, paidAmount: 0 },
    { id: 'q3', periodKey: '2026-11', dueDate: '2026-11-05', plannedAmount: 100000, paidAmount: 0 },
  ],
};

const pay = (quotaId, amount, date = '2026-10-05', extra = {}) => ({
  type: 'gasto',
  category: 'Deudas',
  amount,
  date,
  meta: { debtId: 'd1', debtQuotaIds: [quotaId], debtQuotaDebtIds: { [quotaId]: 'd1' } },
  ...extra,
});

describe('allocateByWeights', () => {
  it('reparte sin perder pesos', () => {
    const r = allocateByWeights(100, [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ]);
    expect(r.a + r.b + r.c).toBe(100);
    expect(r).toEqual({ a: 34, b: 33, c: 33 });
  });
});

describe('debtProgress', () => {
  it('calcula el saldo desde los movimientos, no desde `remaining`', () => {
    const idx = buildDebtPaidIndex([pay('q1', 100000, '2026-09-05'), pay('q2', 40000)]);
    const p = debtProgress(debt, idx, '2026-10-20');
    expect(p.paid).toBe(140000);
    expect(p.remaining).toBe(160000);
    expect(p.paidCount).toBe(1);
    expect(p.quotaCount).toBe(3);
    expect(p.overdueCount).toBe(1); // q2 vencida el 05-10 y pagada parcial
    expect(p.overdueAmount).toBe(60000);
    expect(p.nextQuota.id).toBe('q2');
    expect(p.endDate).toBe('2026-11-05');
    expect(p.isPaidOff).toBe(false);
  });

  it('si se borra el movimiento, el saldo vuelve solo', () => {
    const p = debtProgress(debt, buildDebtPaidIndex([]), '2026-08-01');
    expect(p.paid).toBe(0);
    expect(p.remaining).toBe(300000);
  });

  it('ignora movimientos marcados como "pago de deudas" en subcategoría', () => {
    const idx = buildDebtPaidIndex([
      pay('q1', 100000, '2026-09-05', { meta: { debtId: 'd1', debtQuotaIds: ['q1'], budgetSubcategoryName: 'Pago de deudas' } }),
    ]);
    expect(debtProgress(debt, idx).paid).toBe(0);
  });

  it('reparte un pago entre varias cuotas según debtQuotaAmounts', () => {
    const idx = buildDebtPaidIndex([
      {
        amount: 150000,
        meta: {
          debtId: 'd1',
          debtQuotaIds: ['q2', 'q3'],
          debtQuotaAmounts: { q2: 100000, q3: 50000 },
        },
      },
    ]);
    const p = debtProgress(debt, idx, '2026-10-01');
    expect(p.quotas.find((q) => q.id === 'q2').status).toBe('paid');
    expect(p.quotas.find((q) => q.id === 'q3').paid).toBe(50000);
  });

  it('considera alreadyPaid de deudas cargadas a mitad de camino', () => {
    const partial = { ...debt, original: 500000, alreadyPaid: 200000 };
    const p = debtProgress(partial, buildDebtPaidIndex([]));
    expect(p.total).toBe(500000);
    expect(p.remaining).toBe(300000);
  });
});

describe('ahorro', () => {
  const goal = {
    id: 's1',
    name: 'Fondo de emergencia',
    goal: 900000,
    saved: 100000,
    targetDate: '2026-12-20',
    schedule: [
      { id: 'p1', periodKey: '2026-10', plannedAmount: 200000 },
      { id: 'p2', periodKey: '2026-11', plannedAmount: 300000 },
    ],
  };
  const contrib = (amount, date, meta = { savingId: 's1' }) => ({
    type: 'gasto',
    category: 'Ahorro',
    amount,
    date,
    meta,
  });

  it('suma aportes por id y por nombre único', () => {
    const idx = buildSavingsPaidIndex(
      [contrib(50000, '2026-10-02'), contrib(25000, '2026-10-03', { savingName: 'fondo de emergencia ' })],
      [goal],
      1,
    );
    expect(idx.bySaving.get('s1')).toBe(75000);
    expect(idx.bySavingPeriod.get('s1::2026-10')).toBe(75000);
  });

  it('no adivina por nombre si hay metas repetidas', () => {
    const twin = { ...goal, id: 's2' };
    const idx = buildSavingsPaidIndex([contrib(1000, '2026-10-02', { savingName: goal.name })], [goal, twin], 1);
    expect(idx.bySaving.size).toBe(0);
  });

  it('calcula avance y aporte sugerido', () => {
    const idx = buildSavingsPaidIndex([contrib(200000, '2026-10-02')], [goal], 1);
    const p = savingProgress(goal, idx, { periodKey: '2026-10', cutDay: 1 });
    expect(p.saved).toBe(300000);
    expect(p.remaining).toBe(600000);
    expect(p.periodsLeft).toBe(3); // oct, nov, dic
    expect(p.suggestedPerPeriod).toBe(200000);
    expect(p.milestone).toBe(25);
  });

  it('usa el cronograma para el plan del periodo', () => {
    expect(plannedForSavingPeriod(goal, '2026-11', 1)).toBe(300000);
    expect(plannedForSavingPeriod(goal, '2027-01', 1)).toBe(0);
  });
});

describe('commitmentsForPeriod', () => {
  it('une cuotas del mes, cuotas atrasadas y aportes de ahorro', () => {
    const savings = [{ id: 's1', name: 'Vacaciones', goal: 100000, schedule: [{ id: 'p', periodKey: '2026-10', plannedAmount: 50000 }] }];
    const items = commitmentsForPeriod({
      debts: [debt],
      savings,
      transactions: [], // q1 nunca se pagó: queda atrasada
      periodKey: '2026-10',
      cutDay: 1,
      today: '2026-10-10',
    });
    expect(items.map((i) => i.key)).toEqual(['debt:d1:q1', 'debt:d1:q2', 'saving:s1:2026-10']);
    expect(items[0]).toMatchObject({ isOverdue: true, detail: 'Cuota 1 de 3', pending: 100000 });
    expect(summarizeCommitments(items)).toEqual({ planned: 250000, paid: 0, pending: 250000, overdue: 100000 });
  });

  it('excluye deudas archivadas', () => {
    const items = commitmentsForPeriod({ debts: [{ ...debt, archived: true }], periodKey: '2026-10' });
    expect(items).toEqual([]);
  });
});

describe('payloads de movimientos', () => {
  it('el pago de cuota queda vinculado por id y vuelve a contarse', () => {
    const tx = buildDebtPaymentTransaction({ debt, quotaIds: ['q2'], amount: 100000, date: '2026-10-05', user: { id: 'u1' } });
    expect(tx).toMatchObject({ type: 'gasto', category: 'Deudas', amount: 100000, ownerId: 'u1' });
    expect(tx.meta).toEqual({
      debtQuotaIds: ['q2'],
      debtQuotaId: 'q2',
      debtQuotaAmounts: { q2: 100000 },
      debtQuotaDebtIds: { q2: 'd1' },
      debtId: 'd1',
    });
    const p = debtProgress(debt, buildDebtPaidIndex([tx]));
    expect(p.quotas.find((q) => q.id === 'q2').status).toBe('paid');
  });

  it('el aporte de ahorro queda vinculado a la meta', () => {
    const tx = buildSavingContributionTransaction({ saving: { id: 's9', name: 'Auto' }, amount: 1000, date: '2026-10-01' });
    expect(tx.meta).toEqual({ savingId: 's9', savingName: 'Auto' });
  });
});

describe('deudas con intereses', () => {
  it('detecta el costo del crédito cuando las cuotas suman más que el original', () => {
    const d = { id: 'x', original: 300000, schedule: [1, 2, 3].map((i) => ({ id: `q${i}`, periodKey: `2026-1${i - 1}`, plannedAmount: 120000 })) };
    const p = debtProgress(d, buildDebtPaidIndex([]));
    expect(p.interest).toBe(60000);
    expect(p.total).toBe(360000);
  });

  it('con ya pagado e intereses, el total no se queda corto', () => {
    const d = { id: 'x', original: 500000, alreadyPaid: 200000, schedule: [1, 2, 3].map((i) => ({ id: `q${i}`, periodKey: `2026-1${i - 1}`, plannedAmount: 120000 })) };
    const p = debtProgress(d, buildDebtPaidIndex([]));
    expect(p.total).toBe(560000);
    expect(p.remaining).toBe(360000);
    expect(p.interest).toBe(60000);
  });
});
