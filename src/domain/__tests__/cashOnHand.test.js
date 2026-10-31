import { describe, expect, it } from 'vitest';
import { cashOnHand } from '../ledger.js';

describe('cashOnHand', () => {
  it('suma lo que entró y resta lo que salió hasta hoy, sin fechas futuras ni traspasos', () => {
    const transactions = [
      { date: '2026-10-01', type: 'ingreso', amount: 500000 },
      { date: '2026-10-05', type: 'gasto', amount: 120000, category: 'Hogar' },
      { date: '2026-10-06', type: 'gasto', amount: 30000, category: 'Traspaso', meta: { kind: 'transfer' } },
      { date: '2026-10-20', type: 'ingreso', amount: 900000 }, // aún no llega
    ];
    expect(cashOnHand(transactions, '2026-10-10')).toBe(380000);
  });
});
