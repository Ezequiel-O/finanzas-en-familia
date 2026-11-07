import { describe, expect, it } from 'vitest';
import {
  accountBalances,
  accountEffect,
  accountForSender,
  normalizeAccounts,
  reconciliation,
  unassignedTransactions,
} from '../accounts.js';

const ANCHORED_AT = '2026-11-07T12:00:00.000Z';
const accounts = normalizeAccounts([
  { id: 'bancoestado', name: 'BancoEstado', bank: 'bancoestado', anchorBalance: 100000, anchorDate: '2026-11-07', anchoredAt: ANCHORED_AT },
  { id: 'santander', name: 'Santander', bank: 'santander', anchorBalance: 50000, anchorDate: '2026-11-07', anchoredAt: ANCHORED_AT },
  { id: 'efectivo', name: 'Efectivo', kind: 'cash' },
]);

describe('normalizeAccounts', () => {
  it('uses the default accounts when nothing is configured', () => {
    expect(normalizeAccounts(undefined).map((account) => account.id)).toEqual([
      'bancoestado',
      'santander',
      'efectivo',
    ]);
  });

  it('drops invalid or repeated ids and ignores balances without a date', () => {
    const list = normalizeAccounts([
      { id: 'ok', anchorBalance: 500 },
      { id: 'ok' },
      { id: '../x' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'ok', anchorBalance: 0, anchorDate: '' });
  });
});

describe('accountForSender', () => {
  it('maps each bank sender to its account', () => {
    expect(accountForSender(accounts, 'notificaciones@correo.bancoestado.cl')?.id).toBe('bancoestado');
    expect(accountForSender(accounts, 'mensajeria@santander.cl')?.id).toBe('santander');
    expect(accountForSender(accounts, 'alguien@otro.cl')).toBeNull();
  });
});

describe('accountEffect', () => {
  it('moves money between accounts without counting it twice', () => {
    const withdrawal = {
      type: 'gasto',
      amount: 20000,
      category: 'Traspaso',
      meta: { kind: 'transfer', fromAccount: 'bancoestado', toAccount: 'efectivo' },
    };
    expect(accountEffect(withdrawal, 'bancoestado')).toBe(-20000);
    expect(accountEffect(withdrawal, 'efectivo')).toBe(20000);
    expect(accountEffect(withdrawal, 'santander')).toBe(0);
    expect(accountEffect({ type: 'ingreso', amount: 5000, account: 'santander' }, 'santander')).toBe(5000);
  });
});

describe('accountBalances', () => {
  const transactions = [
    // Antes de anotar el saldo real: ya está incluido en él.
    { type: 'gasto', amount: 1000, category: 'Otros', account: 'bancoestado', date: '2026-11-06' },
    { type: 'gasto', amount: 2000, category: 'Otros', account: 'bancoestado', date: '2026-11-07', createdAt: '2026-11-07T10:00:00.000Z' },
    // Después.
    { type: 'gasto', amount: 3000, category: 'Otros', account: 'bancoestado', date: '2026-11-07', createdAt: '2026-11-07T15:00:00.000Z' },
    { type: 'ingreso', amount: 10000, account: 'santander', date: '2026-11-08' },
    {
      type: 'gasto',
      amount: 20000,
      category: 'Traspaso',
      date: '2026-11-08',
      meta: { kind: 'transfer', fromAccount: 'bancoestado', toAccount: 'efectivo' },
    },
    // Fecha futura: todavía no ocurre.
    { type: 'gasto', amount: 9999, category: 'Otros', account: 'santander', date: '2026-11-20' },
  ];

  it('starts from the real balance and adds what happened afterwards', () => {
    const result = accountBalances({ accounts, transactions, today: '2026-11-08' });
    const byId = Object.fromEntries(result.accounts.map((account) => [account.id, account]));
    expect(byId.bancoestado.balance).toBe(100000 - 3000 - 20000);
    expect(byId.santander.balance).toBe(60000);
    expect(byId.efectivo).toMatchObject({ configured: false, balance: null });
    expect(result.total).toBe(77000 + 60000);
    expect(result.configuredCount).toBe(2);
  });

  it('does not count twice a same-day bank notice confirmed after the real balance', () => {
    const notice = {
      type: 'gasto',
      amount: 12290,
      category: 'Abastecimiento',
      account: 'bancoestado',
      date: '2026-11-07',
      occurredAt: '2026-11-07T11:00:00.000Z', // compra antes de anotar el saldo
      createdAt: '2026-11-07T18:00:00.000Z', // confirmada después
    };
    const result = accountBalances({ accounts, transactions: [notice], today: '2026-11-07' });
    expect(result.accounts[0].balance).toBe(100000);
  });

  it('computes the adjustment that makes the app balance match the real money', () => {
    const allConfigured = normalizeAccounts([
      ...accounts.slice(0, 2),
      { id: 'efectivo', name: 'Efectivo', kind: 'cash', anchorBalance: 5000, anchorDate: '2026-11-07', anchoredAt: ANCHORED_AT },
    ]);
    const history = [
      { type: 'ingreso', amount: 200000, date: '2026-10-01' },
      { type: 'gasto', amount: 80000, category: 'Hogar', date: '2026-10-15' },
    ];
    const check = reconciliation({ accounts: allConfigured, transactions: history, today: '2026-11-07' });
    expect(check).toMatchObject({ realTotal: 155000, appCash: 120000, delta: 35000, complete: true });

    const adjusted = [
      ...history,
      { type: 'ingreso', amount: 35000, category: 'Ajuste Balance', date: '2026-11-07', createdAt: '2026-11-07T19:00:00.000Z' },
    ];
    expect(reconciliation({ accounts: allConfigured, transactions: adjusted, today: '2026-11-07' }).delta).toBe(0);
    expect(unassignedTransactions({ accounts: allConfigured, transactions: adjusted, today: '2026-11-07' })).toEqual([]);
  });

  it('lists money movements after the start that have no account', () => {
    const pending = unassignedTransactions({
      accounts,
      today: '2026-11-08',
      transactions: [
        ...transactions,
        { id: 'sin', type: 'gasto', amount: 500, category: 'Otros', date: '2026-11-08' },
        { id: 'viejo', type: 'gasto', amount: 500, category: 'Otros', date: '2026-11-01' },
        { id: 'traspaso', type: 'gasto', amount: 500, category: 'Traspaso', date: '2026-11-08', meta: { kind: 'transfer' } },
      ],
    });
    expect(pending.map((t) => t.id)).toEqual(['sin']);
  });
});
