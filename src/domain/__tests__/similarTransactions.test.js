import { describe, expect, it } from 'vitest';
import { findSimilarTransactions } from '../similarTransactions.js';

const candidate = { id: 'msg1', type: 'gasto', amount: 81460, date: '2026-11-06' };

describe('findSimilarTransactions', () => {
  it('finds a manual entry with the same amount and type on nearby dates', () => {
    const manual = { id: 't1', type: 'gasto', amount: 81460, date: '2026-11-04', description: 'Cuentas' };
    expect(findSimilarTransactions(candidate, [manual])).toEqual([manual]);
  });

  it('ignores other amounts, other types, distant dates and movements imported from emails', () => {
    const transactions = [
      { id: 'a', type: 'gasto', amount: 81461, date: '2026-11-06' },
      { id: 'b', type: 'ingreso', amount: 81460, date: '2026-11-06' },
      { id: 'c', type: 'gasto', amount: 81460, date: '2026-11-10' },
      { id: 'd', type: 'gasto', amount: 81460, date: '2026-11-06', sourceGmailId: 'msg1' },
      { id: 'e', type: 'gasto', amount: 81460, date: 'sin fecha' },
      { id: 'f', type: 'gasto', amount: 81460, date: '2026-11-05', sourceGmailId: 'msg0' },
    ];
    expect(findSimilarTransactions(candidate, transactions)).toEqual([]);
  });

  it('treats member transfers as expenses and sorts the closest dates first', () => {
    const near = { id: 'near', type: 'gasto', amount: 20000, date: '2026-11-04' };
    const far = { id: 'far', type: 'gasto', amount: 20000, date: '2026-11-01' };
    expect(
      findSimilarTransactions(
        { id: 'x', type: 'traspaso', amount: 20000, date: '2026-11-04' },
        [far, near],
      ).map((transaction) => transaction.id),
    ).toEqual(['near', 'far']);
  });

  it('returns nothing for incomplete candidates', () => {
    expect(findSimilarTransactions({ amount: 0, date: '2026-11-06' }, [])).toEqual([]);
    expect(findSimilarTransactions({ amount: 100, date: '' }, [])).toEqual([]);
  });
});
